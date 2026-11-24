"""P7 real AI end-to-end smoke runner and CPU benchmark over real HTTP + PostgreSQL."""

from __future__ import annotations

import argparse
import contextlib
import gzip
import hashlib
import json
import os
import platform
import re
import shutil
import socket
import sys
import tempfile
import threading
import time
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from zoneinfo import ZoneInfo

import httpx
import nibabel as nib
import numpy as np
import psutil
import psycopg
import torch
import uvicorn
from alembic import command
from alembic.config import Config
from psycopg import sql

BE_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[2]

DEFAULT_AI_DATABASE_URL = (
    "postgresql+psycopg://bts_user:bts_local_dev_pw@127.0.0.1:5432/bts_ai_smoke_test"
)
DEFAULT_CASE_DIR = Path(
    r"D:\Nam4\Ky1\PBL6\BraTS2020_TrainingData\MICCAI_BraTS2020_TrainingData\BraTS20_Training_001"
)
DEFAULT_MANIFEST_PATH = BE_DIR / "worker" / "manifest.json"
DEFAULT_CHECKPOINT_PATH = Path(
    r"D:\Nam4\Ky1\PBL6\Demo2\outputs\tda_seg_unet_cce_dice\best.pt"
)

_FORBIDDEN_DB_NAMES = frozenset(
    {"bts_dev", "postgres", "template0", "template1", "bts", "dev", "prod", "production"}
)
_FORBIDDEN_DB_SUFFIXES = ("_dev", "_prod", "_production", "-dev", "-prod")
_UNIT_TO_MM: dict[str, float] = {
    "mm": 1.0,
    "meter": 1000.0,
    "micron": 0.001,
    "unknown": 1.0,
}
_WINDOWS_PATH_RE = re.compile(r"[A-Za-z]:[/\\]")
_POSIX_ABS_PATH_RE = re.compile(
    r"^/(?:Users|home|tmp|var|etc|opt|mnt|app|srv|data|root|usr|proc|dev)(?:/|$)"
    r"|^/[^/\s]+/[^/\s]+"
)


def _ensure_sys_path() -> None:
    """Ensure both repository root and BE/ are present on sys.path."""
    for candidate in (REPO_ROOT, BE_DIR):
        candidate_str = str(candidate)
        if candidate_str not in sys.path:
            sys.path.insert(0, candidate_str)


def validate_isolated_database_url(database_url: str) -> tuple[str, str, str]:
    """Validate PostgreSQL URL and refuse dev/prod/system database names."""
    raw = (database_url or "").strip()
    if not raw:
        raise ValueError("database_url must not be empty")

    parsed = urlsplit(raw)
    scheme = parsed.scheme.lower()
    if scheme not in {"postgresql", "postgresql+psycopg"}:
        raise ValueError(
            f"Unsupported database scheme {parsed.scheme!r}; "
            "expected postgresql or postgresql+psycopg"
        )
    if not parsed.netloc:
        raise ValueError("Database host/credentials missing from database_url")

    db_name = parsed.path.lstrip("/").strip()
    if not db_name or "/" in db_name:
        raise ValueError(f"Invalid target database name {db_name!r} in database_url")

    lowered = db_name.lower()
    if lowered in _FORBIDDEN_DB_NAMES or lowered.endswith(_FORBIDDEN_DB_SUFFIXES):
        raise ValueError(
            f"Refusing to run destructive smoke test against protected database {db_name!r}"
        )

    sa_url = urlunsplit(
        ("postgresql+psycopg", parsed.netloc, f"/{db_name}", parsed.query, parsed.fragment)
    )
    psycopg_url = urlunsplit(
        ("postgresql", parsed.netloc, f"/{db_name}", parsed.query, parsed.fragment)
    )
    return sa_url, psycopg_url, db_name


def _maintenance_dsn(psycopg_url: str, admin_db: str) -> str:
    parsed = urlsplit(psycopg_url)
    return urlunsplit((parsed.scheme, parsed.netloc, f"/{admin_db}", parsed.query, parsed.fragment))


def _connect_maintenance(psycopg_url: str) -> psycopg.Connection[Any]:
    last_exc: Exception | None = None
    for admin_db in ("postgres", "bts_dev"):
        dsn = _maintenance_dsn(psycopg_url, admin_db)
        try:
            return psycopg.connect(dsn, connect_timeout=5, autocommit=True)
        except psycopg.Error as exc:
            last_exc = exc
            continue
    raise RuntimeError(f"Could not connect to PostgreSQL maintenance database: {last_exc}")


def _terminate_db_connections(conn: psycopg.Connection[Any], db_name: str) -> None:
    with contextlib.suppress(psycopg.Error):
        with conn.cursor() as cur:
            cur.execute(
                "SELECT pg_terminate_backend(pid) "
                "FROM pg_stat_activity "
                "WHERE datname = %s AND pid <> pg_backend_pid()",
                (db_name,),
            )


def _create_isolated_database(psycopg_url: str, db_name: str) -> None:
    with _connect_maintenance(psycopg_url) as conn:
        _terminate_db_connections(conn, db_name)
        with conn.cursor() as cur:
            cur.execute(sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(db_name)))
            cur.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(db_name)))


def _drop_isolated_database(psycopg_url: str, db_name: str) -> None:
    with _connect_maintenance(psycopg_url) as conn:
        _terminate_db_connections(conn, db_name)
        with conn.cursor() as cur:
            cur.execute(sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(db_name)))


def _run_alembic_upgrade_head(sa_url: str) -> None:
    cfg = Config(str(BE_DIR / "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", sa_url)
    command.upgrade(cfg, "head")


def _find_case_modality_file(case_dir: Path, modality: str) -> Path:
    if not case_dir.is_dir():
        raise FileNotFoundError(f"BraTS case directory does not exist: {case_dir}")

    preferred_names = (
        f"{case_dir.name}_{modality}.nii.gz",
        f"{case_dir.name}_{modality}.nii",
    )
    for name in preferred_names:
        cand = case_dir / name
        if cand.is_file():
            return cand

    gz_matches = sorted(
        p
        for p in case_dir.glob(f"*_{modality}.nii.gz")
        if p.is_file() and p.name.lower().endswith(f"_{modality}.nii.gz")
    )
    if gz_matches:
        return gz_matches[0]

    nii_matches = sorted(
        p
        for p in case_dir.glob(f"*_{modality}.nii")
        if p.is_file() and p.name.lower().endswith(f"_{modality}.nii")
    )
    if nii_matches:
        return nii_matches[0]

    raise FileNotFoundError(
        f"Expected *_{modality}.nii.gz or *_{modality}.nii file in {case_dir}"
    )


def _resolve_checkpoint_from_args(
    manifest_path: Path,
    checkpoint_path: Path | None,
) -> Path:
    if checkpoint_path is not None:
        resolved = checkpoint_path.resolve()
        if not resolved.is_file():
            raise FileNotFoundError(f"Checkpoint file not found: {resolved}")
        return resolved

    env_ckpt = os.environ.get("MODEL_CHECKPOINT_PATH", "").strip()
    if env_ckpt:
        resolved = Path(env_ckpt).resolve()
        if not resolved.is_file():
            raise FileNotFoundError(f"MODEL_CHECKPOINT_PATH file not found: {resolved}")
        return resolved

    manifest_data = json.loads(manifest_path.read_text(encoding="utf-8"))
    default_raw = str(manifest_data.get("default_checkpoint_path", "")).strip()
    if default_raw:
        cand = Path(default_raw)
        if not cand.is_absolute():
            cand = (manifest_path.parent / cand).resolve()
        if cand.is_file():
            return cand

    if DEFAULT_CHECKPOINT_PATH.is_file():
        return DEFAULT_CHECKPOINT_PATH.resolve()

    raise FileNotFoundError(
        f"Checkpoint not found (checked manifest default and {DEFAULT_CHECKPOINT_PATH})"
    )


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        while chunk := fh.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        sock.listen(1)
        return int(sock.getsockname()[1])


def _sample_rss_mb() -> tuple[float, float]:
    mem = psutil.Process(os.getpid()).memory_info()
    rss_mb = round(int(mem.rss) / (1024.0 * 1024.0), 3)
    peak_wset = int(getattr(mem, "peak_wset", 0) or 0)
    peak_mb = round(max(int(mem.rss), peak_wset) / (1024.0 * 1024.0), 3)
    return rss_mb, peak_mb


def _collect_environment_info(device: str) -> dict[str, Any]:
    cuda_available = bool(torch.cuda.is_available())
    vram_mb: float | None = None
    if cuda_available:
        vram_mb = round(
            float(torch.cuda.get_device_properties(0).total_memory) / (1024.0 * 1024.0), 2
        )
    cpu_model = platform.processor().strip() or platform.machine().strip() or "unknown"
    return {
        "os": platform.platform(),
        "python_version": platform.python_version(),
        "cpu_model": cpu_model,
        "logical_cores": int(os.cpu_count() or 0),
        "ram_gb": round(float(psutil.virtual_memory().total) / (1024.0**3), 2),
        "torch_version": str(torch.__version__),
        "device": device,
        "cuda_available": cuda_available,
        "vram_mb": vram_mb,
    }


def _find_metadata_leaks(
    payload: Any,
    *,
    forbidden_substrings: Sequence[str],
    check_paths: bool = True,
) -> list[str]:
    findings: list[str] = []
    normalized_forbidden = [s.lower() for s in forbidden_substrings if s]

    def _inspect_text(text: str, location: str) -> None:
        lowered = text.lower()
        for needle in normalized_forbidden:
            if needle in lowered:
                findings.append(f"{location}: contains forbidden value {needle!r}")
        if check_paths:
            if text.startswith("\\\\") or _WINDOWS_PATH_RE.search(text):
                findings.append(f"{location}: contains Windows filesystem path")
            elif _POSIX_ABS_PATH_RE.match(text):
                findings.append(f"{location}: contains POSIX absolute path")

    def _walk(node: Any, path: str) -> None:
        if isinstance(node, dict):
            for k, v in node.items():
                key_str = str(k)
                _inspect_text(key_str, f"{path}.{key_str}[key]")
                _walk(v, f"{path}.{key_str}")
        elif isinstance(node, list):
            for idx, item in enumerate(node):
                _walk(item, f"{path}[{idx}]")
        elif isinstance(node, str):
            _inspect_text(node, path)

    _walk(payload, "$")
    return findings


def _wait_for_server_ready(
    client: httpx.Client,
    base_url: str,
    server_thread: threading.Thread,
    server_errors: list[BaseException],
    *,
    timeout_s: float = 20.0,
) -> None:
    deadline = time.monotonic() + timeout_s
    last_error: str | None = None
    while time.monotonic() < deadline:
        if server_errors:
            raise RuntimeError(f"Uvicorn server failed: {server_errors[0]}") from server_errors[0]
        if not server_thread.is_alive():
            raise RuntimeError("Uvicorn server thread exited before becoming ready")
        try:
            resp = client.get(f"{base_url}/api/v1/health/ready", timeout=2.0)
            if resp.status_code == 200 and resp.json().get("status") == "ready":
                return
            last_error = f"HTTP {resp.status_code}: {resp.text}"
        except httpx.HTTPError as exc:
            last_error = f"{type(exc).__name__}: {exc}"
        time.sleep(0.1)
    raise TimeoutError(f"API server did not become ready within {timeout_s}s ({last_error})")


def _nifti_affine_and_spacing_mm(img: nib.Nifti1Image) -> tuple[np.ndarray, np.ndarray]:
    xyzt_units = img.header.get_xyzt_units()
    scale = _UNIT_TO_MM.get(str(xyzt_units[0]), 1.0)
    affine_mm = np.asarray(img.affine, dtype=np.float64).copy()
    affine_mm[:3, :] *= scale
    spacing_mm = np.asarray(
        [float(np.linalg.norm(affine_mm[:3, idx])) for idx in range(3)],
        dtype=np.float64,
    )
    return affine_mm, spacing_mm


def run_real_worker_e2e_smoke(
    *,
    database_url: str | None = None,
    case_dir: Path | None = None,
    checkpoint_path: Path | None = None,
    manifest_path: Path | None = None,
    json_out: Path | None = None,
) -> dict[str, Any]:
    """Run real AI worker E2E smoke test over HTTP + PostgreSQL with isolated temp DB."""
    _ensure_sys_path()

    from app.core.config import Settings
    from app.core.db import create_db_engine, create_session_factory
    from app.core.security import generate_rsa_keypair, hash_password
    from app.main import create_app
    from app.models.user import User
    from app.services.job_service import sync_active_model
    from worker.service import InferenceWorker

    resolved_db_url = (
        database_url or os.environ.get("TEST_AI_DATABASE_URL") or DEFAULT_AI_DATABASE_URL
    )
    sa_url, psycopg_url, db_name = validate_isolated_database_url(resolved_db_url)

    resolved_case_dir = (case_dir or DEFAULT_CASE_DIR).resolve()
    resolved_manifest_path = (manifest_path or DEFAULT_MANIFEST_PATH).resolve()
    if not resolved_manifest_path.is_file():
        raise FileNotFoundError(f"Manifest file not found: {resolved_manifest_path}")
    resolved_checkpoint_path = _resolve_checkpoint_from_args(
        resolved_manifest_path, checkpoint_path
    )

    src_flair = _find_case_modality_file(resolved_case_dir, "flair")
    src_t1ce = _find_case_modality_file(resolved_case_dir, "t1ce")
    for src_path in (src_flair, src_t1ce):
        lowered = src_path.name.lower()
        if "_seg" in lowered or "_t1." in lowered or "_t2." in lowered:
            raise AssertionError(f"Forbidden modality/ground-truth file selected: {src_path.name}")

    manifest_raw = json.loads(resolved_manifest_path.read_text(encoding="utf-8"))
    expected_pipeline_version = str(manifest_raw["pipeline_version"])
    expected_checkpoint_sha256 = str(manifest_raw["checkpoint_sha256"]).lower()
    expected_model_version_id = f"{manifest_raw['model_id']}:{manifest_raw['version']}"

    patient_code = "BN-P7-AI-SMOKE"
    patient_full_name = "P7 Real AI Smoke Patient"
    doctor_username = "dr.p7.ai.smoke"
    doctor_password = f"P7Smoke-{uuid.uuid4().hex}"
    worker_token = f"p7-worker-token-{uuid.uuid4().hex}"

    db_created = False
    tmp_dir_obj: tempfile.TemporaryDirectory[str] | None = None
    server: uvicorn.Server | None = None
    server_thread: threading.Thread | None = None
    app = None
    worker: InferenceWorker | None = None
    doctor_client: httpx.Client | None = None

    try:
        _create_isolated_database(psycopg_url, db_name)
        db_created = True
        _run_alembic_upgrade_head(sa_url)

        tmp_dir_obj = tempfile.TemporaryDirectory(
            prefix="p7_real_ai_smoke_", ignore_cleanup_errors=True
        )
        tmp_root = Path(tmp_dir_obj.name)
        keys_dir = tmp_root / "keys"
        storage_root = tmp_root / "storage"
        isolated_inputs = tmp_root / "isolated_inputs"
        isolated_exports = tmp_root / "isolated_exports"
        storage_root.mkdir(parents=True, exist_ok=True)
        isolated_inputs.mkdir(parents=True, exist_ok=True)
        isolated_exports.mkdir(parents=True, exist_ok=True)

        priv_key_path, pub_key_path = generate_rsa_keypair(
            keys_dir / "jwt-private.pem",
            keys_dir / "jwt-public.pem",
        )

        iso_flair = isolated_inputs / src_flair.name
        iso_t1ce = isolated_inputs / src_t1ce.name
        shutil.copy2(src_flair, iso_flair)
        shutil.copy2(src_t1ce, iso_t1ce)

        isolated_names = sorted(p.name for p in isolated_inputs.iterdir())
        assert isolated_names == sorted([src_flair.name, src_t1ce.name]), (
            f"Isolated upload dir must contain ONLY FLAIR and T1ce, got {isolated_names}"
        )
        assert not any(
            "_seg" in name.lower() or "_t1." in name.lower() or "_t2." in name.lower()
            for name in isolated_names
        )

        flair_sha256 = _sha256_file(iso_flair)
        t1ce_sha256 = _sha256_file(iso_t1ce)

        port = _find_free_port()
        api_base_url = f"http://127.0.0.1:{port}"
        settings = Settings(
            _env_file=None,
            APP_ENV="test",
            LOG_LEVEL="WARNING",
            DATABASE_URL=sa_url,
            STORAGE_ROOT=storage_root,
            PUBLIC_ORIGIN="http://127.0.0.1:5173",
            COOKIE_SECURE=False,
            JWT_PRIVATE_KEY_PATH=priv_key_path,
            JWT_PUBLIC_KEY_PATH=pub_key_path,
            JWT_KEY_ID="p7-smoke-rs256-v1",
            MODEL_MANIFEST_PATH=resolved_manifest_path,
            MODEL_CHECKPOINT_PATH=resolved_checkpoint_path,
            WORKER_API_BASE_URL=api_base_url,
            WORKER_TOKEN=worker_token,
            WORKER_DEVICE="cpu",
        )

        seed_engine = create_db_engine(settings)
        assert seed_engine is not None
        try:
            seed_factory = create_session_factory(seed_engine)
            with seed_factory() as db:
                doctor_user = User(
                    username=doctor_username,
                    display_name="Dr. P7 AI Smoke",
                    password_hash=hash_password(doctor_password),
                    role="doctor",
                    is_active=True,
                    must_change_password=False,
                    password_changed_at=datetime.now(UTC),
                )
                db.add(doctor_user)
                sync_active_model(db, settings)
                db.commit()
        finally:
            seed_engine.dispose()

        app = create_app(settings=settings)
        uvicorn_config = uvicorn.Config(
            app,
            host="127.0.0.1",
            port=port,
            log_level="warning",
            access_log=False,
        )
        server = uvicorn.Server(uvicorn_config)
        server_errors: list[BaseException] = []

        def _serve() -> None:
            try:
                server.run()
            except BaseException as exc:
                server_errors.append(exc)

        server_thread = threading.Thread(
            target=_serve, name="p7-real-ai-uvicorn", daemon=True
        )
        server_thread.start()

        doctor_client = httpx.Client(
            base_url=api_base_url,
            timeout=httpx.Timeout(120.0, connect=10.0),
        )
        _wait_for_server_ready(doctor_client, api_base_url, server_thread, server_errors)

        before_preload_rss_mb, _ = _sample_rss_mb()
        t_preload_start = time.perf_counter()
        worker = InferenceWorker(
            api_base_url=api_base_url,
            token=worker_token,
            worker_id="p7-real-ai-worker-1",
            manifest_path=resolved_manifest_path,
            checkpoint_path=resolved_checkpoint_path,
            device="cpu",
        )
        model_preload_ms = round((time.perf_counter() - t_preload_start) * 1000.0, 3)
        after_preload_rss_mb, _ = _sample_rss_mb()

        captured_worker_outputs: dict[str, Any] = {}
        orig_complete = worker.api.complete

        def _capturing_complete(
            *,
            job_id: str,
            attempt_id: str,
            worker_id: str,
            lease_token: str,
            result: Any,
        ) -> None:
            captured_worker_outputs["stage_timings_ms"] = {
                str(k): float(v) for k, v in result.stage_timings_ms.items()
            }
            captured_worker_outputs["peak_ram_mb"] = float(result.peak_ram_mb)
            captured_worker_outputs["worker_metadata"] = dict(result.metadata)
            captured_worker_outputs["worker_coverage"] = dict(result.coverage)
            # Flush the terminal 155/155 slice progress heartbeat before /complete because
            # InferenceWorker._heartbeat_loop ticks every 15s and /complete preserves slices.
            with httpx.Client(
                timeout=httpx.Timeout(30.0, connect=10.0),
                headers={"X-Worker-Token": worker_token},
            ) as hb_client:
                hb_resp = hb_client.post(
                    f"{api_base_url}/api/v1/internal/jobs/{job_id}/heartbeat",
                    json={
                        "worker_id": worker_id,
                        "attempt_id": attempt_id,
                        "lease_token": lease_token,
                        "stage": "saving",
                        "completed_slices": int(result.evaluated_slices),
                        "total_slices": int(result.total_slices),
                    },
                )
                hb_resp.raise_for_status()
            orig_complete(
                job_id=job_id,
                attempt_id=attempt_id,
                worker_id=worker_id,
                lease_token=lease_token,
                result=result,
            )

        worker.api.complete = _capturing_complete  # type: ignore[method-assign]

        # 1. Doctor login
        login_resp = doctor_client.post(
            "/api/v1/auth/login",
            json={"username": doctor_username, "password": doctor_password},
        )
        assert login_resp.status_code == 200, login_resp.text
        access_token = login_resp.json()["access_token"]
        auth_headers = {"Authorization": f"Bearer {access_token}"}

        # 2. Create synthetic patient
        patient_resp = doctor_client.post(
            "/api/v1/patients",
            headers=auth_headers,
            json={
                "patient_code": patient_code,
                "full_name": patient_full_name,
                "birth_year": 1980,
                "sex": "unknown",
            },
        )
        assert patient_resp.status_code == 201, patient_resp.text
        patient_id = patient_resp.json()["id"]

        # 3. Create case with UUID Idempotency-Key
        study_date_vn = datetime.now(ZoneInfo("Asia/Ho_Chi_Minh")).date().isoformat()
        case_resp = doctor_client.post(
            f"/api/v1/patients/{patient_id}/cases",
            headers={**auth_headers, "Idempotency-Key": str(uuid.uuid4())},
            json={"study_date": study_date_vn, "notes": "P7 real AI E2E smoke"},
        )
        assert case_resp.status_code == 201, case_resp.text
        case_id = case_resp.json()["id"]

        # 4. Upload real FLAIR and T1ce volumes
        for modality, file_path, expected_sha in (
            ("flair", iso_flair, flair_sha256),
            ("t1ce", iso_t1ce, t1ce_sha256),
        ):
            media_type = (
                "application/gzip"
                if file_path.name.lower().endswith(".nii.gz")
                else "application/octet-stream"
            )
            with file_path.open("rb") as fh:
                vol_resp = doctor_client.post(
                    f"/api/v1/cases/{case_id}/volumes",
                    headers=auth_headers,
                    data={"modality": modality},
                    files={"file": (file_path.name, fh, media_type)},
                )
            assert vol_resp.status_code == 201, f"{modality} upload failed: {vol_resp.text}"
            vol_data = vol_resp.json()
            assert vol_data["validation_status"] == "valid"
            assert vol_data["model_profile_compatible"] is True
            assert vol_data["sha256"] == expected_sha

        # 5. Enqueue inference job
        job_create_resp = doctor_client.post(
            f"/api/v1/cases/{case_id}/jobs",
            headers={**auth_headers, "Idempotency-Key": str(uuid.uuid4())},
        )
        assert job_create_resp.status_code == 202, job_create_resp.text
        queued_job = job_create_resp.json()["job"]
        assert queued_job["state"] == "queued"
        job_id = queued_job["id"]

        # 6. Execute real worker claim -> 155-slice inference -> complete upload
        t_job_start = time.perf_counter()
        worker.api.post(
            "/worker/heartbeat",
            {
                "worker_id": worker.worker_id,
                "device_type": worker.device_type,
                "model_version_id": worker.model_version_id,
            },
        )
        claim = worker._claim()
        assert claim is not None, "Expected worker._claim() to claim the queued job"
        assert claim["job_id"] == job_id
        worker._run_claim(claim)
        end_to_end_job_ms = round((time.perf_counter() - t_job_start) * 1000.0, 3)

        # 7. Verify persisted job state via Doctor HTTP API
        job_get_resp = doctor_client.get(f"/api/v1/jobs/{job_id}", headers=auth_headers)
        assert job_get_resp.status_code == 200, job_get_resp.text
        job_data = job_get_resp.json()
        assert job_data["state"] == "succeeded", f"Job did not succeed: {job_data}"
        assert job_data["stage"] == "done"
        assert job_data["completed_slices"] == 155
        assert job_data["total_slices"] == 155
        result_id = job_data["result_mask_version_id"]
        assert result_id is not None

        # 8. Verify exported metadata & AI coverage provenance via HTTP API
        meta_resp = doctor_client.get(
            f"/api/v1/mask-versions/{result_id}/metadata",
            headers=auth_headers,
        )
        assert meta_resp.status_code == 200, meta_resp.text
        exported_metadata = meta_resp.json()
        assert exported_metadata["version_id"] == result_id
        assert exported_metadata["case_id"] == case_id
        assert exported_metadata["job_id"] == job_id
        assert exported_metadata["source"] == "ai"
        assert exported_metadata["model_version_id"] == expected_model_version_id
        assert exported_metadata["coverage"]["status"] == "ai_crop_evaluated"
        coverage_file_id = exported_metadata["coverage"]["coverage_file_id"]
        assert coverage_file_id is not None

        cov_resp = doctor_client.get(
            f"/api/v1/files/{coverage_file_id}/content",
            headers=auth_headers,
        )
        assert cov_resp.status_code == 200, cov_resp.text
        coverage_json = cov_resp.json()
        assert coverage_json["pipeline_version"] == expected_pipeline_version
        assert coverage_json["unevaluated_outside_crop"] is True
        assert coverage_json["evaluated_slices"] == 155
        assert coverage_json["total_slices"] == 155
        assert len(coverage_json["slice_crops"]) == 155

        stage_timings_ms = captured_worker_outputs.get("stage_timings_ms", {})
        assert stage_timings_ms.get("tda", 0.0) > 0.0
        assert stage_timings_ms.get("inference", 0.0) > 0.0
        worker_metadata = captured_worker_outputs.get("worker_metadata", {})
        assert worker_metadata.get("pipeline_version") == expected_pipeline_version

        # 9. Verify exported NIfTI mask round-trip via HTTP API
        export_resp = doctor_client.get(
            f"/api/v1/mask-versions/{result_id}/export",
            headers=auth_headers,
        )
        assert export_resp.status_code == 200, export_resp.text
        content_disposition = export_resp.headers.get("content-disposition", "")
        assert "attachment" in content_disposition.lower()
        assert ".nii.gz" in content_disposition.lower()
        assert f"mask-case-{case_id}-v" in content_disposition

        output_mask_sha256 = hashlib.sha256(export_resp.content).hexdigest()
        assert output_mask_sha256 == exported_metadata["sha256"]

        # Verify valid gzip stream and write for nibabel inspection
        decompressed_nii = gzip.decompress(export_resp.content)
        assert len(decompressed_nii) > 348
        exported_nii_gz_path = isolated_exports / "exported_mask.nii.gz"
        exported_nii_gz_path.write_bytes(export_resp.content)

        ref_img = nib.load(str(iso_flair))
        out_img = nib.load(str(exported_nii_gz_path))
        mask_arr = np.asarray(out_img.dataobj)

        export_shape = [int(d) for d in out_img.shape]
        export_dtype = str(mask_arr.dtype)
        labels_present = sorted(int(v) for v in np.unique(mask_arr))
        assert export_shape == [240, 240, 155]
        assert mask_arr.dtype == np.uint8
        assert out_img.get_data_dtype() == np.uint8
        assert set(labels_present).issubset({0, 1, 2, 4})

        ref_affine_mm, ref_spacing_mm = _nifti_affine_and_spacing_mm(ref_img)
        out_affine_mm, out_spacing_mm = _nifti_affine_and_spacing_mm(out_img)
        affine_match = bool(np.allclose(out_affine_mm, ref_affine_mm, rtol=0.0, atol=1e-4))
        spacing_match = bool(np.allclose(out_spacing_mm, ref_spacing_mm, rtol=0.0, atol=1e-4))
        assert affine_match is True
        assert spacing_match is True

        voxel_volume_mm3 = abs(float(np.linalg.det(out_affine_mm[:3, :3])))
        label_voxel_counts = {
            str(lbl): int(np.count_nonzero(mask_arr == lbl)) for lbl in (0, 1, 2, 4)
        }
        label_volumes_mm3 = {
            k: round(float(v * voxel_volume_mm3), 6) for k, v in label_voxel_counts.items()
        }
        wt_voxels = (
            label_voxel_counts["1"] + label_voxel_counts["2"] + label_voxel_counts["4"]
        )
        tc_voxels = label_voxel_counts["1"] + label_voxel_counts["4"]
        et_voxels = label_voxel_counts["4"]
        group_volumes_mm3 = {
            "WT": round(float(wt_voxels * voxel_volume_mm3), 6),
            "TC": round(float(tc_voxels * voxel_volume_mm3), 6),
            "ET": round(float(et_voxels * voxel_volume_mm3), 6),
        }
        assert group_volumes_mm3["WT"] > 0.0

        # Verify API metadata composite volumes agree with exported mask
        api_groups = {
            item["group"]: float(item["volume_mm3"])
            for item in exported_metadata["statistics"]["composite_groups"]
        }
        for grp_name in ("WT", "TC", "ET"):
            assert abs(api_groups[grp_name] - group_volumes_mm3[grp_name]) <= 1e-3

        # 10. Verify zero path or patient PII leaks across exported API metadata & artifacts
        forbidden_paths = [
            str(tmp_root),
            tmp_root.as_posix(),
            str(storage_root),
            storage_root.as_posix(),
            str(resolved_case_dir),
            resolved_case_dir.as_posix(),
            str(resolved_checkpoint_path),
            resolved_checkpoint_path.as_posix(),
            str(resolved_manifest_path),
            resolved_manifest_path.as_posix(),
            str(REPO_ROOT),
            REPO_ROOT.as_posix(),
            "best.pt",
            "manifest.json",
            "_flair.nii",
            "_t1ce.nii",
            "_seg",
        ]
        forbidden_pii = [
            patient_code,
            patient_full_name,
            resolved_case_dir.name,
        ]

        path_leaks = (
            _find_metadata_leaks(
                exported_metadata, forbidden_substrings=forbidden_paths, check_paths=True
            )
            + _find_metadata_leaks(
                coverage_json, forbidden_substrings=forbidden_paths, check_paths=True
            )
            + _find_metadata_leaks(
                worker_metadata, forbidden_substrings=forbidden_paths, check_paths=True
            )
        )
        pii_leaks = (
            _find_metadata_leaks(
                exported_metadata, forbidden_substrings=forbidden_pii, check_paths=False
            )
            + _find_metadata_leaks(
                coverage_json, forbidden_substrings=forbidden_pii, check_paths=False
            )
            + _find_metadata_leaks(
                worker_metadata, forbidden_substrings=forbidden_pii, check_paths=False
            )
            + _find_metadata_leaks(
                content_disposition, forbidden_substrings=forbidden_pii, check_paths=False
            )
        )
        metadata_has_no_absolute_paths = len(path_leaks) == 0
        metadata_has_no_patient_pii = len(pii_leaks) == 0
        assert metadata_has_no_absolute_paths, f"Path leaks found: {path_leaks}"
        assert metadata_has_no_patient_pii, f"PII leaks found: {pii_leaks}"

        _, peak_rss_mb = _sample_rss_mb()

        report: dict[str, Any] = {
            "status": "passed",
            "case_id": str(case_id),
            "input_hashes": {
                "flair_sha256": flair_sha256,
                "t1ce_sha256": t1ce_sha256,
            },
            "model": {
                "model_version_id": worker.model_version_id,
                "pipeline_version": expected_pipeline_version,
                "checkpoint_sha256": expected_checkpoint_sha256,
                "device": "cpu",
            },
            "environment": _collect_environment_info("cpu"),
            "timings_ms": {
                "model_preload_ms": model_preload_ms,
                "end_to_end_job_ms": end_to_end_job_ms,
            },
            "memory_mb": {
                "before_preload_rss_mb": before_preload_rss_mb,
                "after_preload_rss_mb": after_preload_rss_mb,
                "model_preload_delta_rss_mb": round(
                    max(0.0, after_preload_rss_mb - before_preload_rss_mb), 3
                ),
                "peak_rss_mb": peak_rss_mb,
                "adapter_peak_ram_mb": float(
                    captured_worker_outputs.get("peak_ram_mb", 0.0)
                ),
            },
            "job": {
                "id": job_data["id"],
                "state": job_data["state"],
                "stage": job_data["stage"],
                "completed_slices": job_data["completed_slices"],
                "total_slices": job_data["total_slices"],
                "attempt_count": job_data["attempt_count"],
                "model_version_id": job_data["model_version_id"],
                "result_mask_version_id": job_data["result_mask_version_id"],
            },
            "export_shape": export_shape,
            "export_dtype": export_dtype,
            "labels_present": labels_present,
            "label_voxel_counts": label_voxel_counts,
            "label_volumes_mm3": label_volumes_mm3,
            "group_volumes_mm3": group_volumes_mm3,
            "affine_match": affine_match,
            "spacing_match": spacing_match,
            "output_mask_sha256": output_mask_sha256,
            "export_bytes": len(export_resp.content),
            "content_disposition": content_disposition,
            "stage_timings_ms": stage_timings_ms,
            "coverage_summary": {
                "original_shape": coverage_json["original_shape"],
                "pipeline_version": coverage_json["pipeline_version"],
                "unevaluated_outside_crop": coverage_json["unevaluated_outside_crop"],
                "patch_size": coverage_json["patch_size"],
                "slice_axis": coverage_json["slice_axis"],
                "total_slices": coverage_json["total_slices"],
                "evaluated_slices": coverage_json["evaluated_slices"],
                "empty_slices": coverage_json["empty_slices"],
            },
            "metadata_provenance": {
                "version_id": exported_metadata["version_id"],
                "version_number": exported_metadata["version_number"],
                "source": exported_metadata["source"],
                "model_version_id": exported_metadata["model_version_id"],
                "pipeline_version": coverage_json["pipeline_version"],
                "coverage_status": exported_metadata["coverage"]["status"],
                "coverage_file_id": exported_metadata["coverage"]["coverage_file_id"],
                "geometry": exported_metadata["geometry"],
                "sha256": exported_metadata["sha256"],
            },
            "metadata_has_no_absolute_paths": metadata_has_no_absolute_paths,
            "metadata_has_no_patient_pii": metadata_has_no_patient_pii,
        }

        report_leaks = _find_metadata_leaks(
            report,
            forbidden_substrings=[*forbidden_paths, *forbidden_pii],
            check_paths=True,
        )
        assert not report_leaks, (
            f"Sanitized report leaked sensitive values: {report_leaks}"
        )

        if json_out is not None:
            resolved_json_out = Path(json_out)
            resolved_json_out.parent.mkdir(parents=True, exist_ok=True)
            resolved_json_out.write_text(
                json.dumps(report, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )

        return report
    finally:
        if doctor_client is not None:
            with contextlib.suppress(Exception):
                doctor_client.close()
        if worker is not None:
            with contextlib.suppress(Exception):
                worker.api.close()
        if server is not None:
            server.should_exit = True
        if server_thread is not None and server_thread.is_alive():
            server_thread.join(timeout=10.0)
        if app is not None:
            engine = getattr(app.state, "db_engine", None)
            if engine is not None:
                with contextlib.suppress(Exception):
                    engine.dispose()
        if tmp_dir_obj is not None:
            with contextlib.suppress(OSError):
                tmp_dir_obj.cleanup()
        if db_created:
            _drop_isolated_database(psycopg_url, db_name)


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run P7 real AI worker E2E smoke test and CPU benchmark."
    )
    parser.add_argument("--case-dir", type=Path, default=None)
    parser.add_argument("--checkpoint", type=Path, default=None)
    parser.add_argument("--manifest", type=Path, default=None)
    parser.add_argument("--database-url", type=str, default=None)
    parser.add_argument("--json-out", type=Path, default=None)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """CLI entrypoint returning 0 on passing E2E smoke verification."""
    args = _build_arg_parser().parse_args(argv)
    report = run_real_worker_e2e_smoke(
        database_url=args.database_url,
        case_dir=args.case_dir,
        checkpoint_path=args.checkpoint,
        manifest_path=args.manifest,
        json_out=args.json_out,
    )
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
