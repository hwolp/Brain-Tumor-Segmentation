"""Pydantic schemas for immutable MaskVersion and physical volume metadata export."""

from __future__ import annotations

import uuid
from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, field_validator

from app.schemas.common import UTCDatetime

MaskSource = Literal["ai", "manual"]


class MaskVersionOut(BaseModel):
    """Public representation of an immutable segmentation mask version."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    case_id: uuid.UUID
    version_number: int
    source: MaskSource
    base_version_id: uuid.UUID | None
    reference_volume_id: uuid.UUID
    file_id: uuid.UUID
    created_by: uuid.UUID | None
    created_by_name: str | None = None
    job_id: uuid.UUID | None
    model_version_id: str | None
    coverage_file_id: uuid.UUID | None
    note: str | None
    label_voxel_counts: dict[str, int]
    label_volumes_mm3: dict[str, float]
    composite_volumes_mm3: dict[str, float] | None
    sha256: str
    created_at: UTCDatetime


class MaskVersionNoteUpdateRequest(BaseModel):
    """Request body for updating the clinical/technical note of a mask version."""

    model_config = ConfigDict(extra="forbid")

    note: str | None = None

    @field_validator("note")
    @classmethod
    def _normalize_note(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = value.strip()
        if not stripped:
            return None
        if len(stripped) > 2000:
            raise ValueError("Ghi chú phiên bản mask không được vượt quá 2000 ký tự.")
        return stripped


class MaskGeometryOut(BaseModel):
    """Reference 3D grid geometry for a mask version."""

    shape: list[int]
    spacing_mm: list[float]
    affine: list[list[float]]
    orientation: str
    units: str = "mm"


class MaskCoverageOut(BaseModel):
    """AI evaluation coverage provenance and clinical boundary clarification."""

    status: str
    coverage_file_id: uuid.UUID | None
    note: str


class MaskLabelStatOut(BaseModel):
    """Per-label physical volume statistics."""

    label: int
    name: str
    voxel_count: int
    volume_mm3: float
    volume_ml: float


class MaskCompositeStatOut(BaseModel):
    """Composite region physical volume statistics (non-additive across overlapping groups)."""

    group: str
    labels: list[int]
    volume_mm3: float
    volume_ml: float


class MaskStatisticsOut(BaseModel):
    """Complete server-computed physical volume statistics for a mask version."""

    voxel_volume_mm3: float
    per_label: list[MaskLabelStatOut]
    composite_groups: list[MaskCompositeStatOut]
    total_foreground_voxels: int
    total_foreground_volume_mm3: float
    total_foreground_volume_ml: float


class MaskMetadataExportOut(BaseModel):
    """Non-PII technical metadata and physical volume summary for a mask version."""

    version_id: uuid.UUID
    case_id: uuid.UUID
    study_date: date
    version_number: int
    source: MaskSource
    base_version_id: uuid.UUID | None
    reference_volume_id: uuid.UUID
    model_version_id: str | None
    job_id: uuid.UUID | None
    coverage: MaskCoverageOut
    geometry: MaskGeometryOut
    labels: dict[str, str]
    statistics: MaskStatisticsOut
    sha256: str
    created_by_name: str | None
    created_at: UTCDatetime
