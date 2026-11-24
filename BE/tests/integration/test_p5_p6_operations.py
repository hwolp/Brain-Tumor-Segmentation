"""HTTP integration checks for P5 job lifecycle and P6 operations APIs."""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from threading import Barrier
from typing import Any
from unittest.mock import patch

import nibabel as nib
import numpy as np
import pytest
from argon2 import PasswordHasher
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.core.storage import LocalStorageAdapter
from app.main import create_app
from app.models.case import Case
from app.models.inference_job import InferenceJob, JobAttempt
from app.models.mask_version import MaskVersion
from app.models.patient import Patient
from app.models.stored_file import StoredFile
from app.models.user import User
from app.models.volume import Volume
from app.services.job_service import reap_expired_attempts

_HASHER = PasswordHasher()
_PASSWORD = "P5P6Integration123!"
_WORKER_TOKEN = "p5-p6-test-worker-token"
_MODEL_VERSION = "tda-seg-unet:cce-dice-ep136"
_CASE_SHAPE = (240, 240, 155)
_CASE_AFFINE: list[list[float]] = [
    [1.0, 0.0, 0.0, -120.0],
    [0.0, 1.0, 0.0, -120.0],
    [0.0, 0.0, 1.0, -78.0],
    [0.0, 0.0, 0.0, 1.0],
]


@pytest.fixture()
def clean_p5_p6_db(migrated_postgres: str) -> Iterator[None]:
    engine = create_engine(migrated_postgres)
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "TRUNCATE TABLE job_create_idempotency_keys, job_attempts, worker_instances, "
                    "inference_jobs, model_versions, mask_save_idempotency_keys, mask_versions, "
                    "volumes, stored_files, case_create_idempotency_keys, cases, patients, "
                    "system_settings, audit_events, login_attempts, refresh_tokens, "
                    "sessions, users RESTART IDENTITY CASCADE"
                )
            )
        yield
    finally:
        engine.dispose()


@pytest.fixture()
def p5_p6_db(clean_p5_p6_db: None, migrated_postgres: str) -> Iterator[Session]:
    engine = create_engine(migrated_postgres)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    try:
        with factory() as db:
            yield db
    finally:
        engine.dispose()


@pytest.fixture()
def p5_p6_settings(test_settings: Settings) -> Settings:
    return test_settings.model_copy(update={"WORKER_TOKEN": _WORKER_TOKEN})


@pytest.fixture()
def p5_p6_client(
    clean_p5_p6_db: None, p5_p6_settings: Settings
) -> Iterator[TestClient]:
    with TestClient(create_app(settings=p5_p6_settings), raise_server_exceptions=False) as client:
        yield client


def _make_nifti_gz_bytes(
    data: np.ndarray,
    *,
    affine: list[list[float]] | None = None,
) -> bytes:
    aff = np.asarray(affine if affine is not None else _CASE_AFFINE, dtype=np.float64)
    img = nib.Nifti1Image(data, aff)
    img.header.set_xyzt_units("mm", "sec")
    img.set_qform(aff, code=1)
    img.set_sform(aff, code=1)
    bio = io.BytesIO()
    fmap = img.make_file_map({"image": bio, "header": bio})
    img.to_file_map(fmap)
    return gzip.compress(bio.getvalue(), compresslevel=1)


def _make_mask_gz_bytes(
    *,
    label_coords: dict[tuple[int, int, int], int] | None = None,
) -> bytes:
    arr = np.zeros(_CASE_SHAPE, dtype=np.uint8)
    if label_coords:
        for coords, label in label_coords.items():
            arr[coords] = label
    return _make_nifti_gz_bytes(arr)


def _seed_user(db: Session, *, username: str, role: str) -> User:
    user = User(
        username=username,
        display_name=f"Display {username}",
        password_hash=_HASHER.hash(_PASSWORD),
        role=role,
        is_active=True,
        must_change_password=False,
        password_changed_at=datetime.now(UTC),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _seed_ready_case(
    db: Session,
    doctor: User,
    *,
    storage_root: Path | None = None,
    modalities: tuple[str, ...] = ("flair", "t1ce"),
) -> tuple[uuid.UUID, str]:
    patient = Patient(
        owner_id=doctor.id,
        patient_code=f"P5-{uuid.uuid4().hex[:10]}",
        full_name="Test Patient Name Must Not Reach Admin",
        birth_year=1980,
        sex="unknown",
    )
    db.add(patient)
    db.flush()
    case = Case(
        patient_id=patient.id,
        owner_id=doctor.id,
        study_date=date.today(),
        notes="Private clinical note must not reach admin APIs.",
        readiness="ready" if set(modalities) == {"flair", "t1ce"} else "missing_inputs",
        input_revision=len(modalities),
    )
    db.add(case)
    db.flush()

    adapter = LocalStorageAdapter(storage_root) if storage_root is not None else None
    real_nifti = (
        _make_nifti_gz_bytes(np.zeros(_CASE_SHAPE, dtype=np.float32))
        if adapter is not None
        else None
    )

    volumes: list[Volume] = []
    for idx, modality in enumerate(modalities):
        if adapter is not None and real_nifti is not None:
            payload = real_nifti if idx == 0 else _make_nifti_gz_bytes(
                np.ones(_CASE_SHAPE, dtype=np.float32)
            )
            staged = adapter.put_temp(payload)
            committed = adapter.commit(staged.staging_key)
            s_key = uuid.UUID(committed.storage_key)
            size_bytes = committed.size_bytes
            sha256 = committed.sha256
        else:
            s_key = uuid.uuid4()
            size_bytes = 1024
            sha256 = ("a" if modality == "flair" else "b") * 64

        stored_file = StoredFile(
            storage_key=s_key,
            original_name=f"{modality}.nii.gz",
            size_bytes=size_bytes,
            sha256=sha256,
            media_type="application/gzip",
            state="committed",
            owner_id=doctor.id,
        )
        db.add(stored_file)
        db.flush()
        volume = Volume(
            case_id=case.id,
            modality=modality,
            file_id=stored_file.id,
            shape=list(_CASE_SHAPE),
            spacing_mm=[1.0, 1.0, 1.0],
            affine=_CASE_AFFINE,
            orientation="RAS",
            datatype="float32",
            size_bytes=size_bytes,
            sha256=stored_file.sha256,
            validation_status="valid",
            validation_errors=[],
        )
        db.add(volume)
        volumes.append(volume)
    db.flush()
    if volumes:
        case.reference_volume_id = volumes[0].id
    db.commit()
    return case.id, patient.full_name


def _login(client: TestClient, username: str) -> str:
    response = client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": _PASSWORD},
    )
    assert response.status_code == 200, response.text
    return response.json()["access_token"]


def _doctor_job(
    client: TestClient, doctor_token: str, case_id: uuid.UUID, key: str | None = None
) -> Any:
    return client.post(
        f"/api/v1/cases/{case_id}/jobs",
        headers={
            "Authorization": f"Bearer {doctor_token}",
            "Idempotency-Key": key or str(uuid.uuid4()),
        },
        json={},
    )


def _claim_job(client: TestClient, worker_id: str = "worker-test-01") -> Any:
    return client.post(
        "/api/v1/internal/worker/claim",
        headers={"X-Worker-Token": _WORKER_TOKEN},
        json={
            "worker_id": worker_id,
            "device_type": "CPU",
            "model_version_id": _MODEL_VERSION,
        },
    )


def _complete_multipart(
    client: TestClient,
    *,
    job_id: str,
    attempt_id: str,
    worker_id: str,
    lease_token: str,
    mask_bytes: bytes,
    coverage_obj: dict[str, object] | None = None,
    metadata_obj: dict[str, object] | None = None,
) -> Any:
    cov_raw = json.dumps(
        coverage_obj
        if coverage_obj is not None
        else {
            "pipeline_version": "tda-segunet-2d-v1",
            "original_shape": list(_CASE_SHAPE),
            "evaluated_slices": 155,
            "slice_crops": [
                {"z": z, "x0": 0, "y0": 0, "x1": 128, "y1": 128, "evaluated": True}
                for z in range(_CASE_SHAPE[2])
            ],
        }
    ).encode("utf-8")
    meta_raw = json.dumps(
        metadata_obj
        if metadata_obj is not None
        else {
            "model_version_id": _MODEL_VERSION,
            "pipeline_version": "tda-segunet-2d-v1",
        }
    ).encode("utf-8")
    return client.post(
        f"/api/v1/internal/jobs/{job_id}/complete",
        headers={
            "X-Worker-Token": _WORKER_TOKEN,
            "X-Attempt-ID": attempt_id,
            "X-Worker-ID": worker_id,
            "X-Lease-Token": lease_token,
        },
        files={
            "mask": ("mask.nii.gz", mask_bytes, "application/gzip"),
            "coverage": ("coverage.json", cov_raw, "application/json"),
            "metadata": ("metadata.json", meta_raw, "application/json"),
        },
    )


def test_doctor_job_idempotency_active_conflict_and_worker_claim(
    p5_p6_client: TestClient,
    p5_p6_db: Session,
) -> None:
    doctor = _seed_user(p5_p6_db, username="doctor.jobs", role="doctor")
    case_id, _ = _seed_ready_case(p5_p6_db, doctor)
    incomplete_case_id, _ = _seed_ready_case(p5_p6_db, doctor, modalities=("flair",))
    doctor_token = _login(p5_p6_client, doctor.username)
    idem_key = str(uuid.uuid4())

    avail_before = p5_p6_client.get(
        "/api/v1/system/availability",
        headers={"Authorization": f"Bearer {doctor_token}"},
    )
    assert avail_before.status_code == 200, avail_before.text
    assert avail_before.json()["accepting_jobs"] is True
    assert avail_before.json()["worker_online"] is False
    assert avail_before.json()["active_model_id"] == _MODEL_VERSION

    missing_key = p5_p6_client.post(
        f"/api/v1/cases/{case_id}/jobs",
        headers={"Authorization": f"Bearer {doctor_token}"},
    )
    assert missing_key.status_code == 422

    not_ready = _doctor_job(p5_p6_client, doctor_token, incomplete_case_id)
    assert not_ready.status_code == 422
    assert not_ready.json()["error"]["code"] == "case_not_ready"

    first = _doctor_job(p5_p6_client, doctor_token, case_id, idem_key)
    replay = _doctor_job(p5_p6_client, doctor_token, case_id, idem_key)
    conflict = _doctor_job(p5_p6_client, doctor_token, case_id)
    assert first.status_code == 202, first.text
    assert replay.status_code == 202, replay.text
    assert first.json()["job"]["id"] == replay.json()["job"]["id"]
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "active_job_conflict"

    job_id = first.json()["job"]["id"]
    hb_worker = p5_p6_client.post(
        "/api/v1/internal/worker/heartbeat",
        headers={"X-Worker-Token": _WORKER_TOKEN},
        json={
            "worker_id": "worker-test-01",
            "device_type": "CPU",
            "model_version_id": _MODEL_VERSION,
        },
    )
    assert hb_worker.status_code == 204
    avail_after = p5_p6_client.get(
        "/api/v1/system/availability",
        headers={"Authorization": f"Bearer {doctor_token}"},
    )
    assert avail_after.status_code == 200
    assert avail_after.json()["worker_online"] is True

    claim = _claim_job(p5_p6_client, "worker-test-01")
    assert claim.status_code == 200, claim.text
    claim_data = claim.json()
    assert claim_data["job_id"] == job_id
    assert len(claim_data["files"]) == 2
    assert {file["extension"] for file in claim_data["files"]} == {"nii.gz"}

    bad_hb = p5_p6_client.post(
        f"/api/v1/internal/jobs/{job_id}/heartbeat",
        headers={"X-Worker-Token": _WORKER_TOKEN},
        json={
            "worker_id": "worker-test-01",
            "attempt_id": claim_data["attempt_id"],
            "lease_token": claim_data["lease_token"],
            "stage": "inference",
            "completed_slices": 160,
            "total_slices": 155,
        },
    )
    assert bad_hb.status_code == 422

    heartbeat = p5_p6_client.post(
        f"/api/v1/internal/jobs/{job_id}/heartbeat",
        headers={"X-Worker-Token": _WORKER_TOKEN},
        json={
            "worker_id": "worker-test-01",
            "attempt_id": claim_data["attempt_id"],
            "lease_token": claim_data["lease_token"],
            "stage": "inference",
            "completed_slices": 12,
            "total_slices": 155,
        },
    )
    assert heartbeat.status_code == 200, heartbeat.text
    assert heartbeat.json()["stage"] == "inference"
    assert heartbeat.json()["completed_slices"] == 12

    visible = p5_p6_client.get(
        f"/api/v1/jobs/{job_id}", headers={"Authorization": f"Bearer {doctor_token}"}
    )
    assert visible.status_code == 200
    assert visible.json()["state"] == "running"

    history = p5_p6_client.get(
        f"/api/v1/cases/{case_id}/jobs",
        headers={"Authorization": f"Bearer {doctor_token}"},
    )
    assert history.status_code == 200
    assert history.json()["total"] == 1
    assert history.json()["items"][0]["id"] == job_id


def test_worker_token_is_required_and_admin_settings_use_optimistic_version(
    p5_p6_client: TestClient,
    p5_p6_db: Session,
) -> None:
    admin = _seed_user(p5_p6_db, username="admin.ops", role="admin")
    admin_token = _login(p5_p6_client, admin.username)
    denied = p5_p6_client.post(
        "/api/v1/internal/worker/heartbeat",
        json={"worker_id": "worker-unauth", "device_type": "CPU"},
    )
    assert denied.status_code == 401
    assert denied.json()["error"]["code"] == "worker_unauthenticated"

    wrong_tok = p5_p6_client.post(
        "/api/v1/internal/worker/heartbeat",
        headers={"X-Worker-Token": "wrong-worker-token"},
        json={"worker_id": "worker-unauth", "device_type": "CPU"},
    )
    assert wrong_tok.status_code == 401

    current = p5_p6_client.get(
        "/api/v1/admin/settings", headers={"Authorization": f"Bearer {admin_token}"}
    )
    assert current.status_code == 200, current.text

    extra_field_resp = p5_p6_client.patch(
        "/api/v1/admin/settings",
        headers={"Authorization": f"Bearer {admin_token}"},
        json=current.json(),
    )
    assert extra_field_resp.status_code == 422

    base_settings = {k: v for k, v in current.json().items() if k != "updated_at"}
    payload = {
        **base_settings,
        "accepting_jobs": False,
        "max_upload_mib": 80,
        "max_decompressed_mib": 200,
        "default_doctor_quota_gib": 1,
        "system_quota_gib": 15,
    }
    updated = p5_p6_client.patch(
        "/api/v1/admin/settings",
        headers={"Authorization": f"Bearer {admin_token}"},
        json=payload,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["version"] == current.json()["version"] + 1
    assert updated.json()["accepting_jobs"] is False
    stale = p5_p6_client.patch(
        "/api/v1/admin/settings",
        headers={"Authorization": f"Bearer {admin_token}"},
        json=payload,
    )
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "settings_version_conflict"


def test_admin_job_listing_and_audit_do_not_expose_patient_clinical_content(
    p5_p6_client: TestClient,
    p5_p6_db: Session,
) -> None:
    doctor = _seed_user(p5_p6_db, username="doctor.private", role="doctor")
    admin = _seed_user(p5_p6_db, username="admin.private", role="admin")
    case_id, private_name = _seed_ready_case(p5_p6_db, doctor)
    doctor_token = _login(p5_p6_client, doctor.username)
    admin_token = _login(p5_p6_client, admin.username)
    created = _doctor_job(p5_p6_client, doctor_token, case_id)
    assert created.status_code == 202, created.text

    p5_p6_client.post(
        "/api/v1/internal/worker/heartbeat",
        headers={"X-Worker-Token": _WORKER_TOKEN},
        json={
            "worker_id": "worker-ops-01",
            "device_type": "GPU",
            "model_version_id": _MODEL_VERSION,
        },
    )

    for path in (
        "/api/v1/admin/overview",
        "/api/v1/admin/jobs",
        "/api/v1/admin/workers",
        "/api/v1/admin/models",
        "/api/v1/admin/audit-events",
    ):
        resp = p5_p6_client.get(path, headers={"Authorization": f"Bearer {admin_token}"})
        assert resp.status_code == 200, f"{path}: {resp.text}"
        assert private_name not in resp.text
        assert "Private clinical note" not in resp.text
        assert "best.pt" not in resp.text

    # Wildcard characters (% and _) in ILIKE search must be escaped literally
    pct_jobs = p5_p6_client.get(
        "/api/v1/admin/jobs",
        params={"q": "100%"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert pct_jobs.status_code == 200
    assert pct_jobs.json()["total"] == 0

    underscore_jobs = p5_p6_client.get(
        "/api/v1/admin/jobs",
        params={"q": "doctor_private"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert underscore_jobs.status_code == 200
    assert underscore_jobs.json()["total"] == 0

    pct_audit = p5_p6_client.get(
        "/api/v1/admin/audit-events",
        params={"q": "100%"},
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert pct_audit.status_code == 200
    assert pct_audit.json()["total"] == 0


def test_qa_job_02_concurrent_workers_claim_only_one_wins(
    p5_p6_client: TestClient,
    p5_p6_db: Session,
    p5_p6_settings: Settings,
) -> None:
    doctor = _seed_user(p5_p6_db, username="doctor.claimrace", role="doctor")
    admin = _seed_user(p5_p6_db, username="admin.claimrace", role="admin")
    case_id, _ = _seed_ready_case(p5_p6_db, doctor)
    doctor_token = _login(p5_p6_client, doctor.username)
    admin_token = _login(p5_p6_client, admin.username)

    created = _doctor_job(p5_p6_client, doctor_token, case_id)
    assert created.status_code == 202, created.text
    job_id = created.json()["job"]["id"]

    app_instance = create_app(settings=p5_p6_settings)
    barrier = Barrier(2)

    def _worker_claim(worker_id: str) -> tuple[int, Any]:
        with TestClient(app_instance, raise_server_exceptions=False) as local_client:
            barrier.wait(timeout=5)
            resp = local_client.post(
                "/api/v1/internal/worker/claim",
                headers={"X-Worker-Token": _WORKER_TOKEN},
                json={
                    "worker_id": worker_id,
                    "device_type": "CPU",
                    "model_version_id": _MODEL_VERSION,
                },
            )
            return resp.status_code, (None if resp.status_code == 204 else resp.json())

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(_worker_claim, ["worker-race-1", "worker-race-2"]))

    assert sorted(status for status, _ in outcomes) == [200, 204]
    claimed = [body for _, body in outcomes if body is not None]
    unclaimed = [body for _, body in outcomes if body is None]
    assert len(claimed) == 1
    assert len(unclaimed) == 1
    assert claimed[0]["job_id"] == job_id
    assert claimed[0]["attempt_number"] == 1

    detail = p5_p6_client.get(
        f"/api/v1/admin/jobs/{job_id}",
        headers={"Authorization": f"Bearer {admin_token}"},
    )
    assert detail.status_code == 200
    assert detail.json()["attempt_count"] == 1
    assert len(detail.json()["attempts"]) == 1


def test_cancel_queued_job_unlocks_inputs_and_running_job_returns_409(
    p5_p6_client: TestClient,
    p5_p6_db: Session,
) -> None:
    doctor = _seed_user(p5_p6_db, username="doctor.cancel", role="doctor")
    case_id, _ = _seed_ready_case(p5_p6_db, doctor)
    doctor_token = _login(p5_p6_client, doctor.username)
    auth_hdr = {"Authorization": f"Bearer {doctor_token}"}

    queued = _doctor_job(p5_p6_client, doctor_token, case_id)
    assert queued.status_code == 202
    job1_id = queued.json()["job"]["id"]

    case_locked = p5_p6_client.get(f"/api/v1/cases/{case_id}", headers=auth_hdr)
    assert case_locked.status_code == 200
    assert case_locked.json()["is_inputs_locked"] is True
    assert case_locked.json()["inputs_locked_at"] is not None

    cancelled = p5_p6_client.post(f"/api/v1/jobs/{job1_id}/cancel", headers=auth_hdr)
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["state"] == "cancelled"
    assert cancelled.json()["finished_at"] is not None

    case_unlocked = p5_p6_client.get(f"/api/v1/cases/{case_id}", headers=auth_hdr)
    assert case_unlocked.status_code == 200
    assert case_unlocked.json()["inputs_locked_at"] is None
    assert case_unlocked.json()["is_inputs_locked"] is False

    cancel_again = p5_p6_client.post(f"/api/v1/jobs/{job1_id}/cancel", headers=auth_hdr)
    assert cancel_again.status_code == 409
    assert cancel_again.json()["error"]["code"] == "job_not_cancellable"

    queued2 = _doctor_job(p5_p6_client, doctor_token, case_id)
    assert queued2.status_code == 202
    job2_id = queued2.json()["job"]["id"]
    claim = _claim_job(p5_p6_client, "worker-cancel-01")
    assert claim.status_code == 200
    assert claim.json()["job_id"] == job2_id

    cancel_running = p5_p6_client.post(f"/api/v1/jobs/{job2_id}/cancel", headers=auth_hdr)
    assert cancel_running.status_code == 409
    assert cancel_running.json()["error"]["code"] == "job_not_cancellable"
    running_state = p5_p6_client.get(f"/api/v1/jobs/{job2_id}", headers=auth_hdr).json()["state"]
    assert running_state == "running"


def test_qa_job_03_lease_expiry_reaper_retry_stale_attempt_and_worker_lost(
    p5_p6_client: TestClient,
    p5_p6_db: Session,
) -> None:
    doctor = _seed_user(p5_p6_db, username="doctor.reaper", role="doctor")
    case_id, _ = _seed_ready_case(p5_p6_db, doctor)
    doctor_token = _login(p5_p6_client, doctor.username)

    created = _doctor_job(p5_p6_client, doctor_token, case_id)
    assert created.status_code == 202
    job_id = created.json()["job"]["id"]

    claim1 = _claim_job(p5_p6_client, "worker-reaper-1").json()
    assert claim1["attempt_number"] == 1

    attempt1 = p5_p6_db.get(JobAttempt, uuid.UUID(claim1["attempt_id"]))
    assert attempt1 is not None
    attempt1.lease_expires_at = datetime.now(UTC) - timedelta(seconds=5)
    p5_p6_db.commit()

    # 1st lease expiry -> requeues job with auto_retry_count == 1
    assert reap_expired_attempts(p5_p6_db) == 1
    p5_p6_db.expire_all()
    job_row = p5_p6_db.get(InferenceJob, uuid.UUID(job_id))
    assert job_row is not None
    assert job_row.state == "queued"
    assert job_row.stage == "queued"
    assert job_row.auto_retry_count == 1
    assert job_row.error_code == "worker_retry"

    # Stale Attempt #1 must be rejected with 409 stale_attempt on heartbeat/fail/complete
    stale_hb = p5_p6_client.post(
        f"/api/v1/internal/jobs/{job_id}/heartbeat",
        headers={"X-Worker-Token": _WORKER_TOKEN},
        json={
            "worker_id": "worker-reaper-1",
            "attempt_id": claim1["attempt_id"],
            "lease_token": claim1["lease_token"],
            "stage": "inference",
            "completed_slices": 50,
            "total_slices": 155,
        },
    )
    assert stale_hb.status_code == 409
    assert stale_hb.json()["error"]["code"] == "stale_attempt"

    stale_fail = p5_p6_client.post(
        f"/api/v1/internal/jobs/{job_id}/fail",
        headers={"X-Worker-Token": _WORKER_TOKEN},
        json={
            "worker_id": "worker-reaper-1",
            "attempt_id": claim1["attempt_id"],
            "lease_token": claim1["lease_token"],
            "error_code": "inference_error",
        },
    )
    assert stale_fail.status_code == 409
    assert stale_fail.json()["error"]["code"] == "stale_attempt"

    stale_complete = _complete_multipart(
        p5_p6_client,
        job_id=job_id,
        attempt_id=claim1["attempt_id"],
        worker_id="worker-reaper-1",
        lease_token=claim1["lease_token"],
        mask_bytes=_make_mask_gz_bytes(label_coords={(5, 5, 5): 1}),
    )
    assert stale_complete.status_code == 409
    assert stale_complete.json()["error"]["code"] == "stale_attempt"
    assert p5_p6_db.scalars(select(MaskVersion).where(MaskVersion.case_id == case_id)).all() == []

    # Worker 2 claims Attempt #2; expiring Attempt #2 marks job failed with worker_lost
    claim2 = _claim_job(p5_p6_client, "worker-reaper-2").json()
    assert claim2["job_id"] == job_id
    assert claim2["attempt_number"] == 2

    attempt2 = p5_p6_db.get(JobAttempt, uuid.UUID(claim2["attempt_id"]))
    assert attempt2 is not None
    attempt2.lease_expires_at = datetime.now(UTC) - timedelta(seconds=5)
    p5_p6_db.commit()

    assert reap_expired_attempts(p5_p6_db) == 1
    p5_p6_db.expire_all()
    failed_job = p5_p6_db.get(InferenceJob, uuid.UUID(job_id))
    assert failed_job is not None
    assert failed_job.state == "failed"
    assert failed_job.error_code == "worker_lost"
    assert failed_job.finished_at is not None

    # Queue is now empty (no infinite auto-retry loop) -> HTTP 204 No Content
    empty_claim = _claim_job(p5_p6_client, "worker-reaper-3")
    assert empty_claim.status_code == 204
    assert empty_claim.content == b""


def test_qa_job_04_and_qa_mask_06_complete_preserves_manual_mask_rejects_bad_data_and_replays(
    p5_p6_client: TestClient,
    p5_p6_db: Session,
    p5_p6_settings: Settings,
) -> None:
    storage_root = p5_p6_settings.effective_storage_root
    doctor = _seed_user(p5_p6_db, username="doctor.complete", role="doctor")
    case_id, _ = _seed_ready_case(p5_p6_db, doctor, storage_root=storage_root)
    doctor_token = _login(p5_p6_client, doctor.username)
    auth_hdr = {"Authorization": f"Bearer {doctor_token}"}

    case_row = p5_p6_db.get(Case, case_id)
    assert case_row is not None and case_row.reference_volume_id is not None
    ref_vol_id = str(case_row.reference_volume_id)

    # Save an initial manual MaskVersion v1 before AI job completes (QA-MASK-06)
    manual_mask_bytes = _make_mask_gz_bytes(label_coords={(10, 10, 10): 1, (11, 10, 10): 2})
    manual_resp = p5_p6_client.post(
        f"/api/v1/cases/{case_id}/mask-versions",
        headers={**auth_hdr, "Idempotency-Key": str(uuid.uuid4())},
        data={"reference_volume_id": ref_vol_id, "note": "Manual draft v1"},
        files={"mask": ("manual.nii.gz", manual_mask_bytes, "application/gzip")},
    )
    assert manual_resp.status_code == 201, manual_resp.text
    manual_v1 = manual_resp.json()
    assert manual_v1["version_number"] == 1
    assert manual_v1["source"] == "manual"

    created = _doctor_job(p5_p6_client, doctor_token, case_id)
    assert created.status_code == 202
    job_id = created.json()["job"]["id"]
    claim = _claim_job(p5_p6_client, "worker-complete-1").json()

    # Worker downloads input files with valid lease; wrong lease or non-input file fails
    for file_item in claim["files"]:
        dl = p5_p6_client.get(
            f"/api/v1/internal/files/{file_item['file_id']}/content",
            headers={
                "X-Worker-Token": _WORKER_TOKEN,
                "X-Job-ID": job_id,
                "X-Attempt-ID": claim["attempt_id"],
                "X-Worker-ID": "worker-complete-1",
                "X-Lease-Token": claim["lease_token"],
            },
        )
        assert dl.status_code == 200
        assert dl.headers.get("cache-control") == "no-store"
        assert hashlib.sha256(dl.content).hexdigest() == file_item["sha256"]

    bad_lease_dl = p5_p6_client.get(
        f"/api/v1/internal/files/{claim['files'][0]['file_id']}/content",
        headers={
            "X-Worker-Token": _WORKER_TOKEN,
            "X-Job-ID": job_id,
            "X-Attempt-ID": claim["attempt_id"],
            "X-Worker-ID": "worker-complete-1",
            "X-Lease-Token": "x" * 43,
        },
    )
    assert bad_lease_dl.status_code == 409
    assert bad_lease_dl.json()["error"]["code"] == "stale_attempt"

    mask_file_dl = p5_p6_client.get(
        f"/api/v1/internal/files/{manual_v1['file_id']}/content",
        headers={
            "X-Worker-Token": _WORKER_TOKEN,
            "X-Job-ID": job_id,
            "X-Attempt-ID": claim["attempt_id"],
            "X-Worker-ID": "worker-complete-1",
            "X-Lease-Token": claim["lease_token"],
        },
    )
    assert mask_file_dl.status_code == 404

    # Corrupt NIfTI & invalid mask label {3} at complete are rejected without partial state
    for bad_mask in (b"corrupt-mask-payload", _make_mask_gz_bytes(label_coords={(5, 5, 5): 3})):
        bad_complete = _complete_multipart(
            p5_p6_client,
            job_id=job_id,
            attempt_id=claim["attempt_id"],
            worker_id="worker-complete-1",
            lease_token=claim["lease_token"],
            mask_bytes=bad_mask,
        )
        assert bad_complete.status_code == 422

    # Storage failure on 2nd commit (coverage) cleans up 1st committed object & keeps job running
    objects_dir = storage_root / "objects"
    before_objects = set(objects_dir.rglob("*")) if objects_dir.exists() else set()
    real_commit = LocalStorageAdapter.commit
    commit_calls = 0

    def _fail_second_commit(self: LocalStorageAdapter, staging_key: str):
        nonlocal commit_calls
        commit_calls += 1
        if commit_calls == 2:
            raise OSError("simulated disk full")
        return real_commit(self, staging_key)

    ai_mask_bytes = _make_mask_gz_bytes(label_coords={(20, 20, 20): 4, (21, 20, 20): 2})
    with patch.object(LocalStorageAdapter, "commit", _fail_second_commit):
        disk_fail = _complete_multipart(
            p5_p6_client,
            job_id=job_id,
            attempt_id=claim["attempt_id"],
            worker_id="worker-complete-1",
            lease_token=claim["lease_token"],
            mask_bytes=ai_mask_bytes,
        )
    assert disk_fail.status_code == 500
    after_objects = {p for p in objects_dir.rglob("*") if p.is_file()}
    before_files = {p for p in before_objects if p.is_file()}
    assert after_objects == before_files
    still_running = p5_p6_client.get(f"/api/v1/jobs/{job_id}", headers=auth_hdr).json()["state"]
    assert still_running == "running"

    # Valid complete creates immutable AI MaskVersion v2 without overwriting manual v1
    succeeded = _complete_multipart(
        p5_p6_client,
        job_id=job_id,
        attempt_id=claim["attempt_id"],
        worker_id="worker-complete-1",
        lease_token=claim["lease_token"],
        mask_bytes=ai_mask_bytes,
    )
    assert succeeded.status_code == 200, succeeded.text
    ai_v2_id = succeeded.json()["job"]["result_mask_version_id"]
    assert ai_v2_id is not None
    assert ai_v2_id != manual_v1["id"]

    versions = p5_p6_client.get(
        f"/api/v1/cases/{case_id}/mask-versions", headers=auth_hdr
    ).json()
    assert versions["total"] == 2
    by_num = {item["version_number"]: item for item in versions["items"]}
    assert by_num[1]["id"] == manual_v1["id"]
    assert by_num[1]["source"] == "manual"
    assert by_num[1]["note"] == "Manual draft v1"
    assert by_num[1]["label_voxel_counts"] == {"1": 1, "2": 1, "4": 0}
    assert by_num[2]["id"] == ai_v2_id
    assert by_num[2]["source"] == "ai"
    assert by_num[2]["label_voxel_counts"] == {"1": 0, "2": 1, "4": 1}

    v1_export = p5_p6_client.get(
        f"/api/v1/mask-versions/{manual_v1['id']}/export", headers=auth_hdr
    )
    assert v1_export.status_code == 200
    assert len(v1_export.content) > 0

    # Idempotent replay with identical payload returns same result; mismatched payload -> 409
    replay = _complete_multipart(
        p5_p6_client,
        job_id=job_id,
        attempt_id=claim["attempt_id"],
        worker_id="worker-complete-1",
        lease_token=claim["lease_token"],
        mask_bytes=ai_mask_bytes,
    )
    assert replay.status_code == 200
    assert replay.json()["job"]["result_mask_version_id"] == ai_v2_id

    mismatch = _complete_multipart(
        p5_p6_client,
        job_id=job_id,
        attempt_id=claim["attempt_id"],
        worker_id="worker-complete-1",
        lease_token=claim["lease_token"],
        mask_bytes=ai_mask_bytes,
        coverage_obj={"pipeline_version": "tda-segunet-2d-v1", "evaluated_slices": 100},
    )
    assert mismatch.status_code == 409
    assert mismatch.json()["error"]["code"] == "complete_digest_conflict"


def test_complete_job_ambiguous_commit_preserves_stored_files(
    p5_p6_client: TestClient,
    p5_p6_db: Session,
    p5_p6_settings: Settings,
) -> None:
    storage_root = p5_p6_settings.effective_storage_root
    doctor = _seed_user(p5_p6_db, username="doctor.ambig", role="doctor")
    case_id, _ = _seed_ready_case(p5_p6_db, doctor, storage_root=storage_root)
    doctor_token = _login(p5_p6_client, doctor.username)
    auth_hdr = {"Authorization": f"Bearer {doctor_token}"}

    job_id = _doctor_job(p5_p6_client, doctor_token, case_id).json()["job"]["id"]
    claim = _claim_job(p5_p6_client, "worker-ambig-1").json()
    ai_mask_bytes = _make_mask_gz_bytes(label_coords={(30, 30, 30): 4})

    real_session_commit = Session.commit
    raised_after_commit = False

    def _ambiguous_commit(self: Session) -> None:
        nonlocal raised_after_commit
        has_succeeded_job = any(
            isinstance(obj, InferenceJob) and obj.state == "succeeded"
            for obj in self.identity_map.values()
        )
        real_session_commit(self)
        if has_succeeded_job and not raised_after_commit:
            raised_after_commit = True
            raise RuntimeError("simulated post-commit connection loss")

    with patch.object(Session, "commit", _ambiguous_commit):
        ambig_resp = _complete_multipart(
            p5_p6_client,
            job_id=job_id,
            attempt_id=claim["attempt_id"],
            worker_id="worker-ambig-1",
            lease_token=claim["lease_token"],
            mask_bytes=ai_mask_bytes,
        )
    assert ambig_resp.status_code == 500
    assert raised_after_commit is True

    # PostgreSQL committed job=succeeded, so stored mask & coverage files MUST still exist!
    job_out = p5_p6_client.get(f"/api/v1/jobs/{job_id}", headers=auth_hdr)
    assert job_out.status_code == 200
    assert job_out.json()["state"] == "succeeded"
    mask_ver_id = job_out.json()["result_mask_version_id"]
    assert mask_ver_id is not None

    exported = p5_p6_client.get(f"/api/v1/mask-versions/{mask_ver_id}/export", headers=auth_hdr)
    assert exported.status_code == 200
    assert len(exported.content) > 0

    retry_complete = _complete_multipart(
        p5_p6_client,
        job_id=job_id,
        attempt_id=claim["attempt_id"],
        worker_id="worker-ambig-1",
        lease_token=claim["lease_token"],
        mask_bytes=ai_mask_bytes,
    )
    assert retry_complete.status_code == 200
    assert retry_complete.json()["job"]["result_mask_version_id"] == mask_ver_id


def test_qa_job_05_fail_job_admin_detail_retry_owner_inactive_and_intake_paused(
    p5_p6_client: TestClient,
    p5_p6_db: Session,
) -> None:
    doctor = _seed_user(p5_p6_db, username="doctor.retry", role="doctor")
    admin = _seed_user(p5_p6_db, username="admin.retry", role="admin")
    case_id, private_name = _seed_ready_case(p5_p6_db, doctor)
    doctor_token = _login(p5_p6_client, doctor.username)
    admin_token = _login(p5_p6_client, admin.username)
    admin_hdr = {"Authorization": f"Bearer {admin_token}"}

    job_id = _doctor_job(p5_p6_client, doctor_token, case_id).json()["job"]["id"]
    claim = _claim_job(p5_p6_client, "worker-fail-1").json()

    failed = p5_p6_client.post(
        f"/api/v1/internal/jobs/{job_id}/fail",
        headers={"X-Worker-Token": _WORKER_TOKEN},
        json={
            "worker_id": "worker-fail-1",
            "attempt_id": claim["attempt_id"],
            "lease_token": claim["lease_token"],
            "error_code": "inference_error",
        },
    )
    assert failed.status_code == 200, failed.text
    assert failed.json()["job"]["state"] == "failed"
    assert failed.json()["job"]["error_code"] == "inference_error"

    detail = p5_p6_client.get(f"/api/v1/admin/jobs/{job_id}", headers=admin_hdr)
    assert detail.status_code == 200, detail.text
    assert detail.json()["state"] == "failed"
    assert len(detail.json()["attempts"]) == 1
    assert detail.json()["attempts"][0]["error_code"] == "inference_error"
    assert private_name not in detail.text
    assert "Private clinical note" not in detail.text
    assert claim["lease_token"] not in detail.text

    # Pause job intake -> both admin retry and doctor enqueue return 503 not_accepting_jobs
    settings_cur = p5_p6_client.get("/api/v1/admin/settings", headers=admin_hdr).json()
    pause_payload = {
        **{k: v for k, v in settings_cur.items() if k != "updated_at"},
        "accepting_jobs": False,
    }
    paused = p5_p6_client.patch("/api/v1/admin/settings", headers=admin_hdr, json=pause_payload)
    assert paused.status_code == 200

    retry_paused = p5_p6_client.post(f"/api/v1/admin/jobs/{job_id}/retry", headers=admin_hdr)
    assert retry_paused.status_code == 503
    assert retry_paused.json()["error"]["code"] == "not_accepting_jobs"

    doc_paused = _doctor_job(p5_p6_client, doctor_token, case_id)
    assert doc_paused.status_code == 503
    assert doc_paused.json()["error"]["code"] == "not_accepting_jobs"

    # Resume intake, disable doctor -> retry returns 409 retry_owner_inactive
    resume_payload = {
        **{k: v for k, v in paused.json().items() if k != "updated_at"},
        "accepting_jobs": True,
    }
    assert p5_p6_client.patch(
        "/api/v1/admin/settings", headers=admin_hdr, json=resume_payload
    ).status_code == 200

    disable_doc = p5_p6_client.patch(
        f"/api/v1/admin/users/{doctor.id}",
        headers=admin_hdr,
        json={"is_active": False},
    )
    assert disable_doc.status_code == 200

    retry_disabled = p5_p6_client.post(f"/api/v1/admin/jobs/{job_id}/retry", headers=admin_hdr)
    assert retry_disabled.status_code == 409
    assert retry_disabled.json()["error"]["code"] == "retry_owner_inactive"

    # Re-enable doctor -> retry creates a new queued job without mutating old failed job
    enable_doc = p5_p6_client.patch(
        f"/api/v1/admin/users/{doctor.id}",
        headers=admin_hdr,
        json={"is_active": True},
    )
    assert enable_doc.status_code == 200

    retried = p5_p6_client.post(f"/api/v1/admin/jobs/{job_id}/retry", headers=admin_hdr)
    assert retried.status_code == 202, retried.text
    new_job_id = retried.json()["id"]
    assert new_job_id != job_id
    assert retried.json()["state"] == "queued"

    retry_conflict = p5_p6_client.post(f"/api/v1/admin/jobs/{job_id}/retry", headers=admin_hdr)
    assert retry_conflict.status_code == 409
    assert retry_conflict.json()["error"]["code"] == "active_job_conflict"

    retry_non_failed = p5_p6_client.post(
        f"/api/v1/admin/jobs/{new_job_id}/retry", headers=admin_hdr
    )
    assert retry_non_failed.status_code == 409
    assert retry_non_failed.json()["error"]["code"] == "job_not_retryable"

    audit_resp = p5_p6_client.get("/api/v1/admin/audit-events", headers=admin_hdr)
    assert audit_resp.status_code == 200
    actions = {item["action"] for item in audit_resp.json()["items"]}
    assert {
        "admin.settings_update",
        "admin.user_disable",
        "admin.user_enable",
        "admin.job_retry",
    } <= actions


def test_qa_acl_01_and_02_role_and_ownership_boundaries(
    p5_p6_client: TestClient,
    p5_p6_db: Session,
    p5_p6_settings: Settings,
) -> None:
    storage_root = p5_p6_settings.effective_storage_root
    doctor_a = _seed_user(p5_p6_db, username="doctor.acl.a", role="doctor")
    doctor_b = _seed_user(p5_p6_db, username="doctor.acl.b", role="doctor")
    admin = _seed_user(p5_p6_db, username="admin.acl", role="admin")

    case_a, _ = _seed_ready_case(p5_p6_db, doctor_a, storage_root=storage_root)
    case_b, _ = _seed_ready_case(p5_p6_db, doctor_b, storage_root=storage_root)

    tok_a = _login(p5_p6_client, doctor_a.username)
    tok_b = _login(p5_p6_client, doctor_b.username)
    tok_admin = _login(p5_p6_client, admin.username)

    hdr_a = {"Authorization": f"Bearer {tok_a}"}
    hdr_b = {"Authorization": f"Bearer {tok_b}"}
    hdr_admin = {"Authorization": f"Bearer {tok_admin}"}

    vol_a = p5_p6_client.get(f"/api/v1/cases/{case_a}/volumes", headers=hdr_a).json()[0]
    file_a = vol_a["file_id"]

    job_b_id = _doctor_job(p5_p6_client, tok_b, case_b).json()["job"]["id"]
    claim_b = _claim_job(p5_p6_client, "worker-acl-b").json()
    assert claim_b["job_id"] == job_b_id

    job_a_id = _doctor_job(p5_p6_client, tok_a, case_a).json()["job"]["id"]

    # QA-ACL-01: Doctor B accessing Doctor A's case/job/file -> 404
    assert p5_p6_client.get(f"/api/v1/cases/{case_a}/jobs", headers=hdr_b).status_code == 404
    assert _doctor_job(p5_p6_client, tok_b, case_a).status_code == 404
    assert p5_p6_client.get(f"/api/v1/jobs/{job_a_id}", headers=hdr_b).status_code == 404
    assert p5_p6_client.post(f"/api/v1/jobs/{job_a_id}/cancel", headers=hdr_b).status_code == 404
    assert p5_p6_client.get(f"/api/v1/files/{file_a}/content", headers=hdr_b).status_code == 404

    # QA-ACL-02: Admin calling doctor job & file routes -> 403
    assert p5_p6_client.get("/api/v1/system/availability", headers=hdr_admin).status_code == 403
    assert p5_p6_client.get(f"/api/v1/cases/{case_a}/jobs", headers=hdr_admin).status_code == 403
    assert _doctor_job(p5_p6_client, tok_admin, case_a).status_code == 403
    assert p5_p6_client.get(f"/api/v1/jobs/{job_a_id}", headers=hdr_admin).status_code == 403
    assert (
        p5_p6_client.post(f"/api/v1/jobs/{job_a_id}/cancel", headers=hdr_admin).status_code == 403
    )
    assert p5_p6_client.get(f"/api/v1/files/{file_a}/content", headers=hdr_admin).status_code == 403

    # QA-ACL-02: Doctor calling /admin/* routes -> 403
    for admin_get in (
        "/api/v1/admin/overview",
        "/api/v1/admin/jobs",
        f"/api/v1/admin/jobs/{job_a_id}",
        "/api/v1/admin/workers",
        "/api/v1/admin/models",
        "/api/v1/admin/settings",
        "/api/v1/admin/audit-events",
    ):
        assert p5_p6_client.get(admin_get, headers=hdr_a).status_code == 403
    doc_retry = p5_p6_client.post(f"/api/v1/admin/jobs/{job_a_id}/retry", headers=hdr_a)
    assert doc_retry.status_code == 403
    assert (
        p5_p6_client.patch(
            "/api/v1/admin/settings",
            headers=hdr_a,
            json={
                "version": 1,
                "accepting_jobs": True,
                "max_upload_mib": 100,
                "max_decompressed_mib": 256,
                "default_doctor_quota_gib": 2,
                "system_quota_gib": 20,
            },
        ).status_code
        == 403
    )

    # User JWTs on /internal/* -> 401 worker_unauthenticated
    for user_hdr in (hdr_a, hdr_admin):
        r_hb = p5_p6_client.post(
            "/api/v1/internal/worker/heartbeat",
            headers=user_hdr,
            json={"worker_id": "jwt-impostor", "device_type": "CPU"},
        )
        assert r_hb.status_code == 401
        r_claim = p5_p6_client.post(
            "/api/v1/internal/worker/claim",
            headers=user_hdr,
            json={"worker_id": "jwt-impostor", "device_type": "CPU"},
        )
        assert r_claim.status_code == 401

    # Worker with active lease on case_b cannot download case_a's input file -> 404
    cross_case_dl = p5_p6_client.get(
        f"/api/v1/internal/files/{file_a}/content",
        headers={
            "X-Worker-Token": _WORKER_TOKEN,
            "X-Job-ID": job_b_id,
            "X-Attempt-ID": claim_b["attempt_id"],
            "X-Worker-ID": "worker-acl-b",
            "X-Lease-Token": claim_b["lease_token"],
        },
    )
    assert cross_case_dl.status_code == 404

    # Worker token cannot call /admin/* or doctor /patients -> 401
    assert (
        p5_p6_client.get(
            "/api/v1/admin/overview", headers={"X-Worker-Token": _WORKER_TOKEN}
        ).status_code
        == 401
    )
    assert (
        p5_p6_client.get("/api/v1/patients", headers={"X-Worker-Token": _WORKER_TOKEN}).status_code
        == 401
    )
