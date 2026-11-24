"""Authentication endpoints (login, refresh, logout, me, change-password)."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Cookie, Depends, Request, Response, status

from app.dependencies import (
    ClientIpDep,
    CurrentAuthDep,
    DbSessionDep,
    JwtKeysDep,
    RequestIdDep,
    SettingsDep,
    verify_csrf_origin,
)
from app.schemas.auth import (
    AuthTokenResponse,
    ChangePasswordRequest,
    LoginRequest,
    UserOut,
)
from app.schemas.error import ErrorResponse
from app.services.auth_service import (
    REFRESH_COOKIE_NAME,
    AuthService,
    clear_refresh_cookie,
    set_refresh_cookie,
)

router = APIRouter(
    prefix="/api/v1/auth",
    tags=["auth"],
    responses={
        401: {"model": ErrorResponse, "description": "Authentication failed"},
        403: {"model": ErrorResponse, "description": "CSRF or authorization error"},
        422: {"model": ErrorResponse, "description": "Validation error"},
        500: {"model": ErrorResponse, "description": "Internal server error"},
    },
)


def _extract_optional_bearer(request: Request) -> str | None:
    raw = request.headers.get("authorization")
    if not raw:
        return None
    scheme, _, token = raw.partition(" ")
    if scheme.lower() != "bearer":
        return None
    stripped = token.strip()
    return stripped or None


@router.post(
    "/login",
    dependencies=[Depends(verify_csrf_origin)],
    responses={429: {"model": ErrorResponse, "description": "Rate limit exceeded"}},
)
def login(
    payload: LoginRequest,
    response: Response,
    db: DbSessionDep,
    settings: SettingsDep,
    key_material: JwtKeysDep,
    ip_address: ClientIpDep,
    request_id: RequestIdDep,
) -> AuthTokenResponse:
    """Authenticate username/password, issue RS256 access token, and set bts_refresh cookie."""
    service = AuthService(db, settings=settings, key_material=key_material)
    envelope, raw_refresh, expires_at = service.login(
        username=payload.username,
        password=payload.password,
        ip_address=ip_address,
        request_id=request_id,
    )
    set_refresh_cookie(
        response,
        raw_token=raw_refresh,
        expires_at=expires_at,
        settings=settings,
    )
    return envelope


@router.post(
    "/refresh",
    dependencies=[Depends(verify_csrf_origin)],
)
def refresh_token(
    response: Response,
    db: DbSessionDep,
    settings: SettingsDep,
    key_material: JwtKeysDep,
    ip_address: ClientIpDep,
    request_id: RequestIdDep,
    bts_refresh: Annotated[str | None, Cookie(alias=REFRESH_COOKIE_NAME)] = None,
) -> AuthTokenResponse:
    """Rotate refresh cookie atomically and issue a fresh RS256 access token."""
    service = AuthService(db, settings=settings, key_material=key_material)
    envelope, new_raw_refresh, session_expires_at = service.refresh(
        raw_refresh_token=bts_refresh,
        ip_address=ip_address,
        request_id=request_id,
    )
    set_refresh_cookie(
        response,
        raw_token=new_raw_refresh,
        expires_at=session_expires_at,
        settings=settings,
    )
    return envelope


@router.post(
    "/logout",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(verify_csrf_origin)],
)
def logout(
    request: Request,
    db: DbSessionDep,
    settings: SettingsDep,
    key_material: JwtKeysDep,
    ip_address: ClientIpDep,
    request_id: RequestIdDep,
    bts_refresh: Annotated[str | None, Cookie(alias=REFRESH_COOKIE_NAME)] = None,
) -> Response:
    """Idempotently revoke current session family and clear bts_refresh cookie."""
    service = AuthService(db, settings=settings, key_material=key_material)
    service.logout(
        raw_refresh_token=bts_refresh,
        bearer_token=_extract_optional_bearer(request),
        ip_address=ip_address,
        request_id=request_id,
    )
    out = Response(status_code=status.HTTP_204_NO_CONTENT)
    clear_refresh_cookie(out, settings=settings)
    return out


@router.get("/me")
def get_me(auth: CurrentAuthDep) -> UserOut:
    """Return the authenticated user's profile (allowed when must_change_password=True)."""
    return UserOut.model_validate(auth.user)


@router.post(
    "/change-password",
    status_code=status.HTTP_204_NO_CONTENT,
    responses={400: {"model": ErrorResponse, "description": "Invalid current password"}},
)
def change_password(
    payload: ChangePasswordRequest,
    auth: CurrentAuthDep,
    db: DbSessionDep,
    settings: SettingsDep,
    key_material: JwtKeysDep,
    ip_address: ClientIpDep,
    request_id: RequestIdDep,
) -> Response:
    """Change password, clear must_change_password, revoke all sessions, and clear cookie."""
    service = AuthService(db, settings=settings, key_material=key_material)
    service.change_password(
        user=auth.user,
        current_password=payload.current_password,
        new_password=payload.new_password,
        ip_address=ip_address,
        request_id=request_id,
    )
    out = Response(status_code=status.HTTP_204_NO_CONTENT)
    clear_refresh_cookie(out, settings=settings)
    return out
