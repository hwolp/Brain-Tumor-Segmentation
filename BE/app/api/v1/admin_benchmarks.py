"""Admin AI benchmark & ground-truth evaluation endpoints."""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile, status
from fastapi.responses import StreamingResponse

from app.core.errors import AppError
from app.dependencies import (
    AdminUserDep,
    ClientIpDep,
    DbSessionDep,
    RequestIdDep,
    SettingsDep,
    StorageDep,
    require_admin,
)
from app.schemas.admin_benchmark import (
    AdminBenchmarkDetailOut,
    AdminBenchmarkSummaryOut,
    BenchmarkArtifactKind,
    BenchmarkDeletionOut,
)
from app.schemas.common import PaginatedResponse
from app.schemas.error import ErrorResponse
from app.schemas.jobs import JobState
from app.services.admin_benchmark_service import AdminBenchmarkService

_STREAM_CHUNK_SIZE = 65536

router = APIRouter(
    prefix="/api/v1/admin/benchmarks",
    tags=["admin benchmarks"],
    dependencies=[Depends(require_admin)],
    responses={
        401: {"model": ErrorResponse, "description": "Unauthenticated"},
        403: {"model": ErrorResponse, "description": "Administrator role required"},
        404: {"model": ErrorResponse, "description": "Benchmark or artifact not found"},
        409: {"model": ErrorResponse, "description": "State conflict"},
        422: {"model": ErrorResponse, "description": "Invalid NIfTI input or validation error"},
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


@router.post("", response_model=AdminBenchmarkDetailOut, status_code=status.HTTP_201_CREATED)
async def create_benchmark(
    admin: AdminUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    request_id: RequestIdDep,
    client_ip: ClientIpDep,
    title: Annotated[str, Form(min_length=1, max_length=160)],
    target_worker_id: Annotated[str, Form(min_length=1, max_length=128)],
    flair: Annotated[UploadFile, File()],
    t1ce: Annotated[UploadFile, File()],
    gt_mask: Annotated[UploadFile, File()],
    notes: Annotated[str | None, Form(max_length=2000)] = None,
) -> AdminBenchmarkDetailOut:
    return await AdminBenchmarkService(db, storage, settings).create_benchmark(
        admin=admin,
        title=title,
        target_worker_id=target_worker_id,
        notes=notes,
        flair_upload=flair,
        t1ce_upload=t1ce,
        gt_mask_upload=gt_mask,
        request_id=request_id,
        ip_address=client_ip,
    )


@router.get("", response_model=PaginatedResponse[AdminBenchmarkSummaryOut])
def list_benchmarks(
    _admin: AdminUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    q: Annotated[str | None, Query(max_length=128)] = None,
    state: JobState | None = None,
    worker_id: Annotated[str | None, Query(max_length=128)] = None,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> PaginatedResponse[AdminBenchmarkSummaryOut]:
    return AdminBenchmarkService(db, storage, settings).list_benchmarks(
        q=q,
        state=state,
        worker_id=worker_id,
        page=page,
        page_size=page_size,
    )


@router.get("/{benchmark_id}", response_model=AdminBenchmarkDetailOut)
def get_benchmark_detail(
    benchmark_id: uuid.UUID,
    _admin: AdminUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
) -> AdminBenchmarkDetailOut:
    return AdminBenchmarkService(db, storage, settings).get_benchmark_detail(benchmark_id)


@router.get("/{benchmark_id}/files/{artifact}")
def download_benchmark_artifact(
    benchmark_id: uuid.UUID,
    artifact: BenchmarkArtifactKind,
    _admin: AdminUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
) -> StreamingResponse:
    stored_file = AdminBenchmarkService(db, storage, settings).open_benchmark_artifact(
        benchmark_id=benchmark_id,
        artifact=artifact,
    )
    try:
        handle = storage.open(str(stored_file.storage_key), "rb")
    except FileNotFoundError as exc:
        raise AppError(
            status_code=404,
            code="file_not_found",
            message="Không tìm thấy tệp dữ liệu kiểm định.",
        ) from exc

    ext = ".nii.gz" if stored_file.media_type == "application/gzip" else ".nii"
    safe_filename = f"benchmark-{benchmark_id}-{artifact}{ext}"
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


@router.delete("/{benchmark_id}", response_model=BenchmarkDeletionOut)
def delete_benchmark(
    benchmark_id: uuid.UUID,
    admin: AdminUserDep,
    db: DbSessionDep,
    storage: StorageDep,
    settings: SettingsDep,
    request_id: RequestIdDep,
    client_ip: ClientIpDep,
) -> BenchmarkDeletionOut:
    return AdminBenchmarkService(db, storage, settings).delete_benchmark(
        benchmark_id=benchmark_id,
        admin=admin,
        request_id=request_id,
        ip_address=client_ip,
    )
