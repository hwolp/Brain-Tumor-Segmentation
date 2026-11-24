"""Service-authenticated worker and lease-protected input/artifact endpoints."""

from __future__ import annotations

import hmac
import uuid
from collections.abc import Iterator
from typing import Annotated

from fastapi import APIRouter, Depends, File, Header, Request, Response, UploadFile, status
from fastapi.responses import StreamingResponse

from app.core.errors import AppError
from app.dependencies import DbSessionDep, RequestIdDep, SettingsDep, StorageDep
from app.schemas.error import ErrorResponse
from app.schemas.jobs import (
    InferenceJobOut,
    WorkerActionResponse,
    WorkerClaimOut,
    WorkerClaimRequest,
    WorkerCompleteResponse,
    WorkerFailRequest,
    WorkerHeartbeatRequest,
    WorkerJobHeartbeatRequest,
)
from app.services.job_service import JobService


def require_worker_token(
    request: Request,
    settings: SettingsDep,
    token: Annotated[str | None, Header(alias="X-Worker-Token")] = None,
) -> None:
    expected = settings.WORKER_TOKEN
    if not expected or not token or not hmac.compare_digest(expected, token):
        raise AppError(
            status_code=401, code="worker_unauthenticated", message="Thông tin worker không hợp lệ."
        )


router = APIRouter(
    prefix="/api/v1/internal",
    tags=["internal worker"],
    dependencies=[Depends(require_worker_token)],
    responses={
        401: {"model": ErrorResponse, "description": "Invalid worker credential"},
        409: {"model": ErrorResponse, "description": "Stale lease"},
    },
)


@router.post("/worker/heartbeat", status_code=status.HTTP_204_NO_CONTENT)
def heartbeat_worker(
    payload: WorkerHeartbeatRequest,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
) -> None:
    JobService(db, storage, settings).heartbeat_worker(
        worker_id=payload.worker_id,
        device_type=payload.device_type,
        model_version_id=payload.model_version_id,
    )


@router.post(
    "/worker/claim",
    response_model=WorkerClaimOut,
    responses={status.HTTP_204_NO_CONTENT: {"description": "No queued job available"}},
)
def claim_job(
    payload: WorkerClaimRequest,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
) -> WorkerClaimOut | Response:
    claimed = JobService(db, storage, settings).claim_job(
        worker_id=payload.worker_id,
        device_type=payload.device_type,
        model_version_id=payload.model_version_id,
    )
    if claimed is None:
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    return claimed


@router.get("/files/{file_id}/content")
def download_input_file(
    file_id: uuid.UUID,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    job_id: Annotated[uuid.UUID, Header(alias="X-Job-ID")],
    attempt_id: Annotated[uuid.UUID, Header(alias="X-Attempt-ID")],
    worker_id: Annotated[str, Header(alias="X-Worker-ID")],
    lease_token: Annotated[str, Header(alias="X-Lease-Token")],
) -> StreamingResponse:
    stored_file = JobService(db, storage, settings).authorize_input_file(
        file_id=file_id,
        job_id=job_id,
        attempt_id=attempt_id,
        worker_id=worker_id,
        lease_token=lease_token,
    )
    if stored_file.storage_key is None:
        raise AppError(
            status_code=404, code="file_not_found", message="Không tìm thấy tệp dữ liệu."
        )
    try:
        handle = storage.open(str(stored_file.storage_key), "rb")
    except FileNotFoundError as exc:
        raise AppError(
            status_code=404, code="file_not_found", message="Không tìm thấy tệp dữ liệu."
        ) from exc
    filename = (
        f"volume-{stored_file.id}.nii.gz"
        if stored_file.media_type == "application/gzip"
        else f"volume-{stored_file.id}.nii"
    )
    return StreamingResponse(
        _iter_file_chunks(handle),
        media_type=stored_file.media_type,
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(stored_file.size_bytes),
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.post("/jobs/{job_id}/heartbeat", response_model=InferenceJobOut)
def heartbeat_job(
    job_id: uuid.UUID,
    payload: WorkerJobHeartbeatRequest,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
) -> InferenceJobOut:
    return JobService(db, storage, settings).heartbeat_job(
        job_id=job_id,
        worker_id=payload.worker_id,
        attempt_id=payload.attempt_id,
        lease_token=payload.lease_token,
        stage=payload.stage,
        completed_slices=payload.completed_slices,
        total_slices=payload.total_slices,
    )


@router.post("/jobs/{job_id}/complete", response_model=WorkerCompleteResponse)
async def complete_job(
    job_id: uuid.UUID,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    request_id: RequestIdDep,
    attempt_id: Annotated[uuid.UUID, Header(alias="X-Attempt-ID")],
    worker_id: Annotated[str, Header(alias="X-Worker-ID")],
    lease_token: Annotated[str, Header(alias="X-Lease-Token")],
    mask: Annotated[UploadFile, File()],
    coverage: Annotated[UploadFile, File()],
    metadata: Annotated[UploadFile, File()],
) -> WorkerCompleteResponse:
    job = await JobService(db, storage, settings).complete_job(
        job_id=job_id,
        worker_id=worker_id,
        attempt_id=attempt_id,
        lease_token=lease_token,
        mask_file=mask.file,
        mask_filename=mask.filename or "mask.nii.gz",
        coverage_file=coverage.file,
        metadata_file=metadata.file,
        request_id=request_id,
    )
    return WorkerCompleteResponse(job=job)


@router.post("/jobs/{job_id}/fail", response_model=WorkerActionResponse)
def fail_job(
    job_id: uuid.UUID,
    payload: WorkerFailRequest,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    request_id: RequestIdDep,
) -> WorkerActionResponse:
    job = JobService(db, storage, settings).fail_job(
        job_id=job_id,
        worker_id=payload.worker_id,
        attempt_id=payload.attempt_id,
        lease_token=payload.lease_token,
        error_code=payload.error_code,
        request_id=request_id,
    )
    return WorkerActionResponse(job=job)


def _iter_file_chunks(handle) -> Iterator[bytes]:
    try:
        while True:
            chunk = handle.read(65536)
            if not chunk:
                return
            yield chunk
    finally:
        handle.close()
