import os
import stat
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import paramiko


class SSHTransfer:
    def __init__(self, host: str, port: int, username: str, password: Optional[str] = None, key_path: Optional[str] = None):
        self.host = host
        self.port = port
        self.username = username
        self.password = password
        self.key_path = key_path
        self._client: Optional[paramiko.SSHClient] = None
        self._sftp: Optional[paramiko.SFTPClient] = None

    def connect(self):
        client = paramiko.SSHClient()
        client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        kwargs: Dict[str, Any] = {
            "hostname": self.host,
            "port": self.port,
            "username": self.username,
            "timeout": 10,
        }
        if self.key_path:
            kwargs["key_filename"] = self.key_path
        else:
            kwargs["password"] = self.password
        client.connect(**kwargs)
        self._client = client
        self._sftp = client.open_sftp()

    def disconnect(self):
        if self._sftp:
            self._sftp.close()
        if self._client:
            self._client.close()

    def __enter__(self):
        self.connect()
        return self

    def __exit__(self, *args):
        self.disconnect()

    def list_remote(self, path: str) -> List[Dict[str, Any]]:
        assert self._sftp
        items = []
        for attr in self._sftp.listdir_attr(path):
            is_dir = stat.S_ISDIR(attr.st_mode or 0)
            items.append({
                "name": attr.filename,
                "path": f"{path.rstrip('/')}/{attr.filename}",
                "is_dir": is_dir,
                "size": attr.st_size if not is_dir else None,
                "mtime": attr.st_mtime,
            })
        return sorted(items, key=lambda x: (not x["is_dir"], x["name"]))

    def mkdir(self, remote_path: str):
        assert self._sftp
        self._sftp.mkdir(remote_path)

    def rename(self, old_path: str, new_path: str):
        assert self._sftp
        self._sftp.rename(old_path, new_path)

    def delete(self, remote_path: str):
        assert self._sftp
        try:
            mode = self._sftp.stat(remote_path).st_mode or 0
            if stat.S_ISDIR(mode):
                self._rmdir_recursive(remote_path)
            else:
                self._sftp.remove(remote_path)
        except FileNotFoundError:
            raise FileNotFoundError(f"Remote path not found: {remote_path}")

    def _rmdir_recursive(self, remote_path: str):
        assert self._sftp
        for attr in self._sftp.listdir_attr(remote_path):
            child = f"{remote_path}/{attr.filename}"
            if stat.S_ISDIR(attr.st_mode or 0):
                self._rmdir_recursive(child)
            else:
                self._sftp.remove(child)
        self._sftp.rmdir(remote_path)

    def upload(
        self,
        local_path: Path,
        remote_path: str,
        progress_cb: Optional[Callable[[str, int, int], None]] = None,
    ):
        assert self._sftp
        if local_path.is_dir():
            self._upload_dir(local_path, remote_path, progress_cb)
        else:
            self._upload_file(local_path, remote_path, progress_cb)

    def _ensure_remote_dir(self, remote_path: str):
        assert self._sftp
        parts = remote_path.split("/")
        current = ""
        for part in parts:
            if not part:
                current = "/"
                continue
            current = f"{current}/{part}" if current != "/" else f"/{part}"
            try:
                self._sftp.stat(current)
            except FileNotFoundError:
                self._sftp.mkdir(current)

    def _upload_file(self, local_path: Path, remote_path: str, progress_cb=None):
        assert self._sftp

        def _callback(transferred: int, total: int):
            if progress_cb:
                progress_cb(str(local_path), transferred, total)

        self._sftp.put(str(local_path), remote_path, callback=_callback)

    def _upload_dir(self, local_dir: Path, remote_dir: str, progress_cb=None):
        self._ensure_remote_dir(remote_dir)
        for entry in local_dir.iterdir():
            remote_entry = f"{remote_dir.rstrip('/')}/{entry.name}"
            if entry.is_dir():
                self._upload_dir(entry, remote_entry, progress_cb)
            else:
                self._upload_file(entry, remote_entry, progress_cb)
