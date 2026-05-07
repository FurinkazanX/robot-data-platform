import asyncio
import os
import traceback
from pathlib import Path
from typing import Dict, List, Optional

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.core.converter.base import get_converter, list_converters
from app.core.converter import hdf5_lerobot  # noqa: F401 — triggers registration
from app.jobs import JobStatus, job_manager

router = APIRouter()

DATA_ROOT = os.environ.get("DATA_ROOT", "/data")


def _abs(path: str) -> Path:
    base = Path(DATA_ROOT)
    full = (base / path.lstrip("/")).resolve()
    if not str(full).startswith(str(base.resolve())):
        raise ValueError(f"路径越权: {path}")
    return full


class PreviewRequest(BaseModel):
    path: str


class ConvertRequest(BaseModel):
    source_format: str = "hdf5"
    target_format: str = "lerobot"
    src_paths: List[str]
    dst_path: str
    field_mapping: Dict[str, str]
    incremental: bool = False


@router.get("/converters")
def get_converters():
    return list_converters()


@router.post("/preview")
def preview(req: PreviewRequest):
    try:
        src = _abs(req.path)
    except ValueError as e:
        raise HTTPException(status_code=403, detail=str(e))
    if not src.exists():
        raise HTTPException(status_code=404, detail="文件不存在")
    converter = get_converter("hdf5", "lerobot")
    return converter.preview(src)


@router.post("/start")
async def start_conversion(req: ConvertRequest):
    if not req.src_paths:
        raise HTTPException(status_code=400, detail="请至少选择一个源文件")
    if not req.dst_path.strip():
        raise HTTPException(status_code=400, detail="请填写目标路径")

    job = job_manager.create()
    job.update(total=len(req.src_paths), status=JobStatus.RUNNING, message="启动中...")

    async def _run():
        try:
            try:
                converter = get_converter(req.source_format, req.target_format)
            except ValueError as e:
                job.update(status=JobStatus.FAILED, error=str(e))
                return

            try:
                dst = _abs(req.dst_path)
            except ValueError as e:
                job.update(status=JobStatus.FAILED, error=f"目标路径无效: {e}")
                return

            loop = asyncio.get_running_loop()

            for i, src_rel in enumerate(req.src_paths):
                if job.cancelled:
                    job.update(status=JobStatus.CANCELLED, message="已取消")
                    return

                try:
                    src = _abs(src_rel)
                except ValueError as e:
                    job.update(status=JobStatus.FAILED, error=f"源路径无效: {e}")
                    return

                if not src.exists():
                    job.update(status=JobStatus.FAILED, error=f"文件不存在: {src_rel}")
                    return

                job.update(current=i, current_file=src.name, status=JobStatus.RUNNING,
                           message=f"正在转换 ({i + 1}/{len(req.src_paths)}): {src.name}")

                def _cb(done: int, total: int, msg: str):
                    job.update(message=f"[{src.name}] {msg}")

                await loop.run_in_executor(
                    None,
                    lambda s=src, d=dst, cb=_cb: converter.convert(
                        s, d, req.field_mapping, req.incremental, cb
                    ),
                )
                job.update(current=i + 1,
                           message=f"完成 ({i + 1}/{len(req.src_paths)}): {src.name}")

            job.update(status=JobStatus.DONE, message="所有文件转换完成")

        except Exception as e:
            job.update(
                status=JobStatus.FAILED,
                error=f"{type(e).__name__}: {e}\n\n详细信息:\n{traceback.format_exc()}",
            )

    asyncio.create_task(_run())
    return {"job_id": job.job_id}


@router.post("/cancel/{job_id}")
async def cancel_job(job_id: str):
    job = job_manager.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    job.cancel()
    return {"ok": True}


@router.get("/jobs")
def list_jobs():
    return job_manager.list_all()


@router.get("/jobs/{job_id}")
def get_job(job_id: str):
    job = job_manager.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job.to_dict()


@router.websocket("/ws/{job_id}")
async def job_ws(websocket: WebSocket, job_id: str):
    await websocket.accept()
    job = job_manager.get(job_id)
    if not job:
        await websocket.close(code=4004)
        return

    # subscribe() replays all history, so late-connecting WS gets all events
    q = job.subscribe()
    try:
        while True:
            try:
                update = await asyncio.wait_for(q.get(), timeout=30)
                await websocket.send_json(update)
                if update["status"] in (JobStatus.DONE, JobStatus.FAILED, JobStatus.CANCELLED):
                    break
            except asyncio.TimeoutError:
                await websocket.send_json({"ping": True})
    except WebSocketDisconnect:
        pass
    finally:
        job.unsubscribe(q)
