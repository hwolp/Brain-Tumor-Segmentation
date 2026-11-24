"""Integration tests for Admin Doctor Account management, RBAC boundaries, and bootstrap CLI."""

from __future__ import annotations

import io
import logging
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from argon2 import PasswordHasher
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session as OrmSession

from app.core.config import Settings
from app.core.logging import RedactingFilter, StructuredJsonFormatter
from app.main import create_app
from app.models import AuditEvent, Session, User

_TEST_HASHER = PasswordHasher()


def _seed_user(
    db_session: OrmSession,
    *,
    username: str,
    password: str,
    role: str,
    display_name: str,
    is_active: bool = True,
    must_change_password: bool = False,
) -> User:
    user = User(
        username=username,
        display_name=display_name,
        password_hash=_TEST_HASHER.hash(password),
        role=role,
        is_active=is_active,
        must_change_password=must_change_password,
        password_changed_at=None if must_change_password else datetime.now(UTC),
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


def _login(client: TestClient, username: str, password: str) -> str:
    res = client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": password},
    )
    assert res.status_code == 200, res.text
    return res.json()["access_token"]


def test_admin_and_doctor_role_boundaries(
    api_client: TestClient,
    db_session: OrmSession,
) -> None:
    admin_ok = _seed_user(
        db_session,
        username="admin.main",
        password="AdminPassword123!",
        role="admin",
        display_name="System Admin",
        must_change_password=False,
    )
    _seed_user(
        db_session,
        username="admin.forced",
        password="AdminPassword123!",
        role="admin",
        display_name="Admin Must Change",
        must_change_password=True,
    )
    _seed_user(
        db_session,
        username="dr.boundary",
        password="DoctorPassword123!",
        role="doctor",
        display_name="Doctor Boundary",
        must_change_password=False,
    )

    # Unauthenticated -> 401
    assert api_client.get("/api/v1/admin/users").status_code == 401
    assert api_client.get("/api/v1/doctor/profile").status_code == 401

    doctor_tok = _login(api_client, "dr.boundary", "DoctorPassword123!")
    admin_tok = _login(api_client, "admin.main", "AdminPassword123!")
    admin_forced_tok = _login(api_client, "admin.forced", "AdminPassword123!")

    # Doctor calling admin endpoint -> 403 forbidden
    r_doc_admin = api_client.get(
        "/api/v1/admin/users",
        headers={"Authorization": f"Bearer {doctor_tok}"},
    )
    assert r_doc_admin.status_code == 403
    assert r_doc_admin.json()["error"]["code"] == "forbidden"

    # Admin with must_change_password=True calling admin endpoint -> 403 password_change_required
    r_admin_forced = api_client.get(
        "/api/v1/admin/users",
        headers={"Authorization": f"Bearer {admin_forced_tok}"},
    )
    assert r_admin_forced.status_code == 403
    assert r_admin_forced.json()["error"]["code"] == "password_change_required"

    # QA-ACL-02: Admin calling doctor endpoint -> 403 forbidden
    r_admin_doc = api_client.get(
        "/api/v1/doctor/profile",
        headers={"Authorization": f"Bearer {admin_tok}"},
    )
    assert r_admin_doc.status_code == 403
    assert r_admin_doc.json()["error"]["code"] == "forbidden"

    # Active admin sees empty list of doctors (admins are excluded!)
    r_list = api_client.get(
        "/api/v1/admin/users",
        headers={"Authorization": f"Bearer {admin_tok}"},
    )
    assert r_list.status_code == 200
    body = r_list.json()
    assert body["total"] == 1
    assert [item["username"] for item in body["items"]] == ["dr.boundary"]
    assert all(item["id"] != str(admin_ok.id) for item in body["items"])


def test_admin_create_search_and_pagination_for_doctors(
    api_client: TestClient,
    db_session: OrmSession,
) -> None:
    _seed_user(
        db_session,
        username="admin.crud",
        password="AdminPassword123!",
        role="admin",
        display_name="Admin CRUD",
    )
    admin_tok = _login(api_client, "admin.crud", "AdminPassword123!")
    headers = {"Authorization": f"Bearer {admin_tok}"}

    created_ids: list[str] = []
    for idx, (uname, dname) in enumerate(
        [
            ("dr.alpha", "BS. Nguyen Van A"),
            ("dr.beta_100%", "BS. Tran Thi B"),
            ("dr.gamma", "BS. Le Van C"),
        ],
        start=1,
    ):
        # Wait: '%' is not valid in username regex; test valid usernames & display_name with '%'
        valid_uname = uname.replace("%", "")
        res = api_client.post(
            "/api/v1/admin/users",
            headers=headers,
            json={
                "username": valid_uname.upper(),
                "display_name": dname,
                "temporary_password": f"TempDoctorPw#{idx:04d}",
            },
        )
        assert res.status_code == 201, res.text
        data = res.json()
        assert data["username"] == valid_uname
        assert data["role"] == "doctor"
        assert data["is_active"] is True
        assert data["must_change_password"] is True
        assert "password_hash" not in data
        assert "temporary_password" not in data
        created_ids.append(data["id"])

    # Duplicate username (case-insensitive) -> 409 username_conflict
    dup_res = api_client.post(
        "/api/v1/admin/users",
        headers=headers,
        json={
            "username": "  DR.ALPHA ",
            "display_name": "Duplicate Doctor",
            "temporary_password": "AnotherValidTempPassword1",
        },
    )
    assert dup_res.status_code == 409
    assert dup_res.json()["error"]["code"] == "username_conflict"

    # Short password rejected -> 422
    weak_res = api_client.post(
        "/api/v1/admin/users",
        headers=headers,
        json={
            "username": "dr.weak",
            "display_name": "Weak Pw",
            "temporary_password": "short",
        },
    )
    assert weak_res.status_code == 422

    # Pagination & ordering (created_at desc, id desc)
    page1 = api_client.get("/api/v1/admin/users?page=1&page_size=2", headers=headers)
    assert page1.status_code == 200
    assert page1.json()["total"] == 3
    assert len(page1.json()["items"]) == 2
    assert page1.json()["page"] == 1
    assert page1.json()["page_size"] == 2
    assert [item["username"] for item in page1.json()["items"]] == ["dr.gamma", "dr.beta_100"]

    page2 = api_client.get("/api/v1/admin/users?page=2&page_size=2", headers=headers)
    assert page2.status_code == 200
    assert len(page2.json()["items"]) == 1
    assert page2.json()["items"][0]["username"] == "dr.alpha"

    # is_active filter & contradictory status+is_active
    active_only = api_client.get("/api/v1/admin/users?is_active=true", headers=headers)
    assert active_only.status_code == 200
    assert active_only.json()["total"] == 3

    contradictory = api_client.get(
        "/api/v1/admin/users?status=active&is_active=false",
        headers=headers,
    )
    assert contradictory.status_code == 200
    assert contradictory.json()["total"] == 0
    assert contradictory.json()["items"] == []

    # Search q escaping LIKE wildcards
    search_res = api_client.get("/api/v1/admin/users?q=Tran Thi B", headers=headers)
    assert search_res.status_code == 200
    assert search_res.json()["total"] == 1
    assert search_res.json()["items"][0]["username"] == "dr.beta_100"

    wildcard_res = api_client.get("/api/v1/admin/users?q=%", headers=headers)
    assert wildcard_res.status_code == 200
    assert wildcard_res.json()["total"] == 0


def test_qa_auth_04_admin_disable_doctor_revokes_sessions_and_protects_admin_targets(
    test_settings: Settings,
    db_session: OrmSession,
) -> None:
    admin = _seed_user(
        db_session,
        username="admin.lock",
        password="AdminPassword123!",
        role="admin",
        display_name="Admin Lock",
    )
    doctor = _seed_user(
        db_session,
        username="dr.target",
        password="DoctorPassword123!",
        role="doctor",
        display_name="Dr. Target",
    )

    app = create_app(settings=test_settings)
    with (
        TestClient(app, raise_server_exceptions=False) as admin_client,
        TestClient(app, raise_server_exceptions=False) as doc_client,
    ):
        admin_tok = _login(admin_client, "admin.lock", "AdminPassword123!")
        doc_tok = _login(doc_client, "dr.target", "DoctorPassword123!")
        doc_refresh = doc_client.cookies.get("bts_refresh")
        assert doc_refresh is not None

        # Doctor currently accesses profile
        assert (
            doc_client.get(
                "/api/v1/doctor/profile",
                headers={"Authorization": f"Bearer {doc_tok}"},
            ).status_code
            == 200
        )

        # Admin patches display_name & disables doctor
        patch_res = admin_client.patch(
            f"/api/v1/admin/users/{doctor.id}",
            headers={"Authorization": f"Bearer {admin_tok}"},
            json={"display_name": "Dr. Locked", "is_active": False},
        )
        assert patch_res.status_code == 200
        assert patch_res.json()["display_name"] == "Dr. Locked"
        assert patch_res.json()["is_active"] is False

        # QA-AUTH-04: Doctor's existing access token and refresh cookie fail immediately
        r_doc_after = doc_client.get(
            "/api/v1/doctor/profile",
            headers={"Authorization": f"Bearer {doc_tok}"},
        )
        assert r_doc_after.status_code == 401
        assert r_doc_after.json()["error"]["code"] == "account_disabled"

        r_doc_refresh = doc_client.post(
            "/api/v1/auth/refresh",
            headers={"Cookie": f"bts_refresh={doc_refresh}"},
        )
        assert r_doc_refresh.status_code == 401
        assert r_doc_refresh.json()["error"]["code"] == "account_disabled"

        # Status filter in list
        locked_list = admin_client.get(
            "/api/v1/admin/users?status=locked",
            headers={"Authorization": f"Bearer {admin_tok}"},
        )
        assert locked_list.status_code == 200
        assert locked_list.json()["total"] == 1

        # Re-enable doctor -> can log in again
        enable_res = admin_client.patch(
            f"/api/v1/admin/users/{doctor.id}",
            headers={"Authorization": f"Bearer {admin_tok}"},
            json={"is_active": True},
        )
        assert enable_res.status_code == 200
        assert enable_res.json()["is_active"] is True
        assert _login(doc_client, "dr.target", "DoctorPassword123!")

        # Cannot patch an admin account -> 403 forbidden
        patch_admin = admin_client.patch(
            f"/api/v1/admin/users/{admin.id}",
            headers={"Authorization": f"Bearer {admin_tok}"},
            json={"is_active": False},
        )
        assert patch_admin.status_code == 403
        assert patch_admin.json()["error"]["code"] == "forbidden"

        # Non-existent target -> 404 not_found
        patch_missing = admin_client.patch(
            f"/api/v1/admin/users/{uuid.uuid4()}",
            headers={"Authorization": f"Bearer {admin_tok}"},
            json={"is_active": False},
        )
        assert patch_missing.status_code == 404


def test_admin_reset_password_forces_change_revokes_sessions_and_never_logs_secret(
    test_settings: Settings,
    db_session: OrmSession,
) -> None:
    admin = _seed_user(
        db_session,
        username="admin.reset",
        password="AdminPassword123!",
        role="admin",
        display_name="Admin Reset",
    )
    doctor = _seed_user(
        db_session,
        username="dr.reset",
        password="OldDoctorPassword1!",
        role="doctor",
        display_name="Dr. Reset",
    )

    app = create_app(settings=test_settings)
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.addFilter(RedactingFilter())
    handler.setFormatter(StructuredJsonFormatter())
    root = logging.getLogger()
    root.addHandler(handler)

    try:
        with (
            TestClient(app, raise_server_exceptions=False) as admin_client,
            TestClient(app, raise_server_exceptions=False) as doc_client,
        ):
            admin_tok = _login(admin_client, "admin.reset", "AdminPassword123!")
            old_doc_tok = _login(doc_client, "dr.reset", "OldDoctorPassword1!")

            reset_res = admin_client.post(
                f"/api/v1/admin/users/{doctor.id}/reset-password",
                headers={"Authorization": f"Bearer {admin_tok}"},
            )
            assert reset_res.status_code == 200
            assert reset_res.headers.get("Cache-Control") == "no-store"
            temp_pw = reset_res.json()["temporary_password"]
            assert len(temp_pw) >= 16

            # Old token invalidated immediately
            assert (
                doc_client.get(
                    "/api/v1/auth/me",
                    headers={"Authorization": f"Bearer {old_doc_tok}"},
                ).status_code
                == 401
            )

            # Login with temp_pw -> must_change_password=True
            new_login = doc_client.post(
                "/api/v1/auth/login",
                json={"username": "dr.reset", "password": temp_pw},
            )
            assert new_login.status_code == 200
            assert new_login.json()["user"]["must_change_password"] is True

            # Resetting an admin -> 403 forbidden
            reset_admin = admin_client.post(
                f"/api/v1/admin/users/{admin.id}/reset-password",
                headers={"Authorization": f"Bearer {admin_tok}"},
            )
            assert reset_admin.status_code == 403

            # Resetting non-existent user -> 404 not_found
            reset_missing = admin_client.post(
                f"/api/v1/admin/users/{uuid.uuid4()}/reset-password",
                headers={"Authorization": f"Bearer {admin_tok}"},
            )
            assert reset_missing.status_code == 404
    finally:
        root.removeHandler(handler)

    # Audit event & logs must never contain temp_pw
    audit = db_session.scalar(
        select(AuditEvent).where(
            AuditEvent.action == "admin.user_reset_password",
            AuditEvent.resource_id == str(doctor.id),
        )
    )
    assert audit is not None
    assert temp_pw not in str(audit.safe_diff or {})
    assert temp_pw not in stream.getvalue()


def test_bootstrap_admin_cli_creates_and_resets_admin_interactively(
    test_settings: Settings,
    db_session: OrmSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from scripts import bootstrap_admin

    assert test_settings.DATABASE_URL is not None
    monkeypatch.setenv("DATABASE_URL", test_settings.DATABASE_URL)

    # Ensure --password CLI arg is NOT accepted
    with pytest.raises(SystemExit) as exc_help:
        bootstrap_admin.main(["--username", "admin.cli", "--password", "UnsafeCliArg123"])
    assert exc_help.value.code != 0

    prompts = iter(["AdminSecretPass 123", "AdminSecretPass 123"])
    monkeypatch.setattr("getpass.getpass", lambda _prompt="": next(prompts))

    rc = bootstrap_admin.main(["--username", "admin.cli", "--display-name", "CLI Admin"])
    assert rc == 0

    created = db_session.scalar(select(User).where(User.username == "admin.cli"))
    assert created is not None
    assert created.role == "admin"
    assert created.is_active is True
    assert created.must_change_password is False

    audit_create = db_session.scalar(
        select(AuditEvent).where(
            AuditEvent.actor_type == "system",
            AuditEvent.resource_id == str(created.id),
        )
    )
    assert audit_create is not None

    # Create a session for admin.cli, then test --reset revokes it
    sess = Session(
        user_id=created.id,
        expires_at=datetime.now(UTC) + timedelta(days=1),
    )
    db_session.add(sess)
    db_session.commit()

    # Without --reset fails cleanly
    prompts_dup = iter(["ResetAdminPass 456", "ResetAdminPass 456"])
    monkeypatch.setattr("getpass.getpass", lambda _prompt="": next(prompts_dup))
    rc_dup = bootstrap_admin.main(["--username", "admin.cli", "--display-name", "CLI Admin"])
    assert rc_dup != 0

    prompts_reset = iter(["ResetAdminPass 456", "ResetAdminPass 456"])
    monkeypatch.setattr("getpass.getpass", lambda _prompt="": next(prompts_reset))
    rc_reset = bootstrap_admin.main(["--username", "admin.cli", "--reset"])
    assert rc_reset == 0

    db_session.expire_all()
    revoked_sess = db_session.scalar(select(Session).where(Session.id == sess.id))
    assert revoked_sess is not None and revoked_sess.revoked_at is not None

    # Confirm login works with new reset password
    app = create_app(settings=test_settings)
    with TestClient(app, raise_server_exceptions=False) as client:
        assert _login(client, "admin.cli", "ResetAdminPass 456")
