"""Integration tests for P2 Auth, RS256 JWT, JWKS, Refresh Rotation, CSRF, and Rate Limits."""

from __future__ import annotations

import logging
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from http.cookies import SimpleCookie
from pathlib import Path

import jwt
from argon2 import PasswordHasher
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session as OrmSession

from app.core.config import Settings
from app.core.logging import RedactingFilter, StructuredJsonFormatter
from app.main import create_app
from app.models import AuditEvent, RefreshToken, Session, User

_TEST_HASHER = PasswordHasher()


def _seed_user(
    db_session: OrmSession,
    *,
    username: str,
    password: str,
    role: str = "doctor",
    display_name: str = "Dr. Test User",
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


def _extract_set_cookie_attrs(headers_list: list[tuple[str, str]], cookie_name: str) -> str | None:
    for name, value in headers_list:
        if name.lower() == "set-cookie" and value.startswith(f"{cookie_name}="):
            return value
    return None


def test_jwks_endpoint_returns_public_key_for_token_verification(
    api_client: TestClient,
    db_session: OrmSession,
) -> None:
    _seed_user(db_session, username="dr.jwks", password="PasswordWith12Chars!")
    jwks_res = api_client.get("/.well-known/jwks.json")
    assert jwks_res.status_code == 200
    body = jwks_res.json()
    assert "keys" in body and len(body["keys"]) == 1
    jwk_entry = body["keys"][0]
    assert jwk_entry["kty"] == "RSA"
    assert jwk_entry["use"] == "sig"
    assert jwk_entry["alg"] == "RS256"
    assert jwk_entry["kid"] == "test-rs256-v1"

    login_res = api_client.post(
        "/api/v1/auth/login",
        json={"username": "dr.jwks", "password": "PasswordWith12Chars!"},
    )
    assert login_res.status_code == 200
    access_token = login_res.json()["access_token"]

    pub_key = jwt.PyJWK(jwk_entry).key
    claims = jwt.decode(
        access_token,
        pub_key,
        algorithms=["RS256"],
        issuer="brain-tumor-api",
        audience="brain-tumor-web",
    )
    assert set(claims.keys()) == {"sub", "sid", "role", "iat", "exp", "iss", "aud"}


def test_login_success_normalizes_username_preserves_password_spaces_and_cookie_flags(
    api_client: TestClient,
    db_session: OrmSession,
) -> None:
    spaced_pw = "  SecretPassWithSpaces  "
    user = _seed_user(
        db_session,
        username="dr.nguyen",
        password=spaced_pw,
        role="doctor",
        display_name="BS. Nguyen",
    )

    # Trimmed password must fail even though username has mixed case/whitespace
    bad_res = api_client.post(
        "/api/v1/auth/login",
        json={"username": "  DR.Nguyen ", "password": spaced_pw.strip()},
    )
    assert bad_res.status_code == 401
    assert bad_res.json()["error"]["code"] == "login_failed"

    res = api_client.post(
        "/api/v1/auth/login",
        json={"username": "  DR.Nguyen ", "password": spaced_pw},
    )
    assert res.status_code == 200
    assert res.headers.get("Cache-Control") == "no-store"

    payload = res.json()
    assert payload["token_type"] == "bearer"
    assert payload["expires_in"] == 900
    assert payload["user"]["id"] == str(user.id)
    assert payload["user"]["username"] == "dr.nguyen"
    assert payload["user"]["role"] == "doctor"

    set_cookie = _extract_set_cookie_attrs(list(res.headers.raw), "bts_refresh")
    if set_cookie is None:
        # Fallback for Starlette Headers string representation
        set_cookie = res.headers.get("set-cookie")
    assert set_cookie is not None
    parsed = SimpleCookie()
    parsed.load(set_cookie)
    morsel = parsed["bts_refresh"]
    assert morsel["httponly"] is True
    assert morsel["samesite"].lower() == "lax"
    assert morsel["path"] == "/api/v1/auth"
    assert morsel["domain"] == ""
    assert int(morsel["max-age"]) in range(7 * 86400 - 30, 7 * 86400 + 1)

    # Audit event recorded
    audit = db_session.scalar(
        select(AuditEvent).where(
            AuditEvent.action == "auth.login",
            AuditEvent.outcome == "success",
            AuditEvent.actor_id == user.id,
        )
    )
    assert audit is not None


def test_login_anti_enumeration_for_unknown_wrong_pw_and_disabled_user(
    api_client: TestClient,
    db_session: OrmSession,
) -> None:
    _seed_user(db_session, username="dr.active", password="ValidPassword123")
    _seed_user(db_session, username="dr.locked", password="ValidPassword123", is_active=False)

    res_unknown = api_client.post(
        "/api/v1/auth/login",
        json={"username": "no.such.user", "password": "ValidPassword123"},
    )
    res_wrong_pw = api_client.post(
        "/api/v1/auth/login",
        json={"username": "dr.active", "password": "WrongPassword123"},
    )
    res_disabled = api_client.post(
        "/api/v1/auth/login",
        json={"username": "dr.locked", "password": "ValidPassword123"},
    )

    for res in (res_unknown, res_wrong_pw, res_disabled):
        assert res.status_code == 401
        err = res.json()["error"]
        assert err["code"] == "login_failed"
        assert err["message"] == res_unknown.json()["error"]["message"]


def test_login_rate_limit_persists_in_postgres_and_returns_retry_after(
    test_settings: Settings,
    db_session: OrmSession,
) -> None:
    _seed_user(db_session, username="dr.ratelimit", password="ValidPassword123")

    app1 = create_app(settings=test_settings)
    with TestClient(app1, raise_server_exceptions=False) as client1:
        for _ in range(5):
            r = client1.post(
                "/api/v1/auth/login",
                json={"username": "dr.ratelimit", "password": "WrongPassword99"},
            )
            assert r.status_code == 401

    # Re-create a brand new FastAPI app to confirm rate limit is persisted in PostgreSQL
    app2 = create_app(settings=test_settings)
    with TestClient(app2, raise_server_exceptions=False) as client2:
        blocked = client2.post(
            "/api/v1/auth/login",
            json={"username": "dr.ratelimit", "password": "ValidPassword123"},
        )
        assert blocked.status_code == 429
        assert blocked.json()["error"]["code"] == "rate_limit_exceeded"
        retry_after = blocked.headers.get("Retry-After")
        assert retry_after is not None and 1 <= int(retry_after) <= 900

        # IP-wide limit (30 failures across distinct usernames)
        # Currently 5 attempts recorded for IP; add 25 more across distinct usernames
        for idx in range(25):
            r = client2.post(
                "/api/v1/auth/login",
                json={"username": f"user.probe.{idx}", "password": "WrongPassword99"},
            )
            assert r.status_code == 401

        ip_blocked = client2.post(
            "/api/v1/auth/login",
            json={"username": "fresh.username", "password": "ValidPassword123"},
        )
        assert ip_blocked.status_code == 429
        assert ip_blocked.json()["error"]["code"] == "rate_limit_exceeded"
        assert int(ip_blocked.headers["Retry-After"]) >= 1


def test_csrf_origin_and_sec_fetch_site_rejected_on_auth_endpoints(
    api_client: TestClient,
    db_session: OrmSession,
) -> None:
    _seed_user(db_session, username="dr.csrf", password="ValidPassword123")

    for path in ("/api/v1/auth/login", "/api/v1/auth/refresh", "/api/v1/auth/logout"):
        login_payload = (
            {"username": "dr.csrf", "password": "ValidPassword123"} if "login" in path else None
        )
        bad_origin = api_client.post(
            path,
            headers={"Origin": "https://evil.example"},
            json=login_payload,
        )
        assert bad_origin.status_code == 403
        assert bad_origin.json()["error"]["code"] == "csrf_origin_denied"

        cross_site = api_client.post(
            path,
            headers={"Origin": "http://127.0.0.1:5173", "Sec-Fetch-Site": "cross-site"},
            json=login_payload,
        )
        assert cross_site.status_code == 403
        assert cross_site.json()["error"]["code"] == "csrf_origin_denied"

    ok_login = api_client.post(
        "/api/v1/auth/login",
        headers={"Origin": "http://127.0.0.1:5173", "Sec-Fetch-Site": "same-origin"},
        json={"username": "dr.csrf", "password": "ValidPassword123"},
    )
    assert ok_login.status_code == 200


def test_qa_auth_01_protected_endpoint_rejects_bad_bearer_tokens_with_distinct_codes(
    api_client: TestClient,
    test_settings: Settings,
    db_session: OrmSession,
) -> None:
    user = _seed_user(db_session, username="dr.jwt", password="ValidPassword123")
    login_res = api_client.post(
        "/api/v1/auth/login",
        json={"username": "dr.jwt", "password": "ValidPassword123"},
    )
    assert login_res.status_code == 200
    valid_token = login_res.json()["access_token"]
    valid_claims = jwt.decode(
        valid_token,
        options={"verify_signature": False},
    )

    # 1. Missing token
    r_missing = api_client.get("/api/v1/auth/me")
    assert r_missing.status_code == 401
    assert r_missing.json()["error"]["code"] == "unauthenticated"

    assert test_settings.JWT_PRIVATE_KEY_PATH is not None
    priv_key = serialization.load_pem_private_key(
        test_settings.JWT_PRIVATE_KEY_PATH.read_bytes(), password=None
    )

    # 2. Expired token (>30s past exp)
    exp_claims = {
        **valid_claims,
        "iat": int((datetime.now(UTC) - timedelta(minutes=20)).timestamp()),
        "exp": int((datetime.now(UTC) - timedelta(seconds=60)).timestamp()),
    }
    expired_tok = jwt.encode(
        exp_claims, priv_key, algorithm="RS256", headers={"kid": test_settings.JWT_KEY_ID}
    )
    r_exp = api_client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {expired_tok}"})
    assert r_exp.status_code == 401
    assert r_exp.json()["error"]["code"] == "token_expired"

    # 3. Bad signature (different RSA key)
    other_priv = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    bad_sig_tok = jwt.encode(
        valid_claims, other_priv, algorithm="RS256", headers={"kid": test_settings.JWT_KEY_ID}
    )
    r_sig = api_client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {bad_sig_tok}"})
    assert r_sig.status_code == 401
    assert r_sig.json()["error"]["code"] == "invalid_signature"

    # 4. alg=HS256 and alg=none
    hs_tok = jwt.encode(
        valid_claims,
        "shared-hmac-secret-at-least-32-bytes!",
        algorithm="HS256",
        headers={"kid": test_settings.JWT_KEY_ID},
    )
    r_hs = api_client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {hs_tok}"})
    assert r_hs.status_code == 401
    assert r_hs.json()["error"]["code"] == "invalid_token_alg"

    none_tok = jwt.encode(
        valid_claims, "", algorithm="none", headers={"kid": test_settings.JWT_KEY_ID}
    )
    r_none = api_client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {none_tok}"})
    assert r_none.status_code == 401
    assert r_none.json()["error"]["code"] == "invalid_token_alg"

    # 5. Wrong iss
    wrong_iss_tok = jwt.encode(
        {**valid_claims, "iss": "other-api"},
        priv_key,
        algorithm="RS256",
        headers={"kid": test_settings.JWT_KEY_ID},
    )
    r_iss = api_client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {wrong_iss_tok}"})
    assert r_iss.status_code == 401
    assert r_iss.json()["error"]["code"] == "invalid_issuer"

    # 6. Wrong aud
    wrong_aud_tok = jwt.encode(
        {**valid_claims, "aud": "other-web"},
        priv_key,
        algorithm="RS256",
        headers={"kid": test_settings.JWT_KEY_ID},
    )
    r_aud = api_client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {wrong_aud_tok}"})
    assert r_aud.status_code == 401
    assert r_aud.json()["error"]["code"] == "invalid_audience"

    # 7. Unknown kid
    bad_kid_tok = jwt.encode(
        valid_claims, priv_key, algorithm="RS256", headers={"kid": "unknown-kid-v9"}
    )
    r_kid = api_client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {bad_kid_tok}"})
    assert r_kid.status_code == 401
    assert r_kid.json()["error"]["code"] == "unknown_kid"

    assert user.id == uuid.UUID(valid_claims["sub"])


def test_qa_auth_02_refresh_rotation_reuse_revokes_only_target_family(
    test_settings: Settings,
    db_session: OrmSession,
) -> None:
    user = _seed_user(db_session, username="dr.rotate", password="ValidPassword123")
    app = create_app(settings=test_settings)

    with (
        TestClient(app, raise_server_exceptions=False) as client_a,
        TestClient(app, raise_server_exceptions=False) as client_b,
    ):
        # Missing refresh cookie -> 401 unauthenticated
        r_no_cookie = client_a.post("/api/v1/auth/refresh")
        assert r_no_cookie.status_code == 401
        assert r_no_cookie.json()["error"]["code"] == "unauthenticated"

        # Login on client A (family A) and client B (family B)
        login_a = client_a.post(
            "/api/v1/auth/login",
            json={"username": "dr.rotate", "password": "ValidPassword123"},
        )
        login_b = client_b.post(
            "/api/v1/auth/login",
            json={"username": "dr.rotate", "password": "ValidPassword123"},
        )
        assert login_a.status_code == 200 and login_b.status_code == 200
        cookie_a1 = client_a.cookies.get("bts_refresh")
        assert cookie_a1 is not None

        # Rotate family A once -> succeeds and issues 1 successor
        rot_a = client_a.post("/api/v1/auth/refresh")
        assert rot_a.status_code == 200
        access_a2 = rot_a.json()["access_token"]
        cookie_a2 = client_a.cookies.get("bts_refresh")
        assert cookie_a2 is not None and cookie_a2 != cookie_a1

        # Replay old token cookie_a1 -> revokes entire family A
        replay_res = client_a.post(
            "/api/v1/auth/refresh",
            headers={"Cookie": f"bts_refresh={cookie_a1}"},
        )
        assert replay_res.status_code == 401
        assert replay_res.json()["error"]["code"] == "refresh_reused"

        # New token cookie_a2 and access_a2 from compromised family A must now fail
        r_a2_refresh = client_a.post(
            "/api/v1/auth/refresh",
            headers={"Cookie": f"bts_refresh={cookie_a2}"},
        )
        assert r_a2_refresh.status_code == 401
        assert r_a2_refresh.json()["error"]["code"] == "refresh_reused"

        r_a2_me = client_a.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {access_a2}"},
        )
        assert r_a2_me.status_code == 401

        # Family B must remain completely unaffected!
        r_b_me = client_b.get(
            "/api/v1/auth/me",
            headers={"Authorization": f"Bearer {login_b.json()['access_token']}"},
        )
        assert r_b_me.status_code == 200
        r_b_rot = client_b.post("/api/v1/auth/refresh")
        assert r_b_rot.status_code == 200

    db_session.expire_all()
    sessions = db_session.scalars(
        select(Session).where(Session.user_id == user.id).order_by(Session.created_at)
    ).all()
    assert len(sessions) == 2
    revoked_sessions = [s for s in sessions if s.revoked_at is not None]
    active_sessions = [s for s in sessions if s.revoked_at is None]
    assert len(revoked_sessions) == 1
    assert revoked_sessions[0].revoke_reason == "refresh_reused"
    assert len(active_sessions) == 1


def test_qa_auth_02_concurrent_refresh_race_on_real_postgres(
    test_settings: Settings,
    db_session: OrmSession,
) -> None:
    user = _seed_user(db_session, username="dr.race", password="ValidPassword123")
    app = create_app(settings=test_settings)

    with TestClient(app, raise_server_exceptions=False) as login_client:
        login_res = login_client.post(
            "/api/v1/auth/login",
            json={"username": "dr.race", "password": "ValidPassword123"},
        )
        assert login_res.status_code == 200
        shared_cookie = login_client.cookies.get("bts_refresh")
        assert shared_cookie is not None

    barrier = threading.Barrier(2)

    def _attempt_refresh() -> tuple[int, str | None, str | None]:
        with TestClient(app, raise_server_exceptions=False) as worker_client:
            barrier.wait(timeout=5)
            resp = worker_client.post(
                "/api/v1/auth/refresh",
                headers={"Cookie": f"bts_refresh={shared_cookie}"},
            )
            err_code = None if resp.status_code == 200 else resp.json()["error"]["code"]
            new_cookie = (
                worker_client.cookies.get("bts_refresh") if resp.status_code == 200 else None
            )
            return resp.status_code, err_code, new_cookie

    with ThreadPoolExecutor(max_workers=2) as pool:
        fut1 = pool.submit(_attempt_refresh)
        fut2 = pool.submit(_attempt_refresh)
        results = [fut1.result(), fut2.result()]

    statuses = sorted(r[0] for r in results)
    assert statuses == [200, 401]
    failed = [r for r in results if r[0] == 401][0]
    succeeded = [r for r in results if r[0] == 200][0]
    assert failed[1] == "refresh_reused"

    # Family is now revoked due to reuse detection; even the winning successor cannot refresh again
    assert succeeded[2] is not None
    with TestClient(app, raise_server_exceptions=False) as check_client:
        post_race = check_client.post(
            "/api/v1/auth/refresh",
            headers={"Cookie": f"bts_refresh={succeeded[2]}"},
        )
        assert post_race.status_code == 401

    db_session.expire_all()
    sess = db_session.scalar(select(Session).where(Session.user_id == user.id))
    assert sess is not None
    assert sess.revoked_at is not None
    assert sess.revoke_reason == "refresh_reused"
    tokens = db_session.scalars(
        select(RefreshToken).where(RefreshToken.session_id == sess.id)
    ).all()
    assert len(tokens) == 2


def test_logout_is_idempotent_and_revokes_session(
    api_client: TestClient,
    db_session: OrmSession,
) -> None:
    _seed_user(db_session, username="dr.logout", password="ValidPassword123")
    login_res = api_client.post(
        "/api/v1/auth/login",
        json={"username": "dr.logout", "password": "ValidPassword123"},
    )
    assert login_res.status_code == 200
    access_token = login_res.json()["access_token"]
    refresh_cookie = api_client.cookies.get("bts_refresh")
    assert refresh_cookie is not None

    logout1 = api_client.post(
        "/api/v1/auth/logout",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    assert logout1.status_code == 204

    # Idempotent second logout without cookie/token
    logout2 = api_client.post("/api/v1/auth/logout")
    assert logout2.status_code == 204

    # Old access token & refresh cookie are both rejected
    me_res = api_client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {access_token}"},
    )
    assert me_res.status_code == 401

    refresh_res = api_client.post(
        "/api/v1/auth/refresh",
        headers={"Cookie": f"bts_refresh={refresh_cookie}"},
    )
    assert refresh_res.status_code == 401


def test_must_change_password_gates_and_change_password_revokes_all_sessions(
    test_settings: Settings,
    db_session: OrmSession,
) -> None:
    temp_pw = "TempPassword123!"
    new_pw = "  NewDoctorPassword 2026  "
    _seed_user(
        db_session,
        username="dr.temp",
        password=temp_pw,
        role="doctor",
        must_change_password=True,
    )
    app = create_app(settings=test_settings)

    with (
        TestClient(app, raise_server_exceptions=False) as client_one,
        TestClient(app, raise_server_exceptions=False) as client_two,
    ):
        login1 = client_one.post(
            "/api/v1/auth/login",
            json={"username": "dr.temp", "password": temp_pw},
        )
        login2 = client_two.post(
            "/api/v1/auth/login",
            json={"username": "dr.temp", "password": temp_pw},
        )
        assert login1.status_code == 200 and login2.status_code == 200
        tok1 = login1.json()["access_token"]
        tok2 = login2.json()["access_token"]

        # Allowed while must_change_password=True: /auth/me
        me_res = client_one.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {tok1}"})
        assert me_res.status_code == 200
        assert me_res.json()["must_change_password"] is True

        # Blocked on business endpoint
        prof_blocked = client_one.get(
            "/api/v1/doctor/profile",
            headers={"Authorization": f"Bearer {tok1}"},
        )
        assert prof_blocked.status_code == 403
        assert prof_blocked.json()["error"]["code"] == "password_change_required"

        # Wrong current password rejected
        wrong_cp = client_one.post(
            "/api/v1/auth/change-password",
            headers={"Authorization": f"Bearer {tok1}"},
            json={"current_password": "WrongCurrentPassword1", "new_password": new_pw},
        )
        assert wrong_cp.status_code == 400
        assert wrong_cp.json()["error"]["code"] == "invalid_credentials"

        # Same password rejected
        same_cp = client_one.post(
            "/api/v1/auth/change-password",
            headers={"Authorization": f"Bearer {tok1}"},
            json={"current_password": temp_pw, "new_password": temp_pw},
        )
        assert same_cp.status_code == 422

        # Valid password change succeeds (204) and revokes ALL sessions
        ok_cp = client_one.post(
            "/api/v1/auth/change-password",
            headers={"Authorization": f"Bearer {tok1}"},
            json={"current_password": temp_pw, "new_password": new_pw},
        )
        assert ok_cp.status_code == 204

        assert (
            client_one.get(
                "/api/v1/auth/me", headers={"Authorization": f"Bearer {tok1}"}
            ).status_code
            == 401
        )
        assert (
            client_two.get(
                "/api/v1/auth/me", headers={"Authorization": f"Bearer {tok2}"}
            ).status_code
            == 401
        )

        # New login with preserved spaces works and unlocks /doctor/profile
        new_login = client_one.post(
            "/api/v1/auth/login",
            json={"username": "dr.temp", "password": new_pw},
        )
        assert new_login.status_code == 200
        assert new_login.json()["user"]["must_change_password"] is False
        new_tok = new_login.json()["access_token"]

        prof_ok = client_one.get(
            "/api/v1/doctor/profile",
            headers={"Authorization": f"Bearer {new_tok}"},
        )
        assert prof_ok.status_code == 200
        assert prof_ok.json()["username"] == "dr.temp"


def test_auth_flows_never_log_passwords_or_tokens(
    api_client: TestClient,
    db_session: OrmSession,
) -> None:
    import io

    secret_pw = "SuperSecretPassword#99"
    _seed_user(db_session, username="dr.nolog", password=secret_pw)

    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.addFilter(RedactingFilter())
    handler.setFormatter(StructuredJsonFormatter())
    root = logging.getLogger()
    root.addHandler(handler)
    try:
        login_res = api_client.post(
            "/api/v1/auth/login",
            json={"username": "dr.nolog", "password": secret_pw},
        )
        assert login_res.status_code == 200
        access_tok = login_res.json()["access_token"]
        refresh_tok = api_client.cookies.get("bts_refresh") or ""

        api_client.post("/api/v1/auth/refresh")
        api_client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {access_tok}"})
    finally:
        root.removeHandler(handler)

    logged_output = stream.getvalue()
    assert secret_pw not in logged_output
    assert access_tok not in logged_output
    if refresh_tok:
        assert refresh_tok not in logged_output


def test_refresh_fixed_expiry_never_extends_session_and_rejects_expired_and_unknown_tokens(
    api_client: TestClient,
    db_session: OrmSession,
) -> None:
    user = _seed_user(db_session, username="dr.expiry", password="ValidPassword123")
    login_res = api_client.post(
        "/api/v1/auth/login",
        json={"username": "dr.expiry", "password": "ValidPassword123"},
    )
    assert login_res.status_code == 200
    me_res = api_client.get(
        "/api/v1/auth/me",
        headers={"Authorization": f"Bearer {login_res.json()['access_token']}"},
    )
    assert me_res.status_code == 200
    assert me_res.json()["created_at"].endswith("Z")

    # Shrink session expiry to 90s from now; verify rotation preserves Max-Age <= 90s
    sess = db_session.scalar(select(Session).where(Session.user_id == user.id))
    assert sess is not None
    near_expiry = datetime.now(UTC) + timedelta(seconds=90)
    sess.expires_at = near_expiry
    db_session.commit()

    rot = api_client.post("/api/v1/auth/refresh")
    assert rot.status_code == 200
    set_cookie = rot.headers.get("set-cookie")
    assert set_cookie is not None
    parsed = SimpleCookie()
    parsed.load(set_cookie)
    assert 1 <= int(parsed["bts_refresh"]["max-age"]) <= 90

    # Expire session in DB -> refresh fails 401 token_expired
    sess.expires_at = datetime.now(UTC) - timedelta(seconds=5)
    db_session.commit()
    expired_rot = api_client.post("/api/v1/auth/refresh")
    assert expired_rot.status_code == 401
    assert expired_rot.json()["error"]["code"] == "token_expired"

    # Unknown refresh cookie -> 401 invalid_token
    unknown_rot = api_client.post(
        "/api/v1/auth/refresh",
        headers={"Cookie": "bts_refresh=totally-unknown-opaque-cookie-value"},
    )
    assert unknown_rot.status_code == 401
    assert unknown_rot.json()["error"]["code"] == "invalid_token"


def test_must_change_password_allows_logout_and_bearer_only_logout_works(
    api_client: TestClient,
    db_session: OrmSession,
) -> None:
    _seed_user(
        db_session,
        username="dr.forcedlogout",
        password="TempPassword123!",
        must_change_password=True,
    )
    login_res = api_client.post(
        "/api/v1/auth/login",
        json={"username": "dr.forcedlogout", "password": "TempPassword123!"},
    )
    assert login_res.status_code == 200
    tok = login_res.json()["access_token"]

    # Clear cookie jar on client so logout uses Bearer token ONLY
    api_client.cookies.clear()
    logout_res = api_client.post(
        "/api/v1/auth/logout",
        headers={"Authorization": f"Bearer {tok}"},
    )
    assert logout_res.status_code == 204
    assert (
        api_client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {tok}"}).status_code
        == 401
    )


def test_unconfigured_jwt_keys_in_local_mode_returns_clear_503_on_auth(
    ensure_postgres_ready: str,
    isolated_storage_root: Path,
) -> None:
    local_settings = Settings(
        _env_file=None,
        APP_ENV="local",
        DATABASE_URL=ensure_postgres_ready,
        STORAGE_ROOT=isolated_storage_root,
    )
    app = create_app(settings=local_settings)
    with TestClient(app, raise_server_exceptions=False) as client:
        assert client.get("/api/v1/health/live").status_code == 200
        assert client.get("/.well-known/jwks.json").status_code == 503
        login_res = client.post(
            "/api/v1/auth/login",
            json={"username": "dr.none", "password": "ValidPassword123"},
        )
        assert login_res.status_code == 503
        assert login_res.json()["error"]["code"] == "service_unavailable"

