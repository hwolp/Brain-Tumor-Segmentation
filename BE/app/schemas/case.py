"""Case Pydantic schemas."""

from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.common import UTCDatetime

CaseReadiness = Literal["missing_inputs", "validating", "ready", "invalid"]
_VN_TZ = ZoneInfo("Asia/Ho_Chi_Minh")


def _validate_study_date_not_future(value: date) -> date:
    today_vn = datetime.now(_VN_TZ).date()
    if value > today_vn:
        raise ValueError("study_date must not be in the future (Asia/Ho_Chi_Minh)")
    return value


class CaseCreateRequest(BaseModel):
    """Strict payload for creating a clinical study case."""

    model_config = ConfigDict(extra="forbid")

    study_date: date
    notes: str | None = Field(default=None, max_length=5000)

    @field_validator("study_date")
    @classmethod
    def _check_study_date(cls, value: date) -> date:
        return _validate_study_date_not_future(value)


class CaseUpdateRequest(BaseModel):
    """Strict payload for updating case study_date or notes."""

    model_config = ConfigDict(extra="forbid")

    study_date: date | None = None
    notes: str | None = Field(default=None, max_length=5000)

    @field_validator("study_date")
    @classmethod
    def _check_study_date(cls, value: date | None) -> date | None:
        if value is None:
            return None
        return _validate_study_date_not_future(value)


class CaseOut(BaseModel):
    """Public case representation including readiness and inference blocking reasons."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    patient_id: uuid.UUID
    patient_code: str | None = None
    owner_id: uuid.UUID
    study_date: date
    notes: str | None
    reference_volume_id: uuid.UUID | None
    readiness: CaseReadiness
    input_revision: int = Field(ge=0)
    inputs_locked_at: UTCDatetime | None
    is_inputs_locked: bool = False
    latest_mask_version_id: uuid.UUID | None
    latest_job_state: Literal["queued", "running", "succeeded", "failed", "cancelled"] | None = None
    can_run_inference: bool = False
    blocking_reasons: list[str] = Field(default_factory=list)
    created_at: UTCDatetime
    updated_at: UTCDatetime
