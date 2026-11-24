"""Private local storage adapter with UUID keys, traversal guards, and atomic commit."""

from __future__ import annotations

import hashlib
import os
import re
import tempfile
import time
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_CHUNK_SIZE = 65536


@dataclass(frozen=True, slots=True)
class StagedFile:
    """Metadata returned for a file written to staging."""

    staging_key: str
    sha256: str
    size_bytes: int


@dataclass(frozen=True, slots=True)
class StoredObject:
    """Metadata returned for an immutable committed object."""

    storage_key: str
    sha256: str
    size_bytes: int


class LocalStorageAdapter:
    """UUID-addressed local storage isolating staging writes from committed objects."""

    def __init__(self, root_dir: Path | str) -> None:
        self.root_dir = Path(root_dir).resolve(strict=False)

    def _checked_subdir(self, name: str) -> Path:
        candidate = self.root_dir / name
        if candidate.is_symlink():
            raise ValueError(f"Storage subdirectory '{name}' must not be a symlink")
        resolved = candidate.resolve(strict=False)
        if not resolved.is_relative_to(self.root_dir):
            raise ValueError(f"Storage subdirectory '{name}' escapes root_dir")
        return resolved

    @property
    def staging_root(self) -> Path:
        return self._checked_subdir("staging")

    @property
    def objects_root(self) -> Path:
        return self._checked_subdir("objects")

    @staticmethod
    def _chmod_dir(path: Path) -> None:
        if os.name != "nt":
            os.chmod(path, 0o700)

    @staticmethod
    def _chmod_file(path: Path) -> None:
        if os.name != "nt":
            os.chmod(path, 0o600)

    @staticmethod
    def _validate_uuid_key(key: str | uuid.UUID) -> str:
        raw = str(key) if isinstance(key, uuid.UUID) else key
        if not isinstance(raw, str):
            raise ValueError("Storage key must be a UUID string")
        if "\x00" in raw or "/" in raw or "\\" in raw or ".." in raw:
            raise ValueError("Invalid characters in storage key")
        if not _UUID_RE.fullmatch(raw):
            raise ValueError("Storage key must be a canonical UUID")
        return str(uuid.UUID(raw))

    def _resolve_under(self, base_dir: Path, key: str | uuid.UUID) -> tuple[str, Path]:
        validated = self._validate_uuid_key(key)
        resolved_base = base_dir.resolve(strict=False)
        if not resolved_base.is_relative_to(self.root_dir):
            raise ValueError("Storage subdirectory escapes root_dir")

        candidate = resolved_base / validated
        if candidate.is_symlink():
            raise ValueError("Symlinks are forbidden in storage paths")

        resolved_target = candidate.resolve(strict=False)
        if not resolved_target.is_relative_to(resolved_base) or not resolved_target.is_relative_to(
            self.root_dir
        ):
            raise ValueError("Resolved path escapes storage root")
        return validated, resolved_target

    def _ensure_layout(self) -> None:
        staging = self.staging_root
        objects = self.objects_root
        self.root_dir.mkdir(parents=True, exist_ok=True)
        staging.mkdir(parents=True, exist_ok=True)
        objects.mkdir(parents=True, exist_ok=True)
        self._chmod_dir(self.root_dir)
        self._chmod_dir(staging)
        self._chmod_dir(objects)

    @staticmethod
    def _iter_chunks(
        data: bytes | bytearray | memoryview | BinaryIO | Iterable[bytes],
    ) -> Iterable[bytes]:
        if isinstance(data, (bytes, bytearray, memoryview)):
            view = bytes(data)
            if view:
                yield view
            return
        read_fn = getattr(data, "read", None)
        if callable(read_fn):
            while True:
                chunk = read_fn(_CHUNK_SIZE)
                if not chunk:
                    break
                if not isinstance(chunk, (bytes, bytearray, memoryview)):
                    raise TypeError("Stream read() must return bytes")
                yield bytes(chunk)
            return
        for chunk in data:
            if not isinstance(chunk, (bytes, bytearray, memoryview)):
                raise TypeError("Chunk iterable must yield bytes")
            if chunk:
                yield bytes(chunk)

    def put_temp(
        self,
        data: bytes | bytearray | memoryview | BinaryIO | Iterable[bytes],
        *,
        staging_key: str | None = None,
    ) -> StagedFile:
        """Write payload to a staging file, returning its UUID key, SHA-256, and byte size."""
        key_input = staging_key if staging_key is not None else str(uuid.uuid4())
        validated_key, target_path = self._resolve_under(self.staging_root, key_input)
        self._ensure_layout()

        digest = hashlib.sha256()
        total_bytes = 0
        try:
            with open(target_path, "wb") as handle:
                for chunk in self._iter_chunks(data):
                    handle.write(chunk)
                    digest.update(chunk)
                    total_bytes += len(chunk)
                handle.flush()
                os.fsync(handle.fileno())
            self._chmod_file(target_path)
        except Exception:
            if target_path.exists():
                target_path.unlink(missing_ok=True)
            raise

        return StagedFile(
            staging_key=validated_key,
            sha256=digest.hexdigest(),
            size_bytes=total_bytes,
        )

    def commit(self, staging_key: str, *, target_key: str | None = None) -> StoredObject:
        """Atomically promote a staged file to an immutable committed object."""
        _, src_path = self._resolve_under(self.staging_root, staging_key)
        dest_input = target_key if target_key is not None else str(uuid.uuid4())
        validated_target, dst_path = self._resolve_under(self.objects_root, dest_input)

        self._ensure_layout()

        if not src_path.is_file():
            raise FileNotFoundError("Staged file does not exist")
        if dst_path.exists():
            raise FileExistsError("Target storage object already exists")

        digest = hashlib.sha256()
        total_bytes = 0
        with open(src_path, "rb") as handle:
            while True:
                chunk = handle.read(_CHUNK_SIZE)
                if not chunk:
                    break
                digest.update(chunk)
                total_bytes += len(chunk)

        os.replace(src_path, dst_path)
        os.utime(dst_path, None)
        self._chmod_file(dst_path)
        return StoredObject(
            storage_key=validated_target,
            sha256=digest.hexdigest(),
            size_bytes=total_bytes,
        )

    def open(self, storage_key: str, mode: str = "rb") -> BinaryIO:
        """Open a committed storage object in read-only binary mode."""
        if mode != "rb":
            raise ValueError("Committed storage objects can only be opened in 'rb' mode")
        _, target_path = self._resolve_under(self.objects_root, storage_key)
        if not target_path.is_file():
            raise FileNotFoundError("Storage object not found")
        return open(target_path, "rb")

    def delete(self, storage_key: str) -> bool:
        """Idempotently delete a committed storage object."""
        _, target_path = self._resolve_under(self.objects_root, storage_key)
        if not target_path.exists():
            return False
        if not target_path.is_file():
            raise ValueError("Target storage path is not a regular file")
        target_path.unlink()
        return True

    def cleanup_orphans(
        self,
        max_age_seconds: int = 86400,
        *,
        now: float | None = None,
    ) -> int:
        """Delete staged files older than `max_age_seconds` inside staging_root."""
        if max_age_seconds < 0:
            raise ValueError("max_age_seconds must be non-negative")
        if not self.staging_root.is_dir():
            return 0

        cutoff = (now if now is not None else time.time()) - max_age_seconds
        removed = 0
        for entry in self.staging_root.iterdir():
            if entry.is_symlink() or not entry.is_file():
                continue
            resolved = entry.resolve(strict=False)
            if not resolved.is_relative_to(self.staging_root):
                continue
            if resolved.stat().st_mtime < cutoff:
                resolved.unlink(missing_ok=True)
                removed += 1
        return removed

    def iter_object_keys_older_than(
        self,
        max_age_seconds: int = 86400,
        *,
        now: float | None = None,
    ) -> list[str]:
        """List committed object UUID keys in objects_root older than `max_age_seconds`."""
        if max_age_seconds < 0:
            raise ValueError("max_age_seconds must be non-negative")
        if not self.objects_root.is_dir():
            return []

        cutoff = (now if now is not None else time.time()) - max_age_seconds
        keys: list[str] = []
        for entry in self.objects_root.iterdir():
            if entry.is_symlink() or not entry.is_file():
                continue
            resolved = entry.resolve(strict=False)
            if not resolved.is_relative_to(self.objects_root):
                continue
            try:
                validated = self._validate_uuid_key(entry.name)
            except ValueError:
                continue
            if resolved.stat().st_mtime < cutoff:
                keys.append(validated)
        return keys

    def is_writable(self) -> bool:
        """Verify storage root exists as a directory and permits creating/deleting files."""
        probe_path: Path | None = None
        try:
            if self.root_dir.exists() and not self.root_dir.is_dir():
                return False
            self.root_dir.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                dir=self.root_dir,
                prefix=".health-probe-",
                delete=False,
            ) as tmp:
                probe_path = Path(tmp.name)
                tmp.write(b"ok")
                tmp.flush()
            probe_path.unlink(missing_ok=True)
            return True
        except OSError:
            if probe_path is not None:
                probe_path.unlink(missing_ok=True)
            return False
