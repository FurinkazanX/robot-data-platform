import hashlib
import os
import stat
from pathlib import Path
from typing import List, Optional

from app.core.ssh_transfer import SSHTransfer

CACHE_DIR = Path("/tmp/robot_viz_cache")
_CACHE_DIR = CACHE_DIR  # backward compat
_MAX_BYTES = int(os.environ.get("VIZ_CACHE_GB", "5")) * 1024 ** 3

_CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _cache_path(host: str, port: int, remote_path: str) -> Path:
    key = hashlib.sha1(f"{host}:{port}:{remote_path}".encode()).hexdigest()
    return _CACHE_DIR / (key + Path(remote_path).suffix)


def _evict() -> None:
    files = list(_CACHE_DIR.glob("*"))
    if not files:
        return
    files.sort(key=lambda f: f.stat().st_atime)
    total = sum(f.stat().st_size for f in files)
    while total > _MAX_BYTES and files:
        f = files.pop(0)
        total -= f.stat().st_size
        try:
            f.unlink()
        except OSError:
            pass


class RemoteSession:
    """Single SSH connection reused for all operations in one request."""

    def __init__(self, host: str, port: int, username: str, password: str = ""):
        self._host = host
        self._port = port
        self._t = SSHTransfer(host, port, username, password or None)
        self._t.connect()

    # ── SFTP helpers ──────────────────────────────────────────────────────────

    def read_text(self, remote_path: str) -> str:
        assert self._t._sftp
        with self._t._sftp.open(remote_path) as f:
            return f.read().decode("utf-8")

    def list_dirs(self, remote_path: str) -> Optional[List[str]]:
        assert self._t._sftp
        try:
            entries = self._t._sftp.listdir_attr(remote_path)
            return sorted(e.filename for e in entries if stat.S_ISDIR(e.st_mode or 0))
        except (FileNotFoundError, IOError):
            return None

    def stat_exists(self, remote_path: str) -> bool:
        assert self._t._sftp
        try:
            self._t._sftp.stat(remote_path)
            return True
        except (FileNotFoundError, IOError):
            return False

    def fetch(self, remote_path: str) -> Path:
        """Download remote file to local cache and return local path."""
        local = _cache_path(self._host, self._port, remote_path)
        if local.exists():
            local.touch()  # refresh atime for LRU
            return local
        _evict()
        assert self._t._sftp
        self._t._sftp.get(remote_path, str(local))
        return local

    # ── Context manager ───────────────────────────────────────────────────────

    def close(self) -> None:
        self._t.disconnect()

    def __enter__(self) -> "RemoteSession":
        return self

    def __exit__(self, *_) -> None:
        self.close()
