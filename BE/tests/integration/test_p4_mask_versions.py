"""Integration tests for Phase P4: Immutable Mask Versions, Conflict Control, Geometry, & Export."""

from __future__ import annotations

import gzip
import hashlib
import io
import json
import uuid
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
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
from app.core.storage import LocalStorageAdapter
from app.main import create_app
from app.models.audit_event import AuditEvent
from app.models.case import Case
from app.models.mask_version import MaskVersion
from app.models.stored_file import StoredFile
from app.models.user import User
from app.services import mask_version_service


def _make_nifti_gz_bytes(
    data: np.ndarray,
    *,
    affine: np.ndarray | None = None,
) -> bytes:
    aff = affine if affine is not None else np.eye(4, dtype=np.float64)
    img = nib.Nifti1Image(data, aff)
    img.header.set_xyzt_units("mm", "sec")
    img.set_qform(aff, code=1)
    img.set_sform(aff, code=1)
    bio = io.BytesIO()
    fmap = img.make_file_map({"image": bio, "header": bio})
    img.to_file_map(fmap)
    return gzip.compress(bio.getvalue())


@pytest.fixture()
def clean_p4_db(migrated_postgres: str) -> Iterator[None]:
    engine = create_engine(migrated_postgres)
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "TRUNCATE TABLE mask_save_idempotency_keys, mask_versions, "
                    "volumes, stored_files, case_create_idempotency_keys, "
                    "cases, patients, system_settings, audit_events, login_attempts, "
                    "refresh_tokens, sessions, users RESTART IDENTITY CASCADE"
                )
            )
        yield
    finally:
        engine.dispose()


@pytest.fixture()
def p4_db_session(clean_p4_db: None, migrated_postgres: str) -> Iterator[Session]:
    engine = create_engine(migrated_postgres)
    SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    try:
        with SessionLocal() as session:
            yield session
    finally:
        engine.dispose()


@pytest.fixture()
def p4_client(clean_p4_db: None, test_settings: Settings) -> Iterator[TestClient]:
    application = create_app(settings=test_settings)
    with TestClient(application, raise_server_exceptions=False) as client:
        yield client


def _seed_user(
    db: Session,
    *,
    username: str,
    password: str = "ValidPass123!",
    role: str = "doctor",
    display_name: str = "Dr. P4 Test",
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
    resp = client.post("/api/v1/auth/login", json={"username": username, "password": password})
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _create_patient_and_case(client: TestClient, token: str, code: str = "PAT-P4-01") -> str:
    r_pat = client.post(
        "/api/v1/patients",
        headers=_auth_header(token),
        json={
            "patient_code": code,
            "full_name": "Nguyen Van P4",
            "birth_year": 1980,
            "sex": "male",
        },
    )
    assert r_pat.status_code == 201, r_pat.text
    pat_id = r_pat.json()["id"]
    today_str = datetime.now(ZoneInfo("Asia/Ho_Chi_Minh")).date().isoformat()
    r_case = client.post(
        f"/api/v1/patients/{pat_id}/cases",
        headers={**_auth_header(token), "Idempotency-Key": str(uuid.uuid4())},
        json={"study_date": today_str, "notes": "P4 study"},
    )
    assert r_case.status_code == 201, r_case.text
    return r_case.json()["id"]


def _upload_volume(
    client: TestClient,
    token: str,
    case_id: str,
    modality: str,
    shape: tuple[int, int, int] = (8, 8, 8),
    affine: np.ndarray | None = None,
) -> dict[str, Any]:
    vol_bytes = _make_nifti_gz_bytes(np.zeros(shape, dtype=np.float32), affine=affine)
    resp = client.post(
        f"/api/v1/cases/{case_id}/volumes",
        headers=_auth_header(token),
        data={"modality": modality},
        files={"file": (f"{modality}.nii.gz", vol_bytes, "application/gzip")},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


def test_qa_mask_01_single_t1ce_locks_reference_and_asymmetric_roundtrip(
    p4_client: TestClient,
    p4_db_session: Session,
) -> None:
    _seed_user(p4_db_session, username="doc_p4_1", display_name="Dr. Roundtrip")
    tok = _login(p4_client, "doc_p4_1")
    case_id = _create_patient_and_case(p4_client, tok)

    # Upload ONLY t1ce
    affine = np.diag([1.5, 2.0, 2.5, 1.0])
    affine[:3, 3] = [10.0, -5.0, 2.0]
    t1ce_vol = _upload_volume(p4_client, tok, case_id, "t1ce", shape=(8, 8, 8), affine=affine)
    t1ce_id = t1ce_vol["id"]

    # Asymmetric landmark mask (float32 integral values to test uint8 canonicalization)
    mask_arr = np.zeros((8, 8, 8), dtype=np.float32)
    mask_arr[1, 2, 3] = 1.0
    mask_arr[6, 5, 4] = 2.0
    mask_arr[7, 0, 7] = 4.0
    mask_bytes = _make_nifti_gz_bytes(mask_arr, affine=affine)

    idem_1 = str(uuid.uuid4())
    r_save = p4_client.post(
        f"/api/v1/cases/{case_id}/mask-versions",
        headers={**_auth_header(tok), "Idempotency-Key": idem_1},
        data={
            "base_version_id": "",
            "reference_volume_id": t1ce_id,
            "note": "Initial manual edit on T1ce only",
        },
        files={"mask": ("mask.nii.gz", mask_bytes, "application/gzip")},
    )
    assert r_save.status_code == 201, r_save.text
    v1 = r_save.json()
    assert v1["version_number"] == 1
    assert v1["source"] == "manual"
    assert v1["base_version_id"] is None
    assert v1["reference_volume_id"] == t1ce_id
    assert v1["created_by_name"] == "Dr. Roundtrip"
    assert v1["label_voxel_counts"] == {"1": 1, "2": 1, "4": 1}
    assert v1["label_volumes_mm3"]["1"] == pytest.approx(7.5)
    assert v1["composite_volumes_mm3"]["WT"] == pytest.approx(22.5)
    assert v1["composite_volumes_mm3"]["TC"] == pytest.approx(15.0)
    assert v1["composite_volumes_mm3"]["ET"] == pytest.approx(7.5)

    # Case reference_volume_id is locked to t1ce, and deleting t1ce returns 409 inputs_locked
    r_del_vol = p4_client.delete(
        f"/api/v1/cases/{case_id}/volumes/{t1ce_id}",
        headers=_auth_header(tok),
    )
    assert r_del_vol.status_code == 409
    assert r_del_vol.json()["error"]["code"] == "inputs_locked"

    # Adding flair later cannot change case.reference_volume_id or upload if inputs_locked
    flair_bytes = _make_nifti_gz_bytes(np.zeros((8, 8, 8), dtype=np.float32), affine=affine)
    r_add_flair = p4_client.post(
        f"/api/v1/cases/{case_id}/volumes",
        headers=_auth_header(tok),
        data={"modality": "flair"},
        files={"file": ("flair.nii.gz", flair_bytes, "application/gzip")},
    )
    assert r_add_flair.status_code == 409
    assert r_add_flair.json()["error"]["code"] == "inputs_locked"

    # Export NIfTI and verify exact voxel equality, uint8 dtype, affine/qform/sform, and headers
    r_exp = p4_client.get(
        f"/api/v1/mask-versions/{v1['id']}/export",
        headers=_auth_header(tok),
    )
    assert r_exp.status_code == 200
    assert r_exp.headers["cache-control"] == "no-store"
    assert r_exp.headers["x-content-type-options"] == "nosniff"
    assert (
        r_exp.headers["content-disposition"]
        == f'attachment; filename="mask-case-{case_id}-v1.nii.gz"'
    )

    decompressed = gzip.decompress(r_exp.content)
    fh = nib.FileHolder(fileobj=io.BytesIO(decompressed))
    reloaded = nib.Nifti1Image.from_file_map({"header": fh, "image": fh})
    assert reloaded.get_data_dtype() == np.uint8
    reloaded_arr = np.asarray(reloaded.dataobj)
    assert np.array_equal(reloaded_arr, mask_arr.astype(np.uint8))
    assert np.allclose(reloaded.affine, affine, rtol=0.0, atol=1e-4)
    assert np.allclose(reloaded.header.get_qform(), affine, rtol=0.0, atol=1e-4)
    assert np.allclose(reloaded.header.get_sform(), affine, rtol=0.0, atol=1e-4)

    # Metadata export has no PII or server paths
    r_meta = p4_client.get(
        f"/api/v1/mask-versions/{v1['id']}/metadata",
        headers=_auth_header(tok),
    )
    assert r_meta.status_code == 200, r_meta.text
    meta = r_meta.json()
    assert meta["version_id"] == v1["id"]
    assert meta["geometry"]["units"] == "mm"
    assert meta["statistics"]["total_foreground_voxels"] == 3
    assert meta["statistics"]["total_foreground_volume_mm3"] == pytest.approx(22.5)
    assert meta["statistics"]["total_foreground_volume_ml"] == pytest.approx(0.0225)
    assert meta["coverage"]["status"] == "manual_only_no_ai_coverage"
    meta_str = str(meta)
    assert "Nguyen Van P4" not in meta_str
    assert "PAT-P4-01" not in meta_str

    # Also verify audit log has no PII (patient name/code or note text)
    audit = p4_db_session.query(AuditEvent).filter_by(action="mask_version.save_manual").first()
    assert audit is not None
    assert "Initial manual edit" not in str(audit.safe_diff)
    assert audit.safe_diff["has_note"] is True


def test_qa_mask_02_rejects_invalid_labels_geometry_and_headers(
    p4_client: TestClient,
    p4_db_session: Session,
) -> None:
    _seed_user(p4_db_session, username="doc_p4_2")
    tok = _login(p4_client, "doc_p4_2")
    case_id = _create_patient_and_case(p4_client, tok, code="PAT-P4-02")
    affine = np.eye(4, dtype=np.float64)
    vol = _upload_volume(p4_client, tok, case_id, "flair", shape=(6, 6, 6), affine=affine)
    vol_id = vol["id"]

    # Missing Idempotency-Key -> 422
    mask_ok = _make_nifti_gz_bytes(np.zeros((6, 6, 6), dtype=np.uint8), affine=affine)
    r_no_idem = p4_client.post(
        f"/api/v1/cases/{case_id}/mask-versions",
        headers=_auth_header(tok),
        data={"reference_volume_id": vol_id},
        files={"mask": ("m.nii.gz", mask_ok, "application/gzip")},
    )
    assert r_no_idem.status_code == 422

    # Note > 2000 chars -> 422
    r_long_note = p4_client.post(
        f"/api/v1/cases/{case_id}/mask-versions",
        headers={**_auth_header(tok), "Idempotency-Key": str(uuid.uuid4())},
        data={"reference_volume_id": vol_id, "note": "x" * 2001},
        files={"mask": ("m.nii.gz", mask_ok, "application/gzip")},
    )
    assert r_long_note.status_code == 422

    # Invalid label 3 -> 422 invalid_mask_labels
    d3 = np.zeros((6, 6, 6), dtype=np.uint8)
    d3[1, 1, 1] = 3
    r_l3 = p4_client.post(
        f"/api/v1/cases/{case_id}/mask-versions",
        headers={**_auth_header(tok), "Idempotency-Key": str(uuid.uuid4())},
        data={"reference_volume_id": vol_id},
        files={"mask": ("m.nii.gz", _make_nifti_gz_bytes(d3, affine=affine), "application/gzip")},
    )
    assert r_l3.status_code == 422
    assert r_l3.json()["error"]["code"] == "invalid_mask_labels"

    # Flipped X affine -> 422 geometry_mismatch
    flipped = np.diag([-1.0, 1.0, 1.0, 1.0])
    r_flip = p4_client.post(
        f"/api/v1/cases/{case_id}/mask-versions",
        headers={**_auth_header(tok), "Idempotency-Key": str(uuid.uuid4())},
        data={"reference_volume_id": vol_id},
        files={
            "mask": (
                "m.nii.gz",
                _make_nifti_gz_bytes(np.zeros((6, 6, 6), dtype=np.uint8), affine=flipped),
                "application/gzip",
            )
        },
    )
    assert r_flip.status_code == 422
    assert r_flip.json()["error"]["code"] == "geometry_mismatch"


def test_qa_mask_03_concurrent_save_conflict_and_idempotency_replay_after_head_moves(
    p4_client: TestClient,
    p4_db_session: Session,
    test_settings: Settings,
) -> None:
    _seed_user(p4_db_session, username="doc_p4_conc")
    tok = _login(p4_client, "doc_p4_conc")
    case_id = _create_patient_and_case(p4_client, tok, code="PAT-P4-CONC")
    affine = np.eye(4, dtype=np.float64)
    vol = _upload_volume(p4_client, tok, case_id, "flair", shape=(6, 6, 6), affine=affine)
    vol_id = vol["id"]

    # Seed v1
    m1 = np.zeros((6, 6, 6), dtype=np.uint8)
    m1[0, 0, 0] = 1
    m1_bytes = _make_nifti_gz_bytes(m1, affine=affine)
    idem_v1 = str(uuid.uuid4())
    r1 = p4_client.post(
        f"/api/v1/cases/{case_id}/mask-versions",
        headers={**_auth_header(tok), "Idempotency-Key": idem_v1},
        data={"reference_volume_id": vol_id, "note": "v1"},
        files={"mask": ("v1.nii.gz", m1_bytes, "application/gzip")},
    )
    assert r1.status_code == 201
    v1_id = r1.json()["id"]
    v1_sha = r1.json()["sha256"]

    # Two concurrent saves from base_version_id=v1_id with different Idempotency-Keys
    m2a = np.zeros((6, 6, 6), dtype=np.uint8)
    m2a[1, 1, 1] = 2
    m2a_bytes = _make_nifti_gz_bytes(m2a, affine=affine)

    m2b = np.zeros((6, 6, 6), dtype=np.uint8)
    m2b[2, 2, 2] = 4
    m2b_bytes = _make_nifti_gz_bytes(m2b, affine=affine)

    barrier = Barrier(2)
    app_instance = create_app(settings=test_settings)
    idem_a = str(uuid.uuid4())
    idem_b = str(uuid.uuid4())

    def _post_save(payload: tuple[str, bytes]) -> tuple[int, dict[str, Any]]:
        idem, data_bytes = payload
        with TestClient(app_instance, raise_server_exceptions=False) as local_client:
            barrier.wait(timeout=5)
            resp = local_client.post(
                f"/api/v1/cases/{case_id}/mask-versions",
                headers={**_auth_header(tok), "Idempotency-Key": idem},
                data={"base_version_id": v1_id, "reference_volume_id": vol_id},
                files={"mask": ("v2.nii.gz", data_bytes, "application/gzip")},
            )
            return resp.status_code, resp.json()

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(_post_save, [(idem_a, m2a_bytes), (idem_b, m2b_bytes)]))

    statuses = sorted(r[0] for r in results)
    assert statuses == [201, 409]
    winner = next(r[1] for r in results if r[0] == 201)
    loser = next(r[1] for r in results if r[0] == 409)
    assert winner["version_number"] == 2
    assert loser["error"]["code"] == "mask_version_conflict"
    assert loser["error"]["details"]["latest_mask_version_id"] == winner["id"]

    # v1 hash unchanged
    r1_check = p4_client.get(f"/api/v1/mask-versions/{v1_id}", headers=_auth_header(tok))
    assert r1_check.status_code == 200
    assert r1_check.json()["sha256"] == v1_sha

    # Replay idem_v1 EVEN AFTER head moved to v2 -> returns 201 with v1_id!
    r_replay = p4_client.post(
        f"/api/v1/cases/{case_id}/mask-versions",
        headers={**_auth_header(tok), "Idempotency-Key": idem_v1},
        data={"reference_volume_id": vol_id, "note": "v1"},
        files={"mask": ("v1.nii.gz", m1_bytes, "application/gzip")},
    )
    assert r_replay.status_code == 201
    assert r_replay.json()["id"] == v1_id

    # Same idem_v1 with different digest -> 409 idempotency_conflict
    r_diff = p4_client.post(
        f"/api/v1/cases/{case_id}/mask-versions",
        headers={**_auth_header(tok), "Idempotency-Key": idem_v1},
        data={"reference_volume_id": vol_id, "note": "modified note"},
        files={"mask": ("v1.nii.gz", m1_bytes, "application/gzip")},
    )
    assert r_diff.status_code == 409
    assert r_diff.json()["error"]["code"] == "idempotency_conflict"

    # List mask versions sorted newest first
    r_list = p4_client.get(f"/api/v1/cases/{case_id}/mask-versions", headers=_auth_header(tok))
    assert r_list.status_code == 200
    items = r_list.json()["items"]
    assert [it["version_number"] for it in items] == [2, 1]


def test_qa_mask_04_owner_scoping_admin_403_and_case_deletion_cleanup(
    p4_client: TestClient,
    p4_db_session: Session,
) -> None:
    _seed_user(p4_db_session, username="doc_a")
    _seed_user(p4_db_session, username="doc_b")
    _seed_user(p4_db_session, username="admin_p4", role="admin")

    tok_a = _login(p4_client, "doc_a")
    tok_b = _login(p4_client, "doc_b")
    tok_admin = _login(p4_client, "admin_p4")

    case_id = _create_patient_and_case(p4_client, tok_a, code="PAT-P4-ACL")
    vol = _upload_volume(p4_client, tok_a, case_id, "flair", shape=(4, 4, 4))
    vol_id = vol["id"]
    m_bytes = _make_nifti_gz_bytes(np.zeros((4, 4, 4), dtype=np.uint8))

    r_save = p4_client.post(
        f"/api/v1/cases/{case_id}/mask-versions",
        headers={**_auth_header(tok_a), "Idempotency-Key": str(uuid.uuid4())},
        data={"reference_volume_id": vol_id, "note": "Sensitive note"},
        files={"mask": ("m.nii.gz", m_bytes, "application/gzip")},
    )
    assert r_save.status_code == 201
    mv_id = r_save.json()["id"]
    mv_file_id = r_save.json()["file_id"]

    # Doctor B gets 404 on all endpoints
    for method, url in (
        ("GET", f"/api/v1/cases/{case_id}/mask-versions"),
        ("GET", f"/api/v1/mask-versions/{mv_id}"),
        ("GET", f"/api/v1/mask-versions/{mv_id}/export"),
        ("GET", f"/api/v1/mask-versions/{mv_id}/metadata"),
        ("GET", f"/api/v1/files/{mv_file_id}/content"),
    ):
        resp = p4_client.request(method, url, headers=_auth_header(tok_b))
        assert resp.status_code == 404, (url, resp.status_code)

    # Admin gets 403 on all doctor mask endpoints
    for method, url in (
        ("GET", f"/api/v1/cases/{case_id}/mask-versions"),
        ("GET", f"/api/v1/mask-versions/{mv_id}"),
        ("GET", f"/api/v1/mask-versions/{mv_id}/export"),
        ("GET", f"/api/v1/mask-versions/{mv_id}/metadata"),
    ):
        resp = p4_client.request(method, url, headers=_auth_header(tok_admin))
        assert resp.status_code == 403, (url, resp.status_code)

    # Owner can download mask via /files/{file_id}/content
    r_file = p4_client.get(f"/api/v1/files/{mv_file_id}/content", headers=_auth_header(tok_a))
    assert r_file.status_code == 200

    # Delete case -> cleans up mask file, scrubs note, clears latest_mask_version_id
    r_del = p4_client.delete(f"/api/v1/cases/{case_id}", headers=_auth_header(tok_a))
    assert r_del.status_code == 202
    assert r_del.json()["status"] == "deleted"

    p4_db_session.expire_all()
    mv_row = p4_db_session.get(MaskVersion, uuid.UUID(mv_id))
    assert mv_row is not None
    assert mv_row.note is None
    sf_row = p4_db_session.get(StoredFile, uuid.UUID(mv_file_id))
    assert sf_row is not None
    assert sf_row.state == "deleted"
    case_row = p4_db_session.get(Case, uuid.UUID(case_id))
    assert case_row is not None
    assert case_row.latest_mask_version_id is None
    assert case_row.deleted_at is not None


def test_p4_multipart_ingress_limit_on_mask_versions(
    p4_db_session: Session,
    test_settings: Settings,
) -> None:
    tiny_settings = test_settings.model_copy(
        update={"MAX_UPLOAD_BYTES": 1024, "MAX_MULTIPART_OVERHEAD_BYTES": 256}
    )
    app_instance = create_app(settings=tiny_settings)
    with TestClient(app_instance, raise_server_exceptions=False) as client:
        _seed_user(p4_db_session, username="doc_p4_limit")
        tok = _login(client, "doc_p4_limit")
        case_id = _create_patient_and_case(client, tok, code="PAT-P4-LIM")
        big_payload = b"x" * 2048
        resp = client.post(
            f"/api/v1/cases/{case_id}/mask-versions",
            headers={**_auth_header(tok), "Idempotency-Key": str(uuid.uuid4())},
            data={"reference_volume_id": str(uuid.uuid4())},
            files={"mask": ("big.nii.gz", big_payload, "application/gzip")},
        )
        assert resp.status_code == 413
        assert resp.json()["error"]["code"] == "payload_too_large"


def test_p4_ambiguous_commit_preserves_mask_object_and_allows_retry_export(
    p4_client: TestClient,
    p4_db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_user(p4_db_session, username="doc_p4_ambiguous_commit")
    token = _login(p4_client, "doc_p4_ambiguous_commit")
    case_id = _create_patient_and_case(p4_client, token, code="PAT-P4-AMBIGUOUS")
    volume = _upload_volume(p4_client, token, case_id, "flair", shape=(4, 4, 4))

    mask_data = np.zeros((4, 4, 4), dtype=np.uint8)
    mask_data[1, 2, 3] = 4
    mask_bytes = _make_nifti_gz_bytes(mask_data)
    idempotency_key = str(uuid.uuid4())
    original_commit = Session.commit
    commit_raised_after_success = False

    def _commit_then_raise(session: Session) -> None:
        nonlocal commit_raised_after_success
        should_raise = not commit_raised_after_success and any(
            isinstance(instance, MaskVersion)
            for instance in session.identity_map.values()
        )
        original_commit(session)
        if should_raise:
            commit_raised_after_success = True
            raise RuntimeError("simulated lost commit acknowledgement")

    monkeypatch.setattr(Session, "commit", _commit_then_raise)

    save_url = f"/api/v1/cases/{case_id}/mask-versions"
    save_headers = {**_auth_header(token), "Idempotency-Key": idempotency_key}
    save_data = {"reference_volume_id": volume["id"]}
    first_response = p4_client.post(
        save_url,
        headers=save_headers,
        data=save_data,
        files={"mask": ("mask.nii.gz", mask_bytes, "application/gzip")},
    )
    assert first_response.status_code == 500, first_response.text
    assert commit_raised_after_success is True

    retry_response = p4_client.post(
        save_url,
        headers=save_headers,
        data=save_data,
        files={"mask": ("mask.nii.gz", mask_bytes, "application/gzip")},
    )
    assert retry_response.status_code == 201, retry_response.text
    version_id = retry_response.json()["id"]

    export_response = p4_client.get(
        f"/api/v1/mask-versions/{version_id}/export",
        headers=_auth_header(token),
    )
    assert export_response.status_code == 200, export_response.text
    decompressed = gzip.decompress(export_response.content)
    file_holder = nib.FileHolder(fileobj=io.BytesIO(decompressed))
    exported_mask = nib.Nifti1Image.from_file_map(
        {"header": file_holder, "image": file_holder}
    )
    assert np.array_equal(np.asarray(exported_mask.dataobj), mask_data)


def test_p4_idempotency_replay_after_concurrent_case_soft_delete_returns_404(
    p4_client: TestClient,
    p4_db_session: Session,
    migrated_postgres: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _seed_user(p4_db_session, username="doc_p4_deleted_replay")
    token = _login(p4_client, "doc_p4_deleted_replay")
    case_id = _create_patient_and_case(p4_client, token, code="PAT-P4-DELETED-REPLAY")
    volume = _upload_volume(p4_client, token, case_id, "flair", shape=(4, 4, 4))

    mask_data = np.zeros((4, 4, 4), dtype=np.uint8)
    mask_data[0, 1, 2] = 1
    mask_bytes = _make_nifti_gz_bytes(mask_data)
    idempotency_key = str(uuid.uuid4())
    save_url = f"/api/v1/cases/{case_id}/mask-versions"
    save_headers = {**_auth_header(token), "Idempotency-Key": idempotency_key}
    save_data = {"reference_volume_id": volume["id"]}

    initial_response = p4_client.post(
        save_url,
        headers=save_headers,
        data=save_data,
        files={"mask": ("mask.nii.gz", mask_bytes, "application/gzip")},
    )
    assert initial_response.status_code == 201, initial_response.text

    original_stream_upload = mask_version_service._stream_upload_to_staging
    case_deleted_during_upload = False

    async def _stream_then_soft_delete_case(**kwargs: Any) -> Any:
        nonlocal case_deleted_during_upload
        staged_upload = await original_stream_upload(**kwargs)
        engine = create_engine(migrated_postgres)
        try:
            with engine.begin() as connection:
                result = connection.execute(
                    text(
                        "UPDATE cases SET deleted_at = CURRENT_TIMESTAMP "
                        "WHERE id = :case_id AND deleted_at IS NULL"
                    ),
                    {"case_id": uuid.UUID(case_id)},
                )
                assert result.rowcount == 1
        finally:
            engine.dispose()
        case_deleted_during_upload = True
        return staged_upload

    monkeypatch.setattr(
        mask_version_service,
        "_stream_upload_to_staging",
        _stream_then_soft_delete_case,
    )

    replay_response = p4_client.post(
        save_url,
        headers=save_headers,
        data=save_data,
        files={"mask": ("mask.nii.gz", mask_bytes, "application/gzip")},
    )
    assert case_deleted_during_upload is True
    assert replay_response.status_code == 404, replay_response.text
    assert replay_response.json()["error"]["code"] == "case_not_found"


def _seed_ai_mask_version(
    db: Session,
    *,
    settings: Settings,
    doctor_id: uuid.UUID,
    case_id: uuid.UUID,
    reference_volume_id: uuid.UUID,
    version_number: int = 1,
) -> tuple[MaskVersion, StoredFile, StoredFile]:
    storage = LocalStorageAdapter(settings.effective_storage_root)
    mask_bytes = _make_nifti_gz_bytes(np.zeros((4, 4, 4), dtype=np.uint8))
    mask_sha = hashlib.sha256(mask_bytes).hexdigest()
    mask_staged = storage.put_temp(io.BytesIO(mask_bytes))
    mask_committed = storage.commit(mask_staged.staging_key)

    cov_bytes = json.dumps({"original_shape": [4, 4, 4], "pipeline_version": "p0"}).encode("utf-8")
    cov_sha = hashlib.sha256(cov_bytes).hexdigest()
    cov_staged = storage.put_temp(io.BytesIO(cov_bytes))
    cov_committed = storage.commit(cov_staged.staging_key)

    mask_sf = StoredFile(
        storage_key=uuid.UUID(mask_committed.storage_key),
        original_name=f"mask-case-{case_id}-v{version_number}.nii.gz",
        size_bytes=len(mask_bytes),
        sha256=mask_sha,
        media_type="application/gzip",
        state="committed",
        owner_id=doctor_id,
    )
    cov_sf = StoredFile(
        storage_key=uuid.UUID(cov_committed.storage_key),
        original_name=f"coverage-case-{case_id}-v{version_number}.json",
        size_bytes=len(cov_bytes),
        sha256=cov_sha,
        media_type="application/json",
        state="committed",
        owner_id=doctor_id,
    )
    db.add_all([mask_sf, cov_sf])
    db.flush()

    mv = MaskVersion(
        case_id=case_id,
        version_number=version_number,
        source="ai",
        base_version_id=None,
        reference_volume_id=reference_volume_id,
        file_id=mask_sf.id,
        created_by=None,
        job_id=None,
        model_version_id="tda-seg-unet:test",
        coverage_file_id=cov_sf.id,
        note="AI baseline",
        label_voxel_counts={"1": 0, "2": 0, "4": 0},
        label_volumes_mm3={"1": 0.0, "2": 0.0, "4": 0.0},
        composite_volumes_mm3={"WT": 0.0, "TC": 0.0, "ET": 0.0},
        sha256=mask_sha,
    )
    db.add(mv)
    db.flush()

    case_row = db.get(Case, case_id)
    assert case_row is not None
    case_row.latest_mask_version_id = mv.id
    case_row.inputs_locked_at = datetime.now(ZoneInfo("UTC"))
    db.commit()
    db.refresh(mv)
    db.refresh(mask_sf)
    db.refresh(cov_sf)
    return mv, mask_sf, cov_sf


def test_delete_manual_mask_version_reclaims_storage_and_rolls_back_head(
    p4_client: TestClient,
    p4_db_session: Session,
    test_settings: Settings,
) -> None:
    doctor = _seed_user(p4_db_session, username="doc_p4_del_ok", display_name="Dr. Delete")
    token = _login(p4_client, "doc_p4_del_ok")
    case_id = _create_patient_and_case(p4_client, token, code="PAT-P4-DEL-01")
    volume = _upload_volume(p4_client, token, case_id, "t1ce", shape=(4, 4, 4))

    ai_v1, _, ai_cov_sf = _seed_ai_mask_version(
        p4_db_session,
        settings=test_settings,
        doctor_id=doctor.id,
        case_id=uuid.UUID(case_id),
        reference_volume_id=uuid.UUID(volume["id"]),
        version_number=1,
    )

    mask_data = np.zeros((4, 4, 4), dtype=np.uint8)
    mask_data[1, 1, 1] = 1
    mask_bytes = _make_nifti_gz_bytes(mask_data)

    r_v2 = p4_client.post(
        f"/api/v1/cases/{case_id}/mask-versions",
        headers={**_auth_header(token), "Idempotency-Key": str(uuid.uuid4())},
        data={
            "base_version_id": str(ai_v1.id),
            "reference_volume_id": volume["id"],
            "note": "Manual edit v2",
        },
        files={"mask": ("mask.nii.gz", mask_bytes, "application/gzip")},
    )
    assert r_v2.status_code == 201, r_v2.text
    v2 = r_v2.json()
    assert v2["version_number"] == 2

    idem_v3 = str(uuid.uuid4())
    r_v3 = p4_client.post(
        f"/api/v1/cases/{case_id}/mask-versions",
        headers={**_auth_header(token), "Idempotency-Key": idem_v3},
        data={
            "base_version_id": v2["id"],
            "reference_volume_id": volume["id"],
            "note": "Manual edit v3 to delete",
        },
        files={"mask": ("mask.nii.gz", mask_bytes, "application/gzip")},
    )
    assert r_v3.status_code == 201, r_v3.text
    v3 = r_v3.json()
    assert v3["version_number"] == 3

    r_del_v3 = p4_client.delete(
        f"/api/v1/mask-versions/{v3['id']}",
        headers=_auth_header(token),
    )
    assert r_del_v3.status_code == 202, r_del_v3.text
    del_payload = r_del_v3.json()
    assert del_payload["resource_type"] == "mask_version"
    assert del_payload["resource_id"] == v3["id"]
    assert del_payload["status"] == "deleted"
    assert del_payload["files_cleaned"] == 1

    # Hidden from list, get, export, metadata, and file content endpoints
    r_list = p4_client.get(
        f"/api/v1/cases/{case_id}/mask-versions",
        headers=_auth_header(token),
    )
    assert r_list.status_code == 200
    assert [item["id"] for item in r_list.json()["items"]] == [v2["id"], str(ai_v1.id)]

    for endpoint in (
        f"/api/v1/mask-versions/{v3['id']}",
        f"/api/v1/mask-versions/{v3['id']}/export",
        f"/api/v1/mask-versions/{v3['id']}/metadata",
        f"/api/v1/files/{v3['file_id']}/content",
    ):
        assert p4_client.get(endpoint, headers=_auth_header(token)).status_code == 404

    # DB state, storage reclamation, head rollback, and audit event
    p4_db_session.expire_all()
    v3_row = p4_db_session.get(MaskVersion, uuid.UUID(v3["id"]))
    assert v3_row is not None
    assert v3_row.deleted_at is not None
    assert v3_row.note is None
    v3_file = p4_db_session.get(StoredFile, uuid.UUID(v3["file_id"]))
    assert v3_file is not None
    assert v3_file.state == "deleted"
    storage = LocalStorageAdapter(test_settings.effective_storage_root)
    assert not (storage.objects_root / str(v3_file.storage_key)).exists()

    case_row = p4_db_session.get(Case, uuid.UUID(case_id))
    assert case_row is not None
    assert str(case_row.latest_mask_version_id) == v2["id"]

    audit = p4_db_session.query(AuditEvent).filter_by(
        action="mask_version_deleted",
        resource_id=v3["id"],
    ).one_or_none()
    assert audit is not None

    # Using deleted v3 as base fails with 404; saving from v2 advances monotonically to v4
    r_stale_base = p4_client.post(
        f"/api/v1/cases/{case_id}/mask-versions",
        headers={**_auth_header(token), "Idempotency-Key": str(uuid.uuid4())},
        data={"base_version_id": v3["id"], "reference_volume_id": volume["id"]},
        files={"mask": ("mask.nii.gz", mask_bytes, "application/gzip")},
    )
    assert r_stale_base.status_code == 404

    r_v4 = p4_client.post(
        f"/api/v1/cases/{case_id}/mask-versions",
        headers={**_auth_header(token), "Idempotency-Key": str(uuid.uuid4())},
        data={"base_version_id": v2["id"], "reference_volume_id": volume["id"]},
        files={"mask": ("mask.nii.gz", mask_bytes, "application/gzip")},
    )
    assert r_v4.status_code == 201, r_v4.text
    v4 = r_v4.json()
    assert v4["version_number"] == 4

    # Replaying deleted v3's original Idempotency-Key returns 409 idempotency_conflict
    r_replay_deleted = p4_client.post(
        f"/api/v1/cases/{case_id}/mask-versions",
        headers={**_auth_header(token), "Idempotency-Key": idem_v3},
        data={
            "base_version_id": v2["id"],
            "reference_volume_id": volume["id"],
            "note": "Manual edit v3 to delete",
        },
        files={"mask": ("mask.nii.gz", mask_bytes, "application/gzip")},
    )
    assert r_replay_deleted.status_code == 409
    assert r_replay_deleted.json()["error"]["code"] == "idempotency_conflict"

    # Delete v4 and v2 -> head rolls back to ai_v1 AND shared coverage_file_id remains intact
    assert p4_client.delete(
        f"/api/v1/mask-versions/{v4['id']}", headers=_auth_header(token)
    ).status_code == 202
    assert p4_client.delete(
        f"/api/v1/mask-versions/{v2['id']}", headers=_auth_header(token)
    ).status_code == 202

    p4_db_session.expire_all()
    case_after = p4_db_session.get(Case, uuid.UUID(case_id))
    assert case_after is not None
    assert case_after.latest_mask_version_id == ai_v1.id
    cov_after = p4_db_session.get(StoredFile, ai_cov_sf.id)
    assert cov_after is not None
    assert cov_after.state == "committed"
    assert (storage.objects_root / str(cov_after.storage_key)).is_file()


def test_delete_ai_mask_version_rejected_with_409_and_rbac_owner_boundaries(
    p4_client: TestClient,
    p4_db_session: Session,
    test_settings: Settings,
) -> None:
    doc_a = _seed_user(p4_db_session, username="doc_p4_del_a")
    _seed_user(p4_db_session, username="doc_p4_del_b")
    _seed_user(p4_db_session, username="admin_p4_del", role="admin")

    tok_a = _login(p4_client, "doc_p4_del_a")
    tok_b = _login(p4_client, "doc_p4_del_b")
    tok_admin = _login(p4_client, "admin_p4_del")

    case_id = _create_patient_and_case(p4_client, tok_a, code="PAT-P4-DEL-02")
    volume = _upload_volume(p4_client, tok_a, case_id, "t1ce", shape=(4, 4, 4))

    ai_v1, _, _ = _seed_ai_mask_version(
        p4_db_session,
        settings=test_settings,
        doctor_id=doc_a.id,
        case_id=uuid.UUID(case_id),
        reference_volume_id=uuid.UUID(volume["id"]),
        version_number=1,
    )

    mask_bytes = _make_nifti_gz_bytes(np.zeros((4, 4, 4), dtype=np.uint8))
    r_v2 = p4_client.post(
        f"/api/v1/cases/{case_id}/mask-versions",
        headers={**_auth_header(tok_a), "Idempotency-Key": str(uuid.uuid4())},
        data={"base_version_id": str(ai_v1.id), "reference_volume_id": volume["id"]},
        files={"mask": ("mask.nii.gz", mask_bytes, "application/gzip")},
    )
    assert r_v2.status_code == 201, r_v2.text
    manual_v2_id = r_v2.json()["id"]

    # AI mask cannot be deleted -> 409 ai_mask_not_deletable
    r_del_ai = p4_client.delete(
        f"/api/v1/mask-versions/{ai_v1.id}",
        headers=_auth_header(tok_a),
    )
    assert r_del_ai.status_code == 409, r_del_ai.text
    assert r_del_ai.json()["error"]["code"] == "ai_mask_not_deletable"
    assert p4_client.get(
        f"/api/v1/mask-versions/{ai_v1.id}/export", headers=_auth_header(tok_a)
    ).status_code == 200

    # Doctor B cannot delete Doctor A's manual mask -> 404
    r_del_other = p4_client.delete(
        f"/api/v1/mask-versions/{manual_v2_id}",
        headers=_auth_header(tok_b),
    )
    assert r_del_other.status_code == 404

    # Admin cannot call doctor mask endpoint -> 403
    r_del_admin = p4_client.delete(
        f"/api/v1/mask-versions/{manual_v2_id}",
        headers=_auth_header(tok_admin),
    )
    assert r_del_admin.status_code == 403

    # Manual v2 remains intact
    assert p4_client.get(
        f"/api/v1/mask-versions/{manual_v2_id}", headers=_auth_header(tok_a)
    ).status_code == 200


def test_backup_restore_verify_ignores_soft_deleted_manual_mask_version(
    p4_client: TestClient,
    p4_db_session: Session,
    migrated_postgres: str,
    test_settings: Settings,
) -> None:
    from scripts.backup_restore import verify_storage_and_db_integrity

    _seed_user(p4_db_session, username="doc_p4_del_verify")
    token = _login(p4_client, "doc_p4_del_verify")
    case_id = _create_patient_and_case(p4_client, token, code="PAT-P4-DEL-VERIFY")
    volume = _upload_volume(p4_client, token, case_id, "flair", shape=(4, 4, 4))

    mask_bytes = _make_nifti_gz_bytes(np.zeros((4, 4, 4), dtype=np.uint8))
    r_v1 = p4_client.post(
        f"/api/v1/cases/{case_id}/mask-versions",
        headers={**_auth_header(token), "Idempotency-Key": str(uuid.uuid4())},
        data={"reference_volume_id": volume["id"], "note": "To be deleted"},
        files={"mask": ("mask.nii.gz", mask_bytes, "application/gzip")},
    )
    assert r_v1.status_code == 201, r_v1.text
    v1_id = r_v1.json()["id"]

    r_del = p4_client.delete(
        f"/api/v1/mask-versions/{v1_id}",
        headers=_auth_header(token),
    )
    assert r_del.status_code == 202, r_del.text

    verify_summary = verify_storage_and_db_integrity(
        database_url=migrated_postgres,
        storage_root=test_settings.effective_storage_root,
    )
    assert verify_summary["status"] == "ok"
    assert verify_summary["verified_mask_versions"] == 0


def test_update_mask_version_note_supports_ai_and_manual_enforces_validation_and_rbac(
    p4_client: TestClient,
    p4_db_session: Session,
    test_settings: Settings,
) -> None:
    doc_a = _seed_user(p4_db_session, username="doc_p4_note_a", display_name="Dr. Note A")
    _seed_user(p4_db_session, username="doc_p4_note_b", display_name="Dr. Note B")
    _seed_user(p4_db_session, username="admin_p4_note", role="admin")

    tok_a = _login(p4_client, "doc_p4_note_a")
    tok_b = _login(p4_client, "doc_p4_note_b")
    tok_admin = _login(p4_client, "admin_p4_note")

    case_id = _create_patient_and_case(p4_client, tok_a, code="PAT-P4-NOTE-01")
    volume = _upload_volume(p4_client, tok_a, case_id, "t1ce", shape=(4, 4, 4))

    ai_v1, _, _ = _seed_ai_mask_version(
        p4_db_session,
        settings=test_settings,
        doctor_id=doc_a.id,
        case_id=uuid.UUID(case_id),
        reference_volume_id=uuid.UUID(volume["id"]),
        version_number=1,
    )

    mask_arr = np.zeros((4, 4, 4), dtype=np.uint8)
    mask_arr[1, 1, 1] = 2
    mask_bytes = _make_nifti_gz_bytes(mask_arr)

    r_v2 = p4_client.post(
        f"/api/v1/cases/{case_id}/mask-versions",
        headers={**_auth_header(tok_a), "Idempotency-Key": str(uuid.uuid4())},
        data={
            "base_version_id": str(ai_v1.id),
            "reference_volume_id": volume["id"],
            "note": "Initial note",
        },
        files={"mask": ("mask.nii.gz", mask_bytes, "application/gzip")},
    )
    assert r_v2.status_code == 201, r_v2.text
    v2 = r_v2.json()

    # Edit manual v2 note
    r_patch_v2 = p4_client.patch(
        f"/api/v1/mask-versions/{v2['id']}",
        headers=_auth_header(tok_a),
        json={"note": "  Updated manual note  "},
    )
    assert r_patch_v2.status_code == 200, r_patch_v2.text
    updated_v2 = r_patch_v2.json()
    assert updated_v2["note"] == "Updated manual note"
    assert updated_v2["sha256"] == v2["sha256"]
    assert updated_v2["label_voxel_counts"] == v2["label_voxel_counts"]

    # Confirm persisted in GET detail and list
    r_get_v2 = p4_client.get(
        f"/api/v1/mask-versions/{v2['id']}", headers=_auth_header(tok_a)
    )
    assert r_get_v2.status_code == 200
    assert r_get_v2.json()["note"] == "Updated manual note"

    r_list = p4_client.get(
        f"/api/v1/cases/{case_id}/mask-versions", headers=_auth_header(tok_a)
    )
    assert r_list.status_code == 200
    assert r_list.json()["items"][0]["note"] == "Updated manual note"

    # Zero-PII audit event check
    p4_db_session.expire_all()
    audit = p4_db_session.query(AuditEvent).filter_by(
        action="mask_version_note_updated",
        resource_id=v2["id"],
    ).one_or_none()
    assert audit is not None
    assert audit.safe_diff is not None
    assert audit.safe_diff.get("has_note") is True
    assert "Updated manual note" not in json.dumps(audit.safe_diff)

    # Edit AI v1 note
    r_patch_ai = p4_client.patch(
        f"/api/v1/mask-versions/{ai_v1.id}",
        headers=_auth_header(tok_a),
        json={"note": "AI review note"},
    )
    assert r_patch_ai.status_code == 200, r_patch_ai.text
    assert r_patch_ai.json()["note"] == "AI review note"

    # Clear note with whitespace and explicit null
    r_clear_ws = p4_client.patch(
        f"/api/v1/mask-versions/{v2['id']}",
        headers=_auth_header(tok_a),
        json={"note": "   "},
    )
    assert r_clear_ws.status_code == 200
    assert r_clear_ws.json()["note"] is None

    r_clear_null = p4_client.patch(
        f"/api/v1/mask-versions/{ai_v1.id}",
        headers=_auth_header(tok_a),
        json={"note": None},
    )
    assert r_clear_null.status_code == 200
    assert r_clear_null.json()["note"] is None

    # Validation: > 2000 chars and extra fields
    assert (
        p4_client.patch(
            f"/api/v1/mask-versions/{v2['id']}",
            headers=_auth_header(tok_a),
            json={"note": "x" * 2001},
        ).status_code
        == 422
    )
    assert (
        p4_client.patch(
            f"/api/v1/mask-versions/{v2['id']}",
            headers=_auth_header(tok_a),
            json={"note": "ok", "source": "ai"},
        ).status_code
        == 422
    )

    # RBAC & owner boundaries
    assert (
        p4_client.patch(
            f"/api/v1/mask-versions/{v2['id']}",
            headers=_auth_header(tok_b),
            json={"note": "Hijack"},
        ).status_code
        == 404
    )
    assert (
        p4_client.patch(
            f"/api/v1/mask-versions/{v2['id']}",
            headers=_auth_header(tok_admin),
            json={"note": "Admin edit"},
        ).status_code
        == 403
    )

    # Cannot update note on soft-deleted mask version
    assert (
        p4_client.delete(
            f"/api/v1/mask-versions/{v2['id']}", headers=_auth_header(tok_a)
        ).status_code
        == 202
    )
    assert (
        p4_client.patch(
            f"/api/v1/mask-versions/{v2['id']}",
            headers=_auth_header(tok_a),
            json={"note": "After delete"},
        ).status_code
        == 404
    )
