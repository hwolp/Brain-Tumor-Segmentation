"""Integration tests for Admin AI Benchmark & Ground-Truth Evaluation APIs."""

from __future__ import annotations

import gzip
import io
import json
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta

import nibabel as nib
import numpy as np
import pytest
from argon2 import PasswordHasher
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select, text
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.main import create_app
from app.models.admin_benchmark import AdminBenchmarkRun
from app.models.inference_job import WorkerInstance
from app.models.stored_file import StoredFile
from app.models.user import User
from app.services.inference_job_service import reap_expired_attempts

_HASHER = PasswordHasher()
_PASSWORD = "BenchIntegration123!"
_WORKER_TOKEN = "bench-test-worker-token"
_CASE_SHAPE = (240, 240, 155)
_CASE_AFFINE: list[list[float]] = [
    [1.0, 0.0, 0.0, -120.0],
    [0.0, 1.0, 0.0, -120.0],
    [0.0, 0.0, 1.0, -78.0],
    [0.0, 0.0, 0.0, 1.0],
]


@pytest.fixture()
def clean_bench_db(migrated_postgres: str) -> Iterator[None]:
    engine = create_engine(migrated_postgres)
    try:
        with engine.begin() as conn:
            conn.execute(
                text(
                    "TRUNCATE TABLE admin_benchmark_runs, job_create_idempotency_keys, "
                    "job_attempts, worker_instances, inference_jobs, model_versions, "
                    "mask_save_idempotency_keys, mask_versions, volumes, stored_files, "
                    "case_create_idempotency_keys, cases, patients, system_settings, "
                    "audit_events, login_attempts, refresh_tokens, sessions, users "
                    "RESTART IDENTITY CASCADE"
                )
            )
        yield
    finally:
        engine.dispose()


@pytest.fixture()
def bench_db(clean_bench_db: None, migrated_postgres: str) -> Iterator[Session]:
    engine = create_engine(migrated_postgres)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    try:
        with factory() as db:
            yield db
    finally:
        engine.dispose()


@pytest.fixture()
def bench_settings(test_settings: Settings) -> Settings:
    return test_settings.model_copy(update={"WORKER_TOKEN": _WORKER_TOKEN})


@pytest.fixture()
def bench_client(clean_bench_db: None, bench_settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings=bench_settings), raise_server_exceptions=False) as client:
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


def _seed_worker(
    db: Session, *, worker_id: str, device_type: str = "GPU", model_version_id: str = "tda:v1"
) -> WorkerInstance:
    worker = WorkerInstance(
        worker_id=worker_id,
        device_type=device_type,
        model_version_id=model_version_id,
        current_job_id=None,
        last_heartbeat_at=datetime.now(UTC),
    )
    db.add(worker)
    db.commit()
    return worker


def _login_headers(client: TestClient, username: str) -> dict[str, str]:
    resp = client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": _PASSWORD},
    )
    assert resp.status_code == 200, resp.text
    token = resp.json()["access_token"]
    return {"Authorization": f"Bearer {token}"}


def _worker_headers() -> dict[str, str]:
    return {"X-Worker-Token": _WORKER_TOKEN}


def _build_valid_upload_files(
    *,
    flair_shape: tuple[int, int, int] = _CASE_SHAPE,
    gt_labels: dict[tuple[slice, slice, int], int] | None = None,
    invalid_label: int | None = None,
) -> dict[str, tuple[str, bytes, str]]:
    flair = np.zeros(flair_shape, dtype=np.float32)
    z_idx = min(70, flair_shape[2] - 1)
    flair[50:60, 50:60, z_idx] = 2.0
    t1ce = np.zeros(_CASE_SHAPE, dtype=np.float32)
    t1ce[50:60, 50:60, 70] = 3.5

    gt = np.zeros(_CASE_SHAPE, dtype=np.uint8)
    if gt_labels:
        for (ys, xs, z), val in gt_labels.items():
            gt[ys, xs, z] = val
    else:
        gt[60:64, 60:64, 70] = 2
        gt[64:66, 64:66, 70] = 1
        gt[66:68, 66:68, 70] = 4
    if invalid_label is not None:
        gt[10, 10, 10] = invalid_label

    return {
        "flair": ("case_flair.nii.gz", _make_nifti_gz_bytes(flair), "application/gzip"),
        "t1ce": ("case_t1ce.nii.gz", _make_nifti_gz_bytes(t1ce), "application/gzip"),
        "gt_mask": ("case_seg.nii.gz", _make_nifti_gz_bytes(gt), "application/gzip"),
    }


def _coverage_bytes() -> bytes:
    crops = [
        {
            "z": z,
            "x0": 40,
            "y0": 40,
            "x1": 168,
            "y1": 168,
            "center_x": 104.0,
            "center_y": 104.0,
            "is_empty_slice": z != 70,
            "evaluated": True,
        }
        for z in range(_CASE_SHAPE[2])
    ]
    payload = {
        "original_shape": list(_CASE_SHAPE),
        "pipeline_version": "tda-test-v1",
        "total_slices": _CASE_SHAPE[2],
        "evaluated_slices": _CASE_SHAPE[2],
        "slice_crops": crops,
    }
    return json.dumps(payload).encode("utf-8")


def _metadata_bytes() -> bytes:
    payload = {
        "model_id": "tda-seg-unet",
        "model_version": "v1",
        "geometry": {"shape": list(_CASE_SHAPE)},
    }
    return json.dumps(payload).encode("utf-8")


def test_rbac_blocks_doctor_and_anonymous_on_benchmarks(
    bench_client: TestClient, bench_db: Session
) -> None:
    _seed_user(bench_db, username="doc_rb", role="doctor")
    _seed_user(bench_db, username="admin_rb", role="admin")
    doc_headers = _login_headers(bench_client, "doc_rb")
    admin_headers = _login_headers(bench_client, "admin_rb")

    assert bench_client.get("/api/v1/admin/benchmarks").status_code == 401
    assert bench_client.get("/api/v1/admin/benchmarks", headers=doc_headers).status_code == 403
    resp = bench_client.get("/api/v1/admin/benchmarks", headers=admin_headers)
    assert resp.status_code == 200
    assert resp.json()["total"] == 0

    # Admin must remain blocked on clinical APIs
    assert bench_client.get("/api/v1/patients", headers=admin_headers).status_code == 403


def test_create_benchmark_rejects_invalid_labels_geometry_and_unknown_worker(
    bench_client: TestClient, bench_db: Session
) -> None:
    _seed_user(bench_db, username="admin_val", role="admin")
    _seed_worker(bench_db, worker_id="colab-t4-1")
    headers = _login_headers(bench_client, "admin_val")

    # Unknown worker -> 404
    files = _build_valid_upload_files()
    resp_missing = bench_client.post(
        "/api/v1/admin/benchmarks",
        headers=headers,
        data={"title": "Test unknown", "target_worker_id": "missing-worker"},
        files=files,
    )
    assert resp_missing.status_code == 404
    assert resp_missing.json()["error"]["code"] == "worker_not_found"

    # Geometry mismatch between FLAIR and T1ce -> 422
    files_bad_geom = _build_valid_upload_files(flair_shape=(128, 128, 64))
    resp_geom = bench_client.post(
        "/api/v1/admin/benchmarks",
        headers=headers,
        data={"title": "Bad shape", "target_worker_id": "colab-t4-1"},
        files=files_bad_geom,
    )
    assert resp_geom.status_code == 422
    assert resp_geom.json()["error"]["code"] == "geometry_mismatch"

    # Invalid label 3 in seg mask -> 422
    files_bad_lbl = _build_valid_upload_files(invalid_label=3)
    resp_lbl = bench_client.post(
        "/api/v1/admin/benchmarks",
        headers=headers,
        data={"title": "BraTS2023 label 3", "target_worker_id": "colab-t4-1"},
        files=files_bad_lbl,
    )
    assert resp_lbl.status_code == 422
    assert resp_lbl.json()["error"]["code"] == "invalid_mask_labels"

    # No orphan StoredFile rows leaked from failed creations
    assert bench_db.scalars(select(StoredFile)).all() == []


def test_benchmark_worker_targeting_isolation_e2e_scoring_and_delete(
    bench_client: TestClient, bench_db: Session
) -> None:
    _seed_user(bench_db, username="admin_e2e", role="admin")
    _seed_worker(bench_db, worker_id="worker-a", device_type="GPU", model_version_id="tda:a")
    _seed_worker(bench_db, worker_id="worker-b", device_type="CPU", model_version_id="tda:b")
    admin_headers = _login_headers(bench_client, "admin_e2e")

    create_resp = bench_client.post(
        "/api/v1/admin/benchmarks",
        headers=admin_headers,
        data={
            "title": "BraTS_001 Worker A",
            "target_worker_id": "worker-a",
            "notes": "Test note",
        },
        files=_build_valid_upload_files(),
    )
    assert create_resp.status_code == 201, create_resp.text
    bench = create_resp.json()
    bench_id = bench["id"]
    assert bench["state"] == "queued"
    assert bench["target_worker_id"] == "worker-a"

    # Worker B must NOT receive Worker A's benchmark
    claim_b = bench_client.post(
        "/api/v1/internal/worker/claim",
        headers=_worker_headers(),
        json={"worker_id": "worker-b", "device_type": "CPU", "model_version_id": "tda:b"},
    )
    assert claim_b.status_code == 204

    # Worker A receives the benchmark with ONLY flair and t1ce (never gt_mask!)
    claim_a = bench_client.post(
        "/api/v1/internal/worker/claim",
        headers=_worker_headers(),
        json={"worker_id": "worker-a", "device_type": "GPU", "model_version_id": "tda:a"},
    )
    assert claim_a.status_code == 200, claim_a.text
    claim = claim_a.json()
    assert claim["job_id"] == bench_id
    modalities = [f["modality"] for f in claim["files"]]
    assert modalities == ["flair", "t1ce"]

    # Worker reports active_jobs == 1 while benchmark is running
    workers_resp = bench_client.get("/api/v1/admin/workers", headers=admin_headers)
    assert workers_resp.status_code == 200
    worker_a_row = next(w for w in workers_resp.json() if w["worker_id"] == "worker-a")
    assert worker_a_row["active_jobs"] == 1

    # Running benchmark cannot be deleted -> 409
    del_running = bench_client.delete(
        f"/api/v1/admin/benchmarks/{bench_id}", headers=admin_headers
    )
    assert del_running.status_code == 409

    # Worker must NOT be able to download gt_mask_file_id even with valid lease
    bench_db.expire_all()
    run_row = bench_db.get(AdminBenchmarkRun, uuid.UUID(bench_id))
    assert run_row is not None
    gt_download = bench_client.get(
        f"/api/v1/internal/files/{run_row.gt_mask_file_id}/content",
        headers={
            **_worker_headers(),
            "X-Job-ID": bench_id,
            "X-Attempt-ID": claim["attempt_id"],
            "X-Worker-ID": "worker-a",
            "X-Lease-Token": claim["lease_token"],
        },
    )
    assert gt_download.status_code == 404

    # Worker CAN download flair and t1ce
    for item in claim["files"]:
        dl = bench_client.get(
            f"/api/v1/internal/files/{item['file_id']}/content",
            headers={
                **_worker_headers(),
                "X-Job-ID": bench_id,
                "X-Attempt-ID": claim["attempt_id"],
                "X-Worker-ID": "worker-a",
                "X-Lease-Token": claim["lease_token"],
            },
        )
        assert dl.status_code == 200

    # Heartbeat progress
    hb = bench_client.post(
        f"/api/v1/internal/jobs/{bench_id}/heartbeat",
        headers=_worker_headers(),
        json={
            "worker_id": "worker-a",
            "attempt_id": claim["attempt_id"],
            "lease_token": claim["lease_token"],
            "stage": "inference",
            "completed_slices": 75,
            "total_slices": 155,
        },
    )
    assert hb.status_code == 200
    assert hb.json()["completed_slices"] == 75

    # Worker submits perfect matching pred mask -> score should be Dice=1.0
    pred = np.zeros(_CASE_SHAPE, dtype=np.uint8)
    pred[60:64, 60:64, 70] = 2
    pred[64:66, 64:66, 70] = 1
    pred[66:68, 66:68, 70] = 4
    complete_resp = bench_client.post(
        f"/api/v1/internal/jobs/{bench_id}/complete",
        headers={
            **_worker_headers(),
            "X-Attempt-ID": claim["attempt_id"],
            "X-Worker-ID": "worker-a",
            "X-Lease-Token": claim["lease_token"],
        },
        files={
            "mask": ("mask.nii.gz", _make_nifti_gz_bytes(pred), "application/gzip"),
            "coverage": ("coverage.json", _coverage_bytes(), "application/json"),
            "metadata": ("metadata.json", _metadata_bytes(), "application/json"),
        },
    )
    assert complete_resp.status_code == 200, complete_resp.text
    assert complete_resp.json()["job"]["state"] == "succeeded"
    assert complete_resp.json()["job"]["completed_slices"] == 155
    assert complete_resp.json()["job"]["total_slices"] == 155

    # Detail contains scored metrics & best slice
    detail_resp = bench_client.get(
        f"/api/v1/admin/benchmarks/{bench_id}", headers=admin_headers
    )
    assert detail_resp.status_code == 200
    detail = detail_resp.json()
    assert detail["state"] == "succeeded"
    assert detail["completed_slices"] == 155
    assert detail["total_slices"] == 155
    assert detail["has_pred_mask"] is True
    assert detail["mean_dice_brats"] == 1.0
    assert detail["metrics"]["best_slice_z"] == 70
    assert detail["metrics"]["crop_capture"]["capture_recall"] == 1.0

    # Admin can download all 4 visual artifacts (flair, t1ce, gt_mask, pred_mask)
    for artifact in ("flair", "t1ce", "gt_mask", "pred_mask"):
        art_resp = bench_client.get(
            f"/api/v1/admin/benchmarks/{bench_id}/files/{artifact}",
            headers=admin_headers,
        )
        assert art_resp.status_code == 200
        assert art_resp.headers["cache-control"] == "no-store"

    # Delete succeeds once finished and marks all 5 StoredFiles deleted
    del_resp = bench_client.delete(
        f"/api/v1/admin/benchmarks/{bench_id}", headers=admin_headers
    )
    assert del_resp.status_code == 200
    assert del_resp.json()["status"] == "deleted"
    assert del_resp.json()["files_cleaned"] == 5

    bench_db.expire_all()
    remaining_files = bench_db.scalars(
        select(StoredFile).where(StoredFile.state != "deleted")
    ).all()
    assert remaining_files == []


def test_reap_expired_benchmark_lease_marks_failed(
    bench_client: TestClient, bench_db: Session
) -> None:
    _seed_user(bench_db, username="admin_reap", role="admin")
    _seed_worker(bench_db, worker_id="worker-reap")
    admin_headers = _login_headers(bench_client, "admin_reap")

    create_resp = bench_client.post(
        "/api/v1/admin/benchmarks",
        headers=admin_headers,
        data={"title": "Lease timeout", "target_worker_id": "worker-reap"},
        files=_build_valid_upload_files(),
    )
    assert create_resp.status_code == 201
    bench_id = uuid.UUID(create_resp.json()["id"])

    claim = bench_client.post(
        "/api/v1/internal/worker/claim",
        headers=_worker_headers(),
        json={"worker_id": "worker-reap", "device_type": "CPU", "model_version_id": "tda:v1"},
    )
    assert claim.status_code == 200

    run_row = bench_db.get(AdminBenchmarkRun, bench_id)
    assert run_row is not None
    run_row.lease_expires_at = datetime.now(UTC) - timedelta(seconds=10)
    bench_db.commit()

    reaped = reap_expired_attempts(bench_db)
    assert reaped == 1

    bench_db.expire_all()
    run_after = bench_db.get(AdminBenchmarkRun, bench_id)
    worker_after = bench_db.get(WorkerInstance, "worker-reap")
    assert run_after is not None
    assert run_after.state == "failed"
    assert run_after.error_code == "worker_lease_expired"
    assert worker_after is not None
    assert worker_after.current_job_id is None
