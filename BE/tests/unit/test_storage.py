"""Unit tests for LocalStorageAdapter safety, atomic commits, and cleanup."""

from __future__ import annotations

import hashlib
import io
import os
import time
import uuid
from pathlib import Path

import pytest

from app.core.storage import LocalStorageAdapter


def test_put_temp_commit_open_delete_roundtrip(tmp_path: Path) -> None:
    adapter = LocalStorageAdapter(tmp_path / "storage")
    payload = b"NIfTI-mock-binary-payload-123456"
    expected_sha = hashlib.sha256(payload).hexdigest()

    staged = adapter.put_temp(io.BytesIO(payload))
    assert staged.size_bytes == len(payload)
    assert staged.sha256 == expected_sha
    assert (adapter.staging_root / staged.staging_key).is_file()

    stored = adapter.commit(staged.staging_key)
    assert str(uuid.UUID(stored.storage_key)) == stored.storage_key
    assert stored.size_bytes == len(payload)
    assert stored.sha256 == expected_sha
    assert not (adapter.staging_root / staged.staging_key).exists()
    assert (adapter.objects_root / stored.storage_key).is_file()

    with adapter.open(stored.storage_key) as handle:
        assert handle.read() == payload

    # Immutable objects cannot be overwritten via commit
    staged_two = adapter.put_temp(b"different-bytes")
    with pytest.raises(FileExistsError):
        adapter.commit(staged_two.staging_key, target_key=stored.storage_key)

    assert adapter.delete(stored.storage_key) is True
    assert adapter.delete(stored.storage_key) is False
    with pytest.raises(FileNotFoundError):
        adapter.open(stored.storage_key)


def test_rejects_path_traversal_and_invalid_keys(tmp_path: Path) -> None:
    adapter = LocalStorageAdapter(tmp_path / "storage")
    valid_uuid = str(uuid.uuid4())

    bad_keys = [
        "../secret",
        "../../etc/passwd",
        f"sub/{valid_uuid}",
        f"sub\\{valid_uuid}",
        "not-a-uuid",
        f"{valid_uuid}\x00.nii",
        "",
    ]

    for bad in bad_keys:
        with pytest.raises(ValueError):
            adapter.put_temp(b"abc", staging_key=bad)
        with pytest.raises(ValueError):
            adapter.commit(bad)
        with pytest.raises(ValueError):
            adapter.commit(valid_uuid, target_key=bad)
        with pytest.raises(ValueError):
            adapter.open(bad)
        with pytest.raises(ValueError):
            adapter.delete(bad)


def test_open_rejects_write_modes(tmp_path: Path) -> None:
    adapter = LocalStorageAdapter(tmp_path / "storage")
    staged = adapter.put_temp(b"immutable")
    stored = adapter.commit(staged.staging_key)

    for bad_mode in ("wb", "ab", "r+b", "w"):
        with pytest.raises(ValueError):
            adapter.open(stored.storage_key, mode=bad_mode)


def test_cleanup_orphans_removes_only_expired_staging_files(tmp_path: Path) -> None:
    adapter = LocalStorageAdapter(tmp_path / "storage")
    old_staged = adapter.put_temp(b"old-orphan")
    fresh_staged = adapter.put_temp(b"fresh-staging")

    committed_staged = adapter.put_temp(b"committed-data")
    stored = adapter.commit(committed_staged.staging_key)

    now = time.time()
    old_path = adapter.staging_root / old_staged.staging_key
    os.utime(old_path, (now - 7200, now - 7200))

    removed = adapter.cleanup_orphans(max_age_seconds=3600, now=now)
    assert removed == 1
    assert not old_path.exists()
    assert (adapter.staging_root / fresh_staged.staging_key).is_file()
    assert (adapter.objects_root / stored.storage_key).is_file()


def test_is_writable_detects_writable_and_blocked_paths(tmp_path: Path) -> None:
    writable_adapter = LocalStorageAdapter(tmp_path / "writable_storage")
    assert writable_adapter.is_writable() is True

    blocking_file = tmp_path / "file_not_dir"
    blocking_file.write_text("x", encoding="utf-8")
    blocked_adapter = LocalStorageAdapter(blocking_file)
    assert blocked_adapter.is_writable() is False


def test_rejects_symlinked_staging_or_objects_subdirs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "sym_storage"
    root.mkdir()
    adapter = LocalStorageAdapter(root)

    orig_is_symlink = Path.is_symlink

    def _fake_is_symlink(self: Path) -> bool:
        if self.parent == adapter.root_dir and self.name in {"staging", "objects"}:
            return True
        return orig_is_symlink(self)

    monkeypatch.setattr(Path, "is_symlink", _fake_is_symlink)

    with pytest.raises(ValueError, match="symlink"):
        _ = adapter.staging_root
    with pytest.raises(ValueError, match="symlink"):
        _ = adapter.objects_root


def test_commit_refreshes_mtime_to_prevent_premature_orphan_sweep(tmp_path: Path) -> None:
    adapter = LocalStorageAdapter(tmp_path / "storage")
    staged = adapter.put_temp(b"slow-staged-upload")
    staged_path = adapter.staging_root / staged.staging_key

    now = time.time()
    aged_ts = now - 7200
    os.utime(staged_path, (aged_ts, aged_ts))

    stored = adapter.commit(staged.staging_key)
    committed_path = adapter.objects_root / stored.storage_key
    assert committed_path.stat().st_mtime >= now - 5
    assert adapter.iter_object_keys_older_than(max_age_seconds=3600, now=now) == []


def test_get_referenced_storage_keys_batches_over_1000_parameters() -> None:
    from unittest.mock import MagicMock

    from app.repositories.file_repo import FileRepository

    candidates = [uuid.uuid4() for _ in range(2505)]
    expected_present = {candidates[0], candidates[1000], candidates[2504]}

    call_count = 0
    mock_db = MagicMock()

    def _fake_scalars(_stmt: object) -> MagicMock:
        nonlocal call_count
        idx = call_count
        call_count += 1
        batch = candidates[idx * 1000 : (idx + 1) * 1000]
        assert len(batch) <= 1000
        res = MagicMock()
        res.all.return_value = [k for k in batch if k in expected_present]
        return res

    mock_db.scalars.side_effect = _fake_scalars
    repo = FileRepository(mock_db)
    found = repo.get_referenced_storage_keys(candidates)
    assert call_count == 3
    assert found == expected_present
