"""Public and worker-facing inference job schemas."""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.schemas.common import UTCDatetime

JobState = Literal["queued", "running", "succeeded", "failed", "cancelled"]
JobStage = Literal[
    "queued", "loading", "preprocessing", "inference", "reconstructing", "saving", "done"
]
WorkerActiveStage = Literal[
    "loading", "preprocessing", "inference", "reconstructing", "saving"
]


class InferenceJobOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    case_id: uuid.UUID
    model_version_id: str
    state: JobState
    stage: JobStage
    completed_slices: int | None
    total_slices: int | None
    attempt_count: int
    max_auto_retries: int
    error_code: str | None
    created_at: UTCDatetime
    started_at: UTCDatetime | None
    finished_at: UTCDatetime | None
    result_mask_version_id: uuid.UUID | None


class JobCreateResponse(BaseModel):
    job: InferenceJobOut


class WorkerHeartbeatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    worker_id: str = Field(min_length=1, max_length=128)
    device_type: Literal["CPU", "GPU"]
    model_version_id: str | None = Field(default=None, max_length=128)


class WorkerClaimRequest(WorkerHeartbeatRequest):
    pass


class WorkerInputFile(BaseModel):
    volume_id: uuid.UUID
    file_id: uuid.UUID
    modality: Literal["flair", "t1ce"]
    sha256: str
    extension: Literal["nii", "nii.gz"]


class WorkerClaimOut(BaseModel):
    job_id: uuid.UUID
    attempt_id: uuid.UUID
    attempt_number: int
    lease_token: str
    lease_expires_at: UTCDatetime
    model_version_id: str
    manifest: dict[str, object]
    files: list[WorkerInputFile]


class WorkerJobHeartbeatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    worker_id: str = Field(min_length=1, max_length=128)
    attempt_id: uuid.UUID
    lease_token: str = Field(min_length=32, max_length=256)
    stage: WorkerActiveStage
    completed_slices: int | None = Field(default=None, ge=0)
    total_slices: int | None = Field(default=None, ge=1)

    @model_validator(mode="after")
    def _validate_slice_progress(self) -> WorkerJobHeartbeatRequest:
        if self.completed_slices is not None and self.total_slices is None:
            raise ValueError("total_slices is required when completed_slices is provided")
        if (
            self.completed_slices is not None
            and self.total_slices is not None
            and self.completed_slices > self.total_slices
        ):
            raise ValueError("completed_slices must not exceed total_slices")
        return self


class WorkerCompleteResponse(BaseModel):
    job: InferenceJobOut


class WorkerFailRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    worker_id: str = Field(min_length=1, max_length=128)
    attempt_id: uuid.UUID
    lease_token: str = Field(min_length=32, max_length=256)
    error_code: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9_]+$")


class WorkerActionResponse(BaseModel):
    accepted: bool = True
    job: InferenceJobOut | None = None


class InternalFileContentOut(BaseModel):
    file_id: uuid.UUID
    job_id: uuid.UUID
    attempt_id: uuid.UUID
    expires_at: UTCDatetime


class AdminOverviewOut(BaseModel):
    active_doctors: int
    locked_doctors: int
    queued_jobs: int
    running_jobs: int
    failed_jobs: int
    storage_used_bytes: int
    storage_quota_bytes: int
    worker_online: bool
    updated_at: UTCDatetime


class SystemAvailabilityOut(BaseModel):
    accepting_jobs: bool
    worker_online: bool
    active_model_id: str | None
    updated_at: UTCDatetime


class AdminJobOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    case_id: uuid.UUID
    doctor_username: str
    model_version: str
    state: JobState
    stage: JobStage
    attempt_count: int
    error_code: str | None
    created_at: UTCDatetime
    started_at: UTCDatetime | None
    finished_at: UTCDatetime | None


class AdminJobAttemptOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    attempt_number: int
    worker_id: str
    state: str
    stage: JobStage
    error_code: str | None
    started_at: UTCDatetime
    finished_at: UTCDatetime | None


class AdminJobDetailOut(AdminJobOut):
    attempts: list[AdminJobAttemptOut]


class AdminWorkerOut(BaseModel):
    worker_id: str
    online: bool
    device_type: Literal["GPU", "CPU"]
    active_jobs: int
    last_heartbeat_at: UTCDatetime
    model_version: str


class AdminModelOut(BaseModel):
    id: str
    name: str
    version: str
    checkpoint_sha256: str
    expected_shape: list[int]
    expected_spacing_mm: list[float]
    is_active: bool
    verified: bool


class AdminSettingsOut(BaseModel):
    version: int
    accepting_jobs: bool
    max_upload_mib: int
    max_decompressed_mib: int
    default_doctor_quota_gib: int
    system_quota_gib: int
    updated_at: UTCDatetime


class AdminSettingsUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: int = Field(ge=1)
    accepting_jobs: bool
    max_upload_mib: int = Field(ge=1, le=100)
    max_decompressed_mib: int = Field(ge=1, le=256)
    default_doctor_quota_gib: int = Field(ge=1, le=100)
    system_quota_gib: int = Field(ge=1, le=1000)


class AuditEventOut(BaseModel):
    id: uuid.UUID
    created_at: UTCDatetime
    actor_username: str
    action: str
    target_id: str
    outcome: Literal["success", "failure"]
    request_id: str
