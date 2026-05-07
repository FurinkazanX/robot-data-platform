import asyncio
import os
from pathlib import Path
from typing import Dict

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.core.file_watcher import monitor_service

router = APIRouter()

DATA_ROOT = os.environ.get("DATA_ROOT", "/data")


def _abs(path: str) -> Path:
    base = Path(DATA_ROOT)
    full = (base / path.lstrip("/")).resolve()
    if not str(full).startswith(str(base.resolve())):
        raise ValueError(f"路径越权: {path}")
    return full


class StartMonitorRequest(BaseModel):
    source_dir: str
    target_dir: str
    field_mapping: Dict[str, str] = {}
    source_format: str = "hdf5"
    target_format: str = "lerobot"


@router.get("/status")
def get_status():
    return monitor_service.get_status()


@router.post("/start")
async def start_monitor(req: StartMonitorRequest):
    try:
        src = _abs(req.source_dir)
        dst = _abs(req.target_dir)
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))

    if not src.is_dir():
        raise HTTPException(status_code=400, detail="源路径不是目录或不存在")

    dst.mkdir(parents=True, exist_ok=True)

    try:
        await monitor_service.start(
            source_dir=src,
            target_dir=dst,
            field_mapping=req.field_mapping,
            source_format=req.source_format,
            target_format=req.target_format,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))

    return {"ok": True, "message": "监控已启动"}


@router.post("/stop")
async def stop_monitor():
    if monitor_service.get_status()["is_converting"]:
        raise HTTPException(status_code=409, detail="正在转换中，请等待当前转换完成后再停止")
    try:
        await monitor_service.stop()
    except RuntimeError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {"ok": True, "message": "监控已停止"}


@router.websocket("/ws")
async def monitor_ws(websocket: WebSocket):
    await websocket.accept()
    q = monitor_service.subscribe()
    try:
        while True:
            try:
                event = await asyncio.wait_for(q.get(), timeout=30)
                await websocket.send_json(event)
            except asyncio.TimeoutError:
                await websocket.send_json({"type": "ping"})
    except WebSocketDisconnect:
        pass
    finally:
        monitor_service.unsubscribe(q)
