"""Directory monitoring service for real-time data conversion or transfer."""
import asyncio
import threading
from dataclasses import dataclass, field as dc_field
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from watchdog.observers.polling import PollingObserver
from watchdog.events import FileSystemEventHandler


class MonitorState:
    IDLE = "idle"
    MONITORING = "monitoring"


@dataclass
class ConversionItem:
    file_path: str
    file_name: str
    # pending | waiting | converting | transferring | done | failed
    status: str = "pending"
    percent: float = 0.0
    message: str = ""
    added_at: str = dc_field(default_factory=lambda: datetime.now().isoformat())


class MonitorService:
    def __init__(self):
        self._state = MonitorState.IDLE
        self._mode = "convert"              # "convert" | "transfer"
        self._is_converting = False
        self._source_dir: Optional[Path] = None
        self._target_dir: Optional[Path] = None
        self._field_mapping: Dict[str, str] = {}
        self._source_format = "hdf5"
        self._target_format = "lerobot"
        # SSH transfer fields
        self._ssh_host = ""
        self._ssh_port = 22
        self._ssh_username = ""
        self._ssh_password = ""
        self._remote_target_dir = ""
        # Runtime
        self._observer: Optional[PollingObserver] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._subscribers: List[asyncio.Queue] = []
        self._logs: List[Dict[str, Any]] = []
        self._pending_queue: Optional[asyncio.Queue] = None
        self._convert_task: Optional[asyncio.Task] = None
        self._lock = threading.Lock()
        self._conversion_items: List[ConversionItem] = []

    # ── Public state ──────────────────────────────────────────────────────────

    def get_status(self) -> Dict[str, Any]:
        return {
            "state": self._state,
            "mode": self._mode,
            "is_converting": self._is_converting,
            "source_dir": str(self._source_dir) if self._source_dir else None,
            "target_dir": str(self._target_dir) if self._target_dir else None,
            "remote_host": self._ssh_host or None,
            "remote_target_dir": self._remote_target_dir or None,
            "queue": self._queue_snapshot(),
        }

    def _item_dict(self, item: ConversionItem) -> Dict[str, Any]:
        return {
            "file_name": item.file_name,
            "file_path": item.file_path,
            "status": item.status,
            "percent": item.percent,
            "message": item.message,
            "added_at": item.added_at,
        }

    def _queue_snapshot(self) -> List[Dict[str, Any]]:
        return [self._item_dict(it) for it in self._conversion_items]

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

    def _emit_with_queue(self, event_type: str, message: str = ""):
        """Emit an event containing the current queue snapshot. Must be on event loop thread."""
        self._emit({
            "type": event_type,
            "message": message,
            "state": self._state,
            "is_converting": self._is_converting,
            "queue": self._queue_snapshot(),
        })

    def _emit_with_queue_threadsafe(self, event_type: str, message: str = ""):
        """Thread-safe version for calls from watchdog / executor threads."""
        if not (self._loop and not self._loop.is_closed()):
            return
        snapshot = self._queue_snapshot()
        self._loop.call_soon_threadsafe(self._emit, {
            "type": event_type,
            "message": message,
            "state": self._state,
            "is_converting": self._is_converting,
            "queue": snapshot,
        })

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    async def start(
        self,
        source_dir: Path,
        mode: str = "convert",
        # convert mode
        target_dir: Optional[Path] = None,
        field_mapping: Optional[Dict[str, str]] = None,
        source_format: str = "hdf5",
        target_format: str = "lerobot",
        # transfer mode
        ssh_host: str = "",
        ssh_port: int = 22,
        ssh_username: str = "",
        ssh_password: str = "",
        remote_target_dir: str = "",
    ):
        if self._state != MonitorState.IDLE:
            raise RuntimeError("监控已在运行中")

        self._mode = mode
        self._source_dir = source_dir
        self._target_dir = target_dir
        self._field_mapping = field_mapping or {}
        self._source_format = source_format
        self._target_format = target_format
        self._ssh_host = ssh_host
        self._ssh_port = ssh_port
        self._ssh_username = ssh_username
        self._ssh_password = ssh_password
        self._remote_target_dir = remote_target_dir
        self._state = MonitorState.MONITORING
        self._logs = []
        self._conversion_items = []
        self._loop = asyncio.get_running_loop()
        self._pending_queue = asyncio.Queue()

        handler = _HDF5EventHandler(self)
        self._observer = PollingObserver(timeout=2)
        self._observer.schedule(handler, str(source_dir), recursive=False)
        self._observer.start()

        self._convert_task = asyncio.create_task(self._worker())

        dest_desc = (
            str(target_dir) if mode == "convert"
            else f"{ssh_host}:{remote_target_dir}"
        )
        self._emit({
            "type": "info",
            "message": f"开始监控: {source_dir}  →  {dest_desc}",
            "state": MonitorState.MONITORING,
            "is_converting": False,
            "queue": [],
        })

    async def stop(self):
        if self._is_converting:
            raise RuntimeError("正在处理中，请等待当前任务完成后再停止")
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
        self._emit_with_queue("info", "监控已停止")

    # ── Internal ──────────────────────────────────────────────────────────────

    def _is_active(self, path: Path) -> bool:
        active = {'pending', 'waiting', 'converting', 'transferring'}
        return any(it.file_path == str(path) and it.status in active
                   for it in self._conversion_items)

    def _enqueue_file(self, path: Path):
        """Called from watchdog thread."""
        item = ConversionItem(file_path=str(path), file_name=path.name)
        self._conversion_items.append(item)
        if self._loop and self._pending_queue and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(self._pending_queue.put_nowait, path)
        self._emit_with_queue_threadsafe("detected", f"检测到新文件: {path.name}")

    async def _wait_file_stable(
        self, path: Path, item: ConversionItem,
        poll_interval: float = 1.0,
        stable_required: int = 10,
        stall_timeout: float = 300.0,
    ) -> bool:
        """Wait until the file has finished being written.

        Returns True when stable, False on stall timeout.
        """
        prev_size = -1
        stable = 0
        no_growth = 0.0

        while self._state == MonitorState.MONITORING:
            try:
                size = path.stat().st_size
            except OSError:
                no_growth += poll_interval
                if no_growth >= stall_timeout:
                    return False
                await asyncio.sleep(poll_interval)
                continue

            size_mb = size / 1024 / 1024

            if size != prev_size:
                if prev_size >= 0:
                    speed_mb = (size - prev_size) / poll_interval / 1024 / 1024
                    speed_str = f"  {speed_mb:.1f} MB/s" if speed_mb > 0.01 else ""
                else:
                    speed_str = ""
                stable = 0
                no_growth = 0.0
                item.message = f"写入中… {size_mb:.1f} MB{speed_str}"
            else:
                stable += 1
                no_growth += poll_interval
                if size > 0:
                    item.message = f"写入稳定中…（{stable}/{stable_required}）{size_mb:.1f} MB"
                    if stable >= stable_required:
                        return True
                else:
                    item.message = "等待文件写入…"

                if no_growth >= stall_timeout:
                    return False

            prev_size = size
            self._emit_with_queue("progress", "")
            await asyncio.sleep(poll_interval)

        return False

    async def _worker(self):
        """Main worker — routes to convert or transfer based on mode."""
        if self._mode == "convert":
            from app.core.converter.base import get_converter
            from app.core.converter import hdf5_lerobot  # noqa: F401

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

            item = next(
                (it for it in self._conversion_items if it.file_path == str(file_path)), None
            )
            if not item:
                continue

            # Phase 1: wait for write to complete
            item.status = "waiting"
            item.percent = 0.0
            item.message = "等待文件写入完成…"
            self._emit_with_queue("info", f"等待文件就绪: {file_path.name}")

            stable = await self._wait_file_stable(file_path, item)
            if not stable:
                item.status = "failed"
                item.message = "超时：文件长时间未变化，可能传输已中断"
                self._emit_with_queue("error", f"等待超时: {file_path.name}")
                continue

            # Phase 2: process (convert or transfer)
            self._is_converting = True
            try:
                if self._mode == "transfer":
                    await self._do_transfer(file_path, item, loop)
                else:
                    await self._do_convert(file_path, item, loop)
            except asyncio.CancelledError:
                item.status = "failed"
                item.message = "已取消"
                self._emit_with_queue("warning", f"已取消: {file_path.name}")
                break
            finally:
                self._is_converting = False

    async def _do_convert(self, file_path: Path, item: ConversionItem, loop: asyncio.AbstractEventLoop):
        from app.core.converter.base import get_converter

        item.status = "converting"
        item.percent = 0.0
        item.message = "准备中..."
        self._emit_with_queue("converting", f"开始转换: {file_path.name}")

        try:
            converter = get_converter(self._source_format, self._target_format)

            mapping = self._field_mapping
            if not mapping:
                preview = await loop.run_in_executor(None, converter.preview, file_path)
                mapping = preview.get("suggested_mapping", {})
                item.message = "自动检测字段映射"
                self._emit_with_queue("info", f"自动检测字段映射: {list(mapping.values())}")

            def _progress_cb(done: int, total: int, msg: str):
                item.percent = round(done / total * 100, 1) if total else 0
                item.message = msg
                self._emit_with_queue_threadsafe("progress", msg)

            dst = self._target_dir
            fm = mapping
            await loop.run_in_executor(
                None,
                lambda fp=file_path, d=dst, m=fm: converter.convert(fp, d, m, True, _progress_cb),
            )

            item.status = "done"
            item.percent = 100.0
            item.message = "转换完成"
            self._emit_with_queue("done", f"转换完成: {file_path.name}")

        except Exception as exc:
            item.status = "failed"
            item.message = str(exc)
            self._emit_with_queue("error", f"转换失败 {file_path.name}: {exc}")

    async def _do_transfer(self, file_path: Path, item: ConversionItem, loop: asyncio.AbstractEventLoop):
        from app.core.ssh_transfer import SSHTransfer

        item.status = "transferring"
        item.percent = 0.0
        item.message = "连接远程服务器…"
        self._emit_with_queue("info", f"开始传输: {file_path.name}")

        remote_path = f"{self._remote_target_dir.rstrip('/')}/{file_path.name}"

        def _upload():
            def _progress(_, transferred: int, total: int):
                item.percent = transferred / total * 100 if total else 0
                item.message = f"{item.percent:.1f}%  ({transferred / 1048576:.1f} / {total / 1048576:.1f} MB)"
                self._emit_with_queue_threadsafe("progress", item.message)

            with SSHTransfer(self._ssh_host, self._ssh_port, self._ssh_username, self._ssh_password) as t:
                t.upload(file_path, remote_path, _progress)

        try:
            await loop.run_in_executor(None, _upload)
            item.status = "done"
            item.percent = 100.0
            item.message = "传输完成"
            self._emit_with_queue("done", f"传输完成: {file_path.name}")
        except Exception as exc:
            item.status = "failed"
            item.message = str(exc)
            self._emit_with_queue("error", f"传输失败 {file_path.name}: {exc}")


class _HDF5EventHandler(FileSystemEventHandler):
    def __init__(self, service: MonitorService):
        self._service = service

    def _handle(self, path: Path):
        if path.suffix.lower() in {".hdf5", ".h5"} and not self._service._is_active(path):
            self._service._enqueue_file(path)

    def on_created(self, event):
        if not event.is_directory:
            self._handle(Path(event.src_path))

    def on_moved(self, event):
        if not event.is_directory:
            self._handle(Path(event.dest_path))


monitor_service = MonitorService()
