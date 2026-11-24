"""Doctor-scoped patient endpoints and nested patient case endpoints."""

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
from app.schemas.case import CaseCreateRequest, CaseOut
from app.schemas.common import PaginatedResponse
from app.schemas.error import ErrorResponse
from app.schemas.patient import (
    DeletionStatusOut,
    PatientCreateRequest,
    PatientOut,
    PatientUpdateRequest,
)
from app.services.case_service import CaseService
from app.services.patient_service import PatientService

router = APIRouter(
    prefix="/api/v1/patients",
    tags=["patients"],
    dependencies=[Depends(require_doctor)],
    responses={
        401: {"model": ErrorResponse, "description": "Unauthenticated"},
        403: {"model": ErrorResponse, "description": "Forbidden or password change required"},
        404: {"model": ErrorResponse, "description": "Resource not found"},
        409: {"model": ErrorResponse, "description": "Conflict"},
        422: {"model": ErrorResponse, "description": "Validation error"},
        500: {"model": ErrorResponse, "description": "Internal server error"},
    },
)


@router.get("")
def list_patients(
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    q: Annotated[str | None, Query(max_length=150)] = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> PaginatedResponse[PatientOut]:
    """List patients owned by the current doctor with optional search."""
    return PatientService(db, storage).list_patients(
        doctor_id=doctor.id,
        q=q,
        page=page,
        page_size=page_size,
    )


@router.post("", status_code=status.HTTP_201_CREATED)
def create_patient(
    payload: PatientCreateRequest,
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    request_id: RequestIdDep,
    client_ip: ClientIpDep,
) -> PatientOut:
    """Create a new patient record owned by the current doctor."""
    return PatientService(db, storage).create_patient(
        doctor_id=doctor.id,
        payload=payload,
        request_id=request_id,
        ip_address=client_ip,
    )


@router.get("/{patient_id}")
def get_patient(
    patient_id: uuid.UUID,
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
) -> PatientOut:
    """Get details of a doctor-owned patient."""
    return PatientService(db, storage).get_patient(doctor_id=doctor.id, patient_id=patient_id)


@router.patch("/{patient_id}")
def update_patient(
    patient_id: uuid.UUID,
    payload: PatientUpdateRequest,
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    request_id: RequestIdDep,
    client_ip: ClientIpDep,
) -> PatientOut:
    """Update allowed metadata fields of a doctor-owned patient."""
    return PatientService(db, storage).update_patient(
        doctor_id=doctor.id,
        patient_id=patient_id,
        payload=payload,
        request_id=request_id,
        ip_address=client_ip,
    )


@router.delete("/{patient_id}", status_code=status.HTTP_202_ACCEPTED)
def delete_patient(
    patient_id: uuid.UUID,
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    request_id: RequestIdDep,
    client_ip: ClientIpDep,
) -> DeletionStatusOut:
    """Delete a doctor-owned patient and revoke all associated access immediately."""
    return PatientService(db, storage).delete_patient(
        doctor_id=doctor.id,
        patient_id=patient_id,
        request_id=request_id,
        ip_address=client_ip,
    )


@router.get("/{patient_id}/cases")
def list_patient_cases(
    patient_id: uuid.UUID,
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> PaginatedResponse[CaseOut]:
    """List clinical cases for a doctor-owned patient."""
    return CaseService(db, storage, settings).list_patient_cases(
        doctor_id=doctor.id,
        patient_id=patient_id,
        page=page,
        page_size=page_size,
    )


@router.post("/{patient_id}/cases", status_code=status.HTTP_201_CREATED)
def create_patient_case(
    patient_id: uuid.UUID,
    payload: CaseCreateRequest,
    idempotency_key: Annotated[uuid.UUID, Header(alias="Idempotency-Key")],
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    request_id: RequestIdDep,
    client_ip: ClientIpDep,
) -> CaseOut:
    """Idempotently create a clinical case under a doctor-owned patient."""
    return CaseService(db, storage, settings).create_case(
        doctor_id=doctor.id,
        patient_id=patient_id,
        idempotency_key=idempotency_key,
        payload=payload,
        request_id=request_id,
        ip_address=client_ip,
    )
