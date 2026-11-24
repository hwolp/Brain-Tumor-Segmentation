"""SystemSetting repository."""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.system_setting import SystemSetting


class SystemSettingRepository:
    """Data access helpers for allowlisted system settings."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def get_by_key(self, key: str) -> SystemSetting | None:
        return self.db.scalar(select(SystemSetting).where(SystemSetting.key == key))

    def upsert(
        self,
        *,
        key: str,
        value_json: dict[str, Any],
        updated_by: uuid.UUID | None = None,
    ) -> SystemSetting:
        existing = self.get_by_key(key)
        if existing is not None:
            existing.value_json = value_json
            existing.updated_by = updated_by
            self.db.flush()
            return existing

        setting = SystemSetting(key=key, value_json=value_json, updated_by=updated_by)
        self.db.add(setting)
        self.db.flush()
        return setting
