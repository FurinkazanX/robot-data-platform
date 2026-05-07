import asyncio
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional


class JobStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"
    DISMISSED = "dismissed"


@dataclass
class JobProgress:
    job_id: str
    job_type: str = ""          # "convert" | "transfer"
    status: JobStatus = JobStatus.PENDING
    total: int = 0
    current: int = 0
    current_file: str = ""
    message: str = ""
    error: str = ""
    cancelled: bool = False
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    updated_at: str = field(default_factory=lambda: datetime.now().isoformat())
    _subscribers: List[asyncio.Queue] = field(default_factory=list, repr=False)
    _history: List[Dict[str, Any]] = field(default_factory=list, repr=False)

    def cancel(self):
        self.cancelled = True

    def to_dict(self) -> Dict[str, Any]:
        return {
            "job_id": self.job_id,
            "job_type": self.job_type,
            "status": self.status,
            "total": self.total,
            "current": self.current,
            "percent": round(self.current / self.total * 100, 1) if self.total else 0,
            "current_file": self.current_file,
            "message": self.message,
            "error": self.error,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    def update(self, **kwargs):
        for k, v in kwargs.items():
            if k not in ("_subscribers", "_history"):
                setattr(self, k, v)
        self.updated_at = datetime.now().isoformat()
        event = self.to_dict()
        self._history.append(event)
        for q in self._subscribers:
            q.put_nowait(event)

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        for event in self._history:
            q.put_nowait(event)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        if q in self._subscribers:
            self._subscribers.remove(q)


class JobManager:
    def __init__(self):
        self._jobs: Dict[str, JobProgress] = {}

    def create(self, job_type: str = "") -> JobProgress:
        job_id = str(uuid.uuid4())
        job = JobProgress(job_id=job_id, job_type=job_type)
        self._jobs[job_id] = job
        return job

    def get(self, job_id: str) -> Optional[JobProgress]:
        return self._jobs.get(job_id)

    def list_all(self) -> List[Dict[str, Any]]:
        return sorted(
            [j.to_dict() for j in self._jobs.values()
             if j.status != JobStatus.DISMISSED],
            key=lambda d: d["created_at"],
            reverse=True,
        )


job_manager = JobManager()
