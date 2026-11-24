"""Authentication, refresh rotation, rate limiting, and cookie management service."""

from __future__ import annotations

import math
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import Response
from sqlalchemy import select
from sqlalchemy.orm import Session as OrmSession

from app.core.config import Settings
from app.core.errors import AppError
from app.core.security import (
    JwtKeyMaterial,
    decode_access_token,
    generate_refresh_token,
    hash_password,
    hash_refresh_token,
    issue_access_token,
    validate_password_policy,
    verify_dummy_password,
    verify_password,
)
from app.models.user import User
from app.repositories.audit_repo import AuditRepository
from app.repositories.session_repo import SessionRepository
from app.repositories.user_repo import UserRepository
from app.schemas.auth import AuthTokenResponse, UserOut

REFRESH_COOKIE_NAME = "bts_refresh"
REFRESH_COOKIE_PATH = "/api/v1/auth"


def _as_utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


def set_refresh_cookie(
    response: Response,
    *,
    raw_token: str,
    expires_at: datetime,
    settings: Settings,
    now: datetime | None = None,
) -> None:
    """Attach the HttpOnly SameSite=Lax host-only bts_refresh cookie."""
    ref_now = now if now is not None else datetime.now(UTC)
    max_age = max(1, int((_as_utc(expires_at) - ref_now).total_seconds()))
    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=raw_token,
        max_age=max_age,
        httponly=True,
        samesite="lax",
        path=REFRESH_COOKIE_PATH,
        domain=None,
        secure=settings.COOKIE_SECURE,
    )


def clear_refresh_cookie(response: Response, *, settings: Settings) -> None:
    """Expire the bts_refresh cookie cleanly on the client."""
    response.delete_cookie(
        key=REFRESH_COOKIE_NAME,
        path=REFRESH_COOKIE_PATH,
        domain=None,
        secure=settings.COOKIE_SECURE,
        httponly=True,
        samesite="lax",
    )


def build_clear_refresh_cookie_headers(settings: Settings) -> dict[str, str]:
    """Build Set-Cookie header dict for clearing bts_refresh on error responses."""
    tmp = Response()
    clear_refresh_cookie(tmp, settings=settings)
    cookie_header = tmp.headers.get("set-cookie")
    return {"Set-Cookie": cookie_header} if cookie_header else {}


class AuthService:
    """Business logic for login, RS256 issuance, refresh rotation, logout, and password change."""

    def __init__(
        self,
        db: OrmSession,
        *,
        settings: Settings,
        key_material: JwtKeyMaterial | None,
    ) -> None:
        self.db = db
        self.settings = settings
        self.key_material = key_material
        self.users = UserRepository(db)
        self.sessions = SessionRepository(db)
        self.audits = AuditRepository(db)

    def _require_key_material(self) -> JwtKeyMaterial:
        if self.key_material is None:
            raise AppError(
                status_code=503,
                code="service_unavailable",
                message="Hệ thống chưa cấu hình khóa ký JWT RS256.",
            )
        return self.key_material

    def _lock_user_by_id(self, user_id: uuid.UUID) -> User | None:
        return self.db.scalar(
            select(User)
            .where(User.id == user_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )

    def _check_login_rate_limit(
        self,
        *,
        username: str,
        ip_address: str,
        request_id: str,
        now: datetime,
    ) -> None:
        window = timedelta(seconds=self.settings.LOGIN_RATE_LIMIT_WINDOW_SECONDS)
        since = now - window

        user_count, user_release = self.sessions.count_recent_failures_user_ip(
            username=username,
            ip_address=ip_address,
            since=since,
            threshold=self.settings.LOGIN_RATE_LIMIT_PER_USER_IP,
        )
        ip_count, ip_release = self.sessions.count_recent_failures_ip(
            ip_address=ip_address,
            since=since,
            threshold=self.settings.LOGIN_RATE_LIMIT_PER_IP,
        )

        retry_candidates: list[int] = []
        scopes: list[str] = []
        if user_count >= self.settings.LOGIN_RATE_LIMIT_PER_USER_IP and user_release is not None:
            scopes.append("user_ip")
            retry_candidates.append(
                max(1, math.ceil((_as_utc(user_release) + window - now).total_seconds()))
            )
        if ip_count >= self.settings.LOGIN_RATE_LIMIT_PER_IP and ip_release is not None:
            scopes.append("ip")
            retry_candidates.append(
                max(1, math.ceil((_as_utc(ip_release) + window - now).total_seconds()))
            )

        if not retry_candidates:
            return

        retry_after = max(retry_candidates)
        self.audits.record_event(
            actor_type="user",
            actor_id=None,
            action="auth.login_rate_limited",
            resource_type="auth",
            resource_id=None,
            outcome="failure",
            request_id=request_id,
            ip_address=ip_address,
            safe_diff={"scopes": scopes, "retry_after_seconds": retry_after},
            now=now,
        )
        self.db.commit()
        raise AppError(
            status_code=429,
            code="rate_limit_exceeded",
            message="Quá nhiều lần đăng nhập thất bại. Vui lòng thử lại sau.",
            headers={"Retry-After": str(retry_after)},
        )

    def login(
        self,
        *,
        username: str,
        password: str,
        ip_address: str,
        request_id: str,
    ) -> tuple[AuthTokenResponse, str, datetime]:
        """Authenticate credentials, create session family, and issue access + refresh tokens."""
        keys = self._require_key_material()
        normalized_username = username.strip().lower()
        rate_check_now = datetime.now(UTC)

        self.sessions.acquire_login_ip_lock(ip_address)
        self._check_login_rate_limit(
            username=normalized_username,
            ip_address=ip_address,
            request_id=request_id,
            now=rate_check_now,
        )

        user = self.users.get_by_username(normalized_username)
        initial_hash: str | None = None
        if user is None:
            verify_dummy_password(password)
            password_ok = False
        else:
            initial_hash = user.password_hash
            password_ok = verify_password(initial_hash, password)

        locked_user: User | None = user
        login_valid = False
        if user is not None and password_ok:
            locked_user = self._lock_user_by_id(user.id)
            login_valid = (
                locked_user is not None
                and locked_user.is_active
                and locked_user.password_hash == initial_hash
            )

        if not login_valid or locked_user is None:
            fail_now = datetime.now(UTC)
            self.sessions.record_login_attempt(
                username=normalized_username,
                ip_address=ip_address,
                attempted_at=fail_now,
            )
            self.audits.record_event(
                actor_type="user",
                actor_id=locked_user.id if locked_user is not None else None,
                action="auth.login",
                resource_type="user",
                resource_id=str(locked_user.id) if locked_user is not None else None,
                outcome="failure",
                request_id=request_id,
                ip_address=ip_address,
                safe_diff={"reason": "login_failed"},
                now=fail_now,
            )
            self.db.commit()
            raise AppError(
                status_code=401,
                code="login_failed",
                message="Tên đăng nhập hoặc mật khẩu không chính xác.",
            )

        now = datetime.now(UTC)
        if locked_user.password_changed_at is not None and now < _as_utc(
            locked_user.password_changed_at
        ):
            now = _as_utc(locked_user.password_changed_at)

        expires_at = now + timedelta(days=self.settings.REFRESH_SESSION_TTL_DAYS)
        raw_refresh, refresh_hash = generate_refresh_token()
        session_obj, _ = self.sessions.create_session_with_refresh_token(
            user_id=locked_user.id,
            expires_at=expires_at,
            token_hash=refresh_hash,
            now=now,
        )
        access_token = issue_access_token(
            user_id=locked_user.id,
            session_id=session_obj.id,
            role=locked_user.role,  # type: ignore[arg-type]
            key_material=keys,
            settings=self.settings,
            now=now,
        )
        self.audits.record_event(
            actor_type="user",
            actor_id=locked_user.id,
            action="auth.login",
            resource_type="session",
            resource_id=str(session_obj.id),
            outcome="success",
            request_id=request_id,
            ip_address=ip_address,
            safe_diff=None,
            now=now,
        )
        self.db.commit()

        envelope = AuthTokenResponse(
            access_token=access_token,
            token_type="bearer",
            expires_in=self.settings.JWT_ACCESS_TTL_SECONDS,
            user=UserOut.model_validate(locked_user),
        )
        return envelope, raw_refresh, expires_at

    def refresh(
        self,
        *,
        raw_refresh_token: str | None,
        ip_address: str,
        request_id: str,
    ) -> tuple[AuthTokenResponse, str, datetime]:
        """Rotate opaque refresh token under PostgreSQL row lock with reuse detection."""
        keys = self._require_key_material()
        if not raw_refresh_token:
            raise AppError(
                status_code=401,
                code="unauthenticated",
                message="Thiếu cookie phiên làm mới.",
            )

        now = datetime.now(UTC)
        clear_headers = build_clear_refresh_cookie_headers(self.settings)
        token_hash = hash_refresh_token(raw_refresh_token)

        rt_probe = self.sessions.get_refresh_token_by_hash(token_hash)
        if rt_probe is None:
            self.audits.record_event(
                actor_type="user",
                actor_id=None,
                action="auth.refresh",
                resource_type="session",
                resource_id=None,
                outcome="failure",
                request_id=request_id,
                ip_address=ip_address,
                safe_diff={"reason": "invalid_token"},
                now=now,
            )
            self.db.commit()
            raise AppError(
                status_code=401,
                code="invalid_token",
                message="Refresh token không hợp lệ.",
                headers=clear_headers,
            )

        sess = self.sessions.get_session_for_update(rt_probe.session_id)
        if sess is None:
            raise AppError(
                status_code=401,
                code="invalid_token",
                message="Phiên đăng nhập không tồn tại.",
                headers=clear_headers,
            )

        rt = self.sessions.get_refresh_token_for_update(token_hash)
        if rt is None:
            raise AppError(
                status_code=401,
                code="invalid_token",
                message="Refresh token không hợp lệ.",
                headers=clear_headers,
            )

        user = self.db.scalar(
            select(User).where(User.id == sess.user_id).execution_options(populate_existing=True)
        )
        if user is None:
            raise AppError(
                status_code=401,
                code="invalid_token",
                message="Tài khoản không tồn tại.",
                headers=clear_headers,
            )

        sess_exp = _as_utc(sess.expires_at)
        rt_exp = _as_utc(rt.expires_at)

        if rt.used_at is not None:
            self._handle_refresh_reuse(
                session_id=sess.id,
                user_id=user.id,
                token_id=rt.id,
                ip_address=ip_address,
                request_id=request_id,
                now=now,
                clear_headers=clear_headers,
            )

        if sess.revoked_at is not None:
            if sess.revoke_reason == "expired":
                self._reject_expired_refresh(
                    session_id=sess.id,
                    user_id=user.id,
                    ip_address=ip_address,
                    request_id=request_id,
                    now=now,
                    clear_headers=clear_headers,
                )
            if sess.revoke_reason == "account_disabled" or not user.is_active:
                self._reject_disabled_refresh(
                    session_id=sess.id,
                    user_id=user.id,
                    ip_address=ip_address,
                    request_id=request_id,
                    now=now,
                    clear_headers=clear_headers,
                )
            self._handle_refresh_reuse(
                session_id=sess.id,
                user_id=user.id,
                token_id=rt.id,
                ip_address=ip_address,
                request_id=request_id,
                now=now,
                clear_headers=clear_headers,
            )

        if rt.revoked_at is not None:
            self._handle_refresh_reuse(
                session_id=sess.id,
                user_id=user.id,
                token_id=rt.id,
                ip_address=ip_address,
                request_id=request_id,
                now=now,
                clear_headers=clear_headers,
            )

        if now >= sess_exp or now >= rt_exp:
            self._reject_expired_refresh(
                session_id=sess.id,
                user_id=user.id,
                ip_address=ip_address,
                request_id=request_id,
                now=now,
                clear_headers=clear_headers,
            )

        if not user.is_active:
            self._reject_disabled_refresh(
                session_id=sess.id,
                user_id=user.id,
                ip_address=ip_address,
                request_id=request_id,
                now=now,
                clear_headers=clear_headers,
            )

        if user.password_changed_at is not None and _as_utc(sess.created_at) < _as_utc(
            user.password_changed_at
        ):
            self.sessions.revoke_session_family(
                sess.id,
                reason="password_changed",
                now=now,
            )
            self.audits.record_event(
                actor_type="user",
                actor_id=user.id,
                action="auth.refresh",
                resource_type="session",
                resource_id=str(sess.id),
                outcome="failure",
                request_id=request_id,
                ip_address=ip_address,
                safe_diff={"reason": "password_changed"},
                now=now,
            )
            self.db.commit()
            raise AppError(
                status_code=401,
                code="unauthenticated",
                message="Phiên làm mới đã hết hiệu lực do thay đổi mật khẩu.",
                headers=clear_headers,
            )

        new_raw, new_hash = generate_refresh_token()
        rt.used_at = now
        successor = self.sessions.create_successor_refresh_token(
            session_id=sess.id,
            token_hash=new_hash,
            expires_at=sess_exp,
            now=now,
        )
        rt.replaced_by_id = successor.id

        access_token = issue_access_token(
            user_id=user.id,
            session_id=sess.id,
            role=user.role,  # type: ignore[arg-type]
            key_material=keys,
            settings=self.settings,
            now=now,
        )
        self.audits.record_event(
            actor_type="user",
            actor_id=user.id,
            action="auth.refresh",
            resource_type="session",
            resource_id=str(sess.id),
            outcome="success",
            request_id=request_id,
            ip_address=ip_address,
            safe_diff=None,
            now=now,
        )
        self.db.commit()

        envelope = AuthTokenResponse(
            access_token=access_token,
            token_type="bearer",
            expires_in=self.settings.JWT_ACCESS_TTL_SECONDS,
            user=UserOut.model_validate(user),
        )
        return envelope, new_raw, sess_exp

    def _handle_refresh_reuse(
        self,
        *,
        session_id: uuid.UUID,
        user_id: uuid.UUID,
        token_id: uuid.UUID,
        ip_address: str,
        request_id: str,
        now: datetime,
        clear_headers: dict[str, str],
    ) -> None:
        self.sessions.revoke_session_family(
            session_id,
            reason="refresh_reused",
            now=now,
            overwrite_reason=True,
        )
        self.audits.record_event(
            actor_type="user",
            actor_id=user_id,
            action="auth.refresh_reused",
            resource_type="session",
            resource_id=str(session_id),
            outcome="failure",
            request_id=request_id,
            ip_address=ip_address,
            safe_diff={"token_id": str(token_id)},
            now=now,
        )
        self.db.commit()
        raise AppError(
            status_code=401,
            code="refresh_reused",
            message="Phát hiện tái sử dụng refresh token. Toàn bộ phiên đã bị thu hồi.",
            headers=clear_headers,
        )

    def _reject_expired_refresh(
        self,
        *,
        session_id: uuid.UUID,
        user_id: uuid.UUID,
        ip_address: str,
        request_id: str,
        now: datetime,
        clear_headers: dict[str, str],
    ) -> None:
        self.sessions.revoke_session_family(session_id, reason="expired", now=now)
        self.audits.record_event(
            actor_type="user",
            actor_id=user_id,
            action="auth.refresh",
            resource_type="session",
            resource_id=str(session_id),
            outcome="failure",
            request_id=request_id,
            ip_address=ip_address,
            safe_diff={"reason": "token_expired"},
            now=now,
        )
        self.db.commit()
        raise AppError(
            status_code=401,
            code="token_expired",
            message="Phiên làm mới đã hết hạn.",
            headers=clear_headers,
        )

    def _reject_disabled_refresh(
        self,
        *,
        session_id: uuid.UUID,
        user_id: uuid.UUID,
        ip_address: str,
        request_id: str,
        now: datetime,
        clear_headers: dict[str, str],
    ) -> None:
        self.sessions.revoke_session_family(session_id, reason="account_disabled", now=now)
        self.audits.record_event(
            actor_type="user",
            actor_id=user_id,
            action="auth.refresh",
            resource_type="session",
            resource_id=str(session_id),
            outcome="failure",
            request_id=request_id,
            ip_address=ip_address,
            safe_diff={"reason": "account_disabled"},
            now=now,
        )
        self.db.commit()
        raise AppError(
            status_code=401,
            code="account_disabled",
            message="Tài khoản hiện đang bị vô hiệu hóa.",
            headers=clear_headers,
        )

    def logout(
        self,
        *,
        raw_refresh_token: str | None,
        bearer_token: str | None,
        ip_address: str,
        request_id: str,
    ) -> None:
        """Idempotently revoke session family identified by cookie and/or bearer token."""
        now = datetime.now(UTC)
        candidate_ids: list[uuid.UUID] = []
        actor_id: uuid.UUID | None = None

        if raw_refresh_token:
            rt = self.sessions.get_refresh_token_by_hash(hash_refresh_token(raw_refresh_token))
            if rt is not None:
                sess = self.sessions.get_session_by_id(rt.session_id)
                if sess is not None:
                    actor_id = sess.user_id
                    candidate_ids.append(sess.id)

        if bearer_token and self.key_material is not None:
            try:
                claims = decode_access_token(
                    bearer_token,
                    key_material=self.key_material,
                    settings=self.settings,
                    verify_exp=False,
                )
            except AppError:
                claims = None
            if claims is not None:
                actor_id = actor_id or claims.sub
                if claims.sid not in candidate_ids:
                    candidate_ids.append(claims.sid)

        for sid in sorted(set(candidate_ids)):
            self.sessions.revoke_session_family(sid, reason="logout", now=now)

        self.audits.record_event(
            actor_type="user",
            actor_id=actor_id,
            action="auth.logout",
            resource_type="session",
            resource_id=str(candidate_ids[0]) if candidate_ids else None,
            outcome="success",
            request_id=request_id,
            ip_address=ip_address,
            safe_diff=None,
            now=now,
        )
        self.db.commit()

    def change_password(
        self,
        *,
        user: User,
        current_password: str,
        new_password: str,
        ip_address: str,
        request_id: str,
    ) -> None:
        """Verify current password, store new Argon2id hash, and revoke all user sessions."""
        initial_hash = user.password_hash
        if not verify_password(initial_hash, current_password):
            fail_now = datetime.now(UTC)
            self.audits.record_event(
                actor_type="user",
                actor_id=user.id,
                action="auth.change_password",
                resource_type="user",
                resource_id=str(user.id),
                outcome="failure",
                request_id=request_id,
                ip_address=ip_address,
                safe_diff={"reason": "invalid_current_password"},
                now=fail_now,
            )
            self.db.commit()
            raise AppError(
                status_code=400,
                code="invalid_credentials",
                message="Mật khẩu hiện tại không chính xác.",
            )

        validate_password_policy(new_password)
        if new_password == current_password:
            raise AppError(
                status_code=422,
                code="validation_error",
                message="Mật khẩu mới phải khác mật khẩu hiện tại.",
                details=[
                    {
                        "field": "new_password",
                        "reason": "Mật khẩu mới phải khác mật khẩu hiện tại.",
                        "type": "value_error",
                    }
                ],
            )

        new_hash = hash_password(new_password)
        locked_user = self._lock_user_by_id(user.id)
        if locked_user is None or not locked_user.is_active:
            raise AppError(
                status_code=401,
                code="account_disabled",
                message="Tài khoản hiện đang bị vô hiệu hóa.",
            )
        if locked_user.password_hash != initial_hash:
            fail_now = datetime.now(UTC)
            self.audits.record_event(
                actor_type="user",
                actor_id=locked_user.id,
                action="auth.change_password",
                resource_type="user",
                resource_id=str(locked_user.id),
                outcome="failure",
                request_id=request_id,
                ip_address=ip_address,
                safe_diff={"reason": "invalid_current_password"},
                now=fail_now,
            )
            self.db.commit()
            raise AppError(
                status_code=400,
                code="invalid_credentials",
                message="Mật khẩu hiện tại không chính xác.",
            )

        now = datetime.now(UTC)
        locked_user.password_hash = new_hash
        locked_user.must_change_password = False
        locked_user.password_changed_at = now
        locked_user.updated_at = now

        revoked_count = self.sessions.revoke_all_user_sessions(
            locked_user.id,
            reason="password_changed",
            now=now,
        )
        self.audits.record_event(
            actor_type="user",
            actor_id=locked_user.id,
            action="auth.change_password",
            resource_type="user",
            resource_id=str(locked_user.id),
            outcome="success",
            request_id=request_id,
            ip_address=ip_address,
            safe_diff={"sessions_revoked": revoked_count},
            now=now,
        )
        self.db.commit()
