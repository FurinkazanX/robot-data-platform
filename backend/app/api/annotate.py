import json
import os
from pathlib import Path
from typing import Any, Dict, List

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
