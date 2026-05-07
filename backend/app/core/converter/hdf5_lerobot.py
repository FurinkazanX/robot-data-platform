"""HDF5 → LeRobot dataset converter.

LeRobot directory layout:
  <dst>/
    meta/
      info.json
      episodes.jsonl
    data/
      chunk-000/
        episode_000000.parquet
        videos/
          <cam_key>/
            episode_000000.mp4
"""

import json
import os
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import h5py
import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from .base import BaseConverter, register_converter

_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg"}


def _is_image_dataset(ds: h5py.Dataset) -> bool:
    """Shape (T, H, W) or (T, H, W, C) with uint8."""
    return ds.dtype == np.uint8 and ds.ndim in (3, 4)


def _scan_hdf5(fp: h5py.File, prefix: str = "") -> List[Dict[str, Any]]:
    result = []
    for key in fp.keys():
        full_key = f"{prefix}/{key}" if prefix else key
        item = fp[key]
        if isinstance(item, h5py.Dataset):
            result.append({
                "key": full_key,
                "shape": list(item.shape),
                "dtype": str(item.dtype),
                "is_image": _is_image_dataset(item),
            })
        elif isinstance(item, h5py.Group):
            result.extend(_scan_hdf5(item, full_key))
    return result


def _encode_video(frames: np.ndarray, out_path: Path, fps: float = 30.0):
    import imageio
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if frames.ndim == 3:
        frames = np.stack([frames] * 3, axis=-1)
    writer = imageio.get_writer(str(out_path), fps=fps, codec="libx264", quality=8)
    for frame in frames:
        writer.append_data(frame)
    writer.close()


@register_converter
class HDF5ToLerobotConverter(BaseConverter):
    name = "HDF5 → LeRobot"
    source_format = "hdf5"
    target_format = "lerobot"

    def preview(self, src_path: Path) -> Dict[str, Any]:
        with h5py.File(src_path, "r") as fp:
            fields = _scan_hdf5(fp)
            n_frames = fields[0]["shape"][0] if fields else 0
        return {
            "path": str(src_path),
            "fields": fields,
            "n_frames": n_frames,
            "suggested_mapping": self._suggest_mapping(fields),
        }

    def _suggest_mapping(self, fields: List[Dict]) -> Dict[str, str]:
        mapping: Dict[str, str] = {}
        for f in fields:
            key = f["key"].lower()
            if f["is_image"]:
                cam = f["key"].split("/")[-1]
                mapping[f["key"]] = f"observation.images.{cam}"
            elif "action" in key:
                mapping[f["key"]] = "action"
            elif "qpos" in key or "joint" in key:
                mapping[f["key"]] = "observation.state"
            elif "timestamp" in key or "time" in key:
                mapping[f["key"]] = "timestamp"
        return mapping

    def convert(
        self,
        src_path: Path,
        dst_path: Path,
        field_mapping: Dict[str, str],
        incremental: bool = False,
        progress_cb: Optional[Callable[[int, int, str], None]] = None,
    ) -> None:
        dst_path.mkdir(parents=True, exist_ok=True)
        meta_dir = dst_path / "meta"
        meta_dir.mkdir(exist_ok=True)
        chunk_dir = dst_path / "data" / "chunk-000"
        chunk_dir.mkdir(parents=True, exist_ok=True)

        # Load existing meta if incremental
        info_path = meta_dir / "info.json"
        episodes_path = meta_dir / "episodes.jsonl"
        episode_offset = 0
        frame_offset = 0
        existing_info: Dict[str, Any] = {}

        if incremental and info_path.exists():
            with open(info_path) as f:
                existing_info = json.load(f)
            episode_offset = existing_info.get("total_episodes", 0)
            frame_offset = existing_info.get("total_frames", 0)

        with h5py.File(src_path, "r") as fp:
            all_fields = _scan_hdf5(fp)
            n_frames = all_fields[0]["shape"][0] if all_fields else 0

            # Build dataframe columns
            scalar_cols: Dict[str, np.ndarray] = {}
            image_cols: Dict[str, np.ndarray] = {}

            mapped_keys = set(field_mapping.keys())
            step = max(1, len(mapped_keys))
            done = 0

            for hdf5_key, lerobot_field in field_mapping.items():
                if progress_cb:
                    progress_cb(done, step, f"读取字段: {hdf5_key}")
                done += 1

                if hdf5_key not in fp:
                    continue
                data = fp[hdf5_key][()]  # type: ignore[index]

                if lerobot_field.startswith("observation.images."):
                    cam_name = lerobot_field.split("observation.images.")[-1]
                    image_cols[cam_name] = data
                else:
                    scalar_cols[lerobot_field] = data

            # Build parquet
            ep_idx = episode_offset
            ep_file = chunk_dir / f"episode_{ep_idx:06d}.parquet"

            rows: List[Dict[str, Any]] = []
            for i in range(n_frames):
                row: Dict[str, Any] = {
                    "episode_index": ep_idx,
                    "frame_index": i,
                    "index": frame_offset + i,
                }
                for field_name, arr in scalar_cols.items():
                    val = arr[i]
                    row[field_name] = val.tolist() if hasattr(val, "tolist") else float(val)
                rows.append(row)

            df = pd.DataFrame(rows)
            table = pa.Table.from_pandas(df)
            pq.write_table(table, ep_file)

            # Encode videos
            for cam_name, frames in image_cols.items():
                vid_path = chunk_dir / "videos" / cam_name / f"episode_{ep_idx:06d}.mp4"
                if progress_cb:
                    progress_cb(done, step + len(image_cols), f"编码视频: {cam_name}")
                _encode_video(frames, vid_path)
                done += 1

        # Write/update episodes.jsonl
        ep_entry = {
            "episode_index": ep_idx,
            "tasks": [],
            "length": n_frames,
        }
        with open(episodes_path, "a") as f:
            f.write(json.dumps(ep_entry) + "\n")

        # Write/update info.json
        info: Dict[str, Any] = {
            "codebase_version": "v2.0",
            "robot_type": "unknown",
            "total_episodes": episode_offset + 1,
            "total_frames": frame_offset + n_frames,
            "fps": existing_info.get("fps", 30),
            "features": self._build_features(field_mapping, scalar_cols, image_cols, n_frames),
        }
        with open(info_path, "w") as f:
            json.dump(info, f, indent=2)

        if progress_cb:
            progress_cb(step, step, "完成")

    def _build_features(
        self,
        field_mapping: Dict[str, str],
        scalar_cols: Dict[str, np.ndarray],
        image_cols: Dict[str, np.ndarray],
        n_frames: int,
    ) -> Dict[str, Any]:
        features: Dict[str, Any] = {
            "episode_index": {"dtype": "int64", "shape": [1]},
            "frame_index": {"dtype": "int64", "shape": [1]},
            "index": {"dtype": "int64", "shape": [1]},
        }
        for field_name, arr in scalar_cols.items():
            shape = list(arr.shape[1:]) if arr.ndim > 1 else [1]
            features[field_name] = {"dtype": str(arr.dtype), "shape": shape}
        for cam_name, frames in image_cols.items():
            h, w = frames.shape[1], frames.shape[2]
            c = frames.shape[3] if frames.ndim == 4 else 1
            features[f"observation.images.{cam_name}"] = {
                "dtype": "video",
                "shape": [c, h, w],
                "video_info": {"video.fps": 30, "video.codec": "libx264"},
            }
        return features
