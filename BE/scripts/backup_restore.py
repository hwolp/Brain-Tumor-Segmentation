"""Consistent PostgreSQL + local storage backup, isolated restore, and integrity CLI."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

_BE_DIR = Path(__file__).resolve().parents[1]
if str(_BE_DIR) not in sys.path:
    sys.path.insert(0, str(_BE_DIR))

import psycopg  # noqa: E402
from psycopg import sql  # noqa: E402
from sqlalchemy import create_engine, func, select, text, update  # noqa: E402
from sqlalchemy.engine import URL, make_url  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.core.config import Settings  # noqa: E402
from app.core.storage import LocalStorageAdapter  # noqa: E402
from app.models.case import Case  # noqa: E402
from app.models.inference_job import InferenceJob  # noqa: E402
from app.models.mask_version import MaskVersion  # noqa: E402
from app.models.patient import Patient  # noqa: E402
from app.models.session import RefreshToken  # noqa: E402
from app.models.session import Session as AuthSession  # noqa: E402
from app.models.stored_file import StoredFile  # noqa: E402
from app.models.user import User  # noqa: E402
from app.models.volume import Volume  # noqa: E402

DEFAULT_DOCKER_CONTAINER = "braintumorsegmentation-postgres-1"
_CHUNK_SIZE = 65536
_PROTECTED_DB_NAMES = frozenset(
    {"bts_dev", "postgres", "template0", "template1", "bts", "dev", "prod", "production"}
)
_PROTECTED_DB_SUFFIXES = ("_dev", "_prod", "_production", "-dev", "-prod")
_HARMLESS_PG_RESTORE_PATTERNS = (
    re.compile(r'schema "public" already exists', re.IGNORECASE),
    re.compile(r"must be owner of schema public", re.IGNORECASE),
    re.compile(r"must be owner of extension", re.IGNORECASE),
)


def _parse_pg_url(database_url: str) -> URL:
    if not database_url or not database_url.strip():
        raise ValueError("Database URL must not be empty")
    url = make_url(database_url.strip())
    if not url.drivername.startswith("postgresql"):
        raise ValueError(f"Unsupported database scheme '{url.drivername}'; expected PostgreSQL")
    if not url.database:
        raise ValueError("Database name is missing from PostgreSQL URL")
    return url


def _assert_safe_restore_target(url: URL) -> str:
    db_name = (url.database or "").strip()
    lowered = db_name.lower()
    if (
        not lowered
        or "/" in db_name
        or lowered in _PROTECTED_DB_NAMES
        or lowered.endswith(_PROTECTED_DB_SUFFIXES)
    ):
        raise ValueError(
            f"Refusing destructive restore against protected or invalid database '{db_name}'"
        )
    return db_name


def _ensure_safe_dir(path: Path, *, create: bool) -> Path:
    if path.is_symlink():
        raise ValueError(f"Directory path must not be a symlink: {path}")
    resolved = path.resolve(strict=not create)
    if resolved.exists() and not resolved.is_dir():
        raise ValueError(f"Expected a directory path, got file: {resolved}")
    if create:
        resolved.mkdir(parents=True, exist_ok=True)
        if os.name != "nt":
            os.chmod(resolved, 0o700)
    return resolved


def _resolve_flat_object(objects_root: Path, key: str | uuid.UUID) -> tuple[str, Path]:
    if objects_root.is_symlink():
        raise ValueError("Storage objects directory must not be a symlink")
    resolved_root = objects_root.resolve(strict=False)
    validated_key = LocalStorageAdapter._validate_uuid_key(key)
    candidate = resolved_root / validated_key
    if candidate.is_symlink():
        raise ValueError(f"Storage object must not be a symlink: {validated_key}")
    resolved_target = candidate.resolve(strict=False)
    if not resolved_target.is_relative_to(resolved_root):
        raise ValueError(f"Storage object path escapes objects root: {validated_key}")
    return validated_key, resolved_target


def _sha256_and_size(file_path: Path) -> tuple[str, int]:
    if file_path.is_symlink():
        raise ValueError(f"File must not be a symlink: {file_path}")
    if not file_path.is_file():
        raise ValueError(f"Required file does not exist: {file_path}")
    digest = hashlib.sha256()
    total = 0
    with file_path.open("rb") as handle:
        while True:
            chunk = handle.read(_CHUNK_SIZE)
            if not chunk:
                break
            digest.update(chunk)
            total += len(chunk)
    return digest.hexdigest(), total


def _copy_verified_object(
    src: Path,
    dst: Path,
    *,
    expected_sha256: str | None = None,
    expected_size: int | None = None,
) -> tuple[str, int]:
    if src.is_symlink() or not src.is_file():
        raise ValueError(f"Source object missing or invalid: {src}")
    if dst.is_symlink():
        raise ValueError(f"Destination path must not be a symlink: {dst}")

    tmp_dst = dst.parent / f".tmp-{uuid.uuid4().hex}"
    digest = hashlib.sha256()
    total = 0
    try:
        with src.open("rb") as reader, tmp_dst.open("wb") as writer:
            while True:
                chunk = reader.read(_CHUNK_SIZE)
                if not chunk:
                    break
                writer.write(chunk)
                digest.update(chunk)
                total += len(chunk)
            writer.flush()
            os.fsync(writer.fileno())

        actual_sha = digest.hexdigest()
        if expected_size is not None and total != expected_size:
            raise ValueError(
                f"Size mismatch for {src.name}: expected {expected_size} bytes, got {total}"
            )
        if expected_sha256 is not None and actual_sha != expected_sha256.lower():
            raise ValueError(
                f"SHA-256 mismatch for {src.name}: expected {expected_sha256}, got {actual_sha}"
            )

        os.replace(tmp_dst, dst)
        if os.name != "nt":
            os.chmod(dst, 0o600)
        return actual_sha, total
    except Exception:
        tmp_dst.unlink(missing_ok=True)
        raise


def _run_pg_dump(url: URL, dump_path: Path, docker_container: str) -> tuple[str, int]:
    user = url.username or "postgres"
    password = url.password or ""
    host = url.host or "127.0.0.1"
    port = str(url.port or 5432)
    db_name = url.database or ""

    pg_dump_bin = shutil.which("pg_dump")
    env: dict[str, str] | None = None
    if pg_dump_bin is not None:
        env = os.environ.copy()
        if password:
            env["PGPASSWORD"] = password
        cmd = [
            pg_dump_bin,
            "--format=custom",
            "-h",
            host,
            "-p",
            port,
            "-U",
            user,
            "-d",
            db_name,
        ]
    else:
        docker_bin = shutil.which("docker")
        if docker_bin is None:
            raise RuntimeError("Neither 'pg_dump' nor 'docker' executable is available on PATH")
        cmd = [
            docker_bin,
            "exec",
            "-i",
            "-e",
            f"PGPASSWORD={password}",
            docker_container,
            "pg_dump",
            "--format=custom",
            "-h",
            "127.0.0.1",
            "-p",
            "5432",
            "-U",
            user,
            "-d",
            db_name,
        ]

    tmp_dump = dump_path.parent / f".tmp-{uuid.uuid4().hex}.dump"
    try:
        with tmp_dump.open("wb") as dump_file:
            proc = subprocess.run(
                cmd,
                stdout=dump_file,
                stderr=subprocess.PIPE,
                env=env,
                check=False,
            )
        if proc.returncode != 0:
            err_msg = proc.stderr.decode("utf-8", errors="replace").strip()
            raise RuntimeError(f"pg_dump failed with exit code {proc.returncode}: {err_msg}")
        with tmp_dump.open("rb") as probe:
            magic = probe.read(5)
        if magic != b"PGDMP":
            raise RuntimeError("pg_dump output does not have a valid custom-format PGDMP header")
        os.replace(tmp_dump, dump_path)
        if os.name != "nt":
            os.chmod(dump_path, 0o600)
    except Exception:
        tmp_dump.unlink(missing_ok=True)
        raise

    return _sha256_and_size(dump_path)


def _is_harmless_pg_restore_stderr(stderr_text: str) -> bool:
    error_lines = [
        line.strip()
        for line in stderr_text.splitlines()
        if "error:" in line.lower() and "errors ignored on restore" not in line.lower()
    ]
    if not error_lines:
        return False
    return all(
        any(pattern.search(line) for pattern in _HARMLESS_PG_RESTORE_PATTERNS)
        for line in error_lines
    )


def _run_pg_restore(url: URL, dump_path: Path, docker_container: str) -> None:
    user = url.username or "postgres"
    password = url.password or ""
    host = url.host or "127.0.0.1"
    port = str(url.port or 5432)
    db_name = url.database or ""

    pg_restore_bin = shutil.which("pg_restore")
    env: dict[str, str] | None = None
    if pg_restore_bin is not None:
        env = os.environ.copy()
        if password:
            env["PGPASSWORD"] = password
        cmd = [
            pg_restore_bin,
            "--clean",
            "--if-exists",
            "--no-owner",
            "--no-privileges",
            "-h",
            host,
            "-p",
            port,
            "-U",
            user,
            "-d",
            db_name,
        ]
    else:
        docker_bin = shutil.which("docker")
        if docker_bin is None:
            raise RuntimeError("Neither 'pg_restore' nor 'docker' executable is available on PATH")
        cmd = [
            docker_bin,
            "exec",
            "-i",
            "-e",
            f"PGPASSWORD={password}",
            docker_container,
            "pg_restore",
            "--clean",
            "--if-exists",
            "--no-owner",
            "--no-privileges",
            "-h",
            "127.0.0.1",
            "-p",
            "5432",
            "-U",
            user,
            "-d",
            db_name,
        ]

    with dump_path.open("rb") as dump_file:
        proc = subprocess.run(
            cmd,
            stdin=dump_file,
            capture_output=True,
            env=env,
            check=False,
        )

    if proc.returncode != 0:
        err_text = proc.stderr.decode("utf-8", errors="replace").strip()
        if proc.returncode == 1 and _is_harmless_pg_restore_stderr(err_text):
            return
        raise RuntimeError(f"pg_restore failed with exit code {proc.returncode}: {err_text}")


def _recreate_target_database(url: URL) -> None:
    db_name = _assert_safe_restore_target(url)
    maint_dsn = url.set(drivername="postgresql", database="postgres").render_as_string(
        hide_password=False
    )
    with psycopg.connect(maint_dsn, autocommit=True, connect_timeout=5) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname = %s AND pid <> pg_backend_pid()",
                (db_name,),
            )
            cur.execute(sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(db_name)))
            cur.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(db_name)))


def run_backup(
    *,
    database_url: str,
    storage_root: Path | str,
    output_dir: Path | str,
    docker_container: str = DEFAULT_DOCKER_CONTAINER,
    force: bool = False,
) -> dict[str, Any]:
    """Create a consistent PostgreSQL custom dump and verified flat-object backup snapshot."""
    url = _parse_pg_url(database_url)
    storage_path = Path(storage_root)
    if storage_path.is_symlink():
        raise ValueError("storage_root must not be a symlink")
    adapter = LocalStorageAdapter(storage_path)

    resolved_output = _ensure_safe_dir(Path(output_dir), create=True)
    backup_objects_root = _ensure_safe_dir(resolved_output / "objects", create=True)
    if not backup_objects_root.is_relative_to(resolved_output):
        raise ValueError("Backup objects directory escapes output_dir")

    engine = create_engine(database_url, hide_parameters=True)
    try:
        with Session(engine) as db:
            running_count = int(
                db.scalar(
                    select(func.count())
                    .select_from(InferenceJob)
                    .where(InferenceJob.state == "running")
                )
                or 0
            )
            if running_count > 0 and not force:
                raise ValueError(
                    f"Refusing backup while {running_count} inference job(s) are running; "
                    "wait for completion or pass force=True."
                )

            pre_committed = {
                sf.id: (sf.storage_key, sf.sha256.lower(), int(sf.size_bytes))
                for sf in db.scalars(
                    select(StoredFile)
                    .where(StoredFile.state == "committed")
                    .order_by(StoredFile.id.asc())
                ).all()
            }
            pre_total_files = int(
                db.scalar(select(func.count()).select_from(StoredFile)) or 0
            )
            db.rollback()
            db.expunge_all()

            dump_path = resolved_output / "database.dump"
            dump_sha256, dump_size_bytes = _run_pg_dump(url, dump_path, docker_container)

            alembic_rev = db.scalar(text("SELECT version_num FROM alembic_version LIMIT 1"))
            counts = {
                "users": int(db.scalar(select(func.count()).select_from(User)) or 0),
                "patients": int(db.scalar(select(func.count()).select_from(Patient)) or 0),
                "cases": int(db.scalar(select(func.count()).select_from(Case)) or 0),
                "volumes": int(db.scalar(select(func.count()).select_from(Volume)) or 0),
                "mask_versions": int(db.scalar(select(func.count()).select_from(MaskVersion)) or 0),
                "inference_jobs": int(
                    db.scalar(select(func.count()).select_from(InferenceJob)) or 0
                ),
            }
            committed_files = list(
                db.scalars(
                    select(StoredFile)
                    .where(StoredFile.state == "committed")
                    .order_by(StoredFile.id.asc())
                ).all()
            )
            post_committed = {
                sf.id: (sf.storage_key, sf.sha256.lower(), int(sf.size_bytes))
                for sf in committed_files
            }
            post_total_files = int(
                db.scalar(select(func.count()).select_from(StoredFile)) or 0
            )
            if pre_committed != post_committed or pre_total_files != post_total_files:
                dump_path.unlink(missing_ok=True)
                raise ValueError(
                    "StoredFile set changed concurrently during pg_dump; "
                    "retry backup when storage writes are quiesced."
                )
            counts["committed_files"] = len(committed_files)

            objects_manifest: dict[str, dict[str, Any]] = {}
            src_objects_root = adapter.objects_root
            for sf in committed_files:
                if sf.storage_key is None:
                    raise ValueError(f"Committed StoredFile {sf.id} is missing storage_key")
                key_str, src_path = _resolve_flat_object(src_objects_root, sf.storage_key)
                _, dst_path = _resolve_flat_object(backup_objects_root, key_str)
                obj_sha, obj_size = _copy_verified_object(
                    src_path,
                    dst_path,
                    expected_sha256=sf.sha256,
                    expected_size=int(sf.size_bytes),
                )
                objects_manifest[key_str] = {
                    "sha256": obj_sha,
                    "size_bytes": obj_size,
                }
    finally:
        engine.dispose()

    manifest: dict[str, Any] = {
        "created_at": datetime.now(UTC).isoformat(),
        "alembic_revision": alembic_rev,
        "database_dump": {
            "filename": "database.dump",
            "sha256": dump_sha256,
            "size_bytes": dump_size_bytes,
        },
        "counts": counts,
        "objects": objects_manifest,
    }
    manifest_path = resolved_output / "backup_manifest.json"
    tmp_manifest = resolved_output / f".tmp-{uuid.uuid4().hex}.json"
    try:
        tmp_manifest.write_text(
            json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        os.replace(tmp_manifest, manifest_path)
    finally:
        tmp_manifest.unlink(missing_ok=True)
    return manifest


def _load_and_verify_backup_dir(
    backup_dir: Path,
) -> tuple[dict[str, Any], Path, dict[str, tuple[Path, str, int]]]:
    resolved_backup = _ensure_safe_dir(backup_dir, create=False)
    manifest_path = resolved_backup / "backup_manifest.json"
    if manifest_path.is_symlink() or not manifest_path.is_file():
        raise ValueError(f"Missing backup_manifest.json in {resolved_backup}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("backup_manifest.json root must be a JSON object")

    dump_meta = manifest.get("database_dump")
    if not isinstance(dump_meta, dict):
        raise ValueError("backup_manifest.json missing database_dump metadata")
    dump_filename = dump_meta.get("filename")
    if dump_filename != "database.dump":
        raise ValueError(f"Invalid database dump filename in manifest: {dump_filename!r}")
    dump_path = resolved_backup / dump_filename
    if not dump_path.resolve(strict=False).is_relative_to(resolved_backup):
        raise ValueError("Database dump path escapes backup directory")
    actual_dump_sha, actual_dump_size = _sha256_and_size(dump_path)
    if actual_dump_size != int(dump_meta["size_bytes"]):
        raise ValueError("database.dump size does not match backup_manifest.json")
    if actual_dump_sha != str(dump_meta["sha256"]).lower():
        raise ValueError("database.dump SHA-256 does not match backup_manifest.json")

    raw_objects = manifest.get("objects")
    if not isinstance(raw_objects, dict):
        raise ValueError("backup_manifest.json missing objects mapping")
    backup_objects_root = _ensure_safe_dir(resolved_backup / "objects", create=False)
    if not backup_objects_root.is_relative_to(resolved_backup):
        raise ValueError("Backup objects directory escapes backup_dir")

    verified_objects: dict[str, tuple[Path, str, int]] = {}
    for key, obj_meta in raw_objects.items():
        if not isinstance(obj_meta, dict):
            raise ValueError(f"Invalid object manifest entry for key {key!r}")
        key_str, obj_path = _resolve_flat_object(backup_objects_root, str(key))
        expected_sha = str(obj_meta["sha256"]).lower()
        expected_size = int(obj_meta["size_bytes"])
        actual_sha, actual_size = _sha256_and_size(obj_path)
        if actual_size != expected_size:
            raise ValueError(f"Backup object size mismatch for {key_str}")
        if actual_sha != expected_sha:
            raise ValueError(f"Backup object SHA-256 mismatch for {key_str}")
        verified_objects[key_str] = (obj_path, expected_sha, expected_size)

    return manifest, dump_path, verified_objects


def _clean_storage_subdir(subdir: Path, root_dir: Path) -> None:
    if subdir.is_symlink():
        raise ValueError(f"Storage subdirectory must not be a symlink: {subdir}")
    resolved_sub = subdir.resolve(strict=False)
    if not resolved_sub.is_relative_to(root_dir):
        raise ValueError(f"Storage subdirectory escapes root_dir: {subdir}")
    if not resolved_sub.is_dir():
        return
    for entry in list(resolved_sub.iterdir()):
        if entry.is_symlink():
            raise ValueError(f"Refusing to remove symlink inside storage directory: {entry}")
        resolved_entry = entry.resolve(strict=False)
        if not resolved_entry.is_relative_to(resolved_sub):
            raise ValueError(f"Path inside storage subdirectory escapes bounds: {entry}")
        if entry.is_dir():
            shutil.rmtree(entry)
        else:
            entry.unlink(missing_ok=True)


def run_restore(
    *,
    backup_dir: Path | str,
    target_database_url: str,
    target_storage_root: Path | str,
    docker_container: str = DEFAULT_DOCKER_CONTAINER,
    create_db: bool = False,
) -> dict[str, Any]:
    """Restore a verified backup into an isolated target DB/storage and revoke all sessions."""
    target_url = _parse_pg_url(target_database_url)
    _assert_safe_restore_target(target_url)

    target_storage_path = Path(target_storage_root)
    if target_storage_path.is_symlink():
        raise ValueError("target_storage_root must not be a symlink")

    _, dump_path, verified_objects = _load_and_verify_backup_dir(Path(backup_dir))

    if create_db:
        _recreate_target_database(target_url)

    _run_pg_restore(target_url, dump_path, docker_container)

    target_adapter = LocalStorageAdapter(target_storage_path)
    target_adapter._ensure_layout()
    _clean_storage_subdir(target_adapter.objects_root, target_adapter.root_dir)
    _clean_storage_subdir(target_adapter.staging_root, target_adapter.root_dir)
    target_objects_root = target_adapter.objects_root
    for key_str, (src_path, expected_sha, expected_size) in verified_objects.items():
        _, dst_path = _resolve_flat_object(target_objects_root, key_str)
        _copy_verified_object(
            src_path,
            dst_path,
            expected_sha256=expected_sha,
            expected_size=expected_size,
        )

    engine = create_engine(target_database_url, hide_parameters=True)
    try:
        now = datetime.now(UTC)
        with Session(engine) as db:
            revoked_sessions = (
                db.execute(
                    update(AuthSession)
                    .where(AuthSession.revoked_at.is_(None))
                    .values(revoked_at=now, revoke_reason="backup_restore")
                ).rowcount
                or 0
            )
            revoked_refresh_tokens = (
                db.execute(
                    update(RefreshToken)
                    .where(RefreshToken.revoked_at.is_(None))
                    .values(revoked_at=now)
                ).rowcount
                or 0
            )
            db.commit()
    finally:
        engine.dispose()

    summary = verify_storage_and_db_integrity(
        database_url=target_database_url,
        storage_root=target_storage_root,
    )
    summary["revoked_sessions"] = int(revoked_sessions)
    summary["revoked_refresh_tokens"] = int(revoked_refresh_tokens)
    return summary


def verify_storage_and_db_integrity(
    *,
    database_url: str,
    storage_root: Path | str,
) -> dict[str, Any]:
    """Read-only check verifying committed files, flat objects, SHA-256, and DB references."""
    _parse_pg_url(database_url)
    storage_path = Path(storage_root)
    if storage_path.is_symlink():
        raise ValueError("storage_root must not be a symlink")
    adapter = LocalStorageAdapter(storage_path)
    objects_root = adapter.objects_root

    engine = create_engine(database_url, hide_parameters=True)
    try:
        with Session(engine) as db:
            alembic_rev = db.scalar(text("SELECT version_num FROM alembic_version LIMIT 1"))
            committed_files = list(
                db.scalars(
                    select(StoredFile).where(StoredFile.state == "committed")
                ).all()
            )
            committed_by_id: dict[uuid.UUID, StoredFile] = {}
            for sf in committed_files:
                if sf.deleted_at is not None:
                    raise ValueError(
                        f"Committed StoredFile {sf.id} unexpectedly has deleted_at set"
                    )
                if sf.storage_key is None:
                    raise ValueError(f"Committed StoredFile {sf.id} has null storage_key")
                key_str, obj_path = _resolve_flat_object(objects_root, sf.storage_key)
                actual_sha, actual_size = _sha256_and_size(obj_path)
                if actual_size != int(sf.size_bytes):
                    raise ValueError(
                        f"Object size mismatch for StoredFile {sf.id} ({key_str}): "
                        f"db={sf.size_bytes}, disk={actual_size}"
                    )
                if actual_sha != sf.sha256.lower():
                    raise ValueError(
                        f"Object SHA-256 mismatch for StoredFile {sf.id} ({key_str})"
                    )
                committed_by_id[sf.id] = sf

            active_volumes = list(
                db.scalars(select(Volume).where(Volume.deleted_at.is_(None))).all()
            )
            for vol in active_volumes:
                sf = committed_by_id.get(vol.file_id)
                if sf is None:
                    raise ValueError(
                        f"Active Volume {vol.id} references non-committed StoredFile {vol.file_id}"
                    )
                if int(sf.size_bytes) != int(vol.size_bytes) or (
                    sf.sha256.lower() != vol.sha256.lower()
                ):
                    raise ValueError(
                        f"Volume {vol.id} metadata disagrees with StoredFile {sf.id}"
                    )

            active_masks = list(
                db.scalars(
                    select(MaskVersion)
                    .join(Case, Case.id == MaskVersion.case_id)
                    .join(Patient, Patient.id == Case.patient_id)
                    .where(
                        Case.deleting_at.is_(None),
                        Case.deleted_at.is_(None),
                        Patient.deleting_at.is_(None),
                        Patient.deleted_at.is_(None),
                    )
                ).all()
            )
            for mv in active_masks:
                sf = committed_by_id.get(mv.file_id)
                if sf is None:
                    raise ValueError(
                        f"MaskVersion {mv.id} references non-committed StoredFile {mv.file_id}"
                    )
                if sf.sha256.lower() != mv.sha256.lower():
                    raise ValueError(f"MaskVersion {mv.id} SHA-256 disagrees with StoredFile")
                if mv.coverage_file_id is not None and mv.coverage_file_id not in committed_by_id:
                    raise ValueError(
                        f"MaskVersion {mv.id} coverage_file_id {mv.coverage_file_id} "
                        "is not a committed StoredFile"
                    )
    finally:
        engine.dispose()

    return {
        "status": "ok",
        "alembic_revision": alembic_rev,
        "verified_committed_files": len(committed_files),
        "verified_volumes": len(active_volumes),
        "verified_mask_versions": len(active_masks),
    }


def _resolve_default_settings() -> Settings:
    settings = Settings()
    if settings.DATABASE_URL is None:
        env_path = _BE_DIR / ".env"
        if env_path.is_file():
            settings = Settings(_env_file=env_path)
    return settings


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint for backup, isolated restore, and integrity verification."""
    parser = argparse.ArgumentParser(
        description="Consistent PostgreSQL and private flat-storage backup/restore utility."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_backup = sub.add_parser("backup", help="Create consistent DB + storage backup snapshot.")
    p_backup.add_argument("--database-url", type=str, default=None)
    p_backup.add_argument("--storage-root", type=Path, default=None)
    p_backup.add_argument("--output-dir", type=Path, required=True)
    p_backup.add_argument("--docker-container", type=str, default=DEFAULT_DOCKER_CONTAINER)
    p_backup.add_argument("--force", action="store_true")

    p_restore = sub.add_parser("restore", help="Restore backup into isolated DB and storage.")
    p_restore.add_argument("--backup-dir", type=Path, required=True)
    p_restore.add_argument("--target-database-url", type=str, required=True)
    p_restore.add_argument("--target-storage-root", type=Path, required=True)
    p_restore.add_argument("--docker-container", type=str, default=DEFAULT_DOCKER_CONTAINER)
    p_restore.add_argument("--create-db", action="store_true")

    p_verify = sub.add_parser("verify", help="Read-only storage & DB integrity verification.")
    p_verify.add_argument("--database-url", type=str, default=None)
    p_verify.add_argument("--storage-root", type=Path, default=None)

    args = parser.parse_args(argv)
    try:
        if args.command == "backup":
            cfg = _resolve_default_settings()
            db_url = args.database_url or cfg.DATABASE_URL
            if not db_url:
                raise ValueError("--database-url or DATABASE_URL is required")
            storage_root = args.storage_root or cfg.effective_storage_root
            result = run_backup(
                database_url=db_url,
                storage_root=storage_root,
                output_dir=args.output_dir,
                docker_container=args.docker_container,
                force=args.force,
            )
        elif args.command == "restore":
            result = run_restore(
                backup_dir=args.backup_dir,
                target_database_url=args.target_database_url,
                target_storage_root=args.target_storage_root,
                docker_container=args.docker_container,
                create_db=args.create_db,
            )
        else:
            cfg = _resolve_default_settings()
            db_url = args.database_url or cfg.DATABASE_URL
            if not db_url:
                raise ValueError("--database-url or DATABASE_URL is required")
            storage_root = args.storage_root or cfg.effective_storage_root
            result = verify_storage_and_db_integrity(
                database_url=db_url,
                storage_root=storage_root,
            )
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:
        print(f"Failure: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
