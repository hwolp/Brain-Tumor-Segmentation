"""Integration tests for Component 2 & 3 logic fixes (L-02, L-03, L-04, L-09, L-10, L-11, L-12)."""

from __future__ import annotations

import gzip
import io
import json
import uuid
from collections.abc import Iterator
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any
from unittest.mock import patch

import nibabel as nib
import numpy as np
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.core.security import hash_password
from app.core.storage import LocalStorageAdapter
from app.main import create_app
from app.models.case import Case
from app.models.inference_job import InferenceJob, WorkerInstance
from app.models.stored_file import StoredFile
from app.models.system_setting import SystemSetting
from app.models.user import User
from app.models.volume import Volume
from app.services.job_service import sync_active_model

_PASSWORD = "LogicFixesPass!2026"
_WORKER_TOKEN = "logic-fixes-worker-token"
_BRATS_SHAPE = (240, 240, 155)


def _nifti_gz_bytes(
    data: np.ndarray,
    affine: np.ndarray,
    *,
    qform_code: int = 1,
    sform_code: int = 1,
    xyz_unit: str = "mm",
) -> bytes:
    img = nib.Nifti1Image(data, affine)
    if data.dtype == np.uint8:
        img.set_data_dtype(np.uint8)
    img.header.set_xyzt_units(xyz_unit, "sec")
    if qform_code > 0:
        img.set_qform(affine, code=qform_code)
    else:
        img.set_qform(None, code=0)
    if sform_code > 0:
        img.set_sform(affine, code=sform_code)
    else:
        img.set_sform(None, code=0)
    bio = io.BytesIO()
    img.to_file_map(img.make_file_map({"image": bio, "header": bio}))
    return gzip.compress(bio.getvalue(), compresslevel=1)


@pytest.fixture()
def clean_fix_db(migrated_postgres: str) -> Iterator[None]:
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
def fix_db(clean_fix_db: None, migrated_postgres: str) -> Iterator[Session]:
    engine = create_engine(migrated_postgres)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    try:
        with factory() as db:
            yield db
    finally:
        engine.dispose()


@pytest.fixture()
def fix_settings(test_settings: Settings) -> Settings:
    return test_settings.model_copy(update={"WORKER_TOKEN": _WORKER_TOKEN})


@pytest.fixture()
def fix_client(clean_fix_db: None, fix_settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings=fix_settings), raise_server_exceptions=False) as client:
        yield client


def _seed_doctor(db: Session, username: str = "doc.fixes") -> User:
    user = User(
        username=username,
        display_name=f"Dr. {username}",
        password_hash=hash_password(_PASSWORD),
        role="doctor",
        is_active=True,
        must_change_password=False,
        password_changed_at=datetime.now(UTC),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _login(client: TestClient, username: str) -> dict[str, str]:
    resp = client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": _PASSWORD},
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


def _create_case(client: TestClient, hdrs: dict[str, str], code: str) -> tuple[str, str]:
    pat = client.post(
        "/api/v1/patients",
        headers=hdrs,
        json={
            "patient_code": code,
            "full_name": f"Patient {code}",
            "birth_year": 1982,
            "sex": "unknown",
        },
    )
    assert pat.status_code == 201, pat.text
    pat_id = pat.json()["id"]
    case = client.post(
        f"/api/v1/patients/{pat_id}/cases",
        headers={**hdrs, "Idempotency-Key": str(uuid.uuid4())},
        json={"study_date": date.today().isoformat(), "notes": "logic fix test"},
    )
    assert case.status_code == 201, case.text
    return pat_id, case.json()["id"]


def test_volume_ambiguous_commit_preserves_file_and_hard_quota_cap_enforced(
    fix_client: TestClient,
    fix_db: Session,
    fix_settings: Settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    doctor = _seed_doctor(fix_db, "doc.vol.ambig")
    hdrs = _login(fix_client, doctor.username)
    _, case_id = _create_case(fix_client, hdrs, "PAT-VOL-AMBIG")

    payload = _nifti_gz_bytes(np.zeros((8, 8, 8), dtype=np.float32), np.eye(4))
    orig_commit = Session.commit
    raised_after_commit = False

    def _commit_then_raise(session: Session) -> None:
        nonlocal raised_after_commit
        has_vol = not raised_after_commit and any(
            isinstance(obj, Volume) for obj in session.identity_map.values()
        )
        orig_commit(session)
        if has_vol:
            raised_after_commit = True
            raise RuntimeError("simulated lost commit acknowledgement")

    with patch.object(Session, "commit", _commit_then_raise):
        resp = fix_client.post(
            f"/api/v1/cases/{case_id}/volumes",
            headers=hdrs,
            data={"modality": "flair"},
            files={"file": ("flair.nii.gz", payload, "application/gzip")},
        )
    assert resp.status_code == 500
    assert raised_after_commit is True

    # Committed Volume row in DB MUST still have its physical file preserved on disk!
    vols = fix_client.get(f"/api/v1/cases/{case_id}/volumes", headers=hdrs).json()
    assert len(vols) == 1
    dl = fix_client.get(f"/api/v1/files/{vols[0]['file_id']}/content", headers=hdrs)
    assert dl.status_code == 200
    assert dl.content == payload

    # Hard cap Settings.DOCTOR_QUOTA_BYTES overrides inflated admin_settings in DB (L-09)
    fix_db.add(
        SystemSetting(
            key="admin_settings",
            value_json={
                "version": 1,
                "accepting_jobs": True,
                "max_upload_mib": 100,
                "max_decompressed_mib": 256,
                "default_doctor_quota_gib": 500,
                "system_quota_gib": 1000,
            },
        )
    )
    fix_db.commit()

    tiny_cap_settings = fix_settings.model_copy(update={"DOCTOR_QUOTA_BYTES": 100})
    with TestClient(
        create_app(settings=tiny_cap_settings), raise_server_exceptions=False
    ) as capped_client:
        capped_hdrs = _login(capped_client, doctor.username)
        r_quota = capped_client.post(
            f"/api/v1/cases/{case_id}/volumes",
            headers=capped_hdrs,
            data={"modality": "t1ce"},
            files={"file": ("t1ce.nii.gz", payload, "application/gzip")},
        )
        assert r_quota.status_code == 413
        assert r_quota.json()["error"]["code"] == "storage_quota_exceeded"


def test_mask_idempotency_conflict_before_ref_mismatch_and_shear_roundtrip(
    fix_client: TestClient,
    fix_db: Session,
) -> None:
    doctor = _seed_doctor(fix_db, "doc.mask.fix")
    hdrs = _login(fix_client, doctor.username)
    _, case_id = _create_case(fix_client, hdrs, "PAT-MASK-FIX")

    sheared_aff = np.array(
        [
            [1.0, 0.25, 0.0, -10.0],
            [0.0, 1.0, 0.0, -20.0],
            [0.0, 0.0, 1.5, -5.0],
            [0.0, 0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )
    vol_bytes = _nifti_gz_bytes(
        np.zeros((8, 8, 6), dtype=np.float32),
        sheared_aff,
        qform_code=0,
        sform_code=2,
        xyz_unit="unknown",
    )
    r_vol = fix_client.post(
        f"/api/v1/cases/{case_id}/volumes",
        headers=hdrs,
        data={"modality": "flair"},
        files={"file": ("sheared_flair.nii.gz", vol_bytes, "application/gzip")},
    )
    assert r_vol.status_code == 201, r_vol.text
    vol_id = r_vol.json()["id"]

    mask_arr = np.zeros((8, 8, 6), dtype=np.uint8)
    mask_arr[2, 3, 1] = 1
    mask_arr[4, 5, 2] = 4
    mask_bytes = _nifti_gz_bytes(
        mask_arr,
        sheared_aff,
        qform_code=0,
        sform_code=2,
    )
    idem_key = str(uuid.uuid4())
    r_v1 = fix_client.post(
        f"/api/v1/cases/{case_id}/mask-versions",
        headers={**hdrs, "Idempotency-Key": idem_key},
        data={"reference_volume_id": vol_id, "note": "v1 shear"},
        files={"mask": ("m1.nii.gz", mask_bytes, "application/gzip")},
    )
    assert r_v1.status_code == 201, r_v1.text
    v1_id = r_v1.json()["id"]

    # Replay same Idempotency-Key with different reference_volume_id -> 409 idempotency_conflict
    r_idem_conflict = fix_client.post(
        f"/api/v1/cases/{case_id}/mask-versions",
        headers={**hdrs, "Idempotency-Key": idem_key},
        data={"reference_volume_id": str(uuid.uuid4()), "note": "v1 shear"},
        files={"mask": ("m1.nii.gz", mask_bytes, "application/gzip")},
    )
    assert r_idem_conflict.status_code == 409, r_idem_conflict.text
    assert r_idem_conflict.json()["error"]["code"] == "idempotency_conflict"

    # Non-existent base_version_id returns 404 mask_version_not_found
    r_bad_base = fix_client.post(
        f"/api/v1/cases/{case_id}/mask-versions",
        headers={**hdrs, "Idempotency-Key": str(uuid.uuid4())},
        data={"base_version_id": str(uuid.uuid4()), "reference_volume_id": vol_id},
        files={"mask": ("m2.nii.gz", mask_bytes, "application/gzip")},
    )
    assert r_bad_base.status_code == 404
    assert r_bad_base.json()["error"]["code"] == "mask_version_not_found"

    # Export v1 and re-upload exported bytes as v2 -> round-trip succeeds without qform/sform clash!
    exp = fix_client.get(f"/api/v1/mask-versions/{v1_id}/export", headers=hdrs)
    assert exp.status_code == 200
    r_v2 = fix_client.post(
        f"/api/v1/cases/{case_id}/mask-versions",
        headers={**hdrs, "Idempotency-Key": str(uuid.uuid4())},
        data={"base_version_id": v1_id, "reference_volume_id": vol_id, "note": "v2 roundtrip"},
        files={"mask": ("exported_v1.nii.gz", exp.content, "application/gzip")},
    )
    assert r_v2.status_code == 201, r_v2.text
    assert r_v2.json()["version_number"] == 2


def test_oblique_volume_blocks_inference_and_job_lifecycle_fixes(
    fix_client: TestClient,
    fix_db: Session,
    fix_settings: Settings,
) -> None:
    doctor = _seed_doctor(fix_db, "doc.jobs.fix")
    hdrs = _login(fix_client, doctor.username)

    # 1. Oblique 240x240x155 1mm pair uploads as valid for viewer, but blocks AI job creation
    _, obl_case_id = _create_case(fix_client, hdrs, "PAT-OBL-01")
    theta = np.deg2rad(20.0)
    obl_aff = np.eye(4, dtype=np.float64)
    obl_aff[:3, :3] = np.array(
        [
            [1.0, 0.0, 0.0],
            [0.0, np.cos(theta), -np.sin(theta)],
            [0.0, np.sin(theta), np.cos(theta)],
        ],
        dtype=np.float64,
    )
    obl_bytes = _nifti_gz_bytes(np.zeros(_BRATS_SHAPE, dtype=np.float32), obl_aff)
    for mod in ("flair", "t1ce"):
        rv = fix_client.post(
            f"/api/v1/cases/{obl_case_id}/volumes",
            headers=hdrs,
            data={"modality": mod},
            files={"file": (f"{mod}.nii.gz", obl_bytes, "application/gzip")},
        )
        assert rv.status_code == 201, rv.text
        assert rv.json()["model_profile_compatible"] is False

    obl_case = fix_client.get(f"/api/v1/cases/{obl_case_id}", headers=hdrs).json()
    assert obl_case["readiness"] == "invalid"
    assert obl_case["can_run_inference"] is False
    assert any("oblique" in r.lower() for r in obl_case["blocking_reasons"])

    r_obl_job = fix_client.post(
        f"/api/v1/cases/{obl_case_id}/jobs",
        headers={**hdrs, "Idempotency-Key": str(uuid.uuid4())},
        json={},
    )
    assert r_obl_job.status_code == 422
    assert r_obl_job.json()["error"]["code"] == "case_not_ready"

    # 2. Claim skips broken head queued job (input_changed) and claims next valid queued job;
    #    fail_job auto-retries worker_error once; cancel after attempt_count > 0 keeps lock.
    model = sync_active_model(fix_db, fix_settings)
    fix_db.commit()

    storage = LocalStorageAdapter(fix_settings.effective_storage_root)
    axis_aff = np.eye(4, dtype=np.float64)
    valid_bytes = _nifti_gz_bytes(np.zeros(_BRATS_SHAPE, dtype=np.float32), axis_aff)

    _, broken_case_id = _create_case(fix_client, hdrs, "PAT-BROKEN-Q")
    broken_job = InferenceJob(
        case_id=uuid.UUID(broken_case_id),
        doctor_id=doctor.id,
        model_version_id=model.id,
        state="queued",
        stage="queued",
    )
    fix_db.add(broken_job)
    fix_db.commit()
    broken_job_id = str(broken_job.id)

    _, ready_case_id = _create_case(fix_client, hdrs, "PAT-READY-Q")
    for mod in ("flair", "t1ce"):
        assert (
            fix_client.post(
                f"/api/v1/cases/{ready_case_id}/volumes",
                headers=hdrs,
                data={"modality": mod},
                files={"file": (f"{mod}.nii.gz", valid_bytes, "application/gzip")},
            ).status_code
            == 201
        )
    good_job_resp = fix_client.post(
        f"/api/v1/cases/{ready_case_id}/jobs",
        headers={**hdrs, "Idempotency-Key": str(uuid.uuid4())},
        json={},
    )
    assert good_job_resp.status_code == 202
    good_job_id = good_job_resp.json()["job"]["id"]

    worker_hdr = {"X-Worker-Token": _WORKER_TOKEN}
    claim1_resp = fix_client.post(
        "/api/v1/internal/worker/claim",
        headers=worker_hdr,
        json={"worker_id": "w-fix-1", "device_type": "CPU", "model_version_id": model.id},
    )
    assert claim1_resp.status_code == 200, claim1_resp.text
    claim1 = claim1_resp.json()
    assert claim1["job_id"] == good_job_id

    # Broken head job was marked failed(input_changed) automatically during the same claim!
    broken_state = fix_client.get(f"/api/v1/jobs/{broken_job_id}", headers=hdrs).json()
    assert broken_state["state"] == "failed"
    assert broken_state["error_code"] == "input_changed"

    # Worker heartbeat rejects stage="done" with 422
    bad_stage_hb = fix_client.post(
        f"/api/v1/internal/jobs/{good_job_id}/heartbeat",
        headers=worker_hdr,
        json={
            "worker_id": "w-fix-1",
            "attempt_id": claim1["attempt_id"],
            "lease_token": claim1["lease_token"],
            "stage": "done",
            "completed_slices": 155,
            "total_slices": 155,
        },
    )
    assert bad_stage_hb.status_code == 422

    # fail_job with error_code="worker_error" auto-requeues once (attempt_count == 1)
    fail_retry = fix_client.post(
        f"/api/v1/internal/jobs/{good_job_id}/fail",
        headers=worker_hdr,
        json={
            "worker_id": "w-fix-1",
            "attempt_id": claim1["attempt_id"],
            "lease_token": claim1["lease_token"],
            "error_code": "worker_error",
        },
    )
    assert fail_retry.status_code == 200
    assert fail_retry.json()["job"]["state"] == "queued"
    assert fail_retry.json()["job"]["error_code"] == "worker_retry"

    # Cancel requeued job (attempt_count == 1): clears error_code, KEEPS inputs_locked_at!
    cancelled = fix_client.post(f"/api/v1/jobs/{good_job_id}/cancel", headers=hdrs)
    assert cancelled.status_code == 200
    assert cancelled.json()["state"] == "cancelled"
    assert cancelled.json()["error_code"] is None
    case_after_cancel = fix_client.get(f"/api/v1/cases/{ready_case_id}", headers=hdrs).json()
    assert case_after_cancel["is_inputs_locked"] is True
    assert case_after_cancel["inputs_locked_at"] is not None

    # Enqueue another job, claim, verify bad coverage_json -> 422, then complete & check .json
    job2_id = fix_client.post(
        f"/api/v1/cases/{ready_case_id}/jobs",
        headers={**hdrs, "Idempotency-Key": str(uuid.uuid4())},
        json={},
    ).json()["job"]["id"]
    claim2 = fix_client.post(
        "/api/v1/internal/worker/claim",
        headers=worker_hdr,
        json={"worker_id": "w-fix-1", "device_type": "CPU", "model_version_id": model.id},
    ).json()

    mask_bytes = _nifti_gz_bytes(np.zeros(_BRATS_SHAPE, dtype=np.uint8), axis_aff)
    bad_cov_complete = fix_client.post(
        f"/api/v1/internal/jobs/{job2_id}/complete",
        headers={
            **worker_hdr,
            "X-Attempt-ID": claim2["attempt_id"],
            "X-Worker-ID": "w-fix-1",
            "X-Lease-Token": claim2["lease_token"],
        },
        files={
            "mask": ("mask.nii.gz", mask_bytes, "application/gzip"),
            "coverage": (
                "coverage.json",
                json.dumps({"original_shape": [1, 1, 1], "pipeline_version": "v1"}).encode(),
                "application/json",
            ),
            "metadata": (
                "metadata.json",
                json.dumps({"pipeline_version": "v1"}).encode(),
                "application/json",
            ),
        },
    )
    assert bad_cov_complete.status_code == 422
    assert bad_cov_complete.json()["error"]["code"] == "invalid_result_metadata"

    good_cov = {
        "original_shape": list(_BRATS_SHAPE),
        "pipeline_version": "tda-segunet-2d-v1",
        "slice_crops": [
            {"z": z, "x0": 0, "y0": 0, "x1": 128, "y1": 128, "evaluated": True}
            for z in range(_BRATS_SHAPE[2])
        ],
    }
    ok_complete = fix_client.post(
        f"/api/v1/internal/jobs/{job2_id}/complete",
        headers={
            **worker_hdr,
            "X-Attempt-ID": claim2["attempt_id"],
            "X-Worker-ID": "w-fix-1",
            "X-Lease-Token": claim2["lease_token"],
        },
        files={
            "mask": ("mask.nii.gz", mask_bytes, "application/gzip"),
            "coverage": ("coverage.json", json.dumps(good_cov).encode(), "application/json"),
            "metadata": (
                "metadata.json",
                json.dumps({"pipeline_version": "tda-segunet-2d-v1"}).encode(),
                "application/json",
            ),
        },
    )
    assert ok_complete.status_code == 200, ok_complete.text
    mv_id = ok_complete.json()["job"]["result_mask_version_id"]
    meta_out = fix_client.get(f"/api/v1/mask-versions/{mv_id}/metadata", headers=hdrs).json()
    cov_fid = meta_out["coverage"]["coverage_file_id"]
    cov_dl = fix_client.get(f"/api/v1/files/{cov_fid}/content", headers=hdrs)
    assert cov_dl.status_code == 200
    assert cov_dl.headers["content-disposition"].endswith('.json"')

    # Empty queue claim returns 204 and clears any stale worker.current_job_id
    fix_db.expire_all()
    w_inst = fix_db.get(WorkerInstance, "w-fix-1")
    assert w_inst is not None
    w_inst.current_job_id = uuid.uuid4()
    fix_db.commit()

    empty_resp = fix_client.post(
        "/api/v1/internal/worker/claim",
        headers=worker_hdr,
        json={"worker_id": "w-fix-1", "device_type": "CPU", "model_version_id": model.id},
    )
    assert empty_resp.status_code == 204
    fix_db.expire_all()
    w_after = fix_db.get(WorkerInstance, "w-fix-1")
    assert w_after is not None and w_after.current_job_id is None
    _ = storage


def test_patient_delete_finalizes_clean_case_even_if_sibling_case_file_fails_unlink(
    fix_client: TestClient,
    fix_db: Session,
    fix_settings: Settings,
) -> None:
    doctor = _seed_doctor(fix_db, "doc.pat.del")
    hdrs = _login(fix_client, doctor.username)
    pat_id, case_clean_id = _create_case(fix_client, hdrs, "PAT-PARTIAL-DEL")
    case_busy_resp = fix_client.post(
        f"/api/v1/patients/{pat_id}/cases",
        headers={**hdrs, "Idempotency-Key": str(uuid.uuid4())},
        json={"study_date": date.today().isoformat(), "notes": "busy case"},
    )
    assert case_busy_resp.status_code == 201
    case_busy_id = case_busy_resp.json()["id"]

    vol_bytes = _nifti_gz_bytes(np.zeros((6, 6, 6), dtype=np.float32), np.eye(4))
    busy_vol = fix_client.post(
        f"/api/v1/cases/{case_busy_id}/volumes",
        headers=hdrs,
        data={"modality": "flair"},
        files={"file": ("busy.nii.gz", vol_bytes, "application/gzip")},
    ).json()
    busy_sf = fix_db.get(StoredFile, uuid.UUID(busy_vol["file_id"]))
    assert busy_sf is not None and busy_sf.storage_key is not None
    busy_key = str(busy_sf.storage_key)

    real_delete = LocalStorageAdapter.delete

    def _fail_busy_key(self: LocalStorageAdapter, storage_key: str) -> None:
        if storage_key == busy_key:
            raise OSError("simulated busy file")
        real_delete(self, storage_key)

    with patch.object(LocalStorageAdapter, "delete", _fail_busy_key):
        del_resp = fix_client.delete(f"/api/v1/patients/{pat_id}", headers=hdrs)
    assert del_resp.status_code == 202
    assert del_resp.json()["status"] == "deleting"

    fix_db.expire_all()
    clean_case = fix_db.get(Case, uuid.UUID(case_clean_id))
    busy_case = fix_db.get(Case, uuid.UUID(case_busy_id))
    assert clean_case is not None and clean_case.deleted_at is not None
    assert busy_case is not None and busy_case.deleted_at is None
    # Clean up remaining busy file so storage stays tidy
    LocalStorageAdapter(fix_settings.effective_storage_root).delete(busy_key)
    _ = Path
    _ = Any
