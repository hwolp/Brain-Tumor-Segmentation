"""Doctor-scoped case and volume endpoints."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile, status

from app.dependencies import (
    ClientIpDep,
    DbSessionDep,
    DoctorUserDep,
    RequestIdDep,
    SettingsDep,
    StorageDep,
    require_doctor,
)
from app.schemas.case import CaseOut, CaseUpdateRequest
from app.schemas.common import PaginatedResponse
from app.schemas.error import ErrorResponse
from app.schemas.patient import DeletionStatusOut
from app.schemas.volume import VolumeModality, VolumeOut
from app.services.case_service import CaseService
from app.services.volume_service import VolumeService

router = APIRouter(
    prefix="/api/v1/cases",
    tags=["cases"],
    dependencies=[Depends(require_doctor)],
    responses={
        401: {"model": ErrorResponse, "description": "Unauthenticated"},
        403: {"model": ErrorResponse, "description": "Forbidden or password change required"},
        404: {"model": ErrorResponse, "description": "Resource not found"},
        409: {"model": ErrorResponse, "description": "Conflict"},
        413: {"model": ErrorResponse, "description": "Payload or quota too large"},
        422: {"model": ErrorResponse, "description": "Validation error"},
        500: {"model": ErrorResponse, "description": "Internal server error"},
    },
)


@router.get("")
def list_cases(
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> PaginatedResponse[CaseOut]:
    """List active clinical cases owned by the current doctor, newest first."""
    return CaseService(db, storage, settings).list_doctor_cases(
        doctor_id=doctor.id,
        page=page,
        page_size=page_size,
    )


@router.get("/{case_id}")
def get_case(
    case_id: uuid.UUID,
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
) -> CaseOut:
    """Get details of a doctor-owned clinical case."""
    return CaseService(db, storage, settings).get_case(doctor_id=doctor.id, case_id=case_id)


@router.patch("/{case_id}")
def update_case(
    case_id: uuid.UUID,
    payload: CaseUpdateRequest,
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    request_id: RequestIdDep,
    client_ip: ClientIpDep,
) -> CaseOut:
    """Update allowed fields (study_date, notes) of a doctor-owned case."""
    return CaseService(db, storage, settings).update_case(
        doctor_id=doctor.id,
        case_id=case_id,
        payload=payload,
        request_id=request_id,
        ip_address=client_ip,
    )


@router.delete("/{case_id}", status_code=status.HTTP_202_ACCEPTED)
def delete_case(
    case_id: uuid.UUID,
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    request_id: RequestIdDep,
    client_ip: ClientIpDep,
) -> DeletionStatusOut:
    """Delete a doctor-owned case and revoke access to its volumes immediately."""
    return CaseService(db, storage, settings).delete_case(
        doctor_id=doctor.id,
        case_id=case_id,
        request_id=request_id,
        ip_address=client_ip,
    )


@router.get("/{case_id}/volumes")
def list_case_volumes(
    case_id: uuid.UUID,
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
) -> list[VolumeOut]:
    """List validated MRI volumes attached to a doctor-owned case."""
    return VolumeService(db, storage, settings).list_volumes(
        doctor_id=doctor.id,
        case_id=case_id,
    )


@router.post("/{case_id}/volumes", status_code=status.HTTP_201_CREATED)
async def upload_case_volume(
    case_id: uuid.UUID,
    modality: Annotated[VolumeModality, Form()],
    file: Annotated[UploadFile, File()],
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    request_id: RequestIdDep,
    client_ip: ClientIpDep,
) -> VolumeOut:
    """Upload, validate, and commit a 3D NIfTI MRI volume for a case."""
    return await VolumeService(db, storage, settings).upload_volume(
        doctor_id=doctor.id,
        case_id=case_id,
        modality=modality,
        file=file,
        request_id=request_id,
        ip_address=client_ip,
    )


@router.delete("/{case_id}/volumes/{volume_id}", status_code=status.HTTP_202_ACCEPTED)
def delete_case_volume(
    case_id: uuid.UUID,
    volume_id: uuid.UUID,
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    request_id: RequestIdDep,
    client_ip: ClientIpDep,
) -> DeletionStatusOut:
    """Delete a volume from an unlocked case and recalculate case readiness."""
    return VolumeService(db, storage, settings).delete_volume(
        doctor_id=doctor.id,
        case_id=case_id,
        volume_id=volume_id,
        request_id=request_id,
        ip_address=client_ip,
    )
