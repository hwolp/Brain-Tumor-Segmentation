"""Pydantic schemas for Admin AI benchmark & ground-truth evaluation endpoints."""

from __future__ import annotations

import uuid
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

from app.schemas.common import UTCDatetime
from app.schemas.jobs import JobStage, JobState

BenchmarkArtifactKind = Literal["flair", "t1ce", "gt_mask", "pred_mask"]


class BenchmarkRegionMetricsOut(BaseModel):
    dice: float
    iou: float
    precision: float
    recall: float
    gt_voxels: int
    pred_voxels: int
    tp_voxels: int
    fp_voxels: int
    fn_voxels: int
    gt_volume_ml: float
    pred_volume_ml: float
    volume_diff_ml: float
    both_empty: bool


class BenchmarkCropCaptureOut(BaseModel):
    gt_wt_voxels: int
    inside_crop_voxels: int
    outside_crop_voxels: int
    capture_recall: float


class BenchmarkMetricsOut(BaseModel):
    voxel_volume_mm3: float
    mean_dice_brats: float
    best_slice_z: int
    regions: dict[Literal["WT", "TC", "ET"], BenchmarkRegionMetricsOut]
    labels: dict[Literal["1", "2", "4"], BenchmarkRegionMetricsOut]
    crop_capture: BenchmarkCropCaptureOut | None = None


class AdminBenchmarkSummaryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    title: str
    notes: str | None
    target_worker_id: str
    executed_worker_id: str | None
    worker_device_type: str | None
    model_version_id: str | None
    state: JobState
    stage: JobStage
    completed_slices: int | None
    total_slices: int | None
    error_code: str | None
    mean_dice_brats: float | None
    wt_dice: float | None
    tc_dice: float | None
    et_dice: float | None
    inference_duration_ms: int | None
    created_at: UTCDatetime
    started_at: UTCDatetime | None
    finished_at: UTCDatetime | None


class AdminBenchmarkDetailOut(AdminBenchmarkSummaryOut):
    shape: list[int]
    spacing_mm: list[float]
    affine: list[list[float]]
    metrics: BenchmarkMetricsOut | None
    coverage: dict[str, Any] | None
    has_pred_mask: bool
    created_by_username: str


class BenchmarkDeletionOut(BaseModel):
    resource_type: Literal["admin_benchmark"] = "admin_benchmark"
    resource_id: uuid.UUID
    status: Literal["deleted"] = "deleted"
    files_cleaned: int = 0
    message: str
