"""Shared FastAPI dependencies for DB, storage, Auth, RBAC, and CSRF origin checks."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import Engine
from sqlalchemy.orm import Session as OrmSession

from app.core.config import Settings, normalize_origin
from app.core.db import get_db_session
from app.core.errors import AppError
from app.core.logging import request_id_var, resolve_request_id
from app.core.security import JwtKeyMaterial, decode_access_token
from app.core.storage import LocalStorageAdapter
from app.models.session import Session as AuthSession
from app.models.user import User
from app.repositories.session_repo import SessionRepository

_bearer_scheme = HTTPBearer(auto_error=False)


@dataclass(frozen=True, slots=True)
class AuthContext:
    """Verified user and active session context attached to an authenticated request."""

    user: User
    session: AuthSession


def get_settings(request: Request) -> Settings:
    """Return application Settings stored on FastAPI app state."""
    return request.app.state.settings


def get_db_engine(request: Request) -> Engine | None:
    """Return optional SQLAlchemy Engine stored on FastAPI app state."""
    return getattr(request.app.state, "db_engine", None)


def get_storage_adapter(request: Request) -> LocalStorageAdapter:
    """Return LocalStorageAdapter stored on FastAPI app state."""
    return request.app.state.storage


def get_jwt_key_material(request: Request) -> JwtKeyMaterial | None:
    """Return loaded RSA JWT key material stored on FastAPI app state."""
    return getattr(request.app.state, "jwt_keys", None)


def get_request_id(request: Request) -> str:
    """Return the validated UUID request ID for the current HTTP request."""
    state_id = getattr(request.state, "request_id", None)
    if isinstance(state_id, str) and state_id:
        return state_id
    ctx_id = request_id_var.get()
    if ctx_id and ctx_id != "-":
        return ctx_id
    return resolve_request_id(request.headers.get("x-request-id"))


def get_client_ip(request: Request) -> str:
    """Extract peer IP address from the ASGI client tuple without trusting spoofable headers."""
    if request.client and request.client.host:
        return request.client.host[:64]
    return "unknown"


SettingsDep = Annotated[Settings, Depends(get_settings)]
DbEngineDep = Annotated[Engine | None, Depends(get_db_engine)]
StorageDep = Annotated[LocalStorageAdapter, Depends(get_storage_adapter)]
DbSessionDep = Annotated[OrmSession, Depends(get_db_session)]
JwtKeysDep = Annotated[JwtKeyMaterial | None, Depends(get_jwt_key_material)]
RequestIdDep = Annotated[str, Depends(get_request_id)]
ClientIpDep = Annotated[str, Depends(get_client_ip)]


def _as_utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


def verify_csrf_origin(request: Request, settings: SettingsDep) -> None:
    """Verify Origin and Sec-Fetch-Site headers on cookie-bearing auth endpoints."""
    origin = request.headers.get("origin")
    origin_verified = False
    if origin is not None:
        try:
            normalized = normalize_origin(origin)
        except ValueError as exc:
            raise AppError(
                status_code=403,
                code="csrf_origin_denied",
                message="Header Origin không hợp lệ.",
            ) from exc
        if normalized not in settings.effective_allowed_origins:
            raise AppError(
                status_code=403,
                code="csrf_origin_denied",
                message="Origin không nằm trong danh sách cho phép.",
            )
        origin_verified = True
    elif settings.APP_ENV == "production":
        raise AppError(
            status_code=403,
            code="csrf_origin_denied",
            message="Thiếu header Origin hợp lệ trong môi trường production.",
        )

    sec_fetch_site = request.headers.get("sec-fetch-site")
    if sec_fetch_site is not None:
        tokens = {part.strip().lower() for part in sec_fetch_site.split(",") if part.strip()}
        if not tokens or not tokens.issubset({"same-origin", "none", "same-site"}):
            raise AppError(
                status_code=403,
                code="csrf_origin_denied",
                message="Yêu cầu bị từ chối bởi chính sách kiểm tra Sec-Fetch-Site.",
            )
        if "same-site" in tokens and not origin_verified:
            raise AppError(
                status_code=403,
                code="csrf_origin_denied",
                message="Yêu cầu same-site bắt buộc phải có header Origin hợp lệ.",
            )


def extract_bearer_token(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer_scheme)],
) -> str:
    """Extract Bearer token from Authorization header or raise 401 unauthenticated."""
    raw_auth = request.headers.get("authorization")
    if not raw_auth:
        raise AppError(
            status_code=401,
            code="unauthenticated",
            message="Thiếu header Authorization.",
        )
    if (
        credentials is None
        or credentials.scheme.lower() != "bearer"
        or not credentials.credentials.strip()
    ):
        raise AppError(
            status_code=401,
            code="unauthenticated",
            message="Authorization header phải có định dạng Bearer token.",
        )
    return credentials.credentials.strip()


def get_current_session_user(
    db: DbSessionDep,
    settings: SettingsDep,
    key_material: JwtKeysDep,
    token: Annotated[str, Depends(extract_bearer_token)],
) -> AuthContext:
    """Validate RS256 access JWT and verify active session/user state in PostgreSQL."""
    if key_material is None:
        raise AppError(
            status_code=503,
            code="service_unavailable",
            message="Hệ thống chưa cấu hình khóa xác thực JWT RS256.",
        )

    claims = decode_access_token(token, key_material=key_material, settings=settings)
    row = SessionRepository(db).get_session_and_user(session_id=claims.sid, user_id=claims.sub)
    if row is None:
        raise AppError(
            status_code=401,
            code="invalid_token",
            message="Phiên xác thực không tồn tại.",
        )

    sess, user = row
    if not user.is_active or sess.revoke_reason == "account_disabled":
        raise AppError(
            status_code=401,
            code="account_disabled",
            message="Tài khoản hiện đang bị vô hiệu hóa.",
        )

    if sess.revoked_at is not None:
        if sess.revoke_reason == "expired":
            raise AppError(
                status_code=401,
                code="token_expired",
                message="Phiên đăng nhập đã hết hạn.",
            )
        raise AppError(
            status_code=401,
            code="unauthenticated",
            message="Phiên đăng nhập đã bị thu hồi.",
        )

    if user.password_changed_at is not None and _as_utc(sess.created_at) < _as_utc(
        user.password_changed_at
    ):
        raise AppError(
            status_code=401,
            code="unauthenticated",
            message="Phiên đăng nhập đã bị thu hồi do thay đổi mật khẩu.",
        )

    exp_utc = _as_utc(sess.expires_at)
    if datetime.now(UTC) >= exp_utc:
        raise AppError(
            status_code=401,
            code="token_expired",
            message="Phiên đăng nhập đã hết hạn.",
        )

    return AuthContext(user=user, session=sess)


CurrentAuthDep = Annotated[AuthContext, Depends(get_current_session_user)]


def get_current_active_user(auth: CurrentAuthDep) -> User:
    """Ensure the authenticated user has completed any forced password change."""
    if auth.user.must_change_password:
        raise AppError(
            status_code=403,
            code="password_change_required",
            message="Bạn cần đổi mật khẩu tạm trước khi sử dụng hệ thống.",
        )
    return auth.user


ActiveUserDep = Annotated[User, Depends(get_current_active_user)]


def require_admin(user: ActiveUserDep) -> User:
    """Restrict access to active administrators."""
    if user.role != "admin":
        raise AppError(
            status_code=403,
            code="forbidden",
            message="Bạn không có quyền quản trị viên để thực hiện thao tác này.",
        )
    return user


def require_doctor(user: ActiveUserDep) -> User:
    """Restrict access to active doctors."""
    if user.role != "doctor":
        raise AppError(
            status_code=403,
            code="forbidden",
            message="Chỉ tài khoản bác sĩ mới được phép truy cập chức năng này.",
        )
    return user


AdminUserDep = Annotated[User, Depends(require_admin)]
DoctorUserDep = Annotated[User, Depends(require_doctor)]
CsrfOriginDep = Annotated[None, Depends(verify_csrf_origin)]
