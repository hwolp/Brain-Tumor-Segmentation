"""Volume Pydantic schemas."""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.schemas.common import UTCDatetime

VolumeModality = Literal["flair", "t1ce"]
VolumeValidationStatus = Literal["validating", "valid", "invalid"]


class VolumeOut(BaseModel):
    """Public NIfTI volume metadata (never exposes internal storage_key)."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    case_id: uuid.UUID
    modality: VolumeModality
    file_id: uuid.UUID
    filename: str | None = None
    shape: list[int]
    spacing_mm: list[float]
    affine: list[list[float]]
    orientation: str
    datatype: str
    size_bytes: int = Field(ge=0)
    sha256: str
    validation_status: VolumeValidationStatus
    validation_errors: list[str] = Field(default_factory=list)
    model_profile_compatible: bool = False
    model_profile_warnings: list[str] = Field(default_factory=list)
    created_at: UTCDatetime
