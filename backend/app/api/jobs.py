from fastapi import APIRouter, HTTPException

from app.jobs import JobStatus, job_manager

router = APIRouter()


@router.get("/")
def list_jobs():
    return job_manager.list_all()


@router.post("/{job_id}/dismiss")
def dismiss_job(job_id: str):
    job = job_manager.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    job.update(status=JobStatus.DISMISSED)
    job_manager.persist()
    return {"ok": True}
