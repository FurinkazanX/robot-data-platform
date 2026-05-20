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


# ── Reward group storage helpers ──────────────────────────────────────────────
# Works for both local paths (stored inside meta/) and remote paths (cached in
# DATA_ROOT/.reward_annotations/).

def _reward_storage_path(raw_path: str) -> Path:
    base = Path(DATA_ROOT)
    try:
        full = (base / raw_path.lstrip("/")).resolve()
        if str(full).startswith(str(base.resolve())) and full.exists():
            return _annotation_file(full)
    except Exception:
        pass
    # Remote or non-existent path: use a local cache keyed by sanitized path
    safe = raw_path.replace("/", "_").replace("\\", "_").replace(":", "_").strip("_")[:200]
    return base / ".reward_annotations" / f"{safe}.json"


def _reward_load(raw_path: str) -> Dict[str, Any]:
    storage = _reward_storage_path(raw_path)
    if storage.exists():
        with open(storage) as f:
            return json.load(f)
    return {"version": 1, "episodes": {}}


def _reward_save(raw_path: str, data: Dict[str, Any]):
    storage = _reward_storage_path(raw_path)
    storage.parent.mkdir(parents=True, exist_ok=True)
    with open(storage, "w") as f:
        json.dump(data, f, indent=2)


# ── Label annotation (existing) ───────────────────────────────────────────────

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
    frame_rewards: Dict[str, float] = {}


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
    data = _reward_load(path)
    ep_key = str(episode)
    groups = data.get("episodes", {}).get(ep_key, {}).get("reward_groups", [])
    return {"groups": groups}


@router.get("/reward/annotated")
def get_annotated_episodes(path: str = Query(...)) -> Dict[str, Any]:
    data = _reward_load(path)
    annotated = sorted(
        int(k) for k, v in data.get("episodes", {}).items()
        if v.get("reward_groups")
    )
    return {"episodes": annotated}


@router.get("/reward/written")
def get_reward_written_episodes(path: str = Query(...)) -> Dict[str, Any]:
    """Return episode indices where the parquet file has a 'reward' column."""
    import pyarrow.parquet as pq

    p = _abs(path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="路径不存在")
    data_dir = p / "data"
    if not data_dir.exists():
        return {"episodes": []}
    written = []
    for chunk_dir in sorted(data_dir.glob("chunk-*")):
        for pq_file in sorted(chunk_dir.glob("episode_*.parquet")):
            try:
                schema = pq.read_schema(pq_file)
                if "reward" in schema.names:
                    ep_num = int(pq_file.stem.split("_")[-1])
                    written.append(ep_num)
            except Exception:
                pass
    return {"episodes": sorted(written)}


@router.post("/reward")
def save_reward(req: RewardSaveRequest) -> Dict[str, Any]:
    data = _reward_load(req.path)
    ep_key = str(req.episode)
    data["episodes"].setdefault(ep_key, {})
    data["episodes"][ep_key]["reward_groups"] = [g.model_dump() for g in req.groups]
    _reward_save(req.path, data)
    return {"ok": True}


# ── Write reward into local LeRobot parquet ───────────────────────────────────

class ApplyRewardRequest(BaseModel):
    path: str
    episode: int
    rewards: List[float]


@router.post("/reward/apply")
def apply_reward_to_dataset(req: ApplyRewardRequest) -> Dict[str, Any]:
    import pandas as pd
    import pyarrow as pa
    import pyarrow.parquet as pq

    p = _abs(req.path)
    if not p.exists():
        raise HTTPException(status_code=404, detail="路径不存在")

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

    info_path = p / "meta" / "info.json"
    if info_path.exists():
        with open(info_path) as f:
            meta = json.load(f)
        meta.setdefault("features", {})["reward"] = {"dtype": "float32", "shape": [1]}
        with open(info_path, "w") as f:
            json.dump(meta, f, indent=2)

    return {"ok": True}


# ── Write reward into remote LeRobot parquet via SSH ─────────────────────────

class ApplyRewardRemoteRequest(BaseModel):
    host: str
    port: int = 22
    username: str
    password: Optional[str] = None
    key_path: Optional[str] = None
    path: str
    episode: int
    rewards: List[float]


@router.post("/reward/apply_remote")
def apply_reward_remote(req: ApplyRewardRemoteRequest) -> Dict[str, Any]:
    import io
    import paramiko
    import pandas as pd
    import pyarrow as pa
    import pyarrow.parquet as pq

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            req.host, port=req.port, username=req.username,
            password=req.password,
            key_filename=req.key_path or None,
        )
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"SSH 连接失败: {e}")

    sftp = client.open_sftp()
    try:
        ep_file = f"{req.path}/data/chunk-000/episode_{req.episode:06d}.parquet"

        buf = io.BytesIO()
        try:
            sftp.getfo(ep_file, buf)
        except Exception:
            raise HTTPException(status_code=404, detail=f"远程 parquet 文件不存在: {ep_file}")

        buf.seek(0)
        df = pq.read_table(buf).to_pandas()

        if len(req.rewards) != len(df):
            raise HTTPException(
                status_code=400,
                detail=f"reward 帧数({len(req.rewards)})与数据帧数({len(df)})不匹配",
            )

        df["reward"] = [float(v) for v in req.rewards]
        out = io.BytesIO()
        pq.write_table(pa.Table.from_pandas(df, preserve_index=False), out)
        out.seek(0)
        sftp.putfo(out, ep_file)

        # Update remote info.json
        info_file = f"{req.path}/meta/info.json"
        try:
            with sftp.open(info_file, "r") as f:
                meta = json.load(f)
            meta.setdefault("features", {})["reward"] = {"dtype": "float32", "shape": [1]}
            with sftp.open(info_file, "w") as f:
                f.write(json.dumps(meta, indent=2))
        except Exception:
            pass

        return {"ok": True}
    finally:
        sftp.close()
        client.close()

