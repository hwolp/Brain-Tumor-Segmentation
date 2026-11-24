"""Doctor-scoped inference job endpoints."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Header, Query, status

from app.dependencies import (
    ClientIpDep,
    DbSessionDep,
    DoctorUserDep,
    RequestIdDep,
    SettingsDep,
    StorageDep,
    require_doctor,
)
from app.schemas.common import PaginatedResponse
from app.schemas.error import ErrorResponse
from app.schemas.jobs import InferenceJobOut, JobCreateResponse, SystemAvailabilityOut
from app.services.job_service import JobService

router = APIRouter(
    tags=["inference jobs"],
    dependencies=[Depends(require_doctor)],
    responses={
        401: {"model": ErrorResponse, "description": "Unauthenticated"},
        403: {"model": ErrorResponse, "description": "Forbidden"},
        404: {"model": ErrorResponse, "description": "Job or case not found"},
        409: {"model": ErrorResponse, "description": "State or idempotency conflict"},
        422: {"model": ErrorResponse, "description": "Case is not ready"},
        503: {"model": ErrorResponse, "description": "Inference intake is paused"},
    },
)


@router.get("/api/v1/system/availability", response_model=SystemAvailabilityOut)
def get_system_availability(
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
) -> SystemAvailabilityOut:
    return SystemAvailabilityOut(**JobService(db, storage, settings).availability())


@router.get("/api/v1/cases/{case_id}/jobs")
def list_case_jobs(
    case_id: uuid.UUID,
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> PaginatedResponse[InferenceJobOut]:
    return JobService(db, storage, settings).list_case_jobs(
        doctor_id=doctor.id, case_id=case_id, page=page, page_size=page_size
    )


@router.post("/api/v1/cases/{case_id}/jobs", status_code=status.HTTP_202_ACCEPTED)
def create_case_job(
    case_id: uuid.UUID,
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    request_id: RequestIdDep,
    client_ip: ClientIpDep,
    idempotency_key: Annotated[str, Header(alias="Idempotency-Key", min_length=1, max_length=128)],
) -> JobCreateResponse:
    job = JobService(db, storage, settings).create_job(
        doctor_id=doctor.id,
        case_id=case_id,
        idempotency_key=idempotency_key,
        request_id=request_id,
        ip_address=client_ip,
    )
    return JobCreateResponse(job=job)


@router.get("/api/v1/jobs/{job_id}")
def get_job(
    job_id: uuid.UUID,
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
) -> InferenceJobOut:
    return JobService(db, storage, settings).get_job(doctor_id=doctor.id, job_id=job_id)


@router.post("/api/v1/jobs/{job_id}/cancel")
def cancel_job(
    job_id: uuid.UUID,
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    request_id: RequestIdDep,
    client_ip: ClientIpDep,
) -> InferenceJobOut:
    return JobService(db, storage, settings).cancel_job(
        doctor_id=doctor.id,
        job_id=job_id,
        request_id=request_id,
        ip_address=client_ip,
    )
