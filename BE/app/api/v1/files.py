"""Authenticated binary file streaming endpoint with strict ownership checks."""

from __future__ import annotations

import uuid
from collections.abc import Iterator

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from app.core.errors import AppError
from app.dependencies import DbSessionDep, DoctorUserDep, StorageDep, require_doctor
from app.repositories.file_repo import FileRepository
from app.schemas.error import ErrorResponse

_STREAM_CHUNK_SIZE = 65536

router = APIRouter(
    prefix="/api/v1/files",
    tags=["files"],
    dependencies=[Depends(require_doctor)],
    responses={
        401: {"model": ErrorResponse, "description": "Unauthenticated"},
        403: {"model": ErrorResponse, "description": "Forbidden or password change required"},
        404: {"model": ErrorResponse, "description": "File not found"},
        500: {"model": ErrorResponse, "description": "Internal server error"},
    },
)


def _iter_file_chunks(file_obj) -> Iterator[bytes]:
    try:
        while True:
            chunk = file_obj.read(_STREAM_CHUNK_SIZE)
            if not chunk:
                break
            yield chunk
    finally:
        file_obj.close()


@router.get("/{file_id}/content")
def download_file_content(
    file_id: uuid.UUID,
    doctor: DoctorUserDep,
    db: DbSessionDep,
    storage: StorageDep,
) -> StreamingResponse:
    """Stream committed binary NIfTI file content for the owning doctor only."""
    stored_file = FileRepository(db).get_committed_for_owner(file_id, doctor.id)
    if stored_file is None or stored_file.storage_key is None:
        raise AppError(
            status_code=404,
            code="file_not_found",
            message="Không tìm thấy tệp dữ liệu.",
        )

    try:
        handle = storage.open(str(stored_file.storage_key), "rb")
    except FileNotFoundError as exc:
        raise AppError(
            status_code=404,
            code="file_not_found",
            message="Không tìm thấy tệp dữ liệu.",
        ) from exc

    if stored_file.media_type == "application/gzip":
        safe_filename = f"volume-{stored_file.id}.nii.gz"
    elif stored_file.media_type == "application/json":
        safe_filename = f"file-{stored_file.id}.json"
    else:
        safe_filename = f"volume-{stored_file.id}.nii"
    return StreamingResponse(
        _iter_file_chunks(handle),
        media_type=stored_file.media_type,
        headers={
            "Cache-Control": "no-store",
            "Content-Disposition": f'attachment; filename="{safe_filename}"',
            "Content-Length": str(stored_file.size_bytes),
            "X-Content-Type-Options": "nosniff",
        },
    )
