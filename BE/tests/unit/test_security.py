"""Unit tests for Argon2id password hashing, RSA RS256 JWTs, JWKS, and refresh tokens."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.core.config import Settings
from app.core.errors import AppError
from app.core.security import (
    decode_access_token,
    generate_refresh_token,
    generate_rsa_keypair,
    generate_temporary_password,
    hash_password,
    hash_refresh_token,
    issue_access_token,
    load_jwt_key_material,
    validate_password_policy,
    verify_password,
)


def _settings_for_keys(priv_path: Path, pub_path: Path, app_env: str = "test") -> Settings:
    return Settings(
        _env_file=None,
        APP_ENV=app_env,  # type: ignore[arg-type]
        JWT_PRIVATE_KEY_PATH=priv_path,
        JWT_PUBLIC_KEY_PATH=pub_path,
        JWT_KEY_ID="unit-rs256-v1",
        JWT_ISSUER="brain-tumor-api",
        JWT_AUDIENCE="brain-tumor-web",
    )


def test_argon2id_hashing_preserves_whitespace_and_enforces_length() -> None:
    raw_with_spaces = "  correct horse battery  "
    hashed = hash_password(raw_with_spaces)
    assert hashed.startswith("$argon2id$")
    assert verify_password(hashed, raw_with_spaces) is True
    assert verify_password(hashed, raw_with_spaces.strip()) is False
    assert verify_password(hashed, "wrong password 123") is False
    assert verify_password("not-a-valid-hash", raw_with_spaces) is False

    assert validate_password_policy("a" * 12) == "a" * 12
    assert validate_password_policy("  " + "x" * 10) == "  " + "x" * 10
    assert validate_password_policy("b" * 128) == "b" * 128

    for bad_pw in ("short11char", "c" * 129):
        with pytest.raises(ValueError):
            validate_password_policy(bad_pw)


def test_generate_temporary_password_and_refresh_tokens() -> None:
    temp1 = generate_temporary_password()
    temp2 = generate_temporary_password()
    assert len(temp1) >= 16
    assert temp1 != temp2
    assert validate_password_policy(temp1) == temp1

    raw1, digest1 = generate_refresh_token()
    raw2, digest2 = generate_refresh_token()
    assert raw1 != raw2
    assert len(raw1) >= 32
    assert len(digest1) == 64
    assert digest1 == hash_refresh_token(raw1)
    assert digest1 != digest2


def test_rsa_keypair_loading_env_rules_and_minimum_key_size(tmp_path: Path) -> None:
    priv_path = tmp_path / "priv.pem"
    pub_path = tmp_path / "pub.pem"
    generate_rsa_keypair(priv_path, pub_path, key_size=2048)

    local_unconfigured = Settings(_env_file=None, APP_ENV="local")
    assert load_jwt_key_material(local_unconfigured) is None

    settings = _settings_for_keys(priv_path, pub_path, app_env="test")
    material = load_jwt_key_material(settings)
    assert material is not None
    assert material.kid == "unit-rs256-v1"
    assert material.public_jwk["kty"] == "RSA"
    assert material.public_jwk["use"] == "sig"
    assert material.public_jwk["alg"] == "RS256"
    assert material.public_jwk["kid"] == "unit-rs256-v1"
    assert "n" in material.public_jwk and "e" in material.public_jwk

    # Reject < 2048-bit key
    weak_priv = rsa.generate_private_key(public_exponent=65537, key_size=1024)
    weak_priv_path = tmp_path / "weak-priv.pem"
    weak_pub_path = tmp_path / "weak-pub.pem"
    weak_priv_path.write_bytes(
        weak_priv.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    weak_pub_path.write_bytes(
        weak_priv.public_key().public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        )
    )
    with pytest.raises(ValueError, match="2048"):
        load_jwt_key_material(_settings_for_keys(weak_priv_path, weak_pub_path))

    # Production requires existing valid key files
    prod_missing = Settings(
        _env_file=None,
        APP_ENV="production",
        DATABASE_URL="postgresql+psycopg://app_prod:StrongRandomPass99@db.internal:5432/bts_prod",
        STORAGE_ROOT=tmp_path / "storage",
        PUBLIC_ORIGIN="https://bts.hospital.example",
        COOKIE_SECURE=True,
        JWT_PRIVATE_KEY_PATH=tmp_path / "missing-priv.pem",
        JWT_PUBLIC_KEY_PATH=tmp_path / "missing-pub.pem",
        JWT_KEY_ID="prod-v1",
        MODEL_MANIFEST_PATH=tmp_path / "manifest.json",
        MODEL_CHECKPOINT_PATH=tmp_path / "best.pt",
        WORKER_API_BASE_URL="http://127.0.0.1:8000",
        WORKER_TOKEN="prod-worker-service-token-64chars-long-enough",
    )
    with pytest.raises((FileNotFoundError, ValueError)):
        load_jwt_key_material(prod_missing)


def test_access_jwt_claims_jwk_verification_and_qa_auth_01_rejections(tmp_path: Path) -> None:
    priv_path, pub_path = generate_rsa_keypair(tmp_path / "priv.pem", tmp_path / "pub.pem")
    other_priv_path, other_pub_path = generate_rsa_keypair(
        tmp_path / "other-priv.pem", tmp_path / "other-pub.pem"
    )
    settings = _settings_for_keys(priv_path, pub_path)
    material = load_jwt_key_material(settings)
    assert material is not None

    user_id = uuid.uuid4()
    session_id = uuid.uuid4()
    now = datetime.now(UTC)

    token = issue_access_token(
        user_id=user_id,
        session_id=session_id,
        role="doctor",
        key_material=material,
        settings=settings,
        now=now,
    )

    header = jwt.get_unverified_header(token)
    assert header["alg"] == "RS256"
    assert header["kid"] == "unit-rs256-v1"

    # Verify via exported JWK
    jwk_key = jwt.PyJWK(material.public_jwk).key
    raw_claims = jwt.decode(
        token,
        jwk_key,
        algorithms=["RS256"],
        issuer="brain-tumor-api",
        audience="brain-tumor-web",
    )
    assert set(raw_claims.keys()) == {"sub", "sid", "role", "iat", "exp", "iss", "aud"}
    assert raw_claims["exp"] - raw_claims["iat"] == 900
    assert raw_claims["sub"] == str(user_id)
    assert raw_claims["sid"] == str(session_id)
    assert raw_claims["role"] == "doctor"

    decoded = decode_access_token(token, key_material=material, settings=settings)
    assert decoded.sub == user_id
    assert decoded.sid == session_id
    assert decoded.role == "doctor"

    # Clock skew <= 30s allowed, > 30s rejected
    within_skew = issue_access_token(
        user_id=user_id,
        session_id=session_id,
        role="doctor",
        key_material=material,
        settings=settings,
        now=now - timedelta(seconds=910),
    )
    assert decode_access_token(within_skew, key_material=material, settings=settings).sub == user_id

    expired = issue_access_token(
        user_id=user_id,
        session_id=session_id,
        role="doctor",
        key_material=material,
        settings=settings,
        now=now - timedelta(seconds=940),
    )
    with pytest.raises(AppError) as exc_exp:
        decode_access_token(expired, key_material=material, settings=settings)
    assert exc_exp.value.status_code == 401
    assert exc_exp.value.code == "token_expired"

    # Bad signature
    other_material = load_jwt_key_material(_settings_for_keys(other_priv_path, other_pub_path))
    assert other_material is not None
    bad_sig = issue_access_token(
        user_id=user_id,
        session_id=session_id,
        role="doctor",
        key_material=other_material,
        settings=settings,
        now=now,
    )
    with pytest.raises(AppError) as exc_sig:
        decode_access_token(bad_sig, key_material=material, settings=settings)
    assert exc_sig.value.status_code == 401
    assert exc_sig.value.code == "invalid_signature"

    # alg=HS256 and alg=none rejected
    hs256_token = jwt.encode(
        raw_claims,
        "shared-hmac-secret-at-least-32-bytes!",
        algorithm="HS256",
        headers={"kid": material.kid},
    )
    with pytest.raises(AppError) as exc_hs:
        decode_access_token(hs256_token, key_material=material, settings=settings)
    assert exc_hs.value.status_code == 401
    assert exc_hs.value.code == "invalid_token_alg"

    none_token = jwt.encode(raw_claims, "", algorithm="none", headers={"kid": material.kid})
    with pytest.raises(AppError) as exc_none:
        decode_access_token(none_token, key_material=material, settings=settings)
    assert exc_none.value.status_code == 401
    assert exc_none.value.code == "invalid_token_alg"

    # Unknown kid
    unknown_kid_token = jwt.encode(
        raw_claims,
        material.private_key,
        algorithm="RS256",
        headers={"kid": "unknown-key-99"},
    )
    with pytest.raises(AppError) as exc_kid:
        decode_access_token(unknown_kid_token, key_material=material, settings=settings)
    assert exc_kid.value.status_code == 401
    assert exc_kid.value.code == "unknown_kid"

    # Wrong issuer
    wrong_iss_token = jwt.encode(
        {**raw_claims, "iss": "evil-issuer"},
        material.private_key,
        algorithm="RS256",
        headers={"kid": material.kid},
    )
    with pytest.raises(AppError) as exc_iss:
        decode_access_token(wrong_iss_token, key_material=material, settings=settings)
    assert exc_iss.value.status_code == 401
    assert exc_iss.value.code == "invalid_issuer"

    # Wrong audience
    wrong_aud_token = jwt.encode(
        {**raw_claims, "aud": "wrong-audience"},
        material.private_key,
        algorithm="RS256",
        headers={"kid": material.kid},
    )
    with pytest.raises(AppError) as exc_aud:
        decode_access_token(wrong_aud_token, key_material=material, settings=settings)
    assert exc_aud.value.status_code == 401
    assert exc_aud.value.code == "invalid_audience"


def test_auth_and_admin_request_schemas_forbid_extra_fields() -> None:
    from pydantic import ValidationError

    from app.schemas.admin_user import AdminCreateDoctorRequest, AdminUpdateDoctorRequest
    from app.schemas.auth import ChangePasswordRequest, LoginRequest

    with pytest.raises(ValidationError):
        LoginRequest.model_validate(
            {"username": "dr.a", "password": "ValidPassword123", "unexpected": 1}
        )
    with pytest.raises(ValidationError):
        ChangePasswordRequest.model_validate(
            {
                "current_password": "OldPassword123",
                "new_password": "NewPassword456",
                "role": "admin",
            }
        )
    with pytest.raises(ValidationError):
        AdminCreateDoctorRequest.model_validate(
            {
                "username": "dr.new",
                "display_name": "Dr New",
                "temporary_password": "TempPassword1234",
                "role": "admin",
            }
        )
    with pytest.raises(ValidationError):
        AdminUpdateDoctorRequest.model_validate({"is_active": False, "role": "admin"})


def test_verify_csrf_origin_enforces_sec_fetch_site_and_production_origin(
    tmp_path: Path,
) -> None:
    from starlette.requests import Request

    from app.dependencies import verify_csrf_origin

    def _make_req(headers: dict[str, str]) -> Request:
        raw_headers = [
            (k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers.items()
        ]
        return Request(
            {
                "type": "http",
                "method": "POST",
                "path": "/api/v1/auth/refresh",
                "headers": raw_headers,
            }
        )

    dev_settings = Settings(_env_file=None, APP_ENV="test", PUBLIC_ORIGIN="http://127.0.0.1:5173")

    # same-site without Origin -> 403
    with pytest.raises(AppError) as exc_ss:
        verify_csrf_origin(_make_req({"Sec-Fetch-Site": "same-site"}), dev_settings)
    assert exc_ss.value.status_code == 403
    assert exc_ss.value.code == "csrf_origin_denied"

    # same-site with allowed Origin -> allowed
    verify_csrf_origin(
        _make_req({"Sec-Fetch-Site": "same-site", "Origin": "http://127.0.0.1:5173"}),
        dev_settings,
    )

    # unknown Sec-Fetch-Site token -> 403
    with pytest.raises(AppError) as exc_unk:
        verify_csrf_origin(_make_req({"Sec-Fetch-Site": "weird-token"}), dev_settings)
    assert exc_unk.value.status_code == 403

    # production requires Origin header even if Sec-Fetch-Site is same-origin
    priv_path, pub_path = generate_rsa_keypair(tmp_path / "p.pem", tmp_path / "pub.pem")
    prod_settings = Settings(
        _env_file=None,
        APP_ENV="production",
        DATABASE_URL="postgresql+psycopg://app_prod:StrongRandomPass99@db.internal:5432/bts_prod",
        STORAGE_ROOT=tmp_path / "storage",
        PUBLIC_ORIGIN="https://bts.hospital.example",
        COOKIE_SECURE=True,
        JWT_PRIVATE_KEY_PATH=priv_path,
        JWT_PUBLIC_KEY_PATH=pub_path,
        JWT_KEY_ID="prod-v1",
        MODEL_MANIFEST_PATH=tmp_path / "manifest.json",
        MODEL_CHECKPOINT_PATH=tmp_path / "best.pt",
        WORKER_API_BASE_URL="http://127.0.0.1:8000",
        WORKER_TOKEN="prod-worker-service-token-64chars-long-enough",
    )
    with pytest.raises(AppError) as exc_prod_missing:
        verify_csrf_origin(_make_req({"Sec-Fetch-Site": "same-origin"}), prod_settings)
    assert exc_prod_missing.value.status_code == 403
    assert exc_prod_missing.value.code == "csrf_origin_denied"

    verify_csrf_origin(
        _make_req(
            {"Sec-Fetch-Site": "same-origin", "Origin": "https://bts.hospital.example"}
        ),
        prod_settings,
    )


def test_chunked_multipart_limit_returns_413_without_logging_500(tmp_path: Path) -> None:
    import logging

    import httpx

    from app.main import create_app

    priv_path, pub_path = generate_rsa_keypair(tmp_path / "priv.pem", tmp_path / "pub.pem")
    small_settings = Settings(
        _env_file=None,
        APP_ENV="local",
        STORAGE_ROOT=tmp_path / "storage",
        JWT_PRIVATE_KEY_PATH=priv_path,
        JWT_PUBLIC_KEY_PATH=pub_path,
        MAX_UPLOAD_BYTES=1024,
        MAX_MULTIPART_OVERHEAD_BYTES=4096,
    )
    app = create_app(settings=small_settings)
    records: list[logging.LogRecord] = []

    class _ListHandler(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            records.append(record)

    err_logger = logging.getLogger("app.core.errors")
    handler = _ListHandler(level=logging.ERROR)
    err_logger.addHandler(handler)
    try:
        import asyncio

        async def _send_chunked() -> httpx.Response:
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                base_url="http://testserver",
            ) as async_client:
                async def _agen():
                    yield (
                        b"--xyz\r\n"
                        b'Content-Disposition: form-data; name="file"; filename="a.nii"\r\n'
                        b"Content-Type: application/octet-stream\r\n\r\n"
                    )
                    for _ in range(10):
                        yield b"x" * 1024
                    yield b"\r\n--xyz--\r\n"

                return await async_client.post(
                    f"/api/v1/cases/{uuid.uuid4()}/volumes",
                    content=_agen(),
                    headers={"Content-Type": "multipart/form-data; boundary=xyz"},
                )

        resp = asyncio.run(_send_chunked())
        assert resp.status_code == 413
        assert resp.json()["error"]["code"] == "payload_too_large"
        assert records == []
    finally:
        err_logger.removeHandler(handler)


def test_bootstrap_admin_init_jwt_keys_protects_existing_keys_and_protected_db_guards(
    tmp_path: Path,
) -> None:
    from sqlalchemy.engine import make_url

    from scripts.backup_restore import _assert_safe_restore_target, _clean_storage_subdir
    from scripts.bootstrap_admin import run_bootstrap_admin
    from scripts.run_p7_e2e_stack import _assert_safe_e2e_database

    priv_path = tmp_path / "keys" / "jwt-private.pem"
    pub_path = tmp_path / "keys" / "jwt-public.pem"
    cfg = _settings_for_keys(priv_path, pub_path)

    assert (
        run_bootstrap_admin(
            username=None,
            display_name=None,
            reset=False,
            init_jwt_keys=True,
            settings=cfg,
        )
        == 0
    )
    original_priv = priv_path.read_bytes()

    # Refuses overwrite without --force
    assert (
        run_bootstrap_admin(
            username=None,
            display_name=None,
            reset=False,
            init_jwt_keys=True,
            force=False,
            settings=cfg,
        )
        == 1
    )
    assert priv_path.read_bytes() == original_priv

    # Overwrites when force=True
    assert (
        run_bootstrap_admin(
            username=None,
            display_name=None,
            reset=False,
            init_jwt_keys=True,
            force=True,
            settings=cfg,
        )
        == 0
    )
    assert priv_path.read_bytes() != original_priv

    # Protected DB guards (case-insensitive & complete list)
    for bad_db in (
        "BTS_DEV",
        "Postgres",
        "template0",
        "TEMPLATE1",
        "bts",
        "prod",
        "production",
        "clinic-prod",
        "app_production",
        "staging-dev",
    ):
        url_str = f"postgresql+psycopg://u:p@127.0.0.1:5432/{bad_db}"
        with pytest.raises(ValueError):
            _assert_safe_restore_target(make_url(url_str))
        with pytest.raises(ValueError):
            _assert_safe_e2e_database(url_str)

    # Storage subdir cleanup removes stale files safely
    storage_root = tmp_path / "restore_target"
    objects_dir = storage_root / "objects"
    objects_dir.mkdir(parents=True)
    stale = objects_dir / str(uuid.uuid4())
    stale.write_bytes(b"stale")
    _clean_storage_subdir(objects_dir, storage_root.resolve())
    assert list(objects_dir.iterdir()) == []
