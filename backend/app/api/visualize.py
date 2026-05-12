import io
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

import h5py
import numpy as np
import pandas as pd
import pyarrow.parquet as pq
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response
from PIL import Image
from pydantic import BaseModel

router = APIRouter()

DATA_ROOT = os.environ.get("DATA_ROOT", "/data")


def _abs(path: str) -> Path:
    base = Path(DATA_ROOT)
    full = (base / path.lstrip("/")).resolve()
    if not str(full).startswith(str(base.resolve())):
        raise HTTPException(status_code=403, detail="Path outside data root")
    return full


def _detect_format(path: Path) -> str:
    if path.is_file() and path.suffix in (".h5", ".hdf5"):
        return "hdf5"
    if path.is_dir() and (path / "meta" / "info.json").exists():
        return "lerobot"
    return "unknown"


def _find_videos_dir(p: Path) -> Optional[Path]:
    # Converter output: data/chunk-000/videos/<cam>/
    d1 = p / "data" / "chunk-000" / "videos"
    if d1.exists():
        return d1
    # Native LeRobot format: videos/chunk-000/<cam>/
    d2 = p / "videos" / "chunk-000"
    if d2.exists():
        return d2
    return None


def _find_ep_parquet(p: Path, episode: int) -> Optional[Path]:
    ep_name = f"episode_{episode:06d}.parquet"
    f1 = p / "data" / "chunk-000" / ep_name
    if f1.exists():
        return f1
    f2 = p / "data" / "chunk-000" / "episodes" / ep_name
    if f2.exists():
        return f2
    return None


# ── Info ──────────────────────────────────────────────────────────────────────

@router.get("/info")
def get_info(path: str = Query(...)):
    p = _abs(path)
    fmt = _detect_format(p)
    if fmt == "hdf5":
        return _hdf5_info(p, path)
    if fmt == "lerobot":
        return _lerobot_info(p, path)
    raise HTTPException(status_code=400, detail="Unsupported format")


def _hdf5_info(p: Path, path_str: str) -> Dict[str, Any]:
    with h5py.File(p, "r") as fp:
        def _scan(group, prefix=""):
            fields = []
            for k in group.keys():
                full = f"{prefix}/{k}" if prefix else k
                item = group[k]
                if isinstance(item, h5py.Dataset):
                    is_image = item.dtype == np.uint8 and item.ndim in (3, 4)
                    fields.append({
                        "key": full,
                        "shape": list(item.shape),
                        "dtype": str(item.dtype),
                        "is_image": is_image,
                    })
                else:
                    fields.extend(_scan(item, full))
            return fields

        fields = _scan(fp)
        n_frames = fields[0]["shape"][0] if fields else 0
    return {"format": "hdf5", "path": path_str, "n_episodes": 1, "n_frames": n_frames, "fields": fields}


def _lerobot_info(p: Path, path_str: str) -> Dict[str, Any]:
    info_path = p / "meta" / "info.json"
    with open(info_path) as f:
        info = json.load(f)

    episodes_path = p / "meta" / "episodes.jsonl"
    episodes = []
    if episodes_path.exists():
        with open(episodes_path) as f:
            for line in f:
                line = line.strip()
                if line:
                    episodes.append(json.loads(line))

    # Enumerate camera directories for frame access
    videos_dir = _find_videos_dir(p)
    cameras: List[str] = []
    if videos_dir and videos_dir.exists():
        cameras = sorted(d.name for d in videos_dir.iterdir() if d.is_dir())

    return {
        "format": "lerobot",
        "path": path_str,
        "n_episodes": info.get("total_episodes", len(episodes)),
        "n_frames": info.get("total_frames", 0),
        "fps": info.get("fps", 30),
        "features": info.get("features", {}),
        "episodes": episodes,
        "cameras": cameras,
    }


# ── Frame ─────────────────────────────────────────────────────────────────────

@router.get("/frame")
def get_frame(path: str = Query(...), episode: int = 0, frame_idx: int = 0, cam: Optional[str] = None):
    p = _abs(path)
    fmt = _detect_format(p)
    if fmt == "hdf5":
        img = _hdf5_frame(p, frame_idx, cam)
    elif fmt == "lerobot":
        img = _lerobot_frame(p, episode, frame_idx, cam)
    else:
        raise HTTPException(status_code=400, detail="Unsupported format")

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return Response(content=buf.getvalue(), media_type="image/jpeg")


def _hdf5_frame(p: Path, frame_idx: int, cam: Optional[str]) -> Image.Image:
    with h5py.File(p, "r") as fp:
        def _find_image_key(group, prefix=""):
            for k in group.keys():
                full = f"{prefix}/{k}" if prefix else k
                item = group[k]
                if isinstance(item, h5py.Dataset) and item.dtype == np.uint8 and item.ndim in (3, 4):
                    if cam is None or cam == full:
                        return full
                elif isinstance(item, h5py.Group):
                    result = _find_image_key(item, full)
                    if result:
                        return result
            return None

        key = _find_image_key(fp)
        if key is None:
            raise HTTPException(status_code=404, detail="No image data found")
        frame = fp[key][frame_idx]
    if frame.ndim == 2:
        return Image.fromarray(frame, mode="L").convert("RGB")
    return Image.fromarray(frame)


def _lerobot_frame(p: Path, episode: int, frame_idx: int, cam: Optional[str]) -> Image.Image:
    videos_dir = _find_videos_dir(p)
    if not videos_dir:
        raise HTTPException(status_code=404, detail="No video data found")

    cam_dirs = list(videos_dir.iterdir())
    if cam:
        cam_dirs = [d for d in cam_dirs if d.name == cam]
    if not cam_dirs:
        raise HTTPException(status_code=404, detail="Camera not found")

    vid_path = cam_dirs[0] / f"episode_{episode:06d}.mp4"
    if not vid_path.exists():
        raise HTTPException(status_code=404, detail="Video not found")

    import cv2
    cap = cv2.VideoCapture(str(vid_path))
    cap.set(cv2.CAP_PROP_POS_FRAMES, frame_idx)
    ret, frame = cap.read()
    cap.release()
    if not ret:
        raise HTTPException(status_code=404, detail="Frame not found")
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    return Image.fromarray(rgb)


# ── Series (time-series data) ─────────────────────────────────────────────────

@router.get("/series")
def get_series(path: str = Query(...), episode: int = 0, field: Optional[str] = None):
    p = _abs(path)
    fmt = _detect_format(p)
    if fmt == "hdf5":
        return _hdf5_series(p, field)
    if fmt == "lerobot":
        return _lerobot_series(p, episode, field)
    raise HTTPException(status_code=400, detail="Unsupported format")


def _hdf5_series(p: Path, field: Optional[str]) -> Dict[str, Any]:
    results = {}
    with h5py.File(p, "r") as fp:
        def _collect(group, prefix=""):
            for k in group.keys():
                full = f"{prefix}/{k}" if prefix else k
                item = group[k]
                if isinstance(item, h5py.Dataset):
                    if field and full != field:
                        continue
                    arr = item[()]
                    if arr.ndim == 1:
                        results[full] = arr.tolist()
                    elif arr.ndim == 2:
                        for i in range(min(arr.shape[1], 8)):
                            results[f"{full}[{i}]"] = arr[:, i].tolist()
                elif isinstance(item, h5py.Group):
                    _collect(item, full)
        _collect(fp)
    return {"fields": results}


def _lerobot_series(p: Path, episode: int, field: Optional[str]) -> Dict[str, Any]:
    ep_file = _find_ep_parquet(p, episode)
    if not ep_file:
        raise HTTPException(status_code=404, detail="Episode not found")
    df = pq.read_table(ep_file).to_pandas()
    results = {}
    for col in df.columns:
        if field and col != field:
            continue
        vals = df[col].tolist()
        if not vals:
            continue
        if isinstance(vals[0], (int, float)):
            results[col] = vals
        elif isinstance(vals[0], list):
            arr = np.array(vals)
            for i in range(min(arr.shape[1], 8)):
                results[f"{col}[{i}]"] = arr[:, i].tolist()
    return {"fields": results}


# ── Edit ──────────────────────────────────────────────────────────────────────

class EditRequest(BaseModel):
    path: str
    episode: int = 0
    frame_idx: int = 0
    field: str
    value: Any


@router.put("/edit")
def edit_value(req: EditRequest):
    p = _abs(req.path)
    fmt = _detect_format(p)
    if fmt == "hdf5":
        _hdf5_edit(p, req.frame_idx, req.field, req.value)
    elif fmt == "lerobot":
        _lerobot_edit(p, req.episode, req.frame_idx, req.field, req.value)
    else:
        raise HTTPException(status_code=400, detail="Unsupported format")
    return {"ok": True}


def _hdf5_edit(p: Path, frame_idx: int, field: str, value: Any):
    with h5py.File(p, "r+") as fp:
        if field not in fp:
            raise HTTPException(status_code=404, detail=f"Field {field} not found")
        fp[field][frame_idx] = value


def _lerobot_edit(p: Path, episode: int, frame_idx: int, field: str, value: Any):
    ep_file = _find_ep_parquet(p, episode)
    if not ep_file:
        raise HTTPException(status_code=404, detail="Episode not found")
    df = pq.read_table(ep_file).to_pandas()
    if field not in df.columns:
        raise HTTPException(status_code=404, detail=f"Field {field} not found")
    df.at[frame_idx, field] = value
    import pyarrow as pa
    pq.write_table(pa.Table.from_pandas(df), ep_file)
