"""Doctor-scoped immutable mask version endpoints."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Header, Query, UploadFile, status
from fastapi.responses import StreamingResponse

from app.core.errors import AppError
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
from app.schemas.mask_version import (
    MaskMetadataExportOut,
    MaskVersionNoteUpdateRequest,
    MaskVersionOut,
)
from app.schemas.patient import DeletionStatusOut
from app.services.mask_version_service import MaskVersionService

_STREAM_CHUNK_SIZE = 65536

router = APIRouter(
    prefix="/api/v1",
    tags=["mask-versions"],
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


def _parse_optional_uuid(raw: str | None, *, field_name: str) -> uuid.UUID | None:
    if raw is None:
        return None
    cleaned = raw.strip()
    if not cleaned or cleaned.lower() == "null":
        return None
    try:
        return uuid.UUID(cleaned)
    except ValueError as exc:
        raise AppError(
            status_code=422,
            code="validation_error",
            message="Định dạng UUID không hợp lệ.",
            details=[
                {
                    "field": f"body.{field_name}",
                    "reason": "Input should be a valid UUID",
                    "type": "uuid_parsing",
                }
            ],
        ) from exc


def _iter_file_chunks(file_obj) -> Iterator[bytes]:
    try:
        while True:
            chunk = file_obj.read(_STREAM_CHUNK_SIZE)
            if not chunk:
                break
            yield chunk
    finally:
        file_obj.close()


@router.get("/cases/{case_id}/mask-versions")
def list_case_mask_versions(
    case_id: uuid.UUID,
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> PaginatedResponse[MaskVersionOut]:
    """List immutable mask versions for a doctor-owned case, newest first."""
    return MaskVersionService(db, storage, settings).list_mask_versions(
        doctor_id=doctor.id,
        case_id=case_id,
        page=page,
        page_size=page_size,
    )


@router.post("/cases/{case_id}/mask-versions", status_code=status.HTTP_201_CREATED)
async def save_manual_mask_version(
    case_id: uuid.UUID,
    idempotency_key: Annotated[uuid.UUID, Header(alias="Idempotency-Key")],
    mask: Annotated[UploadFile, File()],
    reference_volume_id: Annotated[uuid.UUID, Form()],
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    request_id: RequestIdDep,
    client_ip: ClientIpDep,
    base_version_id: Annotated[str | None, Form()] = None,
    note: Annotated[str | None, Form()] = None,
) -> MaskVersionOut:
    """Validate, canonicalize, and atomically save a new manual mask version."""
    parsed_base_id = _parse_optional_uuid(base_version_id, field_name="base_version_id")
    return await MaskVersionService(db, storage, settings).save_manual_mask_version(
        doctor_id=doctor.id,
        case_id=case_id,
        idempotency_key=idempotency_key,
        mask_file=mask,
        base_version_id=parsed_base_id,
        reference_volume_id=reference_volume_id,
        note=note,
        request_id=request_id,
        ip_address=client_ip,
    )


@router.get("/mask-versions/{mask_version_id}")
def get_mask_version(
    mask_version_id: uuid.UUID,
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
) -> MaskVersionOut:
    """Get metadata and physical volume statistics for a doctor-owned mask version."""
    return MaskVersionService(db, storage, settings).get_mask_version(
        doctor_id=doctor.id,
        mask_version_id=mask_version_id,
    )


@router.get("/mask-versions/{mask_version_id}/export")
def export_mask_version_nifti(
    mask_version_id: uuid.UUID,
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
) -> StreamingResponse:
    """Stream canonical uint8 .nii.gz mask file with technical filename and no-store headers."""
    stored_file, mv = MaskVersionService(db, storage, settings).get_mask_export_file(
        doctor_id=doctor.id,
        mask_version_id=mask_version_id,
    )
    try:
        handle = storage.open(str(stored_file.storage_key), "rb")
    except FileNotFoundError as exc:
        raise AppError(
            status_code=404,
            code="file_not_found",
            message="Không tìm thấy tệp mask.",
        ) from exc

    safe_filename = f"mask-case-{mv.case_id}-v{mv.version_number}.nii.gz"
    return StreamingResponse(
        _iter_file_chunks(handle),
        media_type="application/gzip",
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": f'attachment; filename="{safe_filename}"',
            "Content-Length": str(stored_file.size_bytes),
            "X-Content-Type-Options": "nosniff",
        },
    )


@router.get("/mask-versions/{mask_version_id}/metadata")
def export_mask_version_metadata(
    mask_version_id: uuid.UUID,
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
) -> MaskMetadataExportOut:
    """Return non-PII provenance, geometry, coverage, and physical volume statistics."""
    return MaskVersionService(db, storage, settings).get_mask_metadata(
        doctor_id=doctor.id,
        mask_version_id=mask_version_id,
    )


@router.delete(
    "/mask-versions/{mask_version_id}",
    status_code=status.HTTP_202_ACCEPTED,
)
def delete_mask_version(
    mask_version_id: uuid.UUID,
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    request_id: RequestIdDep,
    client_ip: ClientIpDep,
) -> DeletionStatusOut:
    """Soft-delete a doctor-owned manual mask version and reclaim storage."""
    return MaskVersionService(db, storage, settings).delete_mask_version(
        doctor_id=doctor.id,
        mask_version_id=mask_version_id,
        request_id=request_id,
        ip_address=client_ip,
    )


@router.patch("/mask-versions/{mask_version_id}")
def update_mask_version_note(
    mask_version_id: uuid.UUID,
    payload: MaskVersionNoteUpdateRequest,
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    request_id: RequestIdDep,
    client_ip: ClientIpDep,
) -> MaskVersionOut:
    """Update the note of an active doctor-owned mask version."""
    return MaskVersionService(db, storage, settings).update_mask_version_note(
        doctor_id=doctor.id,
        mask_version_id=mask_version_id,
        note=payload.note,
        request_id=request_id,
        ip_address=client_ip,
    )
