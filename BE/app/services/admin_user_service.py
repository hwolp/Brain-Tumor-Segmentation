"""Admin doctor account management service."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.security import (
    generate_temporary_password,
    hash_password,
    validate_password_policy,
)
from app.models.user import User
from app.repositories.audit_repo import AuditRepository
from app.repositories.session_repo import SessionRepository
from app.repositories.user_repo import UserRepository
from app.schemas.admin_user import (
    AdminCreateDoctorRequest,
    AdminDoctorUserOut,
    AdminUpdateDoctorRequest,
    TemporaryPasswordResponse,
)
from app.schemas.common import PaginatedResponse


class AdminUserService:
    """Service layer for admin management of doctor accounts."""

    def __init__(self, db: Session) -> None:
        self.db = db
        self.users = UserRepository(db)
        self.sessions = SessionRepository(db)
        self.audits = AuditRepository(db)

    def _get_doctor_or_raise(
        self,
        user_id: uuid.UUID,
        *,
        for_update: bool = False,
    ) -> User:
        if for_update:
            target = self.db.scalar(
                select(User)
                .where(User.id == user_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        else:
            target = self.users.get_by_id(user_id)
        if target is None:
            raise AppError(
                status_code=404,
                code="not_found",
                message="Không tìm thấy tài khoản bác sĩ.",
            )
        if target.role != "doctor":
            raise AppError(
                status_code=403,
                code="forbidden",
                message="Không được phép thao tác với tài khoản quản trị qua endpoint bác sĩ.",
            )
        return target

    def list_doctors(
        self,
        *,
        q: str | None = None,
        status: Literal["active", "locked"] | None = None,
        is_active: bool | None = None,
        page: int = 1,
        page_size: int = 20,
    ) -> PaginatedResponse[AdminDoctorUserOut]:
        """List doctor accounts with search, active/locked filtering, and pagination."""
        status_filter = None if status is None else (status == "active")
        if status_filter is not None and is_active is not None and status_filter != is_active:
            return PaginatedResponse[AdminDoctorUserOut](
                items=[],
                total=0,
                page=page,
                page_size=page_size,
            )

        effective_active = is_active if is_active is not None else status_filter
        users, total = self.users.list_doctors(
            q=q,
            is_active=effective_active,
            page=page,
            page_size=page_size,
        )
        return PaginatedResponse[AdminDoctorUserOut](
            items=[AdminDoctorUserOut.model_validate(item) for item in users],
            total=total,
            page=page,
            page_size=page_size,
        )

    def create_doctor(
        self,
        *,
        admin: User,
        payload: AdminCreateDoctorRequest,
        ip_address: str,
        request_id: str,
    ) -> AdminDoctorUserOut:
        """Create a doctor account with forced password change on first login."""
        if self.users.get_by_username(payload.username) is not None:
            raise AppError(
                status_code=409,
                code="username_conflict",
                message="Tên đăng nhập đã tồn tại.",
            )

        validate_password_policy(payload.temporary_password)
        now = datetime.now(UTC)

        try:
            doctor = self.users.create(
                username=payload.username,
                display_name=payload.display_name,
                password_hash=hash_password(payload.temporary_password),
                role="doctor",
                is_active=True,
                must_change_password=True,
                password_changed_at=None,
                now=now,
            )
        except IntegrityError as exc:
            self.db.rollback()
            raise AppError(
                status_code=409,
                code="username_conflict",
                message="Tên đăng nhập đã tồn tại.",
            ) from exc

        self.audits.record_event(
            actor_type="user",
            actor_id=admin.id,
            action="admin.user_create",
            resource_type="user",
            resource_id=str(doctor.id),
            outcome="success",
            request_id=request_id,
            ip_address=ip_address,
            safe_diff={
                "username": doctor.username,
                "role": "doctor",
                "is_active": True,
                "must_change_password": True,
            },
            now=now,
        )
        self.db.commit()
        self.db.refresh(doctor)
        return AdminDoctorUserOut.model_validate(doctor)

    def update_doctor(
        self,
        *,
        admin: User,
        target_user_id: uuid.UUID,
        payload: AdminUpdateDoctorRequest,
        ip_address: str,
        request_id: str,
    ) -> AdminDoctorUserOut:
        """Update doctor display_name or active status, revoking sessions on disable."""
        target = self._get_doctor_or_raise(target_user_id, for_update=True)
        now = datetime.now(UTC)
        diff: dict[str, Any] = {}
        action = "admin.user_update"

        if payload.display_name is not None and payload.display_name != target.display_name:
            diff["display_name"] = {"from": target.display_name, "to": payload.display_name}
            target.display_name = payload.display_name

        if payload.is_active is not None:
            active_changed = payload.is_active != target.is_active
            if active_changed:
                diff["is_active"] = {"from": target.is_active, "to": payload.is_active}
                action = "admin.user_enable" if payload.is_active else "admin.user_disable"
                target.is_active = payload.is_active
            if not payload.is_active:
                revoked_count = self.sessions.revoke_all_user_sessions(
                    target.id,
                    reason="account_disabled",
                    now=now,
                )
                if active_changed or revoked_count > 0:
                    diff["sessions_revoked"] = revoked_count
                    if not active_changed:
                        action = "admin.user_disable"

        if not diff:
            self.db.commit()
            return AdminDoctorUserOut.model_validate(target)

        target.updated_at = now
        self.audits.record_event(
            actor_type="user",
            actor_id=admin.id,
            action=action,
            resource_type="user",
            resource_id=str(target.id),
            outcome="success",
            request_id=request_id,
            ip_address=ip_address,
            safe_diff=diff,
            now=now,
        )
        self.db.commit()
        self.db.refresh(target)
        return AdminDoctorUserOut.model_validate(target)

    def reset_doctor_password(
        self,
        *,
        admin: User,
        target_user_id: uuid.UUID,
        ip_address: str,
        request_id: str,
    ) -> TemporaryPasswordResponse:
        """Generate a one-time temporary password, force password change, and revoke sessions."""
        self._get_doctor_or_raise(target_user_id, for_update=False)
        temporary_password = generate_temporary_password(20)
        new_hash = hash_password(temporary_password)

        target = self._get_doctor_or_raise(target_user_id, for_update=True)
        now = datetime.now(UTC)

        target.password_hash = new_hash
        target.must_change_password = True
        target.password_changed_at = now
        target.updated_at = now

        revoked_count = self.sessions.revoke_all_user_sessions(
            target.id,
            reason="password_reset",
            now=now,
        )
        self.audits.record_event(
            actor_type="user",
            actor_id=admin.id,
            action="admin.user_reset_password",
            resource_type="user",
            resource_id=str(target.id),
            outcome="success",
            request_id=request_id,
            ip_address=ip_address,
            safe_diff={"must_change_password": True, "sessions_revoked": revoked_count},
            now=now,
        )
        self.db.commit()
        return TemporaryPasswordResponse(temporary_password=temporary_password)
