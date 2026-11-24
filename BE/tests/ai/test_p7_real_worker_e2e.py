"""End-to-end pytest for the real TDA-SegUNet InferenceWorker over HTTP + PostgreSQL."""

from __future__ import annotations

import contextlib
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import psycopg
import pytest

_BE_DIR = Path(__file__).resolve().parents[2]
_REPO_ROOT = Path(__file__).resolve().parents[3]
for _path_item in (_REPO_ROOT, _BE_DIR):
    _path_str = str(_path_item)
    if _path_str not in sys.path:
        sys.path.insert(0, _path_str)

from scripts.run_p7_real_ai_smoke import (  # noqa: E402
    DEFAULT_CASE_DIR,
    DEFAULT_CHECKPOINT_PATH,
    DEFAULT_MANIFEST_PATH,
    run_real_worker_e2e_smoke,
    validate_isolated_database_url,
)

DEFAULT_PYTEST_AI_DATABASE_URL = (
    "postgresql+psycopg://bts_user:bts_local_dev_pw@127.0.0.1:5432/bts_ai_pytest_test"
)


def _resolve_pytest_ai_database_url() -> str:
    explicit = os.environ.get("TEST_AI_PYTEST_DATABASE_URL", "").strip()
    if explicit:
        return explicit
    base = os.environ.get("TEST_AI_DATABASE_URL", "").strip()
    if base:
        parsed = urlsplit(base)
        return urlunsplit(
            (parsed.scheme, parsed.netloc, "/bts_ai_pytest_test", parsed.query, parsed.fragment)
        )
    return DEFAULT_PYTEST_AI_DATABASE_URL


def _has_modality_file(case_dir: Path, modality: str) -> bool:
    if not case_dir.is_dir():
        return False
    return any(
        p.is_file()
        for ext in ("nii.gz", "nii")
        for p in case_dir.glob(f"*_{modality}.{ext}")
    )


def _check_postgres_reachable(psycopg_url: str) -> None:
    parsed = urlsplit(psycopg_url)
    last_exc: Exception | None = None
    for admin_db in ("postgres", "bts_dev"):
        dsn = urlunsplit(
            (parsed.scheme, parsed.netloc, f"/{admin_db}", parsed.query, parsed.fragment)
        )
        try:
            with psycopg.connect(dsn, connect_timeout=3) as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT 1")
                    cur.fetchone()
            return
        except psycopg.Error as exc:
            last_exc = exc
            continue
    pytest.fail(f"PostgreSQL is not reachable for P7 real worker E2E test: {last_exc}")


def _database_exists(psycopg_url: str, db_name: str) -> bool:
    parsed = urlsplit(psycopg_url)
    for admin_db in ("postgres", "bts_dev"):
        dsn = urlunsplit(
            (parsed.scheme, parsed.netloc, f"/{admin_db}", parsed.query, parsed.fragment)
        )
        with contextlib.suppress(psycopg.Error):
            with psycopg.connect(dsn, connect_timeout=3) as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (db_name,))
                    return cur.fetchone() is not None
    return False


def test_p7_real_worker_e2e_full_155_slices() -> None:
    has_flair = _has_modality_file(DEFAULT_CASE_DIR, "flair")
    has_t1ce = _has_modality_file(DEFAULT_CASE_DIR, "t1ce")
    if not (has_flair and has_t1ce):
        pytest.skip(f"BraTS20_Training_001 FLAIR/T1ce inputs not available at {DEFAULT_CASE_DIR}")
    if not DEFAULT_CHECKPOINT_PATH.is_file():
        pytest.skip(f"Real checkpoint best.pt not available at {DEFAULT_CHECKPOINT_PATH}")
    if not DEFAULT_MANIFEST_PATH.is_file():
        pytest.skip(f"Model manifest not available at {DEFAULT_MANIFEST_PATH}")

    db_url = _resolve_pytest_ai_database_url()
    _, psycopg_url, db_name = validate_isolated_database_url(db_url)
    _check_postgres_reachable(psycopg_url)

    report = run_real_worker_e2e_smoke(
        database_url=db_url,
        case_dir=DEFAULT_CASE_DIR,
        checkpoint_path=DEFAULT_CHECKPOINT_PATH,
        manifest_path=DEFAULT_MANIFEST_PATH,
    )

    job = report["job"]
    assert job["state"] == "succeeded"
    assert job["stage"] == "done"
    assert job["completed_slices"] == 155
    assert job["total_slices"] == 155
    assert job["result_mask_version_id"] is not None

    assert report["export_shape"] == [240, 240, 155]
    assert report["export_dtype"] == "uint8"
    assert set(report["labels_present"]) <= {0, 1, 2, 4}
    assert report["group_volumes_mm3"]["WT"] > 0
    assert report["affine_match"] is True
    assert report["spacing_match"] is True

    stage_timings_ms = report["stage_timings_ms"]
    assert stage_timings_ms["tda"] > 0
    assert stage_timings_ms["inference"] > 0

    coverage_summary = report["coverage_summary"]
    assert coverage_summary["unevaluated_outside_crop"] is True
    assert coverage_summary["evaluated_slices"] == 155
    assert coverage_summary["total_slices"] == 155

    assert report["metadata_has_no_absolute_paths"] is True
    assert report["metadata_has_no_patient_pii"] is True
    assert report["timings_ms"]["model_preload_ms"] > 0
    assert report["timings_ms"]["end_to_end_job_ms"] > 0
    assert report["memory_mb"]["peak_rss_mb"] > 0
    assert not _database_exists(psycopg_url, db_name)
