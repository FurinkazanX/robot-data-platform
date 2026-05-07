import asyncio
import os
import traceback
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.core.ssh_transfer import SSHTransfer
from app.jobs import JobStatus, job_manager

router = APIRouter()

DATA_ROOT = os.environ.get("DATA_ROOT", "/data")


def _abs(path: str) -> Path:
    base = Path(DATA_ROOT)
    full = (base / path.lstrip("/")).resolve()
    if not str(full).startswith(str(base.resolve())):
        raise HTTPException(status_code=403, detail="Path outside data root")
    return full


class SSHCredentials(BaseModel):
    host: str
    port: int = 22
    username: str
    password: Optional[str] = None
    key_path: Optional[str] = None


class RemoteListRequest(SSHCredentials):
    path: str = "/"


class TransferRequest(SSHCredentials):
    local_paths: List[str]
    remote_base: str


class RemoteMkdirRequest(SSHCredentials):
    path: str


class RemoteRenameRequest(SSHCredentials):
    old_path: str
    new_path: str


class RemoteDeleteRequest(SSHCredentials):
    path: str


@router.post("/test")
def test_connection(creds: SSHCredentials):
    try:
        with SSHTransfer(creds.host, creds.port, creds.username, creds.password, creds.key_path):
            pass
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/remote")
def list_remote(req: RemoteListRequest):
    try:
        with SSHTransfer(req.host, req.port, req.username, req.password, req.key_path) as t:
            items = t.list_remote(req.path)
        return {"path": req.path, "items": items}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/remote/mkdir")
def remote_mkdir(req: RemoteMkdirRequest):
    try:
        with SSHTransfer(req.host, req.port, req.username, req.password, req.key_path) as t:
            t.mkdir(req.path)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/remote/rename")
def remote_rename(req: RemoteRenameRequest):
    try:
        with SSHTransfer(req.host, req.port, req.username, req.password, req.key_path) as t:
            t.rename(req.old_path, req.new_path)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/remote/delete")
def remote_delete(req: RemoteDeleteRequest):
    try:
        with SSHTransfer(req.host, req.port, req.username, req.password, req.key_path) as t:
            t.delete(req.path)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/start")
async def start_transfer(req: TransferRequest):
    if not req.local_paths:
        raise HTTPException(status_code=400, detail="请至少选择一个本地文件")

    job = job_manager.create(job_type="transfer")
    job.update(total=len(req.local_paths), status=JobStatus.RUNNING, message="连接中...")

    async def _run():
        try:
            transfer = SSHTransfer(req.host, req.port, req.username, req.password, req.key_path)
            transfer.connect()
            loop = asyncio.get_running_loop()
            for i, local_rel in enumerate(req.local_paths):
                if job.cancelled:
                    transfer.disconnect()
                    job.update(status=JobStatus.CANCELLED, message="已取消")
                    return
                local = _abs(local_rel)
                remote = f"{req.remote_base.rstrip('/')}/{local.name}"
                job.update(current=i, current_file=local.name, status=JobStatus.RUNNING,
                           message=f"传输中 ({i + 1}/{len(req.local_paths)}): {local.name}")

                def _cb(fname: str, transferred: int, total: int):
                    pct = round(transferred / total * 100, 1) if total else 0
                    job.update(message=f"{local.name}: {pct}%")

                await loop.run_in_executor(
                    None, lambda l=local, r=remote, cb=_cb: transfer.upload(l, r, cb)
                )
                job.update(current=i + 1)
            transfer.disconnect()
            job.update(status=JobStatus.DONE, message="传输完成")
        except Exception as e:
            job.update(
                status=JobStatus.FAILED,
                error=f"{type(e).__name__}: {e}\n\n{traceback.format_exc()}",
            )

    asyncio.create_task(_run())
    return {"job_id": job.job_id}


@router.post("/cancel/{job_id}")
async def cancel_transfer_job(job_id: str):
    job = job_manager.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    job.cancel()
    return {"ok": True}


@router.get("/jobs/{job_id}")
def get_job(job_id: str):
    job = job_manager.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job.to_dict()


@router.websocket("/ws/{job_id}")
async def transfer_ws(websocket: WebSocket, job_id: str):
    await websocket.accept()
    job = job_manager.get(job_id)
    if not job:
        await websocket.close(code=4004)
        return

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
