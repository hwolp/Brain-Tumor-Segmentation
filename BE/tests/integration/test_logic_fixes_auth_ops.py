"""Integration tests for Component 1 logic fixes (L-01, L-08, L-09, Auth & Admin Ops)."""

from __future__ import annotations

import json
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from threading import Barrier
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.core.security import (
    hash_password,
    issue_access_token,
    load_jwt_key_material,
    verify_password,
)
from app.core.storage import LocalStorageAdapter
from app.main import create_app
from app.models.audit_event import AuditEvent
from app.models.case import Case
from app.models.inference_job import InferenceJob, ModelVersion, WorkerInstance
from app.models.patient import Patient
from app.models.session import LoginAttempt, RefreshToken
from app.models.session import Session as AuthSession
from app.models.system_setting import SystemSetting
from app.models.user import User
from app.services.file_cleanup_service import run_orphan_cleanup
from app.services.job_service import sync_active_model

_BE_DIR = Path(__file__).resolve().parents[2]
_PASSWORD = "AuthOpsFixPass!2026"
_WORKER_TOKEN = "auth-ops-fix-worker-token-secret"


@pytest.fixture()
def clean_auth_ops_db(migrated_postgres: str) -> Iterator[None]:
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
def auth_ops_db(clean_auth_ops_db: None, migrated_postgres: str) -> Iterator[Session]:
    engine = create_engine(migrated_postgres)
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    try:
        with factory() as db:
            yield db
    finally:
        engine.dispose()


@pytest.fixture()
def auth_ops_settings(test_settings: Settings) -> Settings:
    return test_settings.model_copy(
        update={
            "WORKER_TOKEN": _WORKER_TOKEN,
            "MODEL_MANIFEST_PATH": _BE_DIR / "worker" / "manifest.json",
        }
    )


def _seed_user(
    db: Session,
    *,
    username: str,
    role: str = "doctor",
    password: str = _PASSWORD,
    must_change_password: bool = False,
) -> User:
    user = User(
        username=username,
        display_name=f"Display {username}",
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


def _login(client: TestClient, username: str, password: str = _PASSWORD) -> tuple[str, str]:
    resp = client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": password},
    )
    assert resp.status_code == 200, resp.text
    return str(resp.json()["access_token"]), str(resp.cookies.get("bts_refresh") or "")


def test_l01_login_race_against_disable_and_password_reset_rejects_session(
    auth_ops_db: Session,
    auth_ops_settings: Settings,
) -> None:
    admin = _seed_user(auth_ops_db, username="admin.l01", role="admin")
    doc_disable = _seed_user(auth_ops_db, username="doc.race.disable", role="doctor")
    doc_reset = _seed_user(auth_ops_db, username="doc.race.reset", role="doctor")

    app = create_app(settings=auth_ops_settings)
    with (
        TestClient(app, raise_server_exceptions=False) as admin_client,
        TestClient(app, raise_server_exceptions=False) as login_client,
    ):
        admin_tok, _ = _login(admin_client, admin.username)
        admin_hdr = {"Authorization": f"Bearer {admin_tok}"}

        # Subcase A: Doctor disabled during Argon2id verification -> 401 login_failed
        def _verify_then_disable(stored_hash: str, raw_pw: str) -> bool:
            ok = verify_password(stored_hash, raw_pw)
            if ok and stored_hash == doc_disable.password_hash:
                r = admin_client.patch(
                    f"/api/v1/admin/users/{doc_disable.id}",
                    headers=admin_hdr,
                    json={"is_active": False},
                )
                assert r.status_code == 200
            return ok

        with patch("app.services.auth_service.verify_password", side_effect=_verify_then_disable):
            r_login_dis = login_client.post(
                "/api/v1/auth/login",
                json={"username": doc_disable.username, "password": _PASSWORD},
            )
        assert r_login_dis.status_code == 401
        assert r_login_dis.json()["error"]["code"] == "login_failed"

        # Subcase B: Doctor password reset during Argon2id verification -> 401 login_failed
        initial_reset_hash = doc_reset.password_hash

        def _verify_then_reset(stored_hash: str, raw_pw: str) -> bool:
            ok = verify_password(stored_hash, raw_pw)
            if ok and stored_hash == initial_reset_hash:
                r = admin_client.post(
                    f"/api/v1/admin/users/{doc_reset.id}/reset-password",
                    headers=admin_hdr,
                )
                assert r.status_code == 200
            return ok

        with patch("app.services.auth_service.verify_password", side_effect=_verify_then_reset):
            r_login_rst = login_client.post(
                "/api/v1/auth/login",
                json={"username": doc_reset.username, "password": _PASSWORD},
            )
        assert r_login_rst.status_code == 401
        assert r_login_rst.json()["error"]["code"] == "login_failed"

    auth_ops_db.expire_all()
    open_sessions = auth_ops_db.scalars(
        select(AuthSession).where(
            AuthSession.user_id.in_([doc_disable.id, doc_reset.id]),
            AuthSession.revoked_at.is_(None),
        )
    ).all()
    assert open_sessions == []


def test_l01_password_changed_at_enforced_and_noop_doctor_update_skips_audit(
    auth_ops_db: Session,
    auth_ops_settings: Settings,
) -> None:
    admin = _seed_user(auth_ops_db, username="admin.pwcheck", role="admin")
    doctor = _seed_user(
        auth_ops_db,
        username="doc.pwcheck",
        role="doctor",
        must_change_password=True,
    )
    assert doctor.password_changed_at is None

    app = create_app(settings=auth_ops_settings)
    with (
        TestClient(app, raise_server_exceptions=False) as admin_client,
        TestClient(app, raise_server_exceptions=False) as doc_client,
    ):
        admin_tok, _ = _login(admin_client, admin.username)
        admin_hdr = {"Authorization": f"Bearer {admin_tok}"}

        # No-op update_doctor must NOT record an empty AuditEvent
        before_audits = int(
            auth_ops_db.scalar(
                select(func.count())
                .select_from(AuditEvent)
                .where(AuditEvent.resource_id == str(doctor.id))
            )
            or 0
        )
        noop_resp = admin_client.patch(
            f"/api/v1/admin/users/{doctor.id}",
            headers=admin_hdr,
            json={"display_name": doctor.display_name, "is_active": True},
        )
        assert noop_resp.status_code == 200
        after_audits = int(
            auth_ops_db.scalar(
                select(func.count())
                .select_from(AuditEvent)
                .where(AuditEvent.resource_id == str(doctor.id))
            )
            or 0
        )
        assert after_audits == before_audits

        # Reset password sets password_changed_at
        rst_resp = admin_client.post(
            f"/api/v1/admin/users/{doctor.id}/reset-password",
            headers=admin_hdr,
        )
        assert rst_resp.status_code == 200
        temp_pw = rst_resp.json()["temporary_password"]

        auth_ops_db.expire_all()
        refreshed_doc = auth_ops_db.get(User, doctor.id)
        assert refreshed_doc is not None
        assert refreshed_doc.password_changed_at is not None

        # Immediate login after reset succeeds and passes /auth/me + /auth/refresh
        doc_tok, doc_rt = _login(doc_client, doctor.username, temp_pw)
        assert (
            doc_client.get(
                "/api/v1/auth/me", headers={"Authorization": f"Bearer {doc_tok}"}
            ).status_code
            == 200
        )
        rot = doc_client.post("/api/v1/auth/refresh", cookies={"bts_refresh": doc_rt})
        assert rot.status_code == 200
        doc_rt_latest = str(rot.cookies.get("bts_refresh") or "")

        # Backdate session.created_at before password_changed_at -> rejected even if unrevoked
        sess_row = auth_ops_db.scalar(
            select(AuthSession).where(
                AuthSession.user_id == doctor.id,
                AuthSession.revoked_at.is_(None),
            )
        )
        assert sess_row is not None
        sess_row.created_at = refreshed_doc.password_changed_at - timedelta(seconds=5)
        auth_ops_db.commit()

        key_mat = load_jwt_key_material(auth_ops_settings)
        assert key_mat is not None
        stale_jwt = issue_access_token(
            user_id=doctor.id,
            session_id=sess_row.id,
            role="doctor",
            key_material=key_mat,
            settings=auth_ops_settings,
        )
        r_me = doc_client.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {stale_jwt}"},
        )
        assert r_me.status_code == 401
        assert r_me.json()["error"]["code"] == "unauthenticated"

        r_ref = doc_client.post(
            "/api/v1/auth/refresh",
            cookies={"bts_refresh": doc_rt_latest},
        )
        assert r_ref.status_code == 401


def test_l08_concurrent_refresh_vs_disable_and_login_attempt_cleanup(
    auth_ops_db: Session,
    auth_ops_settings: Settings,
) -> None:
    admin = _seed_user(auth_ops_db, username="admin.l08", role="admin")
    doctor = _seed_user(auth_ops_db, username="doc.l08", role="doctor")
    app = create_app(settings=auth_ops_settings)

    with (
        TestClient(app, raise_server_exceptions=False) as admin_setup,
        TestClient(app, raise_server_exceptions=False) as doc_setup,
    ):
        admin_tok, _ = _login(admin_setup, admin.username)
        _, doc_rt = _login(doc_setup, doctor.username)

    barrier = Barrier(2)

    def _do_refresh() -> int:
        with TestClient(app, raise_server_exceptions=False) as c:
            barrier.wait(timeout=5)
            return c.post("/api/v1/auth/refresh", cookies={"bts_refresh": doc_rt}).status_code

    def _do_disable() -> int:
        with TestClient(app, raise_server_exceptions=False) as c:
            barrier.wait(timeout=5)
            return c.patch(
                f"/api/v1/admin/users/{doctor.id}",
                headers={"Authorization": f"Bearer {admin_tok}"},
                json={"is_active": False},
            ).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        f_ref = pool.submit(_do_refresh)
        f_dis = pool.submit(_do_disable)
        ref_status = f_ref.result()
        dis_status = f_dis.result()

    assert dis_status == 200
    assert ref_status in {200, 401}

    auth_ops_db.expire_all()
    open_sess = auth_ops_db.scalars(
        select(AuthSession).where(
            AuthSession.user_id == doctor.id,
            AuthSession.revoked_at.is_(None),
        )
    ).all()
    open_rts = auth_ops_db.scalars(
        select(RefreshToken)
        .join(AuthSession, AuthSession.id == RefreshToken.session_id)
        .where(
            AuthSession.user_id == doctor.id,
            RefreshToken.revoked_at.is_(None),
        )
    ).all()
    assert open_sess == []
    assert open_rts == []

    # Verify expired LoginAttempt cleanup via run_orphan_cleanup
    now_dt = datetime.now(UTC)
    old_attempt = LoginAttempt(
        username="old.probe",
        ip_address="127.0.0.1",
        attempted_at=now_dt - timedelta(seconds=3600),
    )
    recent_attempt = LoginAttempt(
        username="recent.probe",
        ip_address="127.0.0.1",
        attempted_at=now_dt - timedelta(seconds=30),
    )
    auth_ops_db.add_all([old_attempt, recent_attempt])
    auth_ops_db.commit()

    storage = LocalStorageAdapter(auth_ops_settings.effective_storage_root)
    summary = run_orphan_cleanup(
        auth_ops_db,
        storage,
        max_age_seconds=86400,
        login_attempt_max_age_seconds=900,
        now=now_dt.timestamp(),
    )
    auth_ops_db.commit()
    assert summary["login_attempts_removed"] == 1
    remaining_usernames = set(auth_ops_db.scalars(select(LoginAttempt.username)).all())
    assert "old.probe" not in remaining_usernames
    assert "recent.probe" in remaining_usernames


def test_l09_admin_settings_hard_limits_readonly_models_workers_and_retry_cases(
    auth_ops_db: Session,
    auth_ops_settings: Settings,
    tmp_path: Path,
) -> None:
    admin = _seed_user(auth_ops_db, username="admin.l09", role="admin")
    doctor = _seed_user(auth_ops_db, username="doc.l09", role="doctor")
    app = create_app(settings=auth_ops_settings)

    with TestClient(app, raise_server_exceptions=False) as client:
        admin_tok, _ = _login(client, admin.username)
        hdr = {"Authorization": f"Bearer {admin_tok}"}

        # 1. GET /admin/models is strictly read-only (does not insert into model_versions)
        models_resp = client.get("/api/v1/admin/models", headers=hdr)
        assert models_resp.status_code == 200
        assert len(models_resp.json()) == 1
        assert models_resp.json()[0]["is_active"] is True
        assert models_resp.json()[0]["verified"] is True
        assert (
            int(auth_ops_db.scalar(select(func.count()).select_from(ModelVersion)) or 0) == 0
        )

        # 2. PATCH /admin/settings enforces server hard limits & doctor <= system quota
        cur = client.get("/api/v1/admin/settings", headers=hdr).json()
        base = {k: v for k, v in cur.items() if k != "updated_at"}

        over_doc = client.patch(
            "/api/v1/admin/settings",
            headers=hdr,
            json={**base, "default_doctor_quota_gib": 3},
        )
        assert over_doc.status_code == 422
        assert over_doc.json()["error"]["code"] == "validation_error"

        over_sys = client.patch(
            "/api/v1/admin/settings",
            headers=hdr,
            json={**base, "system_quota_gib": 25},
        )
        assert over_sys.status_code == 422

        doc_gt_sys = client.patch(
            "/api/v1/admin/settings",
            headers=hdr,
            json={**base, "default_doctor_quota_gib": 2, "system_quota_gib": 1},
        )
        assert doc_gt_sys.status_code == 422

        valid_upd = client.patch(
            "/api/v1/admin/settings",
            headers=hdr,
            json={
                **base,
                "max_upload_mib": 80,
                "max_decompressed_mib": 200,
                "default_doctor_quota_gib": 1,
                "system_quota_gib": 10,
            },
        )
        assert valid_upd.status_code == 200, valid_upd.text
        auth_ops_db.expire_all()
        doc_q_row = auth_ops_db.get(SystemSetting, "doctor_quota_bytes")
        sys_q_row = auth_ops_db.get(SystemSetting, "system_quota_bytes")
        assert doc_q_row is not None and doc_q_row.value_json["bytes"] == 1 * (1024**3)
        assert sys_q_row is not None and sys_q_row.value_json["bytes"] == 10 * (1024**3)

        # 3. list_workers handles naive timestamps and checks running state + online
        model = sync_active_model(auth_ops_db, auth_ops_settings)
        patient = Patient(
            owner_id=doctor.id,
            patient_code="L09-PAT-1",
            full_name="Patient L09",
            birth_year=1980,
            sex="male",
        )
        auth_ops_db.add(patient)
        auth_ops_db.flush()
        case = Case(
            patient_id=patient.id,
            owner_id=doctor.id,
            study_date=date.today(),
            readiness="ready",
            deleted_at=datetime.now(UTC),
        )
        auth_ops_db.add(case)
        auth_ops_db.flush()

        failed_job = InferenceJob(
            case_id=case.id,
            doctor_id=doctor.id,
            model_version_id=model.id,
            state="failed",
            stage="inference",
            error_code="inference_error",
        )
        running_job = InferenceJob(
            case_id=case.id,
            doctor_id=doctor.id,
            model_version_id=model.id,
            state="running",
            stage="inference",
        )
        auth_ops_db.add_all([failed_job, running_job])
        auth_ops_db.flush()

        naive_now = datetime.now(UTC).replace(tzinfo=None)
        auth_ops_db.add_all(
            [
                WorkerInstance(
                    worker_id="w-online-stale-job",
                    device_type="CPU",
                    model_version_id=model.id,
                    current_job_id=failed_job.id,
                    last_heartbeat_at=naive_now,
                ),
                WorkerInstance(
                    worker_id="w-offline-running-job",
                    device_type="CPU",
                    model_version_id=model.id,
                    current_job_id=running_job.id,
                    last_heartbeat_at=datetime.now(UTC) - timedelta(minutes=5),
                ),
                WorkerInstance(
                    worker_id="w-online-running-job",
                    device_type="GPU",
                    model_version_id=model.id,
                    current_job_id=running_job.id,
                    last_heartbeat_at=datetime.now(UTC),
                ),
            ]
        )
        auth_ops_db.commit()

        workers = {
            w["worker_id"]: w
            for w in client.get("/api/v1/admin/workers", headers=hdr).json()
        }
        assert workers["w-online-stale-job"]["online"] is True
        assert workers["w-online-stale-job"]["active_jobs"] == 0
        assert workers["w-offline-running-job"]["online"] is False
        assert workers["w-offline-running-job"]["active_jobs"] == 0
        assert workers["w-online-running-job"]["online"] is True
        assert workers["w-online-running-job"]["active_jobs"] == 1

        # 4. retry_failed_job distinguishes deleted case (409 retry_case_deleted)
        running_job.state = "cancelled"
        auth_ops_db.commit()
        r_del_case = client.post(f"/api/v1/admin/jobs/{failed_job.id}/retry", headers=hdr)
        assert r_del_case.status_code == 409
        assert r_del_case.json()["error"]["code"] == "retry_case_deleted"

    # 5. Unverified manifest on disk marks DB model inactive/unverified without mutating DB
    bad_manifest = tmp_path / "unverified_manifest.json"
    bad_manifest.write_text(json.dumps({"verification_status": "unverified"}), encoding="utf-8")
    bad_app = create_app(
        settings=auth_ops_settings.model_copy(update={"MODEL_MANIFEST_PATH": bad_manifest})
    )
    with TestClient(bad_app, raise_server_exceptions=False) as bad_client:
        bad_tok, _ = _login(bad_client, admin.username)
        bad_models = bad_client.get(
            "/api/v1/admin/models", headers={"Authorization": f"Bearer {bad_tok}"}
        ).json()
        assert len(bad_models) == 1
        assert bad_models[0]["is_active"] is False
        assert bad_models[0]["verified"] is False
