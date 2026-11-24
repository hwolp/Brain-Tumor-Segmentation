"""P7 release acceptance integration tests against real PostgreSQL and local storage."""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import os
import time
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
import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg import sql
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.core.security import hash_password, issue_access_token, load_jwt_key_material
from app.core.storage import LocalStorageAdapter
from app.main import create_app
from app.models.inference_job import InferenceJob, JobAttempt
from app.models.user import User
from app.services.file_cleanup_service import run_orphan_cleanup
from app.services.job_service import reap_expired_attempts, sync_active_model
from scripts.backup_restore import (
    run_backup,
    run_restore,
    verify_storage_and_db_integrity,
)

_BE_DIR = Path(__file__).resolve().parents[2]
_PASSWORD = "P7ReleasePass!2026"
_WORKER_TOKEN = "p7-release-worker-token-secret"
_BRATS_SHAPE = (240, 240, 155)
_LPS_AFFINE: list[list[float]] = [
    [-1.0, 0.0, 0.0, 120.0],
    [0.0, -1.0, 0.0, 120.0],
    [0.0, 0.0, 1.0, -78.0],
    [0.0, 0.0, 0.0, 1.0],
]


@pytest.fixture()
def clean_p7_db(migrated_postgres: str) -> Iterator[None]:
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
def p7_db(clean_p7_db: None, migrated_postgres: str) -> Iterator[Session]:
    engine = create_engine(migrated_postgres)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    try:
        with factory() as db:
            yield db
    finally:
        engine.dispose()


@pytest.fixture()
def p7_settings(test_settings: Settings) -> Settings:
    return test_settings.model_copy(
        update={
            "WORKER_TOKEN": _WORKER_TOKEN,
            "MODEL_MANIFEST_PATH": _BE_DIR / "worker" / "manifest.json",
        }
    )


@pytest.fixture()
def p7_client(clean_p7_db: None, p7_settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings=p7_settings), raise_server_exceptions=False) as client:
        yield client


def _make_nifti_gz_bytes(
    data: np.ndarray,
    *,
    affine: list[list[float]] | None = None,
) -> bytes:
    aff = np.asarray(affine if affine is not None else _LPS_AFFINE, dtype=np.float64)
    img = nib.Nifti1Image(data, aff)
    if data.dtype == np.uint8:
        img.set_data_dtype(np.uint8)
    img.header.set_xyzt_units("mm", "sec")
    img.set_qform(aff, code=1)
    img.set_sform(aff, code=1)
    bio = io.BytesIO()
    fmap = img.make_file_map({"image": bio, "header": bio})
    img.to_file_map(fmap)
    out = io.BytesIO()
    with gzip.GzipFile(filename="", mode="wb", fileobj=out, mtime=0, compresslevel=1) as gz:
        gz.write(bio.getvalue())
    return out.getvalue()


def _make_brats_mri_gz(*, modality_seed: float) -> bytes:
    arr = np.zeros(_BRATS_SHAPE, dtype=np.float32)
    arr[96:130, 96:118, 72:83] = modality_seed
    arr[118:126, 100:112, 77] = modality_seed * 1.5
    return _make_nifti_gz_bytes(arr)


def _make_brats_mask_array(
    extra_coords: dict[tuple[int, int, int], int] | None = None,
) -> np.ndarray:
    arr = np.zeros(_BRATS_SHAPE, dtype=np.uint8)
    arr[100:110, 100:110, 77] = 1
    arr[110:120, 100:110, 77] = 2
    arr[120:126, 100:110, 77] = 4
    if extra_coords:
        for coords, label in extra_coords.items():
            arr[coords] = label
    return arr


def _seed_user(
    db: Session,
    *,
    username: str,
    role: str,
    must_change_password: bool = False,
    password: str = _PASSWORD,
) -> User:
    user = User(
        username=username,
        display_name=f"User {username}",
        password_hash=hash_password(password),
        role=role,
        is_active=True,
        must_change_password=must_change_password,
        password_changed_at=None if must_change_password else datetime.now(UTC),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _login(
    client: TestClient, username: str, password: str = _PASSWORD
) -> tuple[str, str]:
    resp = client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": password},
    )
    assert resp.status_code == 200, resp.text
    refresh_cookie = resp.cookies.get("bts_refresh") or ""
    assert refresh_cookie
    return str(resp.json()["access_token"]), refresh_cookie


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _worker_complete(
    client: TestClient,
    *,
    job_id: str,
    attempt_id: str,
    worker_id: str,
    lease_token: str,
    mask_bytes: bytes,
    model_version_id: str,
) -> Any:
    cov = json.dumps(
        {
            "original_shape": list(_BRATS_SHAPE),
            "pipeline_version": "tda-segunet-2d-v1",
            "unevaluated_outside_crop": True,
            "total_slices": 155,
            "evaluated_slices": 155,
            "slice_crops": [
                {"z": z, "x0": 56, "y0": 56, "x1": 184, "y1": 184, "evaluated": True}
                for z in range(_BRATS_SHAPE[2])
            ],
        }
    ).encode("utf-8")
    meta = json.dumps(
        {
            "model_version_id": model_version_id,
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
            "coverage": ("coverage.json", cov, "application/json"),
            "metadata": ("metadata.json", meta, "application/json"),
        },
    )


def test_p7_full_doctor_and_admin_e2e_lifecycle(
    p7_client: TestClient,
    p7_db: Session,
    p7_settings: Settings,
) -> None:
    admin = _seed_user(p7_db, username="admin.p7.e2e", role="admin")
    doctor_b = _seed_user(p7_db, username="doctor.b.p7", role="doctor")
    admin_tok, _ = _login(p7_client, admin.username)
    doc_b_tok, _ = _login(p7_client, doctor_b.username)

    # Admin creates Doctor A with one-time temporary password
    temp_pw = "TempDocAPass!2026"
    r_create_doc = p7_client.post(
        "/api/v1/admin/users",
        headers=_auth(admin_tok),
        json={
            "username": "doctor.a.p7",
            "display_name": "Dr. Alpha P7",
            "temporary_password": temp_pw,
        },
    )
    assert r_create_doc.status_code == 201, r_create_doc.text
    doc_a_id = r_create_doc.json()["id"]
    assert r_create_doc.json()["must_change_password"] is True

    # Doctor A forced password change flow
    temp_tok, _ = _login(p7_client, "doctor.a.p7", temp_pw)
    assert (
        p7_client.get("/api/v1/patients", headers=_auth(temp_tok)).status_code == 403
    )
    new_pw = "FinalDocAPass!2026"
    r_chpw = p7_client.post(
        "/api/v1/auth/change-password",
        headers=_auth(temp_tok),
        json={"current_password": temp_pw, "new_password": new_pw},
    )
    assert r_chpw.status_code == 204
    assert p7_client.get("/api/v1/patients", headers=_auth(temp_tok)).status_code == 401
    doc_a_tok, _ = _login(p7_client, "doctor.a.p7", new_pw)

    # Doctor A creates patient + case + uploads FLAIR & T1ce (non-identity LPS affine)
    r_pat = p7_client.post(
        "/api/v1/patients",
        headers=_auth(doc_a_tok),
        json={
            "patient_code": "BN-P7-LIFE-01",
            "full_name": "Patient P7 Lifecycle",
            "birth_year": 1978,
            "sex": "male",
        },
    )
    assert r_pat.status_code == 201, r_pat.text
    pat_id = r_pat.json()["id"]

    r_case = p7_client.post(
        f"/api/v1/patients/{pat_id}/cases",
        headers={**_auth(doc_a_tok), "Idempotency-Key": str(uuid.uuid4())},
        json={"study_date": date.today().isoformat(), "notes": "P7 clinical baseline"},
    )
    assert r_case.status_code == 201, r_case.text
    case_id = r_case.json()["id"]

    flair_bytes = _make_brats_mri_gz(modality_seed=300.0)
    t1ce_bytes = _make_brats_mri_gz(modality_seed=240.0)
    r_flair = p7_client.post(
        f"/api/v1/cases/{case_id}/volumes",
        headers=_auth(doc_a_tok),
        data={"modality": "flair"},
        files={"file": ("flair.nii.gz", flair_bytes, "application/gzip")},
    )
    assert r_flair.status_code == 201, r_flair.text
    flair_vol = r_flair.json()

    r_t1ce = p7_client.post(
        f"/api/v1/cases/{case_id}/volumes",
        headers=_auth(doc_a_tok),
        data={"modality": "t1ce"},
        files={"file": ("t1ce.nii.gz", t1ce_bytes, "application/gzip")},
    )
    assert r_t1ce.status_code == 201, r_t1ce.text

    case_ready = p7_client.get(f"/api/v1/cases/{case_id}", headers=_auth(doc_a_tok)).json()
    assert case_ready["readiness"] == "ready"
    assert case_ready["can_run_inference"] is True
    assert case_ready["reference_volume_id"] == flair_vol["id"]

    # ACL isolation: Doctor B gets 404, Admin gets 403 on clinical routes, Doctor gets 403 on admin
    assert p7_client.get(f"/api/v1/patients/{pat_id}", headers=_auth(doc_b_tok)).status_code == 404
    assert p7_client.get(f"/api/v1/cases/{case_id}", headers=_auth(doc_b_tok)).status_code == 404
    assert (
        p7_client.get(
            f"/api/v1/files/{flair_vol['file_id']}/content", headers=_auth(doc_b_tok)
        ).status_code
        == 404
    )
    assert p7_client.get("/api/v1/patients", headers=_auth(admin_tok)).status_code == 403
    assert p7_client.get(f"/api/v1/cases/{case_id}", headers=_auth(admin_tok)).status_code == 403
    assert p7_client.get("/api/v1/admin/overview", headers=_auth(doc_a_tok)).status_code == 403

    # Doctor A submits AI inference job
    r_job = p7_client.post(
        f"/api/v1/cases/{case_id}/jobs",
        headers={**_auth(doc_a_tok), "Idempotency-Key": str(uuid.uuid4())},
        json={},
    )
    assert r_job.status_code == 202, r_job.text
    job_id = r_job.json()["job"]["id"]
    model_ver_id = r_job.json()["job"]["model_version_id"]

    # Worker heartbeat -> claim -> download -> job heartbeat -> complete
    assert (
        p7_client.post(
            "/api/v1/internal/worker/heartbeat",
            headers={"X-Worker-Token": _WORKER_TOKEN},
            json={
                "worker_id": "p7-worker-1",
                "device_type": "CPU",
                "model_version_id": model_ver_id,
            },
        ).status_code
        == 204
    )
    claim = p7_client.post(
        "/api/v1/internal/worker/claim",
        headers={"X-Worker-Token": _WORKER_TOKEN},
        json={
            "worker_id": "p7-worker-1",
            "device_type": "CPU",
            "model_version_id": model_ver_id,
        },
    ).json()
    assert claim["job_id"] == job_id

    for file_item in claim["files"]:
        dl = p7_client.get(
            f"/api/v1/internal/files/{file_item['file_id']}/content",
            headers={
                "X-Worker-Token": _WORKER_TOKEN,
                "X-Job-ID": job_id,
                "X-Attempt-ID": claim["attempt_id"],
                "X-Worker-ID": "p7-worker-1",
                "X-Lease-Token": claim["lease_token"],
            },
        )
        assert dl.status_code == 200
        assert hashlib.sha256(dl.content).hexdigest() == file_item["sha256"]

    assert (
        p7_client.post(
            f"/api/v1/internal/jobs/{job_id}/heartbeat",
            headers={"X-Worker-Token": _WORKER_TOKEN},
            json={
                "worker_id": "p7-worker-1",
                "attempt_id": claim["attempt_id"],
                "lease_token": claim["lease_token"],
                "stage": "inference",
                "completed_slices": 78,
                "total_slices": 155,
            },
        ).status_code
        == 200
    )

    ai_mask_arr = _make_brats_mask_array()
    r_comp = _worker_complete(
        p7_client,
        job_id=job_id,
        attempt_id=claim["attempt_id"],
        worker_id="p7-worker-1",
        lease_token=claim["lease_token"],
        mask_bytes=_make_nifti_gz_bytes(ai_mask_arr),
        model_version_id=model_ver_id,
    )
    assert r_comp.status_code == 200, r_comp.text
    assert r_comp.json()["job"]["state"] == "succeeded"
    ai_v1_id = r_comp.json()["job"]["result_mask_version_id"]
    assert ai_v1_id is not None

    # Doctor A saves manual edit v2 based on AI v1
    v2_arr = _make_brats_mask_array(extra_coords={(40, 40, 77): 4, (41, 40, 77): 2})
    r_v2 = p7_client.post(
        f"/api/v1/cases/{case_id}/mask-versions",
        headers={**_auth(doc_a_tok), "Idempotency-Key": str(uuid.uuid4())},
        data={
            "base_version_id": ai_v1_id,
            "reference_volume_id": flair_vol["id"],
            "note": "Doctor refined boundary",
        },
        files={"mask": ("edit_v2.nii.gz", _make_nifti_gz_bytes(v2_arr), "application/gzip")},
    )
    assert r_v2.status_code == 201, r_v2.text
    v2 = r_v2.json()
    assert v2["version_number"] == 2
    assert v2["source"] == "manual"
    assert v2["base_version_id"] == ai_v1_id
    assert v2["coverage_file_id"] is not None

    # Export v2 NIfTI and metadata; assert round-trip geometry, uint8, stats, headers, zero PII
    r_exp = p7_client.get(f"/api/v1/mask-versions/{v2['id']}/export", headers=_auth(doc_a_tok))
    assert r_exp.status_code == 200
    assert r_exp.headers["cache-control"] == "no-store"
    assert r_exp.headers["x-content-type-options"] == "nosniff"
    assert (
        r_exp.headers["content-disposition"]
        == f'attachment; filename="mask-case-{case_id}-v2.nii.gz"'
    )
    decompressed = gzip.decompress(r_exp.content)
    fh = nib.FileHolder(fileobj=io.BytesIO(decompressed))
    exported = nib.Nifti1Image.from_file_map({"header": fh, "image": fh})
    assert exported.get_data_dtype() == np.uint8
    assert np.array_equal(np.asarray(exported.dataobj), v2_arr)
    expected_aff = np.asarray(_LPS_AFFINE, dtype=np.float64)
    assert np.allclose(exported.affine, expected_aff, rtol=0.0, atol=1e-4)
    assert np.allclose(exported.header.get_qform(), expected_aff, rtol=0.0, atol=1e-4)
    assert np.allclose(exported.header.get_sform(), expected_aff, rtol=0.0, atol=1e-4)

    r_meta = p7_client.get(f"/api/v1/mask-versions/{v2['id']}/metadata", headers=_auth(doc_a_tok))
    assert r_meta.status_code == 200, r_meta.text
    meta = r_meta.json()
    assert meta["coverage"]["status"] == "inherited_from_ai_crop"
    assert meta["statistics"]["total_foreground_voxels"] == int(np.count_nonzero(v2_arr > 0))
    assert "Patient P7 Lifecycle" not in json.dumps(meta)
    assert "BN-P7-LIFE-01" not in json.dumps(meta)

    # Admin operational views expose zero PII
    for admin_path in (
        "/api/v1/admin/overview",
        "/api/v1/admin/jobs",
        "/api/v1/admin/audit-events",
    ):
        adm_resp = p7_client.get(admin_path, headers=_auth(admin_tok))
        assert adm_resp.status_code == 200
        for pii in (
            "Patient P7 Lifecycle",
            "BN-P7-LIFE-01",
            "P7 clinical baseline",
            "Doctor refined",
        ):
            assert pii not in adm_resp.text

    # Admin retries a failed job for Doctor B and disables Doctor A (immediate 401 revocation)
    r_pat_b = p7_client.post(
        "/api/v1/patients",
        headers=_auth(doc_b_tok),
        json={
            "patient_code": "BN-P7-B-01",
            "full_name": "Patient B",
            "birth_year": 1982,
            "sex": "female",
        },
    )
    assert r_pat_b.status_code == 201
    r_case_b = p7_client.post(
        f"/api/v1/patients/{r_pat_b.json()['id']}/cases",
        headers={**_auth(doc_b_tok), "Idempotency-Key": str(uuid.uuid4())},
        json={"study_date": date.today().isoformat(), "notes": "Case B"},
    )
    case_b_id = r_case_b.json()["id"]
    assert (
        p7_client.post(
            f"/api/v1/cases/{case_b_id}/volumes",
            headers=_auth(doc_b_tok),
            data={"modality": "flair"},
            files={"file": ("b_flair.nii.gz", flair_bytes, "application/gzip")},
        ).status_code
        == 201
    )
    assert (
        p7_client.post(
            f"/api/v1/cases/{case_b_id}/volumes",
            headers=_auth(doc_b_tok),
            data={"modality": "t1ce"},
            files={"file": ("b_t1ce.nii.gz", t1ce_bytes, "application/gzip")},
        ).status_code
        == 201
    )
    failed_job = InferenceJob(
        case_id=uuid.UUID(case_b_id),
        doctor_id=doctor_b.id,
        model_version_id=model_ver_id,
        state="failed",
        stage="inference",
        attempt_count=2,
        error_code="worker_lease_expired",
    )
    p7_db.add(failed_job)
    p7_db.commit()

    r_retry = p7_client.post(
        f"/api/v1/admin/jobs/{failed_job.id}/retry",
        headers=_auth(admin_tok),
    )
    assert r_retry.status_code == 202, r_retry.text
    assert r_retry.json()["state"] == "queued"

    r_lock = p7_client.patch(
        f"/api/v1/admin/users/{doc_a_id}",
        headers=_auth(admin_tok),
        json={"is_active": False},
    )
    assert r_lock.status_code == 200
    r_blocked = p7_client.get("/api/v1/patients", headers=_auth(doc_a_tok))
    assert r_blocked.status_code == 401
    assert r_blocked.json()["error"]["code"] == "account_disabled"


def test_p7_security_refresh_reuse_mid_save_expiry_conflict_and_orphan_cleanup(
    p7_client: TestClient,
    p7_db: Session,
    p7_settings: Settings,
) -> None:
    doctor = _seed_user(p7_db, username="doc.p7.sec", role="doctor")

    # CSRF Origin check rejects cross-origin auth requests
    csrf_resp = p7_client.post(
        "/api/v1/auth/login",
        headers={"Origin": "https://evil.example"},
        json={"username": doctor.username, "password": _PASSWORD},
    )
    assert csrf_resp.status_code == 403
    assert csrf_resp.json()["error"]["code"] == "csrf_origin_denied"

    _, rt1 = _login(p7_client, doctor.username)
    # Rotate refresh token once
    rot = p7_client.post("/api/v1/auth/refresh", cookies={"bts_refresh": rt1})
    assert rot.status_code == 200, rot.text
    rt2 = rot.cookies.get("bts_refresh") or ""
    tok2 = rot.json()["access_token"]
    assert rt2 and rt2 != rt1

    # Reuse old rt1 -> 401 refresh_reused AND revokes entire session family (rt2 & tok2 fail 401)
    reused = p7_client.post("/api/v1/auth/refresh", cookies={"bts_refresh": rt1})
    assert reused.status_code == 401
    assert reused.json()["error"]["code"] == "refresh_reused"
    assert p7_client.post("/api/v1/auth/refresh", cookies={"bts_refresh": rt2}).status_code == 401
    assert p7_client.get("/api/v1/patients", headers=_auth(tok2)).status_code == 401

    # Expired session & expired JWT both rejected with 401 token_expired
    tok_live, rt_live = _login(p7_client, doctor.username)
    key_mat = load_jwt_key_material(p7_settings)
    assert key_mat is not None
    p7_db.execute(
        text(
            "UPDATE sessions SET expires_at = :past WHERE user_id = :uid AND revoked_at IS NULL"
        ),
        {"past": datetime.now(UTC) - timedelta(seconds=10), "uid": doctor.id},
    )
    p7_db.commit()
    exp_api = p7_client.get("/api/v1/patients", headers=_auth(tok_live))
    assert exp_api.status_code == 401
    assert exp_api.json()["error"]["code"] == "token_expired"
    exp_ref = p7_client.post("/api/v1/auth/refresh", cookies={"bts_refresh": rt_live})
    assert exp_ref.status_code == 401
    assert exp_ref.json()["error"]["code"] == "token_expired"

    expired_jwt = issue_access_token(
        user_id=doctor.id,
        session_id=uuid.uuid4(),
        role="doctor",
        key_material=key_mat,
        settings=p7_settings,
        now=datetime.now(UTC) - timedelta(seconds=p7_settings.JWT_ACCESS_TTL_SECONDS + 120),
    )
    assert p7_client.get("/api/v1/patients", headers=_auth(expired_jwt)).status_code == 401

    # Fresh login -> test concurrent mid-save conflict & worker lease expiry
    tok, _ = _login(p7_client, doctor.username)
    pat_id = p7_client.post(
        "/api/v1/patients",
        headers=_auth(tok),
        json={
            "patient_code": "P7-SEC-01",
            "full_name": "Security Patient",
            "birth_year": 1984,
            "sex": "other",
        },
    ).json()["id"]

    # Case 1: concurrent save conflict (one 201, one 409 mask_version_conflict)
    c1_id = p7_client.post(
        f"/api/v1/patients/{pat_id}/cases",
        headers={**_auth(tok), "Idempotency-Key": str(uuid.uuid4())},
        json={"study_date": date.today().isoformat(), "notes": "Concurrent save case"},
    ).json()["id"]
    small_aff = np.eye(4, dtype=np.float64).tolist()
    small_vol = p7_client.post(
        f"/api/v1/cases/{c1_id}/volumes",
        headers=_auth(tok),
        data={"modality": "flair"},
        files={
            "file": (
                "small.nii.gz",
                _make_nifti_gz_bytes(np.zeros((8, 8, 8), dtype=np.float32), affine=small_aff),
                "application/gzip",
            )
        },
    ).json()
    m_v1 = p7_client.post(
        f"/api/v1/cases/{c1_id}/mask-versions",
        headers={**_auth(tok), "Idempotency-Key": str(uuid.uuid4())},
        data={"reference_volume_id": small_vol["id"]},
        files={
            "mask": (
                "v1.nii.gz",
                _make_nifti_gz_bytes(np.zeros((8, 8, 8), dtype=np.uint8), affine=small_aff),
                "application/gzip",
            )
        },
    ).json()

    barrier = Barrier(2)
    shared_app = create_app(settings=p7_settings)

    def _save_from_v1(label: int) -> tuple[int, dict[str, Any]]:
        arr = np.zeros((8, 8, 8), dtype=np.uint8)
        arr[1, 1, 1] = label
        with TestClient(shared_app, raise_server_exceptions=False) as local_client:
            barrier.wait(timeout=5)
            resp = local_client.post(
                f"/api/v1/cases/{c1_id}/mask-versions",
                headers={**_auth(tok), "Idempotency-Key": str(uuid.uuid4())},
                data={"base_version_id": m_v1["id"], "reference_volume_id": small_vol["id"]},
                files={
                    "mask": (
                        "v2.nii.gz",
                        _make_nifti_gz_bytes(arr, affine=small_aff),
                        "application/gzip",
                    )
                },
            )
            return resp.status_code, resp.json()

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(_save_from_v1, [1, 2]))
    assert sorted(status for status, _ in outcomes) == [201, 409]
    conflict_body = next(body for status, body in outcomes if status == 409)
    assert conflict_body["error"]["code"] == "mask_version_conflict"

    # Case 2: worker lease expiry + stale attempt rejection + worker_lost
    c2_id = p7_client.post(
        f"/api/v1/patients/{pat_id}/cases",
        headers={**_auth(tok), "Idempotency-Key": str(uuid.uuid4())},
        json={"study_date": date.today().isoformat(), "notes": "Lease expiry case"},
    ).json()["id"]
    for mod, val in (("flair", 300.0), ("t1ce", 240.0)):
        mod_bytes = _make_brats_mri_gz(modality_seed=val)
        assert (
            p7_client.post(
                f"/api/v1/cases/{c2_id}/volumes",
                headers=_auth(tok),
                data={"modality": mod},
                files={"file": (f"{mod}.nii.gz", mod_bytes, "application/gzip")},
            ).status_code
            == 201
        )
    job_id = p7_client.post(
        f"/api/v1/cases/{c2_id}/jobs",
        headers={**_auth(tok), "Idempotency-Key": str(uuid.uuid4())},
        json={},
    ).json()["job"]["id"]
    model = sync_active_model(p7_db, p7_settings)
    p7_db.commit()

    c_one = p7_client.post(
        "/api/v1/internal/worker/claim",
        headers={"X-Worker-Token": _WORKER_TOKEN},
        json={"worker_id": "w-exp-1", "device_type": "CPU", "model_version_id": model.id},
    ).json()
    att1 = p7_db.get(JobAttempt, uuid.UUID(c_one["attempt_id"]))
    assert att1 is not None
    att1.lease_expires_at = datetime.now(UTC) - timedelta(seconds=5)
    p7_db.commit()
    assert reap_expired_attempts(p7_db) == 1

    stale_complete = _worker_complete(
        p7_client,
        job_id=job_id,
        attempt_id=c_one["attempt_id"],
        worker_id="w-exp-1",
        lease_token=c_one["lease_token"],
        mask_bytes=_make_nifti_gz_bytes(_make_brats_mask_array()),
        model_version_id=model.id,
    )
    assert stale_complete.status_code == 409
    assert stale_complete.json()["error"]["code"] == "stale_attempt"

    c_two = p7_client.post(
        "/api/v1/internal/worker/claim",
        headers={"X-Worker-Token": _WORKER_TOKEN},
        json={"worker_id": "w-exp-2", "device_type": "CPU", "model_version_id": model.id},
    ).json()
    att2 = p7_db.get(JobAttempt, uuid.UUID(c_two["attempt_id"]))
    assert att2 is not None
    att2.lease_expires_at = datetime.now(UTC) - timedelta(seconds=5)
    p7_db.commit()
    assert reap_expired_attempts(p7_db) == 1
    p7_db.expire_all()
    failed_job = p7_db.get(InferenceJob, uuid.UUID(job_id))
    assert failed_job is not None
    assert failed_job.state == "failed"
    assert failed_job.error_code == "worker_lost"

    # Orphan cleanup removes aged staging & unreferenced objects; case deletion cleans files
    storage = LocalStorageAdapter(p7_settings.effective_storage_root)
    staged_orphan = storage.put_temp(b"orphan-stage")
    obj_orphan = storage.commit(storage.put_temp(b"orphan-obj").staging_key)
    past_ts = time.time() - 7200
    os.utime(storage.staging_root / staged_orphan.staging_key, (past_ts, past_ts))
    os.utime(storage.objects_root / obj_orphan.storage_key, (past_ts, past_ts))
    cleanup_summary = run_orphan_cleanup(p7_db, storage, max_age_seconds=3600)
    p7_db.commit()
    assert cleanup_summary["staging_orphans_removed"] >= 1
    assert cleanup_summary["orphan_objects_removed"] >= 1
    assert not (storage.objects_root / obj_orphan.storage_key).exists()

    del_c1 = p7_client.delete(f"/api/v1/cases/{c1_id}", headers=_auth(tok))
    assert del_c1.status_code == 202
    assert del_c1.json()["status"] == "deleted"


def test_p7_restart_persistence_and_storage_failure_atomicity(
    p7_db: Session,
    p7_settings: Settings,
) -> None:
    storage_root = p7_settings.effective_storage_root
    doctor = _seed_user(p7_db, username="doc.p7.restart", role="doctor")

    flair_bytes = _make_brats_mri_gz(modality_seed=310.0)
    t1ce_bytes = _make_brats_mri_gz(modality_seed=260.0)
    flair_sha = hashlib.sha256(flair_bytes).hexdigest()
    ai_mask_arr = _make_brats_mask_array()
    ai_mask_bytes = _make_nifti_gz_bytes(ai_mask_arr)

    app1 = create_app(settings=p7_settings)
    with TestClient(app1, raise_server_exceptions=False) as client1:
        tok1, _ = _login(client1, doctor.username)
        pat_id = client1.post(
            "/api/v1/patients",
            headers=_auth(tok1),
            json={
                "patient_code": "P7-RST-01",
                "full_name": "Restart Patient",
                "birth_year": 1979,
                "sex": "male",
            },
        ).json()["id"]
        case_id = client1.post(
            f"/api/v1/patients/{pat_id}/cases",
            headers={**_auth(tok1), "Idempotency-Key": str(uuid.uuid4())},
            json={"study_date": date.today().isoformat(), "notes": "Restart check"},
        ).json()["id"]
        flair_vol = client1.post(
            f"/api/v1/cases/{case_id}/volumes",
            headers=_auth(tok1),
            data={"modality": "flair"},
            files={"file": ("flair.nii.gz", flair_bytes, "application/gzip")},
        ).json()
        assert (
            client1.post(
                f"/api/v1/cases/{case_id}/volumes",
                headers=_auth(tok1),
                data={"modality": "t1ce"},
                files={"file": ("t1ce.nii.gz", t1ce_bytes, "application/gzip")},
            ).status_code
            == 201
        )
        job_resp = client1.post(
            f"/api/v1/cases/{case_id}/jobs",
            headers={**_auth(tok1), "Idempotency-Key": str(uuid.uuid4())},
            json={},
        ).json()["job"]
        job_id = job_resp["id"]
        model_ver_id = job_resp["model_version_id"]

        claim = client1.post(
            "/api/v1/internal/worker/claim",
            headers={"X-Worker-Token": _WORKER_TOKEN},
            json={
                "worker_id": "w-rst-1",
                "device_type": "CPU",
                "model_version_id": model_ver_id,
            },
        ).json()

        # Simulate storage write error during complete_job -> job must NOT become succeeded
        objects_dir = storage_root / "objects"
        before_objects = {p for p in objects_dir.rglob("*") if p.is_file()}
        real_commit = LocalStorageAdapter.commit
        calls = 0

        def _fail_second_commit(self: LocalStorageAdapter, staging_key: str) -> Any:
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("simulated storage failure")
            return real_commit(self, staging_key)

        with patch.object(LocalStorageAdapter, "commit", _fail_second_commit):
            fail_resp = _worker_complete(
                client1,
                job_id=job_id,
                attempt_id=claim["attempt_id"],
                worker_id="w-rst-1",
                lease_token=claim["lease_token"],
                mask_bytes=ai_mask_bytes,
                model_version_id=model_ver_id,
            )
        assert fail_resp.status_code == 500
        after_fail_objects = {p for p in objects_dir.rglob("*") if p.is_file()}
        assert after_fail_objects == before_objects
        job_after_fail = client1.get(f"/api/v1/jobs/{job_id}", headers=_auth(tok1)).json()
        assert job_after_fail["state"] == "running"
        assert (
            client1.get(f"/api/v1/cases/{case_id}/mask-versions", headers=_auth(tok1)).json()[
                "total"
            ]
            == 0
        )

        # Complete cleanly and record canonical mask SHA-256
        ok_resp = _worker_complete(
            client1,
            job_id=job_id,
            attempt_id=claim["attempt_id"],
            worker_id="w-rst-1",
            lease_token=claim["lease_token"],
            mask_bytes=ai_mask_bytes,
            model_version_id=model_ver_id,
        )
        assert ok_resp.status_code == 200, ok_resp.text
        mask_ver_id = ok_resp.json()["job"]["result_mask_version_id"]
        pre_export = client1.get(
            f"/api/v1/mask-versions/{mask_ver_id}/export", headers=_auth(tok1)
        )
        assert pre_export.status_code == 200
        mask_sha = hashlib.sha256(pre_export.content).hexdigest()

    # App1 exited & disposed its DB engine; start a brand-new FastAPI app2 instance
    app2 = create_app(settings=p7_settings)
    with TestClient(app2, raise_server_exceptions=False) as client2:
        assert client2.get("/api/v1/health/ready").status_code == 200
        tok2, _ = _login(client2, doctor.username)
        dl_flair = client2.get(
            f"/api/v1/files/{flair_vol['file_id']}/content", headers=_auth(tok2)
        )
        assert dl_flair.status_code == 200
        assert hashlib.sha256(dl_flair.content).hexdigest() == flair_sha

        dl_mask = client2.get(
            f"/api/v1/mask-versions/{mask_ver_id}/export", headers=_auth(tok2)
        )
        assert dl_mask.status_code == 200
        assert hashlib.sha256(dl_mask.content).hexdigest() == mask_sha
        decompressed = gzip.decompress(dl_mask.content)
        fh = nib.FileHolder(fileobj=io.BytesIO(decompressed))
        reloaded = nib.Nifti1Image.from_file_map({"header": fh, "image": fh})
        assert np.array_equal(np.asarray(reloaded.dataobj), ai_mask_arr)
        assert np.allclose(reloaded.affine, np.asarray(_LPS_AFFINE), rtol=0.0, atol=1e-4)


def test_qa_ops_02_backup_and_isolated_restore_preserves_checksums_and_revokes_sessions(
    migrated_postgres: str,
    p7_db: Session,
    p7_settings: Settings,
    tmp_path: Path,
) -> None:
    storage_root = p7_settings.effective_storage_root
    _seed_user(p7_db, username="admin.p7.bkp", role="admin")
    doctor = _seed_user(p7_db, username="doc.p7.bkp", role="doctor")

    flair_bytes = _make_brats_mri_gz(modality_seed=325.0)
    t1ce_bytes = _make_brats_mri_gz(modality_seed=250.0)
    flair_sha = hashlib.sha256(flair_bytes).hexdigest()
    ai_mask_arr = _make_brats_mask_array()
    manual_v2_arr = _make_brats_mask_array(extra_coords={(50, 52, 77): 4, (51, 52, 77): 1})

    app1 = create_app(settings=p7_settings)
    with TestClient(app1, raise_server_exceptions=False) as client1:
        pre_access, pre_refresh = _login(client1, doctor.username)
        pat_id = client1.post(
            "/api/v1/patients",
            headers=_auth(pre_access),
            json={
                "patient_code": "BKP-PII-01",
                "full_name": "Patient Backup PII Check",
                "birth_year": 1974,
                "sex": "female",
            },
        ).json()["id"]
        case_id = client1.post(
            f"/api/v1/patients/{pat_id}/cases",
            headers={**_auth(pre_access), "Idempotency-Key": str(uuid.uuid4())},
            json={
                "study_date": date.today().isoformat(),
                "notes": "Confidential backup clinical note",
            },
        ).json()["id"]
        flair_vol = client1.post(
            f"/api/v1/cases/{case_id}/volumes",
            headers=_auth(pre_access),
            data={"modality": "flair"},
            files={"file": ("secret_patient_flair.nii.gz", flair_bytes, "application/gzip")},
        ).json()
        assert (
            client1.post(
                f"/api/v1/cases/{case_id}/volumes",
                headers=_auth(pre_access),
                data={"modality": "t1ce"},
                files={"file": ("secret_patient_t1ce.nii.gz", t1ce_bytes, "application/gzip")},
            ).status_code
            == 201
        )
        job = client1.post(
            f"/api/v1/cases/{case_id}/jobs",
            headers={**_auth(pre_access), "Idempotency-Key": str(uuid.uuid4())},
            json={},
        ).json()["job"]

        claim = client1.post(
            "/api/v1/internal/worker/claim",
            headers={"X-Worker-Token": _WORKER_TOKEN},
            json={
                "worker_id": "w-bkp-1",
                "device_type": "CPU",
                "model_version_id": job["model_version_id"],
            },
        ).json()

        # Backup refuses when a job is running unless force=True
        backup_dir = tmp_path / "backup_snapshot"
        with pytest.raises(ValueError, match="running"):
            run_backup(
                database_url=migrated_postgres,
                storage_root=storage_root,
                output_dir=backup_dir,
            )

        comp = _worker_complete(
            client1,
            job_id=job["id"],
            attempt_id=claim["attempt_id"],
            worker_id="w-bkp-1",
            lease_token=claim["lease_token"],
            mask_bytes=_make_nifti_gz_bytes(ai_mask_arr),
            model_version_id=job["model_version_id"],
        )
        assert comp.status_code == 200
        ai_v1_id = comp.json()["job"]["result_mask_version_id"]

        r_v2 = client1.post(
            f"/api/v1/cases/{case_id}/mask-versions",
            headers={**_auth(pre_access), "Idempotency-Key": str(uuid.uuid4())},
            data={
                "base_version_id": ai_v1_id,
                "reference_volume_id": flair_vol["id"],
                "note": "Manual post-AI v2 note",
            },
            files={
                "mask": (
                    "manual_v2.nii.gz",
                    _make_nifti_gz_bytes(manual_v2_arr),
                    "application/gzip",
                )
            },
        )
        assert r_v2.status_code == 201
        v2_id = r_v2.json()["id"]
        pre_v2_export = client1.get(
            f"/api/v1/mask-versions/{v2_id}/export", headers=_auth(pre_access)
        )
        assert pre_v2_export.status_code == 200
        v2_sha = hashlib.sha256(pre_v2_export.content).hexdigest()

    # Leave a stale staging file to confirm backup/restore skips staging artifacts
    LocalStorageAdapter(storage_root).put_temp(b"stale-staging-garbage")

    manifest = run_backup(
        database_url=migrated_postgres,
        storage_root=storage_root,
        output_dir=backup_dir,
    )
    manifest_path = backup_dir / "backup_manifest.json"
    assert manifest_path.is_file()
    manifest_text = manifest_path.read_text(encoding="utf-8")
    for pii in (
        "Patient Backup PII Check",
        "BKP-PII-01",
        "Confidential backup clinical note",
        "Manual post-AI v2 note",
        "secret_patient_flair.nii.gz",
        "secret_patient_t1ce.nii.gz",
    ):
        assert pii not in manifest_text
    assert manifest["counts"]["committed_files"] >= 5

    # Protected DB targets are rejected by run_restore
    for bad_url in (
        "postgresql+psycopg://bts_user:bts_local_dev_pw@127.0.0.1:5432/bts_dev",
        "postgresql+psycopg://bts_user:bts_local_dev_pw@127.0.0.1:5432/clinic_prod",
    ):
        with pytest.raises(ValueError, match="Refusing destructive restore"):
            run_restore(
                backup_dir=backup_dir,
                target_database_url=bad_url,
                target_storage_root=tmp_path / "unused_storage",
            )

    restore_db_name = f"bts_restore_test_{uuid.uuid4().hex[:8]}"
    base_url = make_url(migrated_postgres)
    restore_url = base_url.set(database=restore_db_name).render_as_string(hide_password=False)
    maint_dsn = base_url.set(drivername="postgresql", database="postgres").render_as_string(
        hide_password=False
    )
    restored_storage = tmp_path / "restored_storage"

    try:
        integrity = run_restore(
            backup_dir=backup_dir,
            target_database_url=restore_url,
            target_storage_root=restored_storage,
            create_db=True,
        )
        assert integrity["status"] == "ok"
        assert integrity["verified_committed_files"] == manifest["counts"]["committed_files"]
        assert list((restored_storage / "staging").iterdir()) == []

        ro_check = verify_storage_and_db_integrity(
            database_url=restore_url,
            storage_root=restored_storage,
        )
        assert ro_check["status"] == "ok"

        restored_settings = p7_settings.model_copy(
            update={"DATABASE_URL": restore_url, "STORAGE_ROOT": restored_storage}
        )
        with TestClient(
            create_app(settings=restored_settings), raise_server_exceptions=False
        ) as restored_client:
            # Pre-backup sessions and refresh tokens are revoked in the restored environment
            assert (
                restored_client.post(
                    "/api/v1/auth/refresh",
                    cookies={"bts_refresh": pre_refresh},
                ).status_code
                == 401
            )
            assert (
                restored_client.get(
                    "/api/v1/patients",
                    headers=_auth(pre_access),
                ).status_code
                == 401
            )

            fresh_tok, _ = _login(restored_client, doctor.username)
            restored_flair = restored_client.get(
                f"/api/v1/files/{flair_vol['file_id']}/content",
                headers=_auth(fresh_tok),
            )
            assert restored_flair.status_code == 200
            assert hashlib.sha256(restored_flair.content).hexdigest() == flair_sha

            restored_mask = restored_client.get(
                f"/api/v1/mask-versions/{v2_id}/export",
                headers=_auth(fresh_tok),
            )
            assert restored_mask.status_code == 200
            assert hashlib.sha256(restored_mask.content).hexdigest() == v2_sha
            fh = nib.FileHolder(fileobj=io.BytesIO(gzip.decompress(restored_mask.content)))
            restored_img = nib.Nifti1Image.from_file_map({"header": fh, "image": fh})
            assert np.array_equal(np.asarray(restored_img.dataobj), manual_v2_arr)
            assert np.allclose(restored_img.affine, np.asarray(_LPS_AFFINE), rtol=0.0, atol=1e-4)
    finally:
        with psycopg.connect(maint_dsn, autocommit=True, connect_timeout=5) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                    "WHERE datname = %s AND pid <> pg_backend_pid()",
                    (restore_db_name,),
                )
                cur.execute(
                    sql.SQL("DROP DATABASE IF EXISTS {}").format(sql.Identifier(restore_db_name))
                )
