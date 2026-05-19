import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

router = APIRouter()

DATA_ROOT = os.environ.get("DATA_ROOT", "/data")


def _abs(path: str) -> Path:
    base = Path(DATA_ROOT)
    full = (base / path.lstrip("/")).resolve()
    if not str(full).startswith(str(base.resolve())):
        raise HTTPException(status_code=403, detail="Path outside data root")
    return full


def _annotation_file(p: Path) -> Path:
    if p.is_file():
        return p.parent / f"{p.stem}.annotations.json"
    # lerobot directory → store inside meta/
    return p / "meta" / "annotations.json"


def _load(p: Path) -> Dict[str, Any]:
    ann = _annotation_file(p)
    if ann.exists():
        with open(ann) as f:
            return json.load(f)
    return {"version": 1, "episodes": {}}


def _save(p: Path, data: Dict[str, Any]):
    ann = _annotation_file(p)
    ann.parent.mkdir(parents=True, exist_ok=True)
    with open(ann, "w") as f:
        json.dump(data, f, indent=2)


@router.get("/load")
def load_annotations(path: str = Query(...)) -> Dict[str, Any]:
    p = _abs(path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="路径不存在")
    return _load(p)


class SaveRequest(BaseModel):
    path: str
    episode: int = 0
    labels: List[str] = []
    frame_rewards: Dict[str, float] = {}   # frame_idx (str) → reward


@router.post("/save")
def save_annotations(req: SaveRequest) -> Dict[str, Any]:
    p = _abs(req.path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="路径不存在")

    data = _load(p)
    ep_key = str(req.episode)
    data["episodes"].setdefault(ep_key, {})
    data["episodes"][ep_key]["labels"] = req.labels
    data["episodes"][ep_key]["frame_rewards"] = req.frame_rewards

    _save(p, data)
    return {"ok": True}



PRESET_LABELS = [
    "success", "failure", "collision", "good_grasp",
    "drop", "slip", "timeout", "reset",
]


@router.get("/labels")
def get_label_suggestions() -> Dict[str, List[str]]:
    return {"suggestions": PRESET_LABELS}


# ── Reward Groups ─────────────────────────────────────────────────────────────

class RewardSegmentModel(BaseModel):
    id: str
    type: str        # 'range' | 'point'
    startFrame: int
    endFrame: int
    value: float


class RewardGroupModel(BaseModel):
    id: str
    name: str
    color: str
    visible: bool
    segments: List[RewardSegmentModel]


class RewardSaveRequest(BaseModel):
    path: str
    episode: int
    groups: List[RewardGroupModel]


@router.get("/reward")
def load_reward(path: str = Query(...), episode: int = Query(0)) -> Dict[str, Any]:
    p = _abs(path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="路径不存在")
    data = _load(p)
    ep_key = str(episode)
    groups = data.get("episodes", {}).get(ep_key, {}).get("reward_groups", [])
    return {"groups": groups}


@router.post("/reward")
def save_reward(req: RewardSaveRequest) -> Dict[str, Any]:
    p = _abs(req.path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="路径不存在")
    data = _load(p)
    ep_key = str(req.episode)
    data["episodes"].setdefault(ep_key, {})
    data["episodes"][ep_key]["reward_groups"] = [g.model_dump() for g in req.groups]
    _save(p, data)
    return {"ok": True}


# ── Write reward into LeRobot parquet ─────────────────────────────────────────

class ApplyRewardRequest(BaseModel):
    path: str
    episode: int
    rewards: List[float]   # one float per frame


@router.post("/reward/apply")
def apply_reward_to_dataset(req: ApplyRewardRequest) -> Dict[str, Any]:
    """Write per-frame reward values as a 'reward' column into the episode parquet file."""
    import pandas as pd
    import pyarrow as pa
    import pyarrow.parquet as pq

    p = _abs(req.path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="路径不存在")

    # Locate the episode parquet file
    data_dir = p / "data"
    parquet_path: Optional[Path] = None
    if data_dir.exists():
        for chunk_dir in sorted(data_dir.glob("chunk-*")):
            candidate = chunk_dir / f"episode_{req.episode:06d}.parquet"
            if candidate.exists():
                parquet_path = candidate
                break

    if parquet_path is None:
        raise HTTPException(status_code=404, detail="找不到对应的 parquet 文件")

    table = pq.read_table(parquet_path)
    df = table.to_pandas()

    if len(req.rewards) != len(df):
        raise HTTPException(
            status_code=400,
            detail=f"reward 帧数({len(req.rewards)})与数据帧数({len(df)})不匹配",
        )

    df["reward"] = [float(v) for v in req.rewards]
    pq.write_table(pa.Table.from_pandas(df, preserve_index=False), parquet_path)

    # Update meta/info.json features
    info_path = p / "meta" / "info.json"
    if info_path.exists():
        with open(info_path) as f:
            meta = json.load(f)
        meta.setdefault("features", {})["reward"] = {"dtype": "float32", "shape": [1]}
        with open(info_path, "w") as f:
            json.dump(meta, f, indent=2)

    return {"ok": True}
