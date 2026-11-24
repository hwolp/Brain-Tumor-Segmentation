"""P6 restricted technical operations endpoints for administrators."""

from __future__ import annotations

import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query

from app.dependencies import (
    AdminUserDep,
    ClientIpDep,
    DbSessionDep,
    RequestIdDep,
    SettingsDep,
    StorageDep,
    require_admin,
)
from app.schemas.common import PaginatedResponse
from app.schemas.error import ErrorResponse
from app.schemas.jobs import (
    AdminJobDetailOut,
    AdminJobOut,
    AdminModelOut,
    AdminOverviewOut,
    AdminSettingsOut,
    AdminSettingsUpdate,
    AdminWorkerOut,
    AuditEventOut,
)
from app.services.admin_operations_service import AdminOperationsService

router = APIRouter(
    prefix="/api/v1/admin",
    tags=["admin operations"],
    dependencies=[Depends(require_admin)],
    responses={
        401: {"model": ErrorResponse, "description": "Unauthenticated"},
        403: {"model": ErrorResponse, "description": "Administrator role required"},
        404: {"model": ErrorResponse, "description": "Job not found"},
        409: {"model": ErrorResponse, "description": "State or version conflict"},
    },
)


@router.get("/overview", response_model=AdminOverviewOut)
def get_overview(
    _admin: AdminUserDep, db: DbSessionDep, storage: StorageDep, settings: SettingsDep
) -> AdminOverviewOut:
    return AdminOperationsService(db, storage, settings).overview()


@router.get("/jobs", response_model=PaginatedResponse[AdminJobOut])
def list_jobs(
    _admin: AdminUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    q: Annotated[str | None, Query(max_length=128)] = None,
    state: Literal["queued", "running", "succeeded", "failed", "cancelled"] | None = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> PaginatedResponse[AdminJobOut]:
    return AdminOperationsService(db, storage, settings).list_jobs(
        q=q, state=state, page=page, page_size=page_size
    )


@router.get("/jobs/{job_id}", response_model=AdminJobDetailOut)
def get_job_detail(
    job_id: uuid.UUID,
    _admin: AdminUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
) -> AdminJobDetailOut:
    return AdminOperationsService(db, storage, settings).get_job_detail(job_id)


@router.post("/jobs/{job_id}/retry", response_model=AdminJobOut, status_code=202)
def retry_job(
    job_id: uuid.UUID,
    admin: AdminUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    request_id: RequestIdDep,
    client_ip: ClientIpDep,
) -> AdminJobOut:
    return AdminOperationsService(db, storage, settings).retry_failed_job(
        job_id=job_id, admin_id=admin.id, request_id=request_id, ip_address=client_ip
    )


@router.get("/workers", response_model=list[AdminWorkerOut])
def list_workers(
    _admin: AdminUserDep, db: DbSessionDep, storage: StorageDep, settings: SettingsDep
) -> list[AdminWorkerOut]:
    return AdminOperationsService(db, storage, settings).list_workers()


@router.get("/models", response_model=list[AdminModelOut])
def list_models(
    _admin: AdminUserDep, db: DbSessionDep, storage: StorageDep, settings: SettingsDep
) -> list[AdminModelOut]:
    return AdminOperationsService(db, storage, settings).list_models()


@router.get("/settings", response_model=AdminSettingsOut)
def get_settings(
    _admin: AdminUserDep, db: DbSessionDep, storage: StorageDep, settings: SettingsDep
) -> AdminSettingsOut:
    return AdminOperationsService(db, storage, settings).get_settings()


@router.patch("/settings", response_model=AdminSettingsOut)
def update_settings(
    payload: AdminSettingsUpdate,
    admin: AdminUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    request_id: RequestIdDep,
    client_ip: ClientIpDep,
) -> AdminSettingsOut:
    return AdminOperationsService(db, storage, settings).update_settings(
        actor_id=admin.id, payload=payload, request_id=request_id, ip_address=client_ip
    )


@router.get("/audit-events", response_model=PaginatedResponse[AuditEventOut])
def list_audit_events(
    _admin: AdminUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    q: Annotated[str | None, Query(max_length=128)] = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> PaginatedResponse[AuditEventOut]:
    return AdminOperationsService(db, storage, settings).list_audit_events(
        q=q, page=page, page_size=page_size
    )
