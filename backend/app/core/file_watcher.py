"""Directory monitoring service for real-time data conversion.

Watches a source directory for new HDF5 files and converts them to the
target format as they arrive.
"""
import asyncio
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler


class MonitorState:
    IDLE = "idle"
    MONITORING = "monitoring"


class MonitorService:
    def __init__(self):
        self._state = MonitorState.IDLE
        self._is_converting = False
        self._source_dir: Optional[Path] = None
        self._target_dir: Optional[Path] = None
        self._field_mapping: Dict[str, str] = {}
        self._source_format = "hdf5"
        self._target_format = "lerobot"
        self._observer: Optional[Observer] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._subscribers: List[asyncio.Queue] = []
        self._logs: List[Dict[str, Any]] = []
        self._pending_queue: Optional[asyncio.Queue] = None
        self._convert_task: Optional[asyncio.Task] = None
        self._lock = threading.Lock()

    # ── Public state ──────────────────────────────────────────────────────────

    def get_status(self) -> Dict[str, Any]:
        return {
            "state": self._state,
            "is_converting": self._is_converting,
            "source_dir": str(self._source_dir) if self._source_dir else None,
            "target_dir": str(self._target_dir) if self._target_dir else None,
        }

    # ── Subscriber management ─────────────────────────────────────────────────

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        for ev in self._logs[-200:]:
            q.put_nowait(ev)
        with self._lock:
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        with self._lock:
            if q in self._subscribers:
                self._subscribers.remove(q)

    def _emit(self, event: Dict[str, Any]):
        """Must be called from the event loop thread."""
        event.setdefault("timestamp", datetime.now().isoformat())
        self._logs.append(event)
        with self._lock:
            subs = list(self._subscribers)
        for q in subs:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                pass

    def _emit_threadsafe(self, event: Dict[str, Any]):
        """Safe to call from watchdog observer thread."""
        if self._loop and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(self._emit, event)

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(
        self,
        source_dir: Path,
        target_dir: Path,
        field_mapping: Dict[str, str],
        source_format: str = "hdf5",
        target_format: str = "lerobot",
    ):
        if self._state != MonitorState.IDLE:
            raise RuntimeError("监控已在运行中")

        self._source_dir = source_dir
        self._target_dir = target_dir
        self._field_mapping = field_mapping
        self._source_format = source_format
        self._target_format = target_format
        self._state = MonitorState.MONITORING
        self._logs = []
        self._loop = asyncio.get_running_loop()
        self._pending_queue = asyncio.Queue()

        handler = _HDF5EventHandler(self)
        self._observer = Observer()
        self._observer.schedule(handler, str(source_dir), recursive=False)
        self._observer.start()

        self._convert_task = asyncio.create_task(self._convert_worker())
        self._emit({
            "type": "info",
            "message": f"开始监控: {source_dir}  →  {target_dir}",
            "state": MonitorState.MONITORING,
            "is_converting": False,
        })

    async def stop(self):
        if self._is_converting:
            raise RuntimeError("正在转换中，请等待当前转换完成后再停止")
        if self._state == MonitorState.IDLE:
            return

        if self._observer:
            self._observer.stop()
            await asyncio.get_running_loop().run_in_executor(None, self._observer.join)
            self._observer = None

        if self._convert_task and not self._convert_task.done():
            self._convert_task.cancel()
            try:
                await self._convert_task
            except asyncio.CancelledError:
                pass
        self._convert_task = None
        self._pending_queue = None
        self._state = MonitorState.IDLE
        self._emit({
            "type": "info",
            "message": "监控已停止",
            "state": MonitorState.IDLE,
            "is_converting": False,
        })

    # ── Internal ──────────────────────────────────────────────────────────────

    def _enqueue_file(self, path: Path):
        """Called from watchdog thread to enqueue a new file."""
        if self._loop and self._pending_queue and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(self._pending_queue.put_nowait, path)
            self._emit_threadsafe({
                "type": "detected",
                "message": f"检测到新文件: {path.name}",
                "state": self._state,
                "is_converting": self._is_converting,
            })

    async def _convert_worker(self):
        from app.core.converter.base import get_converter
        from app.core.converter import hdf5_lerobot  # noqa: F401 — triggers registration

        loop = asyncio.get_running_loop()

        while self._state == MonitorState.MONITORING:
            try:
                file_path: Path = await asyncio.wait_for(
                    self._pending_queue.get(), timeout=1.0  # type: ignore[union-attr]
                )
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break

            self._is_converting = True
            self._emit({
                "type": "converting",
                "message": f"开始转换: {file_path.name}",
                "state": self._state,
                "is_converting": True,
            })

            try:
                converter = get_converter(self._source_format, self._target_format)

                # Auto-detect field mapping if none configured
                mapping = self._field_mapping
                if not mapping:
                    preview = await loop.run_in_executor(None, converter.preview, file_path)
                    mapping = preview.get("suggested_mapping", {})
                    self._emit({
                        "type": "info",
                        "message": f"自动检测字段映射: {list(mapping.values())}",
                        "state": self._state,
                        "is_converting": True,
                    })

                def _progress_cb(done: int, total: int, msg: str):
                    self._emit_threadsafe({
                        "type": "progress",
                        "message": msg,
                        "state": MonitorState.MONITORING,
                        "is_converting": True,
                    })

                dst = self._target_dir
                fm = mapping
                await loop.run_in_executor(
                    None,
                    lambda fp=file_path, d=dst, m=fm: converter.convert(
                        fp, d, m, True, _progress_cb
                    ),
                )
                self._emit({
                    "type": "done",
                    "message": f"转换完成: {file_path.name}",
                    "state": self._state,
                    "is_converting": False,
                })
            except asyncio.CancelledError:
                self._emit({
                    "type": "warning",
                    "message": f"转换被取消: {file_path.name}",
                    "state": self._state,
                    "is_converting": False,
                })
                break
            except Exception as exc:
                self._emit({
                    "type": "error",
                    "message": f"转换失败 {file_path.name}: {exc}",
                    "state": self._state,
                    "is_converting": False,
                })
            finally:
                self._is_converting = False


class _HDF5EventHandler(FileSystemEventHandler):
    """Watchdog event handler that detects new HDF5 files."""

    def __init__(self, service: MonitorService):
        self._service = service
        self._seen: set = set()

    def on_created(self, event):
        if event.is_directory:
            return
        path = Path(event.src_path)
        if path.suffix.lower() in {".hdf5", ".h5"} and path not in self._seen:
            self._seen.add(path)
            self._service._enqueue_file(path)

    def on_moved(self, event):
        # Some writers create a temp file then rename it
        if event.is_directory:
            return
        path = Path(event.dest_path)
        if path.suffix.lower() in {".hdf5", ".h5"} and path not in self._seen:
            self._seen.add(path)
            self._service._enqueue_file(path)


monitor_service = MonitorService()
