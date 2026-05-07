import os
import shutil
from pathlib import Path
from typing import Optional
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

router = APIRouter()

DATA_ROOT = os.environ.get("DATA_ROOT", "/data")


def _safe_path(path: Optional[str]) -> Path:
    base = Path(DATA_ROOT)
    if not path or path in ("", "/"):
        return base
    resolved = (base / path.lstrip("/")).resolve()
    if not str(resolved).startswith(str(base.resolve())):
        raise HTTPException(status_code=403, detail="Path outside data root")
    return resolved


@router.get("/list")
def list_directory(path: Optional[str] = Query(default=None)):
    target = _safe_path(path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="Not a directory")

    items = []
    for entry in sorted(target.iterdir()):
        try:
            stat = entry.stat()
            items.append({
                "name": entry.name,
                "path": str(entry.relative_to(Path(DATA_ROOT))).replace("\\", "/"),
                "is_dir": entry.is_dir(),
                "size": stat.st_size if entry.is_file() else None,
                "mtime": stat.st_mtime,
                "ext": entry.suffix.lower() if entry.is_file() else None,
            })
        except PermissionError:
            continue
    return {"path": str(target.relative_to(Path(DATA_ROOT))).replace("\\", "/"), "items": items}


@router.get("/stat")
def stat_path(path: str = Query(...)):
    target = _safe_path(path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    stat = target.stat()
    return {
        "name": target.name,
        "path": str(target.relative_to(Path(DATA_ROOT))).replace("\\", "/"),
        "is_dir": target.is_dir(),
        "size": stat.st_size,
        "mtime": stat.st_mtime,
    }


class MkdirRequest(BaseModel):
    path: str  # relative path of directory to create


class RenameRequest(BaseModel):
    path: str      # relative path of item to rename
    new_name: str  # new name only (not full path)


class DeleteRequest(BaseModel):
    path: str  # relative path to delete


@router.post("/mkdir")
def mkdir(req: MkdirRequest):
    target = _safe_path(req.path)
    target.mkdir(parents=True, exist_ok=True)
    return {"ok": True}


@router.post("/rename")
def rename(req: RenameRequest):
    target = _safe_path(req.path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    new_name = req.new_name.strip()
    if not new_name or "/" in new_name or "\\" in new_name:
        raise HTTPException(status_code=400, detail="Invalid name")
    new_path = target.parent / new_name
    if not str(new_path.resolve()).startswith(str(Path(DATA_ROOT).resolve())):
        raise HTTPException(status_code=403, detail="Path outside data root")
    if new_path.exists():
        raise HTTPException(status_code=409, detail="Name already exists")
    target.rename(new_path)
    return {"ok": True}


@router.post("/delete")
def delete(req: DeleteRequest):
    target = _safe_path(req.path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="Path not found")
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()
    return {"ok": True}
