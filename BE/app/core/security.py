"""Security primitives for Argon2id passwords, RS256 JWTs, JWKS, and opaque refresh tokens."""

from __future__ import annotations

import base64
import hashlib
import os
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey, RSAPublicKey

from app.core.config import Settings
from app.core.errors import AppError

MIN_PASSWORD_LENGTH = 12
MAX_PASSWORD_LENGTH = 128
MIN_RSA_KEY_BITS = 2048

_PASSWORD_HASHER = PasswordHasher()
_DUMMY_PASSWORD_HASH = _PASSWORD_HASHER.hash("bts-constant-timing-dummy-password-2026")
_TEMP_PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_"


@dataclass(frozen=True, slots=True)
class JwtKeyMaterial:
    """Loaded RSA signing/verifying keypair and JWK metadata."""

    private_key: RSAPrivateKey
    public_key: RSAPublicKey
    kid: str
    public_jwk: dict[str, Any]


@dataclass(frozen=True, slots=True)
class AccessTokenClaims:
    """Verified access JWT payload claims."""

    sub: uuid.UUID
    sid: uuid.UUID
    role: Literal["admin", "doctor"]
    iat: int
    exp: int
    iss: str
    aud: str


def _encode_jwk_uint(value: int) -> str:
    byte_length = max(1, (value.bit_length() + 7) // 8)
    raw_bytes = value.to_bytes(byte_length, "big")
    return base64.urlsafe_b64encode(raw_bytes).rstrip(b"=").decode("ascii")


def build_public_jwk(public_key: RSAPublicKey, kid: str) -> dict[str, Any]:
    """Export an RSA public key as a standard RS256 JWK dictionary."""
    numbers = public_key.public_numbers()
    return {
        "kty": "RSA",
        "use": "sig",
        "alg": "RS256",
        "kid": kid,
        "n": _encode_jwk_uint(numbers.n),
        "e": _encode_jwk_uint(numbers.e),
    }


def generate_rsa_keypair(
    private_key_path: Path,
    public_key_path: Path,
    *,
    key_size: int = MIN_RSA_KEY_BITS,
) -> tuple[Path, Path]:
    """Generate an RSA >=2048-bit keypair and write PEM files to disk."""
    if key_size < MIN_RSA_KEY_BITS:
        raise ValueError(f"RSA key size must be at least {MIN_RSA_KEY_BITS} bits")

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=key_size)
    private_pem = private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_pem = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PublicFormat.SubjectPublicKeyInfo,
    )

    private_key_path.parent.mkdir(parents=True, exist_ok=True)
    public_key_path.parent.mkdir(parents=True, exist_ok=True)
    private_key_path.write_bytes(private_pem)
    public_key_path.write_bytes(public_pem)
    try:
        os.chmod(private_key_path, 0o600)
    except OSError:
        pass
    return private_key_path, public_key_path


def load_jwt_key_material(settings: Settings) -> JwtKeyMaterial | None:
    """Load and validate RSA key material according to APP_ENV rules."""
    priv_path = settings.JWT_PRIVATE_KEY_PATH
    pub_path = settings.JWT_PUBLIC_KEY_PATH
    kid = (settings.JWT_KEY_ID or "").strip()

    if settings.APP_ENV == "production":
        if priv_path is None or pub_path is None:
            raise ValueError("JWT_PRIVATE_KEY_PATH and JWT_PUBLIC_KEY_PATH are required")
        if not priv_path.is_file():
            raise FileNotFoundError(f"JWT private key file does not exist: {priv_path}")
        if not pub_path.is_file():
            raise FileNotFoundError(f"JWT public key file does not exist: {pub_path}")
    else:
        if priv_path is None and pub_path is None:
            return None
        if priv_path is None or pub_path is None:
            raise ValueError(
                "Both JWT_PRIVATE_KEY_PATH and JWT_PUBLIC_KEY_PATH must be configured together"
            )
        if not priv_path.is_file() or not pub_path.is_file():
            return None

    if not kid:
        raise ValueError("JWT_KEY_ID must not be blank")

    loaded_private = serialization.load_pem_private_key(priv_path.read_bytes(), password=None)
    loaded_public = serialization.load_pem_public_key(pub_path.read_bytes())

    if not isinstance(loaded_private, RSAPrivateKey):
        raise ValueError("JWT_PRIVATE_KEY_PATH must contain an RSA private key")
    if not isinstance(loaded_public, RSAPublicKey):
        raise ValueError("JWT_PUBLIC_KEY_PATH must contain an RSA public key")

    if loaded_private.key_size < MIN_RSA_KEY_BITS or loaded_public.key_size < MIN_RSA_KEY_BITS:
        raise ValueError(f"RSA keys must be at least {MIN_RSA_KEY_BITS} bits")

    if loaded_private.public_key().public_numbers() != loaded_public.public_numbers():
        raise ValueError("JWT private key and public key do not form a matching pair")

    return JwtKeyMaterial(
        private_key=loaded_private,
        public_key=loaded_public,
        kid=kid,
        public_jwk=build_public_jwk(loaded_public, kid),
    )


def validate_password_policy(password: str) -> str:
    """Validate password length (12-128 chars) without stripping whitespace."""
    if not isinstance(password, str):
        raise ValueError("Mật khẩu phải là chuỗi ký tự.")
    if not (MIN_PASSWORD_LENGTH <= len(password) <= MAX_PASSWORD_LENGTH):
        raise ValueError(
            f"Mật khẩu phải có độ dài từ {MIN_PASSWORD_LENGTH} đến {MAX_PASSWORD_LENGTH} ký tự."
        )
    return password


def hash_password(password: str) -> str:
    """Hash a password with Argon2id without trimming leading/trailing spaces."""
    return _PASSWORD_HASHER.hash(password)


def verify_password(password_hash: str, password: str) -> bool:
    """Verify a password against an Argon2id hash without trimming."""
    if not password_hash or not isinstance(password, str) or not password:
        return False
    try:
        return bool(_PASSWORD_HASHER.verify(password_hash, password))
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def verify_dummy_password(password: str) -> None:
    """Perform a constant-cost dummy Argon2id check to reduce timing differences."""
    verify_password(_DUMMY_PASSWORD_HASH, password or "dummy-fallback")


def issue_access_token(
    *,
    user_id: uuid.UUID,
    session_id: uuid.UUID,
    role: Literal["admin", "doctor"],
    key_material: JwtKeyMaterial,
    settings: Settings,
    now: datetime | None = None,
) -> str:
    """Issue a signed RS256 access JWT with minimal claims and kid header."""
    issued_at = now if now is not None else datetime.now(UTC)
    iat = int(issued_at.timestamp())
    exp = iat + settings.JWT_ACCESS_TTL_SECONDS
    payload = {
        "sub": str(user_id),
        "sid": str(session_id),
        "role": role,
        "iat": iat,
        "exp": exp,
        "iss": settings.JWT_ISSUER,
        "aud": settings.JWT_AUDIENCE,
    }
    return jwt.encode(
        payload,
        key_material.private_key,
        algorithm="RS256",
        headers={"kid": key_material.kid},
    )


def decode_access_token(
    token: str,
    *,
    key_material: JwtKeyMaterial,
    settings: Settings,
    verify_exp: bool = True,
) -> AccessTokenClaims:
    """Decode and strictly verify an RS256 access JWT."""
    try:
        header = jwt.get_unverified_header(token)
    except jwt.PyJWTError as exc:
        raise AppError(
            status_code=401,
            code="invalid_token",
            message="Token xác thực không hợp lệ.",
        ) from exc

    if header.get("alg") != "RS256":
        raise AppError(
            status_code=401,
            code="invalid_token_alg",
            message="Thuật toán ký token không được chấp nhận.",
        )

    if header.get("kid") != key_material.kid:
        raise AppError(
            status_code=401,
            code="unknown_kid",
            message="Định danh khóa ký token không hợp lệ.",
        )

    try:
        payload = jwt.decode(
            token,
            key_material.public_key,
            algorithms=["RS256"],
            issuer=settings.JWT_ISSUER,
            audience=settings.JWT_AUDIENCE,
            leeway=settings.JWT_CLOCK_SKEW_SECONDS,
            options={
                "verify_signature": True,
                "verify_exp": verify_exp,
                "verify_iat": True,
                "verify_iss": True,
                "verify_aud": True,
                "require": ["sub", "sid", "role", "iat", "exp", "iss", "aud"],
            },
        )
    except jwt.ExpiredSignatureError as exc:
        raise AppError(
            status_code=401,
            code="token_expired",
            message="Phiên đăng nhập đã hết hạn.",
        ) from exc
    except jwt.InvalidIssuerError as exc:
        raise AppError(
            status_code=401,
            code="invalid_issuer",
            message="Nguồn phát hành token không hợp lệ.",
        ) from exc
    except jwt.InvalidAudienceError as exc:
        raise AppError(
            status_code=401,
            code="invalid_audience",
            message="Đối tượng thụ hưởng token không hợp lệ.",
        ) from exc
    except jwt.InvalidSignatureError as exc:
        raise AppError(
            status_code=401,
            code="invalid_signature",
            message="Chữ ký token không hợp lệ.",
        ) from exc
    except jwt.PyJWTError as exc:
        raise AppError(
            status_code=401,
            code="invalid_token",
            message="Token xác thực không hợp lệ.",
        ) from exc

    try:
        sub = uuid.UUID(str(payload["sub"]))
        sid = uuid.UUID(str(payload["sid"]))
        role = str(payload["role"])
        if role not in ("admin", "doctor"):
            raise ValueError("Invalid role claim")
        iat = int(payload["iat"])
        exp = int(payload["exp"])
        iss = str(payload["iss"])
        aud = str(payload["aud"])
    except (KeyError, ValueError, TypeError) as exc:
        raise AppError(
            status_code=401,
            code="invalid_token",
            message="Nội dung claims của token không hợp lệ.",
        ) from exc

    return AccessTokenClaims(
        sub=sub,
        sid=sid,
        role=role,  # type: ignore[arg-type]
        iat=iat,
        exp=exp,
        iss=iss,
        aud=aud,
    )


def hash_refresh_token(raw_token: str) -> str:
    """Return lowercase 64-char SHA-256 hex digest of an opaque refresh token."""
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def generate_refresh_token() -> tuple[str, str]:
    """Generate an opaque refresh token (>=32 bytes entropy) and its SHA-256 hex digest."""
    raw_token = secrets.token_urlsafe(32)
    return raw_token, hash_refresh_token(raw_token)


def generate_temporary_password(length: int = 20) -> str:
    """Generate a cryptographically random temporary password (>=16 chars)."""
    if length < 16 or length > MAX_PASSWORD_LENGTH:
        raise ValueError("Temporary password length must be between 16 and 128")
    return "".join(secrets.choice(_TEMP_PASSWORD_ALPHABET) for _ in range(length))
