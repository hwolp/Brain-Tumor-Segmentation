"""Patient and deletion status Pydantic schemas."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.common import UTCDatetime

PatientSex = Literal["male", "female", "other", "unknown"]
_VN_TZ = ZoneInfo("Asia/Ho_Chi_Minh")


def _current_vn_year() -> int:
    return datetime.now(_VN_TZ).year


def _validate_trimmed_text(value: str, *, field_label: str, max_len: int) -> str:
    trimmed = value.strip()
    if not trimmed:
        raise ValueError(f"{field_label} must not be empty")
    if len(trimmed) > max_len:
        raise ValueError(f"{field_label} must be at most {max_len} characters")
    return trimmed


def _validate_birth_year(value: int) -> int:
    current_year = _current_vn_year()
    if value < 1900 or value > current_year:
        raise ValueError(f"birth_year must be between 1900 and {current_year}")
    return value


class PatientCreateRequest(BaseModel):
    """Strict payload for creating a doctor-owned patient."""

    model_config = ConfigDict(extra="forbid")

    patient_code: str = Field(min_length=1, max_length=50)
    full_name: str = Field(min_length=1, max_length=150)
    birth_year: int = Field(ge=1900)
    sex: PatientSex

    @field_validator("patient_code")
    @classmethod
    def _validate_code(cls, value: str) -> str:
        return _validate_trimmed_text(value, field_label="patient_code", max_len=50)

    @field_validator("full_name")
    @classmethod
    def _validate_name(cls, value: str) -> str:
        return _validate_trimmed_text(value, field_label="full_name", max_len=150)

    @field_validator("birth_year")
    @classmethod
    def _validate_year(cls, value: int) -> int:
        return _validate_birth_year(value)


class PatientUpdateRequest(BaseModel):
    """Strict payload for updating allowed patient metadata fields."""

    model_config = ConfigDict(extra="forbid")

    patient_code: str | None = Field(default=None, min_length=1, max_length=50)
    full_name: str | None = Field(default=None, min_length=1, max_length=150)
    birth_year: int | None = Field(default=None, ge=1900)
    sex: PatientSex | None = None

    @field_validator("patient_code")
    @classmethod
    def _validate_code(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _validate_trimmed_text(value, field_label="patient_code", max_len=50)

    @field_validator("full_name")
    @classmethod
    def _validate_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return _validate_trimmed_text(value, field_label="full_name", max_len=150)

    @field_validator("birth_year")
    @classmethod
    def _validate_year(cls, value: int | None) -> int | None:
        if value is None:
            return None
        return _validate_birth_year(value)


class PatientOut(BaseModel):
    """Public patient representation."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    owner_id: uuid.UUID
    patient_code: str
    full_name: str
    birth_year: int
    sex: PatientSex
    case_count: int = Field(default=0, ge=0)
    created_at: UTCDatetime
    updated_at: UTCDatetime


class DeletionStatusOut(BaseModel):
    """Deletion status response returned by 202 DELETE endpoints."""

    resource_type: Literal["patient", "case", "volume", "mask_version"]
    resource_id: uuid.UUID
    status: Literal["deleting", "deleted"]
    files_cleaned: int = Field(default=0, ge=0)
    message: str
