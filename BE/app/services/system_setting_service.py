"""SystemSetting service with optimistic concurrency and server hard-limit validation."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.errors import AppError
from app.models.system_setting import SystemSetting
from app.repositories.audit_repo import AuditRepository
from app.repositories.system_setting_repo import SystemSettingRepository
from app.schemas.jobs import AdminSettingsOut, AdminSettingsUpdate

_MIB = 1024**2
_GIB = 1024**3


class SystemSettingService:
    """Service layer for reading and updating runtime system settings."""

    def __init__(self, db: Session, settings: Settings) -> None:
        self.db = db
        self.settings = settings
        self.system_settings = SystemSettingRepository(db)
        self.audits = AuditRepository(db)

    def get_current_values(self) -> tuple[dict[str, object], datetime]:
        """Return merged runtime settings dictionary and last update timestamp."""
        row = self.system_settings.get_by_key("admin_settings")
        values = dict(row.value_json) if row is not None else {}
        values.setdefault("version", 1)
        values.setdefault("accepting_jobs", True)
        values.setdefault("max_upload_mib", max(1, self.settings.MAX_UPLOAD_BYTES // _MIB))
        values.setdefault(
            "max_decompressed_mib", max(1, self.settings.MAX_DECOMPRESSED_BYTES // _MIB)
        )
        values.setdefault(
            "default_doctor_quota_gib", max(1, self.settings.DOCTOR_QUOTA_BYTES // _GIB)
        )
        values.setdefault("system_quota_gib", max(1, self.settings.SYSTEM_QUOTA_BYTES // _GIB))
        return values, row.updated_at if row is not None else datetime.now(UTC)

    def get_settings(self) -> AdminSettingsOut:
        """Return current admin-configurable system settings."""
        values, updated_at = self.get_current_values()
        return AdminSettingsOut(**values, updated_at=updated_at)

    def _validate_settings_hard_limits(self, payload: AdminSettingsUpdate) -> None:
        violations: list[dict[str, str]] = []
        if int(payload.max_upload_mib) * _MIB > self.settings.MAX_UPLOAD_BYTES:
            violations.append(
                {
                    "field": "max_upload_mib",
                    "reason": (
                        "Giới hạn tải lên vượt quá trần phần cứng MAX_UPLOAD_BYTES của máy chủ."
                    ),
                    "type": "value_error",
                }
            )
        if int(payload.max_decompressed_mib) * _MIB > self.settings.MAX_DECOMPRESSED_BYTES:
            violations.append(
                {
                    "field": "max_decompressed_mib",
                    "reason": (
                        "Giới hạn giải nén vượt quá trần MAX_DECOMPRESSED_BYTES của máy chủ."
                    ),
                    "type": "value_error",
                }
            )
        if int(payload.default_doctor_quota_gib) * _GIB > self.settings.DOCTOR_QUOTA_BYTES:
            violations.append(
                {
                    "field": "default_doctor_quota_gib",
                    "reason": "Hạn mức bác sĩ vượt quá trần DOCTOR_QUOTA_BYTES của máy chủ.",
                    "type": "value_error",
                }
            )
        if int(payload.system_quota_gib) * _GIB > self.settings.SYSTEM_QUOTA_BYTES:
            violations.append(
                {
                    "field": "system_quota_gib",
                    "reason": "Hạn mức hệ thống vượt quá trần SYSTEM_QUOTA_BYTES của máy chủ.",
                    "type": "value_error",
                }
            )
        if int(payload.default_doctor_quota_gib) > int(payload.system_quota_gib):
            violations.append(
                {
                    "field": "default_doctor_quota_gib",
                    "reason": (
                        "Hạn mức mặc định của bác sĩ không được vượt quá hạn mức toàn hệ thống."
                    ),
                    "type": "value_error",
                }
            )
        if violations:
            raise AppError(
                status_code=422,
                code="validation_error",
                message="Cấu hình vượt quá giới hạn phần cứng hoặc không hợp lệ.",
                details=violations,
            )

    def update_settings(
        self,
        *,
        actor_id: uuid.UUID,
        payload: AdminSettingsUpdate,
        request_id: str,
        ip_address: str,
    ) -> AdminSettingsOut:
        """Validate hard limits, enforce optimistic version lock, and persist settings."""
        self._validate_settings_hard_limits(payload)
        row = self.db.scalar(
            select(SystemSetting)
            .where(SystemSetting.key == "admin_settings")
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        current, _ = self.get_current_values()
        current_version = int(current["version"])
        if payload.version != current_version:
            raise AppError(
                status_code=409,
                code="settings_version_conflict",
                message=(
                    "Cấu hình đã được thay đổi bởi quản trị viên khác. "
                    "Hãy tải lại trước khi lưu."
                ),
            )
        previous = current.copy()
        values = payload.model_dump(exclude={"version"})
        doc_bytes = int(payload.default_doctor_quota_gib) * _GIB
        system_bytes = int(payload.system_quota_gib) * _GIB
        next_values = {
            **values,
            "version": current_version + 1,
        }
        try:
            if row is None:
                row = SystemSetting(
                    key="admin_settings", value_json=next_values, updated_by=actor_id
                )
                self.db.add(row)
            else:
                row.value_json = next_values
                row.updated_by = actor_id
            self.system_settings.upsert(
                key="doctor_quota_bytes", value_json={"bytes": doc_bytes}, updated_by=actor_id
            )
            self.system_settings.upsert(
                key="system_quota_bytes", value_json={"bytes": system_bytes}, updated_by=actor_id
            )
            changed = {
                key: value for key, value in next_values.items() if previous.get(key) != value
            }
            self.audits.record_event(
                actor_type="user",
                actor_id=actor_id,
                action="admin.settings_update",
                resource_type="admin_settings",
                resource_id="admin_settings",
                outcome="success",
                request_id=request_id,
                ip_address=ip_address,
                safe_diff={"changed_fields": sorted(changed), "version": next_values["version"]},
            )
            self.db.commit()
        except IntegrityError as exc:
            self.db.rollback()
            raise AppError(
                status_code=409,
                code="settings_version_conflict",
                message=(
                    "Cấu hình đã được thay đổi bởi quản trị viên khác. "
                    "Hãy tải lại trước khi lưu."
                ),
            ) from exc
        return self.get_settings()
