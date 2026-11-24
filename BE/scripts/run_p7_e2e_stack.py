"""Isolated live backend + deterministic fake worker stack for Playwright Chromium E2E."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import logging
import os
import secrets
import sys
import tempfile
import threading
import time
import uuid
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

_BE_DIR = Path(__file__).resolve().parents[1]
if str(_BE_DIR) not in sys.path:
    sys.path.insert(0, str(_BE_DIR))

import httpx  # noqa: E402
import nibabel as nib  # noqa: E402
import numpy as np  # noqa: E402
import psycopg  # noqa: E402
import uvicorn  # noqa: E402
from alembic import command  # noqa: E402
from alembic.config import Config  # noqa: E402
from psycopg import sql  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.engine import make_url  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

from app.core.config import Settings  # noqa: E402
from app.core.security import generate_rsa_keypair, hash_password  # noqa: E402
from app.core.storage import LocalStorageAdapter  # noqa: E402
from app.main import create_app  # noqa: E402
from app.models.case import Case  # noqa: E402
from app.models.inference_job import InferenceJob, JobAttempt  # noqa: E402
from app.models.patient import Patient  # noqa: E402
from app.models.stored_file import StoredFile  # noqa: E402
from app.models.user import User  # noqa: E402
from app.models.volume import Volume  # noqa: E402
from app.services.inference_job_service import sync_active_model  # noqa: E402

logger = logging.getLogger("bts.p7_e2e_stack")

_PROTECTED_DB_NAMES = frozenset(
    {"bts_dev", "postgres", "template0", "template1", "bts", "dev", "prod", "production"}
)
_PROTECTED_DB_SUFFIXES = ("_dev", "_prod", "_production", "-dev", "-prod")
_BRATS_SHAPE = (240, 240, 155)
_BRATS_AFFINE = np.array(
    [
        [-1.0, 0.0, 0.0, 120.0],
        [0.0, -1.0, 0.0, 120.0],
        [0.0, 0.0, 1.0, -78.0],
        [0.0, 0.0, 0.0, 1.0],
    ],
    dtype=np.float64,
)


def _assert_safe_e2e_database(database_url: str) -> str:
    url = make_url(database_url)
    if not url.drivername.startswith("postgresql"):
        raise ValueError(f"Unsupported database scheme '{url.drivername}'; expected PostgreSQL")
    db_name = (url.database or "").strip()
    lowered = db_name.lower()
    if (
        not lowered
        or "/" in db_name
        or lowered in _PROTECTED_DB_NAMES
        or lowered.endswith(_PROTECTED_DB_SUFFIXES)
    ):
        raise ValueError(
            f"Refusing destructive E2E database reset against protected database '{db_name}'"
        )
    return db_name


def _recreate_e2e_database(database_url: str) -> None:
    db_name = _assert_safe_e2e_database(database_url)
    url = make_url(database_url)
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


def _run_migrations_head(database_url: str) -> None:
    cfg = Config(str(_BE_DIR / "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", database_url)
    command.upgrade(cfg, "head")


def _serialize_nifti_gz(data: np.ndarray, affine: np.ndarray) -> bytes:
    img = nib.Nifti1Image(data, affine)
    if data.dtype == np.uint8:
        img.set_data_dtype(np.uint8)
    img.header.set_xyzt_units("mm", "sec")
    img.set_qform(affine, code=1)
    img.set_sform(affine, code=1)
    bio = io.BytesIO()
    fmap = img.make_file_map({"image": bio, "header": bio})
    img.to_file_map(fmap)
    out = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=out, mtime=0, compresslevel=1) as gz:
        gz.write(bio.getvalue())
    return out.getvalue()


def _build_synthetic_brats_pair() -> tuple[bytes, bytes]:
    flair = np.zeros(_BRATS_SHAPE, dtype=np.float32)
    t1ce = np.zeros(_BRATS_SHAPE, dtype=np.float32)

    xs = np.arange(_BRATS_SHAPE[0], dtype=np.float32)[:, None, None]
    ys = np.arange(_BRATS_SHAPE[1], dtype=np.float32)[None, :, None]
    zs = np.arange(_BRATS_SHAPE[2], dtype=np.float32)[None, None, :]

    brain_mask = (
        ((xs - 120.0) / 74.0) ** 2
        + ((ys - 120.0) / 88.0) ** 2
        + ((zs - 77.0) / 56.0) ** 2
    ) <= 1.0
    flair[brain_mask] = 280.0
    t1ce[brain_mask] = 240.0

    # Asymmetric bright ROI centered around z=77 so axial slice 78 and automatic crop stay valid
    flair[96:130, 96:118, 72:83] = 880.0
    t1ce[96:130, 96:118, 72:83] = 420.0
    t1ce[118:128, 98:112, 74:81] = 960.0

    return (
        _serialize_nifti_gz(flair, _BRATS_AFFINE),
        _serialize_nifti_gz(t1ce, _BRATS_AFFINE),
    )


def _build_deterministic_mask_gz(flair_bytes: bytes, *, is_gzip: bool) -> bytes:
    raw_nii = gzip.decompress(flair_bytes) if is_gzip else flair_bytes
    fh = nib.FileHolder(fileobj=io.BytesIO(raw_nii))
    ref_img = nib.Nifti1Image.from_file_map({"header": fh, "image": fh})
    ref_affine = np.asarray(ref_img.affine, dtype=np.float64)

    mask_arr = np.zeros(_BRATS_SHAPE, dtype=np.uint8)
    mask_arr[100:110, 100:110, 77] = 1
    mask_arr[110:120, 100:110, 77] = 2
    mask_arr[120:126, 100:110, 77] = 4
    return _serialize_nifti_gz(mask_arr, ref_affine)


def _deterministic_worker_loop(
    *,
    api_base_url: str,
    worker_token: str,
    model_version_id: str,
    model_id: str,
    model_version: str,
    pipeline_version: str,
    stop_event: threading.Event,
) -> None:
    worker_id = "p7-deterministic-fake-worker-1"
    internal_base = f"{api_base_url.rstrip('/')}/api/v1/internal"
    headers = {"X-Worker-Token": worker_token}

    with httpx.Client(timeout=httpx.Timeout(30.0, connect=5.0)) as client:
        # Wait until live API reports ready
        while not stop_event.is_set():
            try:
                ready = client.get(f"{api_base_url.rstrip('/')}/api/v1/health/ready")
                if ready.status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            stop_event.wait(0.2)

        last_heartbeat = -2.0
        while not stop_event.is_set():
            try:
                ts = time.monotonic()
                if ts - last_heartbeat >= 2.0:
                    hb = client.post(
                        f"{internal_base}/worker/heartbeat",
                        headers=headers,
                        json={
                            "worker_id": worker_id,
                            "device_type": "CPU",
                            "model_version_id": model_version_id,
                        },
                    )
                    hb.raise_for_status()
                    last_heartbeat = ts

                claim_resp = client.post(
                    f"{internal_base}/worker/claim",
                    headers=headers,
                    json={
                        "worker_id": worker_id,
                        "device_type": "CPU",
                        "model_version_id": model_version_id,
                    },
                )
                claim_resp.raise_for_status()
                if claim_resp.status_code == 204 or not claim_resp.content:
                    stop_event.wait(0.5)
                    continue
                claim = claim_resp.json()
                if claim is None:
                    stop_event.wait(0.5)
                    continue

                job_id = str(claim["job_id"])
                attempt_id = str(claim["attempt_id"])
                lease_token = str(claim["lease_token"])
                lease_headers = {
                    **headers,
                    "X-Job-ID": job_id,
                    "X-Attempt-ID": attempt_id,
                    "X-Worker-ID": worker_id,
                    "X-Lease-Token": lease_token,
                }

                downloaded: dict[str, tuple[bytes, bool]] = {}
                for file_item in claim["files"]:
                    dl = client.get(
                        f"{internal_base}/files/{file_item['file_id']}/content",
                        headers=lease_headers,
                    )
                    dl.raise_for_status()
                    if hashlib.sha256(dl.content).hexdigest() != file_item["sha256"]:
                        raise ValueError("Downloaded worker input checksum mismatch")
                    downloaded[file_item["modality"]] = (
                        dl.content,
                        file_item["extension"] == "nii.gz",
                    )

                job_hb = client.post(
                    f"{internal_base}/jobs/{job_id}/heartbeat",
                    headers=headers,
                    json={
                        "worker_id": worker_id,
                        "attempt_id": attempt_id,
                        "lease_token": lease_token,
                        "stage": "inference",
                        "completed_slices": 78,
                        "total_slices": 155,
                    },
                )
                job_hb.raise_for_status()

                flair_bytes, is_gz = downloaded["flair"]
                mask_gz = _build_deterministic_mask_gz(flair_bytes, is_gzip=is_gz)
                coverage_bytes = json.dumps(
                    {
                        "original_shape": list(_BRATS_SHAPE),
                        "pipeline_version": pipeline_version,
                        "unevaluated_outside_crop": True,
                        "test_mode": "deterministic_fake_worker",
                        "total_slices": 155,
                        "evaluated_slices": 155,
                        "slice_crops": [
                            {
                                "z": z,
                                "x0": 40,
                                "y0": 40,
                                "x1": 200,
                                "y1": 200,
                                "center_x": 120.0,
                                "center_y": 120.0,
                                "is_empty_slice": False,
                                "evaluated": True,
                            }
                            for z in range(155)
                        ],
                    }
                ).encode("utf-8")
                metadata_bytes = json.dumps(
                    {
                        "test_mode": "deterministic_fake_worker",
                        "model_id": model_id,
                        "model_version": model_version,
                        "pipeline_version": pipeline_version,
                    }
                ).encode("utf-8")

                complete = client.post(
                    f"{internal_base}/jobs/{job_id}/complete",
                    headers={
                        **headers,
                        "X-Attempt-ID": attempt_id,
                        "X-Worker-ID": worker_id,
                        "X-Lease-Token": lease_token,
                    },
                    files={
                        "mask": ("mask.nii.gz", mask_gz, "application/gzip"),
                        "coverage": ("coverage.json", coverage_bytes, "application/json"),
                        "metadata": ("metadata.json", metadata_bytes, "application/json"),
                    },
                    timeout=60.0,
                )
                complete.raise_for_status()
            except Exception as exc:
                logger.warning(
                    "Deterministic fake worker iteration failed: %s",
                    type(exc).__name__,
                )
                stop_event.wait(0.5)


def _seed_e2e_state(
    *,
    database_url: str,
    settings: Settings,
    flair_bytes: bytes,
    t1ce_bytes: bytes,
) -> dict[str, Any]:
    storage = LocalStorageAdapter(settings.effective_storage_root)
    orientation = "".join(str(code) for code in nib.orientations.aff2axcodes(_BRATS_AFFINE))
    affine_list = [[float(cell) for cell in row] for row in _BRATS_AFFINE.tolist()]

    admin_username = "admin.e2e"
    admin_password = "AdminE2ePass!2026"
    doctor_b_username = "doctor.b.e2e"
    doctor_b_password = "DoctorBE2ePass!2026"

    engine = create_engine(database_url, hide_parameters=True)
    try:
        with Session(engine) as db:
            now = datetime.now(UTC)
            model = sync_active_model(db, settings)

            admin_user = User(
                username=admin_username,
                display_name="E2E Administrator",
                password_hash=hash_password(admin_password),
                role="admin",
                is_active=True,
                must_change_password=False,
                password_changed_at=now,
            )
            doctor_b = User(
                username=doctor_b_username,
                display_name="Dr. E2E Beta",
                password_hash=hash_password(doctor_b_password),
                role="doctor",
                is_active=True,
                must_change_password=False,
                password_changed_at=now,
            )
            db.add_all([admin_user, doctor_b])
            db.flush()

            patient_b = Patient(
                owner_id=doctor_b.id,
                patient_code="PAT-E2E-B",
                full_name="Benh Nhan E2E B",
                birth_year=1975,
                sex="female",
            )
            db.add(patient_b)
            db.flush()

            case_b = Case(
                patient_id=patient_b.id,
                owner_id=doctor_b.id,
                study_date=date.today(),
                notes="Seeded ready case for E2E Doctor B",
                readiness="ready",
                input_revision=2,
                inputs_locked_at=now - timedelta(minutes=10),
            )
            db.add(case_b)
            db.flush()

            volumes: list[Volume] = []
            for modality, payload in (("flair", flair_bytes), ("t1ce", t1ce_bytes)):
                staged = storage.put_temp(payload)
                committed = storage.commit(staged.staging_key)
                sf = StoredFile(
                    storage_key=uuid.UUID(committed.storage_key),
                    original_name=f"{modality}_valid.nii.gz",
                    size_bytes=committed.size_bytes,
                    sha256=committed.sha256,
                    media_type="application/gzip",
                    state="committed",
                    owner_id=doctor_b.id,
                )
                db.add(sf)
                db.flush()
                vol = Volume(
                    case_id=case_b.id,
                    modality=modality,
                    file_id=sf.id,
                    shape=list(_BRATS_SHAPE),
                    spacing_mm=[1.0, 1.0, 1.0],
                    affine=affine_list,
                    orientation=orientation,
                    datatype="float32",
                    size_bytes=committed.size_bytes,
                    sha256=committed.sha256,
                    validation_status="valid",
                    validation_errors=[],
                )
                db.add(vol)
                volumes.append(vol)
            db.flush()
            case_b.reference_volume_id = volumes[0].id

            failed_job = InferenceJob(
                case_id=case_b.id,
                doctor_id=doctor_b.id,
                model_version_id=model.id,
                state="failed",
                stage="inference",
                completed_slices=78,
                total_slices=155,
                attempt_count=2,
                auto_retry_count=1,
                max_auto_retries=1,
                error_code="worker_lease_expired",
                started_at=now - timedelta(minutes=8),
                finished_at=now - timedelta(minutes=5),
            )
            db.add(failed_job)
            db.flush()
            for attempt_num in (1, 2):
                db.add(
                    JobAttempt(
                        job_id=failed_job.id,
                        attempt_number=attempt_num,
                        worker_id=f"seeded-worker-{attempt_num}",
                        state="expired",
                        lease_token_hash=hashlib.sha256(
                            f"seeded-lease-{attempt_num}".encode()
                        ).hexdigest(),
                        lease_expires_at=now - timedelta(minutes=6 - attempt_num),
                        stage="inference",
                        completed_slices=78,
                        total_slices=155,
                        error_code="worker_lost",
                        started_at=now - timedelta(minutes=8 - attempt_num),
                        finished_at=now - timedelta(minutes=6 - attempt_num),
                    )
                )
            db.commit()

            return {
                "admin_username": admin_username,
                "admin_password": admin_password,
                "doctor_b_username": doctor_b_username,
                "doctor_b_password": doctor_b_password,
                "doctor_b_case_id": str(case_b.id),
                "failed_job_id": str(failed_job.id),
                "model_version_id": model.id,
                "model_id": model.model_id,
                "model_version": model.version,
                "pipeline_version": model.pipeline_version,
            }
    finally:
        engine.dispose()


def _write_state_file(state_file: Path, payload: dict[str, Any]) -> None:
    resolved = state_file.resolve(strict=False)
    resolved.parent.mkdir(parents=True, exist_ok=True)
    tmp_file = resolved.parent / f".tmp-{uuid.uuid4().hex}.json"
    try:
        tmp_file.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp_file, resolved)
    finally:
        tmp_file.unlink(missing_ok=True)


def run_stack(
    *,
    host: str,
    port: int,
    database_url: str,
    web_origin: str,
    state_file: Path,
) -> int:
    """Provision isolated DB/storage/fixtures, start deterministic fake worker, and run API."""
    _assert_safe_e2e_database(database_url)
    _recreate_e2e_database(database_url)
    _run_migrations_head(database_url)

    tmp_dir = tempfile.TemporaryDirectory(prefix="bts-p7-e2e-")
    stop_event = threading.Event()
    worker_thread: threading.Thread | None = None
    try:
        workspace = Path(tmp_dir.name)
        priv_path, pub_path = generate_rsa_keypair(
            workspace / "keys" / "jwt-private.pem",
            workspace / "keys" / "jwt-public.pem",
        )
        storage_root = workspace / "storage"
        storage_root.mkdir(parents=True, exist_ok=True)

        fixtures_dir = workspace / "fixtures"
        fixtures_dir.mkdir(parents=True, exist_ok=True)
        flair_bytes, t1ce_bytes = _build_synthetic_brats_pair()
        flair_path = fixtures_dir / "flair_valid.nii.gz"
        t1ce_path = fixtures_dir / "t1ce_valid.nii.gz"
        flair_path.write_bytes(flair_bytes)
        t1ce_path.write_bytes(t1ce_bytes)

        worker_token = secrets.token_urlsafe(24)
        api_base_url = f"http://{host}:{port}"
        settings = Settings(
            _env_file=None,
            APP_ENV="test",
            DATABASE_URL=database_url,
            STORAGE_ROOT=storage_root,
            PUBLIC_ORIGIN=web_origin,
            ALLOWED_ORIGINS=[web_origin],
            COOKIE_SECURE=False,
            JWT_PRIVATE_KEY_PATH=priv_path,
            JWT_PUBLIC_KEY_PATH=pub_path,
            JWT_KEY_ID="p7-e2e-rs256-v1",
            JWT_ISSUER="brain-tumor-api",
            JWT_AUDIENCE="brain-tumor-web",
            MODEL_MANIFEST_PATH=_BE_DIR / "worker" / "manifest.json",
            WORKER_API_BASE_URL=api_base_url,
            WORKER_TOKEN=worker_token,
            WORKER_DEVICE="cpu",
        )

        seeded = _seed_e2e_state(
            database_url=database_url,
            settings=settings,
            flair_bytes=flair_bytes,
            t1ce_bytes=t1ce_bytes,
        )

        worker_thread = threading.Thread(
            target=_deterministic_worker_loop,
            kwargs={
                "api_base_url": api_base_url,
                "worker_token": worker_token,
                "model_version_id": seeded["model_version_id"],
                "model_id": seeded["model_id"],
                "model_version": seeded["model_version"],
                "pipeline_version": seeded["pipeline_version"],
                "stop_event": stop_event,
            },
            daemon=True,
            name="p7-fake-worker",
        )
        worker_thread.start()

        _write_state_file(
            state_file,
            {
                "api_base_url": api_base_url,
                "web_origin": web_origin,
                "admin_username": seeded["admin_username"],
                "admin_password": seeded["admin_password"],
                "doctor_b_username": seeded["doctor_b_username"],
                "doctor_b_password": seeded["doctor_b_password"],
                "doctor_b_case_id": seeded["doctor_b_case_id"],
                "failed_job_id": seeded["failed_job_id"],
                "flair_nifti_path": str(flair_path),
                "t1ce_nifti_path": str(t1ce_path),
                "worker_mode": "deterministic_fake_worker",
            },
        )

        application = create_app(settings=settings)
        server = uvicorn.Server(
            uvicorn.Config(
                application,
                host=host,
                port=port,
                log_level="warning",
            )
        )
        server.run()
        return 0
    finally:
        stop_event.set()
        if worker_thread is not None:
            worker_thread.join(timeout=3.0)
        tmp_dir.cleanup()


def main(argv: list[str] | None = None) -> int:
    """CLI entrypoint for launching the isolated Playwright E2E backend + worker stack."""
    parser = argparse.ArgumentParser(
        description="Run isolated P7 E2E backend API + deterministic fake worker."
    )
    parser.add_argument("--port", type=int, default=8017)
    parser.add_argument("--host", type=str, default="127.0.0.1")
    parser.add_argument(
        "--database-url",
        type=str,
        default="postgresql+psycopg://bts_user:bts_local_dev_pw@127.0.0.1:5432/bts_e2e_test",
    )
    parser.add_argument("--web-origin", type=str, default="http://127.0.0.1:5177")
    parser.add_argument("--state-file", type=Path, required=True)
    args = parser.parse_args(argv)

    try:
        return run_stack(
            host=args.host,
            port=args.port,
            database_url=args.database_url,
            web_origin=args.web_origin,
            state_file=args.state_file,
        )
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
