"""Integration tests for Phase P3: Patients, Cases, Idempotency, Volumes, Quota, and File ACL."""

from __future__ import annotations

import gzip
import io
import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier
from typing import Any
from zoneinfo import ZoneInfo

import nibabel as nib
import numpy as np
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.core.security import hash_password
from app.main import create_app
from app.models.audit_event import AuditEvent
from app.models.case import Case
from app.models.inference_job import InferenceJob
from app.models.stored_file import StoredFile
from app.models.system_setting import SystemSetting
from app.models.user import User
from app.services.file_cleanup_service import run_orphan_cleanup
from app.services.job_service import sync_active_model


def _make_nifti_gz_bytes(
    shape: tuple[int, int, int] = (240, 240, 155),
    *,
    spacing: tuple[float, float, float] = (1.0, 1.0, 1.0),
    origin: tuple[float, float, float] = (0.0, 0.0, 0.0),
    dtype: Any = np.float32,
) -> bytes:
    data = np.zeros(shape, dtype=dtype)
    affine = np.diag([spacing[0], spacing[1], spacing[2], 1.0])
    affine[:3, 3] = list(origin)
    img = nib.Nifti1Image(data, affine)
    img.header.set_xyzt_units("mm", "sec")
    img.set_qform(affine, code=1)
    img.set_sform(affine, code=1)
    bio = io.BytesIO()
    fmap = img.make_file_map({"image": bio, "header": bio})
    img.to_file_map(fmap)
    return gzip.compress(bio.getvalue())


@pytest.fixture()
def clean_p3_db(migrated_postgres: str) -> Iterator[None]:
    engine = create_engine(migrated_postgres)
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "TRUNCATE TABLE volumes, stored_files, case_create_idempotency_keys, "
                    "cases, patients, system_settings, audit_events, login_attempts, "
                    "refresh_tokens, sessions, users RESTART IDENTITY CASCADE"
                )
            )
        yield
    finally:
        engine.dispose()


@pytest.fixture()
def p3_db_session(clean_p3_db: None, migrated_postgres: str) -> Iterator[Session]:
    engine = create_engine(migrated_postgres)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    try:
        with SessionLocal() as session:
            yield session
    finally:
        engine.dispose()


@pytest.fixture()
def p3_client(clean_p3_db: None, test_settings: Settings) -> Iterator[TestClient]:
    application = create_app(settings=test_settings)
    with TestClient(application, raise_server_exceptions=False) as client:
        yield client


def _seed_user(
    db: Session,
    *,
    username: str,
    password: str = "ValidPass123!",
    role: str = "doctor",
    display_name: str = "Test User",
) -> User:
    user = User(
        username=username,
        display_name=display_name,
        password_hash=hash_password(password),
        role=role,
        is_active=True,
        must_change_password=False,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _login(client: TestClient, username: str, password: str = "ValidPass123!") -> str:
    resp = client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": password},
    )
    assert resp.status_code == 200, resp.text
    return str(resp.json()["access_token"])


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_qa_acl_01_02_patient_case_volume_and_file_ownership_isolation(
    p3_client: TestClient,
    p3_db_session: Session,
    test_settings: Settings,
    caplog: pytest.LogCaptureFixture,
) -> None:
    _seed_user(p3_db_session, username="doc_a", display_name="Doctor A")
    _seed_user(p3_db_session, username="doc_b", display_name="Doctor B")
    _seed_user(p3_db_session, username="admin_u", role="admin", display_name="Admin")

    tok_a = _login(p3_client, "doc_a")
    tok_b = _login(p3_client, "doc_b")
    tok_admin = _login(p3_client, "admin_u")

    # Admin is forbidden on clinical endpoints
    assert p3_client.get("/api/v1/patients", headers=_auth_header(tok_admin)).status_code == 403
    assert p3_client.get("/api/v1/cases", headers=_auth_header(tok_admin)).status_code == 403

    # Unknown owner_id field in create payload is rejected
    bad_create = p3_client.post(
        "/api/v1/patients",
        headers=_auth_header(tok_a),
        json={
            "patient_code": "P-001",
            "full_name": "Nguyen Van A",
            "birth_year": 1980,
            "sex": "male",
            "owner_id": str(uuid.uuid4()),
        },
    )
    assert bad_create.status_code == 422

    # Doctor A creates patient
    r_pat_a = p3_client.post(
        "/api/v1/patients",
        headers=_auth_header(tok_a),
        json={
            "patient_code": "P-001",
            "full_name": "Nguyen Van A",
            "birth_year": 1980,
            "sex": "male",
        },
    )
    assert r_pat_a.status_code == 201, r_pat_a.text
    pat_a_id = r_pat_a.json()["id"]

    # Doctor B CAN reuse the same patient_code "p-001"
    r_pat_b = p3_client.post(
        "/api/v1/patients",
        headers=_auth_header(tok_b),
        json={
            "patient_code": "p-001",
            "full_name": "Tran Thi B",
            "birth_year": 1985,
            "sex": "female",
        },
    )
    assert r_pat_b.status_code == 201, r_pat_b.text

    # Doctor A CANNOT duplicate "p-001" (case-insensitive)
    r_dup_a = p3_client.post(
        "/api/v1/patients",
        headers=_auth_header(tok_a),
        json={
            "patient_code": "p-001",
            "full_name": "Duplicate",
            "birth_year": 1990,
            "sex": "other",
        },
    )
    assert r_dup_a.status_code == 409
    assert r_dup_a.json()["error"]["code"] == "patient_code_exists"

    # Doctor A creates case & uploads FLAIR
    today_vn = datetime.now(ZoneInfo("Asia/Ho_Chi_Minh")).date().isoformat()
    r_case_a = p3_client.post(
        f"/api/v1/patients/{pat_a_id}/cases",
        headers={**_auth_header(tok_a), "Idempotency-Key": str(uuid.uuid4())},
        json={"study_date": today_vn, "notes": "Baseline MRI"},
    )
    assert r_case_a.status_code == 201, r_case_a.text
    case_a_id = r_case_a.json()["id"]

    gz_bytes = _make_nifti_gz_bytes((16, 16, 16))
    r_vol_a = p3_client.post(
        f"/api/v1/cases/{case_a_id}/volumes",
        headers=_auth_header(tok_a),
        data={"modality": "flair"},
        files={"file": ("../../evil\r\n_flair.nii.gz", gz_bytes, "application/gzip")},
    )
    assert r_vol_a.status_code == 201, r_vol_a.text
    file_a_id = r_vol_a.json()["file_id"]
    vol_a_id = r_vol_a.json()["id"]
    assert "storage_key" not in r_vol_a.json()
    sanitized_fname = r_vol_a.json()["filename"]
    assert sanitized_fname is not None
    assert ".." not in sanitized_fname and "/" not in sanitized_fname
    assert "\\" not in sanitized_fname
    assert "\r" not in sanitized_fname and "\n" not in sanitized_fname
    assert sanitized_fname.endswith("_flair.nii.gz")

    r_vols_list = p3_client.get(
        f"/api/v1/cases/{case_a_id}/volumes", headers=_auth_header(tok_a)
    )
    assert r_vols_list.status_code == 200
    assert r_vols_list.json()[0]["filename"] == sanitized_fname

    # QA-FILE-04: StoredFile object path stays strictly under objects_root; no 'evil' path
    sf_a = p3_db_session.get(StoredFile, uuid.UUID(file_a_id))
    assert sf_a is not None and sf_a.storage_key is not None
    objects_root = (test_settings.effective_storage_root / "objects").resolve()
    obj_path = (objects_root / str(sf_a.storage_key)).resolve()
    assert obj_path.is_relative_to(objects_root)
    assert obj_path.is_file()
    for p in test_settings.effective_storage_root.rglob("*"):
        assert "evil" not in p.name

    # Doctor B gets 404 on every Doctor A resource
    assert (
        p3_client.get(f"/api/v1/patients/{pat_a_id}", headers=_auth_header(tok_b)).status_code
        == 404
    )
    assert (
        p3_client.patch(
            f"/api/v1/patients/{pat_a_id}",
            headers=_auth_header(tok_b),
            json={"full_name": "Hacked"},
        ).status_code
        == 404
    )
    assert (
        p3_client.delete(f"/api/v1/patients/{pat_a_id}", headers=_auth_header(tok_b)).status_code
        == 404
    )
    assert (
        p3_client.get(
            f"/api/v1/patients/{pat_a_id}/cases", headers=_auth_header(tok_b)
        ).status_code
        == 404
    )
    assert (
        p3_client.post(
            f"/api/v1/patients/{pat_a_id}/cases",
            headers={**_auth_header(tok_b), "Idempotency-Key": str(uuid.uuid4())},
            json={"study_date": today_vn, "notes": "Cross-owner"},
        ).status_code
        == 404
    )
    assert (
        p3_client.get(f"/api/v1/cases/{case_a_id}", headers=_auth_header(tok_b)).status_code == 404
    )
    assert (
        p3_client.get(
            f"/api/v1/cases/{case_a_id}/volumes", headers=_auth_header(tok_b)
        ).status_code
        == 404
    )
    assert (
        p3_client.get(
            f"/api/v1/files/{file_a_id}/content", headers=_auth_header(tok_b)
        ).status_code
        == 404
    )

    # Admin gets 403 on all clinical patient/case/volume/file endpoints
    for method, url, kwargs in [
        ("GET", f"/api/v1/patients/{pat_a_id}", {}),
        ("PATCH", f"/api/v1/patients/{pat_a_id}", {"json": {"full_name": "X"}}),
        ("DELETE", f"/api/v1/patients/{pat_a_id}", {}),
        ("GET", f"/api/v1/patients/{pat_a_id}/cases", {}),
        (
            "POST",
            f"/api/v1/patients/{pat_a_id}/cases",
            {
                "json": {"study_date": today_vn, "notes": "x"},
                "headers": {"Idempotency-Key": str(uuid.uuid4())},
            },
        ),
        ("GET", f"/api/v1/cases/{case_a_id}", {}),
        ("PATCH", f"/api/v1/cases/{case_a_id}", {"json": {"notes": "x"}}),
        ("DELETE", f"/api/v1/cases/{case_a_id}", {}),
        ("GET", f"/api/v1/cases/{case_a_id}/volumes", {}),
        (
            "POST",
            f"/api/v1/cases/{case_a_id}/volumes",
            {
                "data": {"modality": "t1ce"},
                "files": {"file": ("t1.nii.gz", gz_bytes, "application/gzip")},
            },
        ),
        ("DELETE", f"/api/v1/cases/{case_a_id}/volumes/{vol_a_id}", {}),
        ("GET", f"/api/v1/files/{file_a_id}/content", {}),
    ]:
        extra_headers = kwargs.pop("headers", {})
        resp = p3_client.request(
            method, url, headers={**_auth_header(tok_admin), **extra_headers}, **kwargs
        )
        assert resp.status_code == 403, f"{method} {url} -> {resp.status_code}"
        for forbidden in ("Nguyen Van A", "P-001", case_a_id, today_vn, "Baseline MRI"):
            assert forbidden not in resp.text

    # Assert audit_events and app logs contain NO clinical PII
    audits = p3_db_session.query(AuditEvent).all()
    audit_dump = " ".join(
        f"{a.action} {a.resource_type} {a.resource_id} {a.safe_diff}" for a in audits
    )
    safe_diff_dump = " ".join(str(a.safe_diff) for a in audits)
    for pii in ("Nguyen Van A", "P-001", "Baseline MRI", today_vn):
        assert pii not in audit_dump
    assert pat_a_id not in safe_diff_dump
    for pii in ("Nguyen Van A", "P-001", "Baseline MRI", case_a_id):
        assert pii not in caplog.text

    # Doctor A downloads file with safe Content-Disposition and no-store
    r_dl = p3_client.get(f"/api/v1/files/{file_a_id}/content", headers=_auth_header(tok_a))
    assert r_dl.status_code == 200
    assert r_dl.content == gz_bytes
    assert r_dl.headers.get("cache-control") == "no-store"
    cd = r_dl.headers.get("content-disposition", "")
    assert ".." not in cd
    assert "\r" not in cd and "\n" not in cd
    assert "evil" not in cd
    assert f"volume-{file_a_id}.nii.gz" in cd


def test_patient_search_like_escaping_and_deletion_audit_without_pii(
    p3_client: TestClient,
    p3_db_session: Session,
) -> None:
    _seed_user(p3_db_session, username="doc_search")
    tok = _login(p3_client, "doc_search")

    p1 = p3_client.post(
        "/api/v1/patients",
        headers=_auth_header(tok),
        json={
            "patient_code": "100%_MATCH",
            "full_name": "Le Van Percent",
            "birth_year": 1975,
            "sex": "male",
        },
    )
    assert p1.status_code == 201
    p1_id = p1.json()["id"]

    p2 = p3_client.post(
        "/api/v1/patients",
        headers=_auth_header(tok),
        json={
            "patient_code": "OTHER_CODE",
            "full_name": "Pham Thi Other",
            "birth_year": 1988,
            "sex": "female",
        },
    )
    assert p2.status_code == 201

    # Searching "%" should match only p1, not act as a wildcard matching p2
    r_search = p3_client.get("/api/v1/patients?q=%25", headers=_auth_header(tok))
    assert r_search.status_code == 200
    items = r_search.json()["items"]
    assert len(items) == 1
    assert items[0]["id"] == p1_id

    # Delete patient p1 and verify technical audit has no PII
    r_del = p3_client.delete(f"/api/v1/patients/{p1_id}", headers=_auth_header(tok))
    assert r_del.status_code == 202
    assert r_del.json()["status"] == "deleted"

    # Patient is no longer accessible
    assert p3_client.get(f"/api/v1/patients/{p1_id}", headers=_auth_header(tok)).status_code == 404

    # Same patient_code can be reused after deletion
    p1_reused = p3_client.post(
        "/api/v1/patients",
        headers=_auth_header(tok),
        json={
            "patient_code": "100%_MATCH",
            "full_name": "Reused Code",
            "birth_year": 1976,
            "sex": "male",
        },
    )
    assert p1_reused.status_code == 201

    audits = p3_db_session.query(AuditEvent).all()
    serialized = " ".join(str(a.safe_diff) for a in audits)
    assert "Le Van Percent" not in serialized
    assert "100%_MATCH" not in serialized


def test_qa_case_01_idempotency_concurrency_conflict_and_deleted_case(
    p3_client: TestClient,
    p3_db_session: Session,
    test_settings: Settings,
) -> None:
    _seed_user(p3_db_session, username="doc_idem")
    tok = _login(p3_client, "doc_idem")

    r_pat = p3_client.post(
        "/api/v1/patients",
        headers=_auth_header(tok),
        json={
            "patient_code": "IDEM-01",
            "full_name": "Idempotency Patient",
            "birth_year": 1990,
            "sex": "unknown",
        },
    )
    assert r_pat.status_code == 201
    pat_id = r_pat.json()["id"]

    today_vn = datetime.now(ZoneInfo("Asia/Ho_Chi_Minh")).date()
    future_vn = (today_vn + timedelta(days=1)).isoformat()
    today_str = today_vn.isoformat()

    # Missing or invalid Idempotency-Key -> 422
    assert (
        p3_client.post(
            f"/api/v1/patients/{pat_id}/cases",
            headers=_auth_header(tok),
            json={"study_date": today_str, "notes": "n"},
        ).status_code
        == 422
    )
    assert (
        p3_client.post(
            f"/api/v1/patients/{pat_id}/cases",
            headers={**_auth_header(tok), "Idempotency-Key": "not-a-uuid"},
            json={"study_date": today_str, "notes": "n"},
        ).status_code
        == 422
    )

    # Future study_date -> 422
    assert (
        p3_client.post(
            f"/api/v1/patients/{pat_id}/cases",
            headers={**_auth_header(tok), "Idempotency-Key": str(uuid.uuid4())},
            json={"study_date": future_vn, "notes": "future"},
        ).status_code
        == 422
    )

    # Concurrent create with same Idempotency-Key against real PostgreSQL
    idem_key = str(uuid.uuid4())
    payload = {"study_date": today_str, "notes": "Concurrent baseline"}
    barrier = Barrier(2)
    app_instance = create_app(settings=test_settings)

    def _worker() -> tuple[int, str]:
        with TestClient(app_instance, raise_server_exceptions=False) as local_client:
            barrier.wait(timeout=5)
            resp = local_client.post(
                f"/api/v1/patients/{pat_id}/cases",
                headers={**_auth_header(tok), "Idempotency-Key": idem_key},
                json=payload,
            )
            return resp.status_code, resp.json()["id"]

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: _worker(), range(2)))

    assert results[0][0] == 201
    assert results[1][0] == 201
    assert results[0][1] == results[1][1]
    case_id = results[0][1]

    # Replay same key with different body -> 409 idempotency_conflict
    r_conflict = p3_client.post(
        f"/api/v1/patients/{pat_id}/cases",
        headers={**_auth_header(tok), "Idempotency-Key": idem_key},
        json={"study_date": today_str, "notes": "Different notes"},
    )
    assert r_conflict.status_code == 409
    assert r_conflict.json()["error"]["code"] == "idempotency_conflict"

    # Delete case -> 202, then replay same key + payload -> 409 case_deleted
    r_del = p3_client.delete(f"/api/v1/cases/{case_id}", headers=_auth_header(tok))
    assert r_del.status_code == 202

    r_replay_deleted = p3_client.post(
        f"/api/v1/patients/{pat_id}/cases",
        headers={**_auth_header(tok), "Idempotency-Key": idem_key},
        json=payload,
    )
    assert r_replay_deleted.status_code == 409
    assert r_replay_deleted.json()["error"]["code"] == "case_deleted"


def test_qa_file_volume_lifecycle_geometry_mismatch_and_ops_lock(
    p3_client: TestClient,
    p3_db_session: Session,
) -> None:
    _seed_user(p3_db_session, username="doc_vol")
    tok = _login(p3_client, "doc_vol")

    r_pat = p3_client.post(
        "/api/v1/patients",
        headers=_auth_header(tok),
        json={
            "patient_code": "VOL-01",
            "full_name": "Volume Patient",
            "birth_year": 1982,
            "sex": "female",
        },
    )
    pat_id = r_pat.json()["id"]
    today_str = datetime.now(ZoneInfo("Asia/Ho_Chi_Minh")).date().isoformat()
    r_case = p3_client.post(
        f"/api/v1/patients/{pat_id}/cases",
        headers={**_auth_header(tok), "Idempotency-Key": str(uuid.uuid4())},
        json={"study_date": today_str, "notes": "MRI"},
    )
    case_id = r_case.json()["id"]

    # 1. Upload T1ce first (non-BraTS shape 32x32x16 -> valid for viewer, blocks AI)
    t1ce_small = _make_nifti_gz_bytes((32, 32, 16))
    r_t1ce = p3_client.post(
        f"/api/v1/cases/{case_id}/volumes",
        headers=_auth_header(tok),
        data={"modality": "t1ce"},
        files={"file": ("t1ce.nii.gz", t1ce_small, "application/gzip")},
    )
    assert r_t1ce.status_code == 201, r_t1ce.text
    t1ce_id = r_t1ce.json()["id"]
    assert r_t1ce.json()["model_profile_compatible"] is False

    c1 = p3_client.get(f"/api/v1/cases/{case_id}", headers=_auth_header(tok)).json()
    assert c1["reference_volume_id"] == t1ce_id
    assert c1["readiness"] == "missing_inputs"
    assert c1["can_run_inference"] is False

    # 2. Duplicate modality -> 409 modality_exists
    r_dup_mod = p3_client.post(
        f"/api/v1/cases/{case_id}/volumes",
        headers=_auth_header(tok),
        data={"modality": "t1ce"},
        files={"file": ("t1ce2.nii.gz", t1ce_small, "application/gzip")},
    )
    assert r_dup_mod.status_code == 409
    assert r_dup_mod.json()["error"]["code"] == "modality_exists"

    # 3. Geometry mismatch on FLAIR -> 422 geometry_mismatch
    flair_mismatch = _make_nifti_gz_bytes((32, 32, 15))
    r_mis = p3_client.post(
        f"/api/v1/cases/{case_id}/volumes",
        headers=_auth_header(tok),
        data={"modality": "flair"},
        files={"file": ("flair_bad.nii.gz", flair_mismatch, "application/gzip")},
    )
    assert r_mis.status_code == 422
    assert r_mis.json()["error"]["code"] == "geometry_mismatch"

    # 4. Matching FLAIR (32x32x16) -> reference switches to FLAIR, readiness="invalid" (non-BraTS)
    r_flair_small = p3_client.post(
        f"/api/v1/cases/{case_id}/volumes",
        headers=_auth_header(tok),
        data={"modality": "flair"},
        files={"file": ("flair_small.nii.gz", t1ce_small, "application/gzip")},
    )
    assert r_flair_small.status_code == 201
    flair_small_id = r_flair_small.json()["id"]

    c2 = p3_client.get(f"/api/v1/cases/{case_id}", headers=_auth_header(tok)).json()
    assert c2["reference_volume_id"] == flair_small_id
    assert c2["readiness"] == "invalid"
    assert c2["can_run_inference"] is False
    assert len(c2["blocking_reasons"]) >= 1

    # Delete both small volumes and upload BraTS (240x240x155, 1mm) -> readiness="ready"
    assert (
        p3_client.delete(
            f"/api/v1/cases/{case_id}/volumes/{flair_small_id}", headers=_auth_header(tok)
        ).status_code
        == 202
    )
    assert (
        p3_client.delete(
            f"/api/v1/cases/{case_id}/volumes/{t1ce_id}", headers=_auth_header(tok)
        ).status_code
        == 202
    )

    brats_bytes = _make_nifti_gz_bytes((240, 240, 155), spacing=(1.0, 1.0, 1.0))
    r_b_flair = p3_client.post(
        f"/api/v1/cases/{case_id}/volumes",
        headers=_auth_header(tok),
        data={"modality": "flair"},
        files={"file": ("brats_flair.nii.gz", brats_bytes, "application/gzip")},
    )
    assert r_b_flair.status_code == 201
    b_flair_id = r_b_flair.json()["id"]

    r_b_t1ce = p3_client.post(
        f"/api/v1/cases/{case_id}/volumes",
        headers=_auth_header(tok),
        data={"modality": "t1ce"},
        files={"file": ("brats_t1ce.nii.gz", brats_bytes, "application/gzip")},
    )
    assert r_b_t1ce.status_code == 201

    c3 = p3_client.get(f"/api/v1/cases/{case_id}", headers=_auth_header(tok)).json()
    assert c3["readiness"] == "ready"
    assert c3["can_run_inference"] is True
    assert c3["blocking_reasons"] == []

    # QA-OPS-01: Lock inputs on case -> volume delete/upload returns 409 inputs_locked
    db_case = p3_db_session.get(Case, uuid.UUID(case_id))
    assert db_case is not None
    db_case.inputs_locked_at = datetime.now(UTC)
    p3_db_session.commit()

    r_locked_del = p3_client.delete(
        f"/api/v1/cases/{case_id}/volumes/{b_flair_id}",
        headers=_auth_header(tok),
    )
    assert r_locked_del.status_code == 409
    assert r_locked_del.json()["error"]["code"] == "inputs_locked"


def test_qa_file_03_atomic_quota_exhaustion_under_concurrency(
    p3_client: TestClient,
    p3_db_session: Session,
    test_settings: Settings,
) -> None:
    _seed_user(p3_db_session, username="doc_quota")
    tok = _login(p3_client, "doc_quota")

    r_pat = p3_client.post(
        "/api/v1/patients",
        headers=_auth_header(tok),
        json={
            "patient_code": "QUOTA-01",
            "full_name": "Quota Patient",
            "birth_year": 1985,
            "sex": "male",
        },
    )
    pat_id = r_pat.json()["id"]
    today_str = datetime.now(ZoneInfo("Asia/Ho_Chi_Minh")).date().isoformat()
    r_c1 = p3_client.post(
        f"/api/v1/patients/{pat_id}/cases",
        headers={**_auth_header(tok), "Idempotency-Key": str(uuid.uuid4())},
        json={"study_date": today_str, "notes": "Case 1"},
    )
    r_c2 = p3_client.post(
        f"/api/v1/patients/{pat_id}/cases",
        headers={**_auth_header(tok), "Idempotency-Key": str(uuid.uuid4())},
        json={"study_date": today_str, "notes": "Case 2"},
    )
    c1_id = r_c1.json()["id"]
    c2_id = r_c2.json()["id"]

    # Create a random non-zero NIfTI payload (~4-6 KB) and set doctor_quota_bytes to 1.5x its size
    rng = np.random.default_rng(42)
    raw_arr = rng.integers(0, 1000, size=(16, 16, 16), dtype=np.int16)
    affine = np.eye(4, dtype=np.float64)
    img = nib.Nifti1Image(raw_arr, affine)
    img.header.set_xyzt_units("mm", "sec")
    img.set_qform(affine, code=1)
    img.set_sform(affine, code=1)
    bio = io.BytesIO()
    fmap = img.make_file_map({"image": bio, "header": bio})
    img.to_file_map(fmap)
    payload = gzip.compress(bio.getvalue())

    quota_bytes = int(len(payload) * 1.5)
    p3_db_session.add(
        SystemSetting(key="doctor_quota_bytes", value_json={"bytes": quota_bytes})
    )
    p3_db_session.commit()

    barrier = Barrier(2)
    app_instance = create_app(settings=test_settings)

    def _upload(cid: str) -> tuple[int, str | None]:
        with TestClient(app_instance, raise_server_exceptions=False) as local_client:
            barrier.wait(timeout=5)
            resp = local_client.post(
                f"/api/v1/cases/{cid}/volumes",
                headers=_auth_header(tok),
                data={"modality": "flair"},
                files={"file": ("scan.nii.gz", payload, "application/gzip")},
            )
            code = resp.json().get("error", {}).get("code") if resp.status_code >= 400 else None
            return resp.status_code, code

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(_upload, [c1_id, c2_id]))

    statuses = sorted(item[0] for item in outcomes)
    assert statuses == [201, 413]
    codes = [item[1] for item in outcomes if item[0] == 413]
    assert codes == ["storage_quota_exceeded"]


def test_orphan_and_deleting_cleanup_is_idempotent(
    p3_db_session: Session,
    test_settings: Settings,
) -> None:
    from app.core.storage import LocalStorageAdapter

    user = _seed_user(p3_db_session, username="doc_cleanup")
    storage = LocalStorageAdapter(test_settings.effective_storage_root)

    # 1. Expired staging orphan
    staged = storage.put_temp(b"orphan-bytes")
    staging_path = storage.staging_root / staged.staging_key
    assert staging_path.is_file()

    # 2. Committed file marked "deleting"
    committed = storage.commit(storage.put_temp(b"deleting-bytes").staging_key)
    sf = StoredFile(
        storage_key=uuid.UUID(committed.storage_key),
        original_name="old.nii.gz",
        size_bytes=committed.size_bytes,
        sha256=committed.sha256,
        media_type="application/gzip",
        state="deleting",
        owner_id=user.id,
    )
    p3_db_session.add(sf)
    p3_db_session.commit()

    # 3. Unreferenced orphan object in objects_root
    orphan_obj = storage.commit(storage.put_temp(b"orphan-object-bytes").staging_key)
    assert (storage.objects_root / orphan_obj.storage_key).is_file()

    summary = run_orphan_cleanup(
        p3_db_session,
        storage,
        max_age_seconds=0,
        now=datetime.now(UTC).timestamp() + 10,
    )
    p3_db_session.commit()

    assert summary["staging_orphans_removed"] >= 1
    assert summary["deleting_files_finalized"] == 1
    assert summary["orphan_objects_removed"] >= 1
    p3_db_session.refresh(sf)
    assert sf.state == "deleted"
    assert sf.deleted_at is not None
    assert not (storage.objects_root / committed.storage_key).exists()
    assert not (storage.objects_root / orphan_obj.storage_key).exists()


def test_qa_file_03_same_shape_affine_and_spacing_mismatch_via_http(
    p3_client: TestClient,
    p3_db_session: Session,
    test_settings: Settings,
) -> None:
    _seed_user(p3_db_session, username="doc_geom")
    tok = _login(p3_client, "doc_geom")

    pat_id = p3_client.post(
        "/api/v1/patients",
        headers=_auth_header(tok),
        json={
            "patient_code": "GEOM-01",
            "full_name": "Geometry Patient",
            "birth_year": 1988,
            "sex": "male",
        },
    ).json()["id"]
    today_str = datetime.now(ZoneInfo("Asia/Ho_Chi_Minh")).date().isoformat()
    case_id = p3_client.post(
        f"/api/v1/patients/{pat_id}/cases",
        headers={**_auth_header(tok), "Idempotency-Key": str(uuid.uuid4())},
        json={"study_date": today_str, "notes": "Geom test"},
    ).json()["id"]

    flair_bytes = _make_nifti_gz_bytes(
        (16, 16, 16), spacing=(1.0, 1.0, 1.0), origin=(0.0, 0.0, 0.0)
    )
    assert (
        p3_client.post(
            f"/api/v1/cases/{case_id}/volumes",
            headers=_auth_header(tok),
            data={"modality": "flair"},
            files={"file": ("flair.nii.gz", flair_bytes, "application/gzip")},
        ).status_code
        == 201
    )

    # (a) Same shape (16,16,16), shifted origin -> 422 geometry_mismatch
    t1ce_bad_origin = _make_nifti_gz_bytes(
        (16, 16, 16), spacing=(1.0, 1.0, 1.0), origin=(0.5, 0.0, 0.0)
    )
    r_bad_origin = p3_client.post(
        f"/api/v1/cases/{case_id}/volumes",
        headers=_auth_header(tok),
        data={"modality": "t1ce"},
        files={"file": ("t1ce_origin.nii.gz", t1ce_bad_origin, "application/gzip")},
    )
    assert r_bad_origin.status_code == 422
    assert r_bad_origin.json()["error"]["code"] == "geometry_mismatch"

    # (b) Same shape (16,16,16), different spacing -> 422 geometry_mismatch
    t1ce_bad_spacing = _make_nifti_gz_bytes(
        (16, 16, 16), spacing=(1.5, 1.0, 1.0), origin=(0.0, 0.0, 0.0)
    )
    r_bad_spacing = p3_client.post(
        f"/api/v1/cases/{case_id}/volumes",
        headers=_auth_header(tok),
        data={"modality": "t1ce"},
        files={"file": ("t1ce_spacing.nii.gz", t1ce_bad_spacing, "application/gzip")},
    )
    assert r_bad_spacing.status_code == 422
    assert r_bad_spacing.json()["error"]["code"] == "geometry_mismatch"

    staging_dir = test_settings.effective_storage_root / "staging"
    assert not staging_dir.exists() or list(staging_dir.iterdir()) == []
    case_json = p3_client.get(f"/api/v1/cases/{case_id}", headers=_auth_header(tok)).json()
    assert case_json["can_run_inference"] is False


def test_qa_ops_01_active_job_blocks_case_and_patient_deletion(
    p3_client: TestClient,
    p3_db_session: Session,
    test_settings: Settings,
) -> None:
    user = _seed_user(p3_db_session, username="doc_ops")
    tok = _login(p3_client, "doc_ops")

    pat_id = p3_client.post(
        "/api/v1/patients",
        headers=_auth_header(tok),
        json={
            "patient_code": "OPS-01",
            "full_name": "Ops Patient",
            "birth_year": 1979,
            "sex": "female",
        },
    ).json()["id"]
    today_str = datetime.now(ZoneInfo("Asia/Ho_Chi_Minh")).date().isoformat()
    case_id = p3_client.post(
        f"/api/v1/patients/{pat_id}/cases",
        headers={**_auth_header(tok), "Idempotency-Key": str(uuid.uuid4())},
        json={"study_date": today_str, "notes": "Ops test"},
    ).json()["id"]

    vol_resp = p3_client.post(
        f"/api/v1/cases/{case_id}/volumes",
        headers=_auth_header(tok),
        data={"modality": "flair"},
        files={"file": ("flair.nii.gz", _make_nifti_gz_bytes((16, 16, 16)), "application/gzip")},
    )
    assert vol_resp.status_code == 201
    file_id = vol_resp.json()["file_id"]

    model = sync_active_model(p3_db_session, test_settings)
    job_id = uuid.uuid4()
    p3_db_session.add(
        InferenceJob(
            id=job_id,
            case_id=uuid.UUID(case_id),
            doctor_id=user.id,
            model_version_id=model.id,
            state="queued",
            stage="queued",
        )
    )
    p3_db_session.commit()

    try:
        for state in ("queued", "running"):
            p3_db_session.execute(
                text("UPDATE public.inference_jobs SET state = :st WHERE id = :id"),
                {"st": state, "id": job_id},
            )
            p3_db_session.commit()

            r_del_case = p3_client.delete(f"/api/v1/cases/{case_id}", headers=_auth_header(tok))
            assert r_del_case.status_code == 409
            assert r_del_case.json()["error"]["code"] == "active_job_conflict"

            r_del_pat = p3_client.delete(f"/api/v1/patients/{pat_id}", headers=_auth_header(tok))
            assert r_del_pat.status_code == 409
            assert r_del_pat.json()["error"]["code"] == "active_job_conflict"

        # Case, patient, volume, and file content remain intact
        assert (
            p3_client.get(f"/api/v1/patients/{pat_id}", headers=_auth_header(tok)).status_code
            == 200
        )
        assert (
            p3_client.get(f"/api/v1/cases/{case_id}", headers=_auth_header(tok)).status_code == 200
        )
        assert (
            p3_client.get(f"/api/v1/files/{file_id}/content", headers=_auth_header(tok)).status_code
            == 200
        )
    finally:
        p3_db_session.execute(
            text("DELETE FROM public.inference_jobs WHERE id = :id"),
            {"id": job_id},
        )
        p3_db_session.commit()


def test_concurrent_sibling_geometry_mismatch_and_upload_vs_delete_race(
    p3_client: TestClient,
    p3_db_session: Session,
    test_settings: Settings,
) -> None:
    _seed_user(p3_db_session, username="doc_race")
    tok = _login(p3_client, "doc_race")

    pat_id = p3_client.post(
        "/api/v1/patients",
        headers=_auth_header(tok),
        json={
            "patient_code": "RACE-01",
            "full_name": "Race Patient",
            "birth_year": 1991,
            "sex": "other",
        },
    ).json()["id"]
    today_str = datetime.now(ZoneInfo("Asia/Ho_Chi_Minh")).date().isoformat()

    # 1. Concurrent sibling uploads with mismatched geometry -> strictly 1x 201 + 1x 422
    case1_id = p3_client.post(
        f"/api/v1/patients/{pat_id}/cases",
        headers={**_auth_header(tok), "Idempotency-Key": str(uuid.uuid4())},
        json={"study_date": today_str, "notes": "Race geom"},
    ).json()["id"]

    flair_bytes = _make_nifti_gz_bytes((16, 16, 16), origin=(0.0, 0.0, 0.0))
    t1ce_mismatch = _make_nifti_gz_bytes((16, 16, 16), origin=(2.0, 0.0, 0.0))
    barrier_geom = Barrier(2)
    app_instance = create_app(settings=test_settings)

    def _upload_sibling(args: tuple[str, bytes]) -> tuple[int, str | None]:
        mod, payload = args
        with TestClient(app_instance, raise_server_exceptions=False) as local_client:
            barrier_geom.wait(timeout=5)
            resp = local_client.post(
                f"/api/v1/cases/{case1_id}/volumes",
                headers=_auth_header(tok),
                data={"modality": mod},
                files={"file": (f"{mod}.nii.gz", payload, "application/gzip")},
            )
            err_code = resp.json().get("error", {}).get("code") if resp.status_code >= 400 else None
            return resp.status_code, err_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        geom_outcomes = list(
            pool.map(_upload_sibling, [("flair", flair_bytes), ("t1ce", t1ce_mismatch)])
        )

    assert sorted(o[0] for o in geom_outcomes) == [201, 422]
    assert [o[1] for o in geom_outcomes if o[0] == 422] == ["geometry_mismatch"]

    # 2. Concurrent upload vs DELETE /cases/{id} -> never leaves committed file in deleted case
    case2_id = p3_client.post(
        f"/api/v1/patients/{pat_id}/cases",
        headers={**_auth_header(tok), "Idempotency-Key": str(uuid.uuid4())},
        json={"study_date": today_str, "notes": "Race delete"},
    ).json()["id"]
    barrier_del = Barrier(2)

    def _do_upload() -> int:
        with TestClient(app_instance, raise_server_exceptions=False) as local_client:
            barrier_del.wait(timeout=5)
            return local_client.post(
                f"/api/v1/cases/{case2_id}/volumes",
                headers=_auth_header(tok),
                data={"modality": "flair"},
                files={"file": ("flair.nii.gz", flair_bytes, "application/gzip")},
            ).status_code

    def _do_delete() -> int:
        with TestClient(app_instance, raise_server_exceptions=False) as local_client:
            barrier_del.wait(timeout=5)
            return local_client.delete(
                f"/api/v1/cases/{case2_id}",
                headers=_auth_header(tok),
            ).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        f_up = pool.submit(_do_upload)
        f_del = pool.submit(_do_delete)
        up_status = f_up.result()
        del_status = f_del.result()

    assert del_status == 202
    assert up_status in {201, 404}
    # Regardless of ordering, after DELETE completes, no committed files remain for case2
    assert p3_client.get(f"/api/v1/cases/{case2_id}", headers=_auth_header(tok)).status_code == 404
    remaining_committed = (
        p3_db_session.query(StoredFile).filter(StoredFile.state == "committed").all()
    )
    # Only the 1 committed file from case1 should exist
    assert len(remaining_committed) == 1


def test_qa_file_01_http_rejects_bad_uploads_cleanly(
    p3_client: TestClient,
    p3_db_session: Session,
    test_settings: Settings,
) -> None:
    _seed_user(p3_db_session, username="doc_bad_up")
    tok = _login(p3_client, "doc_bad_up")

    pat_id = p3_client.post(
        "/api/v1/patients",
        headers=_auth_header(tok),
        json={
            "patient_code": "BADUP-01",
            "full_name": "Bad Upload",
            "birth_year": 1986,
            "sex": "male",
        },
    ).json()["id"]
    today_str = datetime.now(ZoneInfo("Asia/Ho_Chi_Minh")).date().isoformat()
    case_id = p3_client.post(
        f"/api/v1/patients/{pat_id}/cases",
        headers={**_auth_header(tok), "Idempotency-Key": str(uuid.uuid4())},
        json={"study_date": today_str, "notes": "Bad upload"},
    ).json()["id"]

    # 4D NIfTI
    img_4d = nib.Nifti1Image(np.zeros((8, 8, 8, 2), dtype=np.float32), np.eye(4))
    bio_4d = io.BytesIO()
    img_4d.to_file_map(img_4d.make_file_map({"image": bio_4d, "header": bio_4d}))
    gz_4d = gzip.compress(bio_4d.getvalue())

    # NaN NIfTI
    arr_nan = np.zeros((8, 8, 8), dtype=np.float32)
    arr_nan[0, 0, 0] = np.nan
    img_nan = nib.Nifti1Image(arr_nan, np.eye(4))
    img_nan.header.set_xyzt_units("mm", "sec")
    img_nan.set_qform(np.eye(4), code=1)
    img_nan.set_sform(np.eye(4), code=1)
    bio_nan = io.BytesIO()
    img_nan.to_file_map(img_nan.make_file_map({"image": bio_nan, "header": bio_nan}))
    gz_nan = gzip.compress(bio_nan.getvalue())

    valid_gz = _make_nifti_gz_bytes((8, 8, 8))
    bad_cases = [
        ("bad.txt", b"not nifti"),
        ("corrupt.nii.gz", valid_gz[: len(valid_gz) // 2]),
        ("4d.nii.gz", gz_4d),
        ("nan.nii.gz", gz_nan),
    ]
    for fname, payload in bad_cases:
        resp = p3_client.post(
            f"/api/v1/cases/{case_id}/volumes",
            headers=_auth_header(tok),
            data={"modality": "flair"},
            files={"file": (fname, payload, "application/octet-stream")},
        )
        assert resp.status_code == 422, f"{fname} -> {resp.status_code} {resp.text}"

    staging_dir = test_settings.effective_storage_root / "staging"
    assert not staging_dir.exists() or list(staging_dir.iterdir()) == []
    assert (
        p3_client.get(f"/api/v1/cases/{case_id}/volumes", headers=_auth_header(tok)).json() == []
    )
    case_json = p3_client.get(f"/api/v1/cases/{case_id}", headers=_auth_header(tok)).json()
    assert case_json["readiness"] == "missing_inputs"


def _pad_gzip_fcomment_to_size(gz_bytes: bytes, target_size: int) -> bytes:
    """Pad a standard gzip stream (FLG=0) using FCOMMENT to reach an exact byte size."""
    assert gz_bytes[:3] == b"\x1f\x8b\x08"
    assert gz_bytes[3] == 0
    overhead = 1  # null terminator for FCOMMENT
    pad_len = target_size - len(gz_bytes) - overhead
    assert pad_len >= 0
    header = bytearray(gz_bytes[:10])
    header[3] = 0x10  # FCOMMENT flag
    return bytes(header) + (b"A" * pad_len) + b"\x00" + gz_bytes[10:]


def test_100_mib_exact_boundary_and_multipart_ingress_limit(
    p3_client: TestClient,
    p3_db_session: Session,
) -> None:
    from app.services.nifti_validator import DEFAULT_MAX_UPLOAD_BYTES

    _seed_user(p3_db_session, username="doc_100m")
    tok = _login(p3_client, "doc_100m")
    pat_id = p3_client.post(
        "/api/v1/patients",
        headers=_auth_header(tok),
        json={
            "patient_code": "M100-01",
            "full_name": "Boundary Patient",
            "birth_year": 1984,
            "sex": "unknown",
        },
    ).json()["id"]
    today_str = datetime.now(ZoneInfo("Asia/Ho_Chi_Minh")).date().isoformat()
    case_id = p3_client.post(
        f"/api/v1/patients/{pat_id}/cases",
        headers={**_auth_header(tok), "Idempotency-Key": str(uuid.uuid4())},
        json={"study_date": today_str, "notes": "100 MiB boundary"},
    ).json()["id"]

    base_gz = _make_nifti_gz_bytes((8, 8, 8))

    # 1. Exact 100 MiB (104,857,600 bytes) -> 201
    exact_100m = _pad_gzip_fcomment_to_size(base_gz, DEFAULT_MAX_UPLOAD_BYTES)
    assert len(exact_100m) == DEFAULT_MAX_UPLOAD_BYTES
    r_ok = p3_client.post(
        f"/api/v1/cases/{case_id}/volumes",
        headers=_auth_header(tok),
        data={"modality": "flair"},
        files={"file": ("exact100m.nii.gz", io.BytesIO(exact_100m), "application/gzip")},
    )
    del exact_100m
    assert r_ok.status_code == 201, r_ok.text

    # 2. 100 MiB + 1 byte (104,857,601 bytes) -> 413 payload_too_large
    over_100m = _pad_gzip_fcomment_to_size(base_gz, DEFAULT_MAX_UPLOAD_BYTES + 1)
    assert len(over_100m) == DEFAULT_MAX_UPLOAD_BYTES + 1
    r_over = p3_client.post(
        f"/api/v1/cases/{case_id}/volumes",
        headers=_auth_header(tok),
        data={"modality": "t1ce"},
        files={"file": ("over100m.nii.gz", io.BytesIO(over_100m), "application/gzip")},
    )
    del over_100m
    assert r_over.status_code == 413
    assert r_over.json()["error"]["code"] == "payload_too_large"

    # 3. Multipart > 101 MiB blocked at ASGI ingress with standard envelope & headers
    over_ingress = str(DEFAULT_MAX_UPLOAD_BYTES + 2 * 1024 * 1024)
    r_ingress = p3_client.post(
        f"/api/v1/cases/{case_id}/volumes",
        headers={**_auth_header(tok), "Content-Length": over_ingress},
        data={"modality": "t1ce"},
        files={"file": ("small.nii.gz", base_gz, "application/gzip")},
    )
    assert r_ingress.status_code == 413
    assert r_ingress.json()["error"]["code"] == "payload_too_large"
    assert r_ingress.headers.get("cache-control") == "no-store"
    assert r_ingress.headers.get("x-request-id")

    # 4. Streamed chunked request without Content-Length > limit -> also 413 at ASGI ingress
    def _chunked_over_limit():
        yield b"--chunkbound\r\n"
        chunk = b"a" * (1024 * 1024)
        for _ in range(102):
            yield chunk

    r_stream = p3_client.post(
        f"/api/v1/cases/{case_id}/volumes",
        headers={
            **_auth_header(tok),
            "Content-Type": "multipart/form-data; boundary=chunkbound",
        },
        content=_chunked_over_limit(),
    )
    assert r_stream.status_code == 413
    assert r_stream.json()["error"]["code"] == "payload_too_large"
    assert r_stream.headers.get("cache-control") == "no-store"
    assert r_stream.headers.get("x-request-id")


def test_pii_redaction_deleting_quota_and_orphan_finalization(
    p3_client: TestClient,
    p3_db_session: Session,
    test_settings: Settings,
) -> None:
    from app.core.storage import LocalStorageAdapter
    from app.models.patient import Patient
    from app.repositories.file_repo import FileRepository

    user = _seed_user(p3_db_session, username="doc_redact")
    tok = _login(p3_client, "doc_redact")

    pat_id = p3_client.post(
        "/api/v1/patients",
        headers=_auth_header(tok),
        json={
            "patient_code": "REDACT-01",
            "full_name": "Secret Name",
            "birth_year": 1970,
            "sex": "female",
        },
    ).json()["id"]
    today_str = datetime.now(ZoneInfo("Asia/Ho_Chi_Minh")).date().isoformat()
    case_id = p3_client.post(
        f"/api/v1/patients/{pat_id}/cases",
        headers={**_auth_header(tok), "Idempotency-Key": str(uuid.uuid4())},
        json={"study_date": today_str, "notes": "Secret clinical notes"},
    ).json()["id"]

    r_vol = p3_client.post(
        f"/api/v1/cases/{case_id}/volumes",
        headers=_auth_header(tok),
        data={"modality": "flair"},
        files={
            "file": ("secret_scan.nii.gz", _make_nifti_gz_bytes((16, 16, 16)), "application/gzip")
        },
    )
    assert r_vol.status_code == 201
    file_id = uuid.UUID(r_vol.json()["file_id"])

    # Simulate a still-deleting StoredFile on the case (e.g. from a prior delete_volume failure)
    sf = p3_db_session.get(StoredFile, file_id)
    assert sf is not None
    sf.state = "deleting"
    p3_db_session.commit()

    # Quota must still count 'deleting' files
    owner_used, sys_used = FileRepository(p3_db_session).get_committed_usage_bytes(user.id)
    assert owner_used == sf.size_bytes
    assert sys_used == sf.size_bytes

    # Mock storage.delete to fail once during delete_case -> status='deleting', deleted_at=None
    from unittest.mock import patch

    with patch.object(LocalStorageAdapter, "delete", side_effect=OSError("disk busy")):
        r_del_case = p3_client.delete(f"/api/v1/cases/{case_id}", headers=_auth_header(tok))
    assert r_del_case.status_code == 202
    assert r_del_case.json()["status"] == "deleting"

    p3_db_session.expire_all()
    db_case = p3_db_session.get(Case, uuid.UUID(case_id))
    assert db_case is not None
    assert db_case.deleting_at is not None
    assert db_case.deleted_at is None
    assert db_case.notes is None  # PII redacted immediately!

    # Now run_orphan_cleanup succeeds -> unlinks file and finalizes Case.deleted_at
    storage = LocalStorageAdapter(test_settings.effective_storage_root)
    summary = run_orphan_cleanup(p3_db_session, storage)
    p3_db_session.commit()
    assert summary["deleting_files_finalized"] == 1
    assert summary["deleting_cases_finalized"] == 1

    p3_db_session.expire_all()
    db_case = p3_db_session.get(Case, uuid.UUID(case_id))
    assert db_case is not None and db_case.deleted_at is not None

    # Delete patient -> PII redacted immediately
    r_del_pat = p3_client.delete(f"/api/v1/patients/{pat_id}", headers=_auth_header(tok))
    assert r_del_pat.status_code == 202
    assert r_del_pat.json()["status"] == "deleted"
    p3_db_session.expire_all()
    db_pat = p3_db_session.get(Patient, uuid.UUID(pat_id))
    assert db_pat is not None
    assert db_pat.full_name == "[deleted]"
    assert db_pat.patient_code == f"deleted-{pat_id}"


def test_create_case_vs_delete_patient_concurrent_race(
    p3_client: TestClient,
    p3_db_session: Session,
    test_settings: Settings,
) -> None:
    _seed_user(p3_db_session, username="doc_pat_race")
    tok = _login(p3_client, "doc_pat_race")
    pat_id = p3_client.post(
        "/api/v1/patients",
        headers=_auth_header(tok),
        json={
            "patient_code": "PRACE-01",
            "full_name": "Patient Race",
            "birth_year": 1990,
            "sex": "male",
        },
    ).json()["id"]
    today_str = datetime.now(ZoneInfo("Asia/Ho_Chi_Minh")).date().isoformat()
    barrier = Barrier(2)
    app_instance = create_app(settings=test_settings)

    def _create_case() -> int:
        with TestClient(app_instance, raise_server_exceptions=False) as local_client:
            barrier.wait(timeout=5)
            return local_client.post(
                f"/api/v1/patients/{pat_id}/cases",
                headers={**_auth_header(tok), "Idempotency-Key": str(uuid.uuid4())},
                json={"study_date": today_str, "notes": "Concurrent"},
            ).status_code

    def _delete_patient() -> int:
        with TestClient(app_instance, raise_server_exceptions=False) as local_client:
            barrier.wait(timeout=5)
            return local_client.delete(
                f"/api/v1/patients/{pat_id}",
                headers=_auth_header(tok),
            ).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        f_create = pool.submit(_create_case)
        f_del = pool.submit(_delete_patient)
        c_status = f_create.result()
        d_status = f_del.result()

    assert d_status == 202
    assert c_status in {201, 404}
    # Patient is deleted and no orphaned active case remains
    assert p3_client.get(f"/api/v1/patients/{pat_id}", headers=_auth_header(tok)).status_code == 404
    active_cases = (
        p3_db_session.query(Case)
        .filter(Case.patient_id == uuid.UUID(pat_id), Case.deleted_at.is_(None))
        .all()
    )
    assert active_cases == []


def test_db_engine_hides_parameters_and_errors_never_log_sql_detail(
    test_settings: Settings,
    caplog: pytest.LogCaptureFixture,
) -> None:
    from app.core.db import create_db_engine

    engine = create_db_engine(test_settings)
    assert engine is not None
    try:
        assert engine.hide_parameters is True
    finally:
        engine.dispose()

    # Trigger a real SQLAlchemyError with sensitive text in detail and ensure handler scrubs it
    app_instance = create_app(settings=test_settings)

    @app_instance.get("/api/v1/_test_sqla_error")
    def _raise_sqla() -> None:
        from sqlalchemy.exc import IntegrityError

        raise IntegrityError(
            "INSERT INTO patients ...",
            params={"full_name": "SensitivePatientName"},
            orig=Exception("DETAIL: Key (full_name)=(SensitivePatientName) already exists"),
        )

    with TestClient(app_instance, raise_server_exceptions=False) as client:
        resp = client.get("/api/v1/_test_sqla_error")
    assert resp.status_code == 500
    assert "SensitivePatientName" not in resp.text
    assert "SensitivePatientName" not in caplog.text


def test_case_endpoints_expose_synced_owner_patient_code(
    p3_client: TestClient,
    p3_db_session: Session,
) -> None:
    _seed_user(p3_db_session, username="doc_case_sync")
    tok = _login(p3_client, "doc_case_sync")

    r_pat = p3_client.post(
        "/api/v1/patients",
        headers=_auth_header(tok),
        json={
            "patient_code": "BN-SYNC-01",
            "full_name": "Nguyen Van Sync",
            "birth_year": 1986,
            "sex": "male",
        },
    )
    assert r_pat.status_code == 201, r_pat.text
    pat_id = r_pat.json()["id"]

    today_str = datetime.now(ZoneInfo("Asia/Ho_Chi_Minh")).date().isoformat()
    idem_key = str(uuid.uuid4())
    r_create = p3_client.post(
        f"/api/v1/patients/{pat_id}/cases",
        headers={**_auth_header(tok), "Idempotency-Key": idem_key},
        json={"study_date": today_str, "notes": "Initial sync note"},
    )
    assert r_create.status_code == 201, r_create.text
    case_id = r_create.json()["id"]
    assert r_create.json()["patient_code"] == "BN-SYNC-01"

    # Idempotent replay also preserves synced patient_code
    r_replay = p3_client.post(
        f"/api/v1/patients/{pat_id}/cases",
        headers={**_auth_header(tok), "Idempotency-Key": idem_key},
        json={"study_date": today_str, "notes": "Initial sync note"},
    )
    assert r_replay.status_code == 201, r_replay.text
    assert r_replay.json()["patient_code"] == "BN-SYNC-01"

    r_pat_cases = p3_client.get(
        f"/api/v1/patients/{pat_id}/cases", headers=_auth_header(tok)
    )
    assert r_pat_cases.status_code == 200, r_pat_cases.text
    assert r_pat_cases.json()["items"][0]["patient_code"] == "BN-SYNC-01"

    r_doc_cases = p3_client.get("/api/v1/cases", headers=_auth_header(tok))
    assert r_doc_cases.status_code == 200, r_doc_cases.text
    assert r_doc_cases.json()["items"][0]["patient_code"] == "BN-SYNC-01"

    r_get_case = p3_client.get(f"/api/v1/cases/{case_id}", headers=_auth_header(tok))
    assert r_get_case.status_code == 200, r_get_case.text
    assert r_get_case.json()["patient_code"] == "BN-SYNC-01"

    r_patch_case = p3_client.patch(
        f"/api/v1/cases/{case_id}",
        headers=_auth_header(tok),
        json={"notes": "Updated sync note"},
    )
    assert r_patch_case.status_code == 200, r_patch_case.text
    assert r_patch_case.json()["patient_code"] == "BN-SYNC-01"

    # Update patient_code on Patient and verify Case endpoints immediately reflect it
    r_patch_pat = p3_client.patch(
        f"/api/v1/patients/{pat_id}",
        headers=_auth_header(tok),
        json={"patient_code": "BN-SYNC-02"},
    )
    assert r_patch_pat.status_code == 200, r_patch_pat.text
    assert r_patch_pat.json()["patient_code"] == "BN-SYNC-02"

    r_doc_cases_after = p3_client.get("/api/v1/cases", headers=_auth_header(tok))
    assert r_doc_cases_after.status_code == 200, r_doc_cases_after.text
    assert r_doc_cases_after.json()["items"][0]["patient_code"] == "BN-SYNC-02"

    r_get_case_after = p3_client.get(
        f"/api/v1/cases/{case_id}", headers=_auth_header(tok)
    )
    assert r_get_case_after.status_code == 200, r_get_case_after.text
    assert r_get_case_after.json()["patient_code"] == "BN-SYNC-02"

