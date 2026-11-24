"""Admin doctor account management schemas."""

from __future__ import annotations

import re
import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.common import UTCDatetime

USERNAME_REGEX = re.compile(r"^[a-z0-9._-]{3,64}$")


def normalize_and_validate_username(value: object) -> str:
    """Trim/lowercase and validate username format."""
    if not isinstance(value, str):
        raise ValueError("Tên đăng nhập phải là chuỗi ký tự.")
    normalized = value.strip().lower()
    if not USERNAME_REGEX.fullmatch(normalized):
        raise ValueError(
            "Tên đăng nhập phải dài 3-64 ký tự và chỉ gồm chữ thường, số, '.', '_', '-'."
        )
    return normalized


def normalize_and_validate_display_name(value: object) -> str:
    """Trim and validate display name length (1-150)."""
    if not isinstance(value, str):
        raise ValueError("Tên hiển thị phải là chuỗi ký tự.")
    trimmed = value.strip()
    if not (1 <= len(trimmed) <= 150):
        raise ValueError("Tên hiển thị phải dài từ 1 đến 150 ký tự.")
    return trimmed


class AdminDoctorUserOut(BaseModel):
    """Doctor account representation returned by admin endpoints."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    username: str
    display_name: str
    role: Literal["doctor"]
    is_active: bool
    must_change_password: bool
    created_at: UTCDatetime
    updated_at: UTCDatetime


class AdminCreateDoctorRequest(BaseModel):
    """Create doctor account payload."""

    model_config = ConfigDict(extra="forbid")

    username: str
    display_name: str
    temporary_password: str = Field(min_length=12, max_length=128)

    @field_validator("username", mode="before")
    @classmethod
    def _validate_username(cls, value: object) -> str:
        return normalize_and_validate_username(value)

    @field_validator("display_name", mode="before")
    @classmethod
    def _validate_display_name(cls, value: object) -> str:
        return normalize_and_validate_display_name(value)


class AdminUpdateDoctorRequest(BaseModel):
    """Patch doctor display_name and/or active status."""

    model_config = ConfigDict(extra="forbid")

    display_name: str | None = None
    is_active: bool | None = None

    @field_validator("display_name", mode="before")
    @classmethod
    def _validate_display_name(cls, value: object) -> str | None:
        if value is None:
            return None
        return normalize_and_validate_display_name(value)

    @model_validator(mode="after")
    def _validate_non_null_patch(self) -> AdminUpdateDoctorRequest:
        if "display_name" in self.model_fields_set and self.display_name is None:
            raise ValueError("display_name không được để null.")
        if "is_active" in self.model_fields_set and self.is_active is None:
            raise ValueError("is_active không được để null.")
        if self.display_name is None and self.is_active is None:
            raise ValueError("Cần cung cấp ít nhất một trường để cập nhật.")
        return self


class TemporaryPasswordResponse(BaseModel):
    """One-time temporary password returned on admin password reset."""

    temporary_password: str
