"""Service layer for Admin AI benchmarks, worker routing, scoring, and storage cleanup."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, BinaryIO, Literal

from fastapi import UploadFile
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.errors import AppError
from app.core.storage import LocalStorageAdapter, StagedFile
from app.models.admin_benchmark import AdminBenchmarkRun
from app.models.inference_job import WorkerInstance
from app.models.stored_file import StoredFile
from app.models.user import User
from app.repositories.admin_benchmark_repo import AdminBenchmarkRepository
from app.repositories.audit_repo import AuditRepository
from app.repositories.file_repo import FileRepository
from app.repositories.system_setting_repo import SystemSettingRepository
from app.schemas.admin_benchmark import (
    AdminBenchmarkDetailOut,
    AdminBenchmarkSummaryOut,
    BenchmarkDeletionOut,
    BenchmarkMetricsOut,
)
from app.schemas.common import PaginatedResponse
from app.schemas.jobs import InferenceJobOut, WorkerClaimOut, WorkerInputFile
from app.services.benchmark_metrics import evaluate_benchmark_mask_streams
from app.services.mask_version_service import validate_and_canonicalize_mask
from app.services.stored_file_service import StoredFileService
from app.services.volume_service import resolve_effective_quotas
from app.validators.nifti_validator import (
    DEFAULT_MAX_DECOMPRESSED_BYTES,
    DEFAULT_MAX_UPLOAD_BYTES,
    VolumeGeometry,
    _detect_nifti_extension,
    _stream_upload_to_staging,
    check_geometry_compatibility,
    check_model_profile,
    validate_and_stage_nifti_upload,
)

_LEASE_SECONDS = 90
_ACTIVE_WORKER_STAGES = frozenset(
    {"loading", "preprocessing", "inference", "reconstructing", "saving"}
)
_SAFE_ERROR_CODES = frozenset(
    {
        "invalid_nifti",
        "input_geometry_mismatch",
        "model_unavailable",
        "model_error",
        "inference_error",
        "result_invalid",
        "worker_error",
    }
)


def _as_utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _manifest_path(settings: Settings) -> Path:
    return (
        settings.MODEL_MANIFEST_PATH
        or Path(__file__).resolve().parents[2] / "worker" / "manifest.json"
    )


def _load_manifest_for_claim(settings: Settings, run: AdminBenchmarkRun) -> dict[str, Any]:
    path = _manifest_path(settings)
    if path.is_file():
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                return data
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            pass
    return {
        "model_id": run.model_version_id or "custom-worker",
        "input_profile": {
            "shape": [int(v) for v in run.shape_json],
            "spacing_mm": [float(v) for v in run.spacing_mm_json],
        },
    }


def _extract_region_dice(metrics_json: dict[str, Any] | None, region: str) -> float | None:
    if not isinstance(metrics_json, dict):
        return None
    regions = metrics_json.get("regions")
    if not isinstance(regions, dict):
        return None
    entry = regions.get(region)
    if not isinstance(entry, dict):
        return None
    raw = entry.get("dice")
    return float(raw) if isinstance(raw, (int, float)) else None


def _to_summary(run: AdminBenchmarkRun) -> AdminBenchmarkSummaryOut:
    metrics = run.metrics_json if isinstance(run.metrics_json, dict) else None
    raw_mean = metrics.get("mean_dice_brats") if metrics is not None else None
    mean_dice = float(raw_mean) if isinstance(raw_mean, (int, float)) else None
    return AdminBenchmarkSummaryOut(
        id=run.id,
        title=run.title,
        notes=run.notes,
        target_worker_id=run.target_worker_id,
        executed_worker_id=run.executed_worker_id,
        worker_device_type=run.worker_device_type,
        model_version_id=run.model_version_id,
        state=run.state,  # type: ignore[arg-type]
        stage=run.stage,  # type: ignore[arg-type]
        completed_slices=run.completed_slices,
        total_slices=run.total_slices,
        error_code=run.error_code,
        mean_dice_brats=mean_dice,
        wt_dice=_extract_region_dice(metrics, "WT"),
        tc_dice=_extract_region_dice(metrics, "TC"),
        et_dice=_extract_region_dice(metrics, "ET"),
        inference_duration_ms=run.inference_duration_ms,
        created_at=run.created_at,
        started_at=run.started_at,
        finished_at=run.finished_at,
    )


def _to_detail(run: AdminBenchmarkRun, created_by_username: str) -> AdminBenchmarkDetailOut:
    summary = _to_summary(run)
    metrics_out = (
        BenchmarkMetricsOut.model_validate(run.metrics_json)
        if isinstance(run.metrics_json, dict)
        else None
    )
    return AdminBenchmarkDetailOut(
        **summary.model_dump(),
        shape=[int(v) for v in run.shape_json],
        spacing_mm=[float(v) for v in run.spacing_mm_json],
        affine=[[float(c) for c in row] for row in run.affine_json],
        metrics=metrics_out,
        coverage=run.coverage_json if isinstance(run.coverage_json, dict) else None,
        has_pred_mask=run.pred_mask_file_id is not None,
        created_by_username=created_by_username,
    )


def _to_worker_job_out(run: AdminBenchmarkRun) -> InferenceJobOut:
    return InferenceJobOut(
        id=run.id,
        case_id=run.id,
        model_version_id=run.model_version_id or "custom-worker",
        state=run.state,  # type: ignore[arg-type]
        stage=run.stage,  # type: ignore[arg-type]
        completed_slices=run.completed_slices,
        total_slices=run.total_slices,
        attempt_count=1 if run.attempt_id is not None else 0,
        max_auto_retries=0,
        error_code=run.error_code,
        created_at=run.created_at,
        started_at=run.started_at,
        finished_at=run.finished_at,
        result_mask_version_id=None,
    )


class AdminBenchmarkService:
    """Service layer managing isolated Admin AI benchmarks and targeted worker runs."""

    def __init__(self, db: Session, storage: LocalStorageAdapter, settings: Settings) -> None:
        self.db = db
        self.storage = storage
        self.settings = settings
        self.benchmarks = AdminBenchmarkRepository(db)
        self.files = FileRepository(db)
        self.system_settings = SystemSettingRepository(db)
        self.audits = AuditRepository(db)

    def _effective_upload_limits(self) -> tuple[int, int]:
        row = self.system_settings.get_by_key("admin_settings")
        values = row.value_json if row is not None else {}
        max_upload_mib = values.get("max_upload_mib") if isinstance(values, dict) else None
        max_decompressed_mib = (
            values.get("max_decompressed_mib") if isinstance(values, dict) else None
        )
        upload_bytes = (
            int(max_upload_mib) * 1024 * 1024
            if isinstance(max_upload_mib, int) and max_upload_mib > 0
            else getattr(self.settings, "MAX_UPLOAD_BYTES", DEFAULT_MAX_UPLOAD_BYTES)
        )
        decompressed_bytes = (
            int(max_decompressed_mib) * 1024 * 1024
            if isinstance(max_decompressed_mib, int) and max_decompressed_mib > 0
            else getattr(
                self.settings, "MAX_DECOMPRESSED_BYTES", DEFAULT_MAX_DECOMPRESSED_BYTES
            )
        )
        return min(upload_bytes, self.settings.MAX_UPLOAD_BYTES), min(
            decompressed_bytes, self.settings.MAX_DECOMPRESSED_BYTES
        )

    def _rollback_cleanup_committed(self, committed_keys: list[str]) -> None:
        if not committed_keys:
            return
        with contextlib.suppress(Exception):
            self.db.expunge_all()
            key_uuids = [uuid.UUID(k) for k in committed_keys]
            persisted_keys = self.db.scalars(
                select(StoredFile.storage_key).where(
                    StoredFile.storage_key.in_(key_uuids),
                    StoredFile.state != "deleted",
                )
            ).all()
            referenced = {str(k) for k in persisted_keys if k is not None}
            self.db.rollback()
            for key in committed_keys:
                if key not in referenced:
                    with contextlib.suppress(OSError):
                        self.storage.delete(key)

    async def create_benchmark(
        self,
        *,
        admin: User,
        title: str,
        target_worker_id: str,
        notes: str | None,
        flair_upload: UploadFile,
        t1ce_upload: UploadFile,
        gt_mask_upload: UploadFile,
        request_id: str,
        ip_address: str,
    ) -> AdminBenchmarkDetailOut:
        clean_title = title.strip()
        if not clean_title or len(clean_title) > 160:
            raise AppError(
                status_code=422,
                code="validation_error",
                message="Tên bài kiểm định phải có từ 1 đến 160 ký tự.",
            )
        clean_worker_id = target_worker_id.strip()
        if not clean_worker_id or len(clean_worker_id) > 128:
            raise AppError(
                status_code=422,
                code="validation_error",
                message="Vui lòng chọn AI Worker hợp lệ.",
            )
        clean_notes = notes.strip() if isinstance(notes, str) and notes.strip() else None

        worker = self.db.get(WorkerInstance, clean_worker_id)
        if worker is None:
            raise AppError(
                status_code=404,
                code="worker_not_found",
                message="Không tìm thấy AI Worker đã chọn trong danh sách kết nối.",
            )

        max_upload_bytes, max_decompressed_bytes = self._effective_upload_limits()
        self.db.rollback()

        flair_staged: StagedFile | None = None
        t1ce_staged: StagedFile | None = None
        gt_raw_staged: StagedFile | None = None
        gt_canon_staged: StagedFile | None = None
        canonical_temp: Path | None = None
        committed_keys: list[str] = []
        committed_to_db = False

        try:
            flair_val = await validate_and_stage_nifti_upload(
                upload=flair_upload,
                storage=self.storage,
                max_upload_bytes=max_upload_bytes,
                max_decompressed_bytes=max_decompressed_bytes,
            )
            flair_staged = flair_val.staged_file

            t1ce_val = await validate_and_stage_nifti_upload(
                upload=t1ce_upload,
                storage=self.storage,
                max_upload_bytes=max_upload_bytes,
                max_decompressed_bytes=max_decompressed_bytes,
            )
            t1ce_staged = t1ce_val.staged_file

            check_geometry_compatibility(
                VolumeGeometry(
                    shape=flair_val.shape,
                    spacing_mm=flair_val.spacing_mm,
                    affine=flair_val.affine,
                ),
                VolumeGeometry(
                    shape=t1ce_val.shape,
                    spacing_mm=t1ce_val.spacing_mm,
                    affine=t1ce_val.affine,
                ),
            )

            compatible, warnings = check_model_profile(
                shape=flair_val.shape,
                spacing_mm=flair_val.spacing_mm,
                affine=flair_val.affine,
                orientation=flair_val.orientation,
                manifest_path=_manifest_path(self.settings),
            )
            if not compatible:
                raise AppError(
                    status_code=422,
                    code="invalid_model_profile",
                    message="Ảnh đầu vào chưa khớp cấu hình hình học của mô hình AI.",
                    details=[
                        {"field": "flair", "reason": msg, "type": "geometry_mismatch"}
                        for msg in warnings
                    ],
                )

            gt_is_gzip, _ = _detect_nifti_extension(gt_mask_upload.filename)
            gt_raw_staged, gt_raw_path = await _stream_upload_to_staging(
                upload=gt_mask_upload,
                storage=self.storage,
                max_upload_bytes=max_upload_bytes,
            )
            canonical_gt = await asyncio.to_thread(
                validate_and_canonicalize_mask,
                file_path=gt_raw_path,
                is_gzip=gt_is_gzip,
                ref_shape=flair_val.shape,
                ref_spacing_mm=flair_val.spacing_mm,
                ref_affine_mm=flair_val.affine,
                max_decompressed_bytes=max_decompressed_bytes,
                temp_dir=self.storage.staging_root,
            )
            canonical_temp = canonical_gt.canonical_nii_gz_path
            with canonical_temp.open("rb") as gt_handle:
                gt_canon_staged = self.storage.put_temp(gt_handle)

            if self.db.get(WorkerInstance, clean_worker_id) is None:
                raise AppError(
                    status_code=404,
                    code="worker_not_found",
                    message="Không tìm thấy AI Worker đã chọn trong danh sách kết nối.",
                )

            self.files.acquire_quota_locks(admin.id)
            _, system_quota = resolve_effective_quotas(self.system_settings, self.settings)
            _, system_used = self.files.get_committed_usage_bytes(admin.id)
            total_bytes = (
                flair_val.size_bytes + t1ce_val.size_bytes + gt_canon_staged.size_bytes
            )
            if system_used + total_bytes > system_quota:
                raise AppError(
                    status_code=413,
                    code="storage_quota_exceeded",
                    message="Dung lượng lưu trữ hệ thống không đủ để lưu bộ kiểm định.",
                )

            flair_obj = self.storage.commit(flair_staged.staging_key)
            flair_staged = None
            committed_keys.append(flair_obj.storage_key)

            t1ce_obj = self.storage.commit(t1ce_staged.staging_key)
            t1ce_staged = None
            committed_keys.append(t1ce_obj.storage_key)

            gt_obj = self.storage.commit(gt_canon_staged.staging_key)
            gt_canon_staged = None
            committed_keys.append(gt_obj.storage_key)

            flair_file = StoredFile(
                storage_key=uuid.UUID(flair_obj.storage_key),
                original_name="benchmark-flair.nii.gz"
                if flair_val.media_type == "application/gzip"
                else "benchmark-flair.nii",
                size_bytes=flair_obj.size_bytes,
                sha256=flair_obj.sha256,
                media_type=flair_val.media_type,
                state="committed",
                owner_id=admin.id,
            )
            t1ce_file = StoredFile(
                storage_key=uuid.UUID(t1ce_obj.storage_key),
                original_name="benchmark-t1ce.nii.gz"
                if t1ce_val.media_type == "application/gzip"
                else "benchmark-t1ce.nii",
                size_bytes=t1ce_obj.size_bytes,
                sha256=t1ce_obj.sha256,
                media_type=t1ce_val.media_type,
                state="committed",
                owner_id=admin.id,
            )
            gt_file = StoredFile(
                storage_key=uuid.UUID(gt_obj.storage_key),
                original_name="benchmark-gt-seg.nii.gz",
                size_bytes=gt_obj.size_bytes,
                sha256=gt_obj.sha256,
                media_type="application/gzip",
                state="committed",
                owner_id=admin.id,
            )
            self.db.add_all([flair_file, t1ce_file, gt_file])
            self.db.flush()

            run = AdminBenchmarkRun(
                created_by=admin.id,
                title=clean_title,
                notes=clean_notes,
                target_worker_id=clean_worker_id,
                state="queued",
                stage="queued",
                flair_file_id=flair_file.id,
                t1ce_file_id=t1ce_file.id,
                gt_mask_file_id=gt_file.id,
                shape_json=flair_val.shape,
                spacing_mm_json=flair_val.spacing_mm,
                affine_json=flair_val.affine,
            )
            self.db.add(run)
            self.db.flush()

            self.audits.record_event(
                actor_type="user",
                actor_id=admin.id,
                action="admin_benchmark.created",
                resource_type="admin_benchmark_run",
                resource_id=str(run.id),
                outcome="success",
                request_id=request_id,
                ip_address=ip_address,
                safe_diff={
                    "target_worker_id": clean_worker_id,
                    "shape": flair_val.shape,
                },
            )
            out = _to_detail(run, admin.username)
            self.db.commit()
            committed_to_db = True
            return out
        except Exception:
            if not committed_to_db:
                with contextlib.suppress(Exception):
                    self.db.rollback()
                    self._rollback_cleanup_committed(committed_keys)
            raise
        finally:
            for staged in (flair_staged, t1ce_staged, gt_raw_staged, gt_canon_staged):
                if staged is not None:
                    self.storage.staging_root.joinpath(staged.staging_key).unlink(missing_ok=True)
            if canonical_temp is not None:
                canonical_temp.unlink(missing_ok=True)

    def list_benchmarks(
        self,
        *,
        q: str | None,
        state: str | None,
        worker_id: str | None,
        page: int,
        page_size: int,
    ) -> PaginatedResponse[AdminBenchmarkSummaryOut]:
        rows, total = self.benchmarks.list_paginated(
            q=q, state=state, worker_id=worker_id, page=page, page_size=page_size
        )
        return PaginatedResponse[AdminBenchmarkSummaryOut](
            items=[_to_summary(row) for row in rows],
            total=total,
            page=page,
            page_size=page_size,
        )

    def get_benchmark_detail(self, benchmark_id: uuid.UUID) -> AdminBenchmarkDetailOut:
        row = self.benchmarks.get_detail_row(benchmark_id)
        if row is None:
            raise AppError(
                status_code=404,
                code="benchmark_not_found",
                message="Không tìm thấy lượt kiểm định AI.",
            )
        run, username = row
        return _to_detail(run, username)

    def open_benchmark_artifact(
        self,
        *,
        benchmark_id: uuid.UUID,
        artifact: Literal["flair", "t1ce", "gt_mask", "pred_mask"],
    ) -> StoredFile:
        run = self.benchmarks.get_by_id(benchmark_id)
        if run is None:
            raise AppError(
                status_code=404,
                code="benchmark_not_found",
                message="Không tìm thấy lượt kiểm định AI.",
            )
        file_map: dict[str, uuid.UUID | None] = {
            "flair": run.flair_file_id,
            "t1ce": run.t1ce_file_id,
            "gt_mask": run.gt_mask_file_id,
            "pred_mask": run.pred_mask_file_id,
        }
        file_id = file_map.get(artifact)
        if file_id is None:
            raise AppError(
                status_code=404,
                code="file_not_found",
                message="Tệp dữ liệu kiểm định chưa sẵn sàng.",
            )
        stored_file = self.db.scalar(
            select(StoredFile).where(
                StoredFile.id == file_id,
                StoredFile.state == "committed",
                StoredFile.deleted_at.is_(None),
            )
        )
        if stored_file is None or stored_file.storage_key is None:
            raise AppError(
                status_code=404,
                code="file_not_found",
                message="Không tìm thấy tệp dữ liệu kiểm định.",
            )
        return stored_file

    def delete_benchmark(
        self,
        *,
        benchmark_id: uuid.UUID,
        admin: User,
        request_id: str,
        ip_address: str,
    ) -> BenchmarkDeletionOut:
        run = self.benchmarks.get_by_id_for_update(benchmark_id)
        if run is None:
            raise AppError(
                status_code=404,
                code="benchmark_not_found",
                message="Không tìm thấy lượt kiểm định AI.",
            )
        if run.state == "running":
            raise AppError(
                status_code=409,
                code="benchmark_running",
                message="Không thể xóa lượt kiểm định đang chạy trên worker.",
            )

        file_ids = [
            fid
            for fid in (
                run.flair_file_id,
                run.t1ce_file_id,
                run.gt_mask_file_id,
                run.pred_mask_file_id,
                run.coverage_file_id,
            )
            if fid is not None
        ]
        target_worker = run.target_worker_id
        self.db.delete(run)
        self.db.flush()

        stored_files = self.files.list_by_ids(file_ids)
        for sf in stored_files:
            if sf.state != "deleted":
                sf.state = "deleting"
        self.db.flush()
        files_cleaned = StoredFileService(self.db, self.storage).cleanup_deleting_files(
            files=stored_files
        )

        self.audits.record_event(
            actor_type="user",
            actor_id=admin.id,
            action="admin_benchmark.deleted",
            resource_type="admin_benchmark_run",
            resource_id=str(benchmark_id),
            outcome="success",
            request_id=request_id,
            ip_address=ip_address,
            safe_diff={"target_worker_id": target_worker, "deleted_files": len(stored_files)},
        )
        self.db.commit()
        return BenchmarkDeletionOut(
            resource_id=benchmark_id,
            files_cleaned=files_cleaned,
            message="Đã xóa lượt kiểm định và dọn các tệp lưu trữ liên quan.",
        )

    # ---- Worker coordination methods (invoked transparently via InferenceJobService) ----

    def claim_for_worker(
        self,
        *,
        worker_id: str,
        device_type: str,
        model_version_id: str | None,
        worker: WorkerInstance,
    ) -> WorkerClaimOut | None:
        now = datetime.now(UTC)
        while True:
            run = self.benchmarks.claim_next_for_worker(worker_id)
            if run is None:
                return None

            file_rows = {
                row.id: row
                for row in self.files.list_by_ids([run.flair_file_id, run.t1ce_file_id])
            }
            if any(
                fid not in file_rows or file_rows[fid].state != "committed"
                for fid in (run.flair_file_id, run.t1ce_file_id)
            ):
                run.state = "failed"
                run.error_code = "input_changed"
                run.finished_at = now
                self.db.flush()
                continue

            attempt_id = uuid.uuid4()
            lease_token = secrets.token_urlsafe(32)
            effective_model = model_version_id or worker.model_version_id or "custom-worker"

            run.attempt_id = attempt_id
            run.lease_token_hash = _hash_token(lease_token)
            run.lease_expires_at = now + timedelta(seconds=_LEASE_SECONDS)
            run.state = "running"
            run.stage = "loading"
            run.executed_worker_id = worker_id
            run.worker_device_type = device_type
            run.model_version_id = effective_model
            run.started_at = run.started_at or now
            run.error_code = None
            worker.current_job_id = run.id
            self.db.flush()

            flair_row = file_rows[run.flair_file_id]
            t1ce_row = file_rows[run.t1ce_file_id]
            claim_out = WorkerClaimOut(
                job_id=run.id,
                attempt_id=attempt_id,
                attempt_number=1,
                lease_token=lease_token,
                lease_expires_at=run.lease_expires_at,
                model_version_id=effective_model,
                manifest=_load_manifest_for_claim(self.settings, run),
                # Strictly FLAIR + T1ce only; never leak gt_mask_file_id.
                files=[
                    WorkerInputFile(
                        volume_id=flair_row.id,
                        file_id=flair_row.id,
                        modality="flair",
                        sha256=flair_row.sha256,
                        extension="nii.gz"
                        if flair_row.media_type == "application/gzip"
                        else "nii",
                    ),
                    WorkerInputFile(
                        volume_id=t1ce_row.id,
                        file_id=t1ce_row.id,
                        modality="t1ce",
                        sha256=t1ce_row.sha256,
                        extension="nii.gz"
                        if t1ce_row.media_type == "application/gzip"
                        else "nii",
                    ),
                ],
            )
            self.db.commit()
            return claim_out

    def _active_run(
        self,
        *,
        benchmark_id: uuid.UUID,
        attempt_id: uuid.UUID,
        lease_token: str,
        worker_id: str,
        lock: bool = True,
    ) -> AdminBenchmarkRun | None:
        stmt = select(AdminBenchmarkRun).where(AdminBenchmarkRun.id == benchmark_id)
        if lock:
            stmt = stmt.with_for_update().execution_options(populate_existing=True)
        run = self.db.scalar(stmt)
        if run is None:
            return None

        now = datetime.now(UTC)
        if (
            run.attempt_id != attempt_id
            or run.executed_worker_id != worker_id
            or run.lease_token_hash is None
            or not secrets.compare_digest(run.lease_token_hash, _hash_token(lease_token))
        ):
            raise AppError(
                status_code=409,
                code="stale_attempt",
                message="Tác vụ worker không còn lease hợp lệ.",
            )
        if (
            run.lease_expires_at is None
            or _as_utc(run.lease_expires_at) <= now
            or run.state != "running"
        ):
            raise AppError(
                status_code=409,
                code="stale_attempt",
                message="Lease của tác vụ đã hết hạn.",
            )
        return run

    def authorize_input_file(
        self,
        *,
        file_id: uuid.UUID,
        job_id: uuid.UUID,
        attempt_id: uuid.UUID,
        worker_id: str,
        lease_token: str,
    ) -> StoredFile | None:
        run = self._active_run(
            benchmark_id=job_id,
            attempt_id=attempt_id,
            lease_token=lease_token,
            worker_id=worker_id,
            lock=False,
        )
        if run is None:
            return None
        # Security boundary: gt_mask_file_id must never be downloadable by any worker.
        if file_id not in {run.flair_file_id, run.t1ce_file_id}:
            raise AppError(
                status_code=404,
                code="file_not_found",
                message="Không tìm thấy tệp đầu vào của tác vụ.",
            )
        file_row = self.db.scalar(
            select(StoredFile).where(
                StoredFile.id == file_id,
                StoredFile.state == "committed",
                StoredFile.deleted_at.is_(None),
            )
        )
        if file_row is None:
            raise AppError(
                status_code=404,
                code="file_not_found",
                message="Không tìm thấy tệp đầu vào của tác vụ.",
            )
        return file_row

    def heartbeat(
        self,
        *,
        job_id: uuid.UUID,
        worker_id: str,
        attempt_id: uuid.UUID,
        lease_token: str,
        stage: str,
        completed_slices: int | None,
        total_slices: int | None,
    ) -> InferenceJobOut | None:
        run = self._active_run(
            benchmark_id=job_id,
            attempt_id=attempt_id,
            lease_token=lease_token,
            worker_id=worker_id,
            lock=True,
        )
        if run is None:
            return None
        if stage not in _ACTIVE_WORKER_STAGES:
            raise AppError(
                status_code=422,
                code="validation_error",
                message="Trạng thái giai đoạn heartbeat của worker không hợp lệ.",
            )
        now = datetime.now(UTC)
        run.lease_expires_at = now + timedelta(seconds=_LEASE_SECONDS)
        run.stage = stage
        run.completed_slices = completed_slices
        run.total_slices = total_slices
        worker = self.db.get(WorkerInstance, worker_id)
        if worker is not None:
            worker.last_heartbeat_at = now
            worker.current_job_id = run.id
        self.db.commit()
        return _to_worker_job_out(run)

    def _verify_succeeded_replay(
        self,
        *,
        run: AdminBenchmarkRun,
        attempt_id: uuid.UUID,
        worker_id: str,
        lease_token: str,
        digest: str | None = None,
    ) -> InferenceJobOut:
        if (
            run.attempt_id != attempt_id
            or run.executed_worker_id != worker_id
            or run.lease_token_hash is None
            or not secrets.compare_digest(run.lease_token_hash, _hash_token(lease_token))
        ):
            raise AppError(
                status_code=409,
                code="stale_attempt",
                message="Tác vụ worker không còn lease hợp lệ.",
            )
        if digest is not None and run.result_digest != digest:
            raise AppError(
                status_code=409,
                code="complete_digest_conflict",
                message="Kết quả hoàn tất của tác vụ kiểm định đã khác payload hiện tại.",
            )
        return _to_worker_job_out(run)

    async def complete(
        self,
        *,
        job_id: uuid.UUID,
        worker_id: str,
        attempt_id: uuid.UUID,
        lease_token: str,
        mask_file: BinaryIO,
        mask_filename: str,
        coverage_file: BinaryIO,
        metadata_file: BinaryIO,
        request_id: str,
    ) -> InferenceJobOut | None:
        from app.services.inference_job_service import (
            _validate_worker_result_metadata,
            resolve_final_slice_counts,
        )

        probe = self.benchmarks.get_by_id(job_id)
        if probe is None:
            return None

        incoming: StagedFile | None = None
        coverage_stage: StagedFile | None = None
        metadata_stage: StagedFile | None = None
        mask_staged: StagedFile | None = None
        coverage_staged: StagedFile | None = None
        canonical_temp: Path | None = None
        committed_keys: list[str] = []
        committed_to_db = False

        try:
            incoming = self.storage.put_temp(mask_file)
            coverage_stage = self.storage.put_temp(coverage_file)
            metadata_stage = self.storage.put_temp(metadata_file)
            if (
                coverage_stage.size_bytes > 8 * 1024 * 1024
                or metadata_stage.size_bytes > 2 * 1024 * 1024
            ):
                raise AppError(
                    status_code=413,
                    code="payload_too_large",
                    message="Metadata kết quả vượt quá giới hạn.",
                )

            if probe.state == "succeeded":
                self._verify_succeeded_replay(
                    run=probe,
                    attempt_id=attempt_id,
                    worker_id=worker_id,
                    lease_token=lease_token,
                )
            else:
                self._active_run(
                    benchmark_id=job_id,
                    attempt_id=attempt_id,
                    lease_token=lease_token,
                    worker_id=worker_id,
                    lock=False,
                )

            ref_shape = [int(v) for v in probe.shape_json]
            ref_spacing = [float(v) for v in probe.spacing_mm_json]
            ref_affine = [[float(c) for c in row] for row in probe.affine_json]
            gt_file = self.db.get(StoredFile, probe.gt_mask_file_id)
            if gt_file is None or gt_file.storage_key is None or gt_file.state != "committed":
                raise AppError(
                    status_code=409,
                    code="invalid_reference_volume",
                    message="Tệp nhãn bác sĩ đối chiếu không còn tồn tại.",
                )
            gt_storage_key = str(gt_file.storage_key)
            _, max_decompressed_bytes = self._effective_upload_limits()
            self.db.rollback()

            raw_mask_path = self.storage.staging_root / incoming.staging_key
            canonical = await asyncio.to_thread(
                validate_and_canonicalize_mask,
                file_path=raw_mask_path,
                is_gzip=mask_filename.lower().endswith(".gz"),
                ref_shape=ref_shape,
                ref_spacing_mm=ref_spacing,
                ref_affine_mm=ref_affine,
                max_decompressed_bytes=max_decompressed_bytes,
                temp_dir=self.storage.staging_root,
            )
            canonical_temp = canonical.canonical_nii_gz_path

            coverage_path = self.storage.staging_root / coverage_stage.staging_key
            try:
                coverage_json = json.loads(coverage_path.read_text(encoding="utf-8"))
                if not isinstance(coverage_json, dict):
                    raise ValueError("coverage must be an object")
                coverage_bytes = json.dumps(
                    coverage_json, ensure_ascii=False, separators=(",", ":")
                ).encode()
            except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
                raise AppError(
                    status_code=422,
                    code="invalid_result_metadata",
                    message="Metadata coverage của worker không hợp lệ.",
                ) from None

            meta_path = self.storage.staging_root / metadata_stage.staging_key
            try:
                metadata_bytes = meta_path.read_bytes()
                meta = json.loads(metadata_bytes.decode("utf-8"))
                if not isinstance(meta, dict):
                    raise ValueError("metadata must be an object")
            except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
                raise AppError(
                    status_code=422,
                    code="invalid_result_metadata",
                    message="Metadata kết quả của worker không hợp lệ.",
                ) from None

            _validate_worker_result_metadata(
                coverage_json=coverage_json,
                meta=meta,
                ref_shape=ref_shape,
            )

            cov_sha = hashlib.sha256(coverage_bytes).hexdigest()
            meta_sha = hashlib.sha256(metadata_bytes).hexdigest()
            digest = hashlib.sha256(f"{canonical.sha256}:{cov_sha}:{meta_sha}".encode()).hexdigest()

            def _score_sync() -> dict[str, Any]:
                with (
                    canonical_temp.open("rb") as pred_handle,
                    self.storage.open(gt_storage_key, "rb") as gt_handle,
                ):
                    return evaluate_benchmark_mask_streams(
                        pred_stream=pred_handle,
                        gt_stream=gt_handle,
                        affine_mm=ref_affine,
                        coverage_json=coverage_json,
                    )

            metrics_json = await asyncio.to_thread(_score_sync)

            with canonical_temp.open("rb") as canonical_handle:
                mask_staged = self.storage.put_temp(canonical_handle)
            coverage_staged = self.storage.put_temp(coverage_bytes)

            try:
                run = self._active_run(
                    benchmark_id=job_id,
                    attempt_id=attempt_id,
                    lease_token=lease_token,
                    worker_id=worker_id,
                    lock=True,
                )
            except AppError:
                self.db.rollback()
                completed_run = self.benchmarks.get_by_id(job_id)
                if completed_run is not None and completed_run.state == "succeeded":
                    return self._verify_succeeded_replay(
                        run=completed_run,
                        attempt_id=attempt_id,
                        worker_id=worker_id,
                        lease_token=lease_token,
                        digest=digest,
                    )
                raise

            if run is None:
                return None

            self.files.acquire_quota_locks(run.created_by)
            _, system_quota = resolve_effective_quotas(self.system_settings, self.settings)
            _, system_used = self.files.get_committed_usage_bytes(run.created_by)
            result_total_bytes = mask_staged.size_bytes + coverage_staged.size_bytes
            if system_used + result_total_bytes > system_quota:
                raise AppError(
                    status_code=413,
                    code="storage_quota_exceeded",
                    message="Không đủ dung lượng hệ thống để lưu kết quả kiểm định AI.",
                )

            mask_obj = self.storage.commit(mask_staged.staging_key)
            mask_staged = None
            committed_keys.append(mask_obj.storage_key)
            coverage_obj = self.storage.commit(coverage_staged.staging_key)
            coverage_staged = None
            committed_keys.append(coverage_obj.storage_key)

            db_mask = StoredFile(
                storage_key=uuid.UUID(mask_obj.storage_key),
                original_name=f"benchmark-ai-mask-{run.id}.nii.gz",
                size_bytes=mask_obj.size_bytes,
                sha256=mask_obj.sha256,
                media_type="application/gzip",
                state="committed",
                owner_id=run.created_by,
            )
            db_coverage = StoredFile(
                storage_key=uuid.UUID(coverage_obj.storage_key),
                original_name=f"benchmark-coverage-{run.id}.json",
                size_bytes=coverage_obj.size_bytes,
                sha256=coverage_obj.sha256,
                media_type="application/json",
                state="committed",
                owner_id=run.created_by,
            )
            self.db.add_all([db_mask, db_coverage])
            self.db.flush()

            now = datetime.now(UTC)
            duration_ms = (
                max(0, int((now - _as_utc(run.started_at)).total_seconds() * 1000))
                if run.started_at is not None
                else None
            )

            final_completed, final_total = resolve_final_slice_counts(coverage_json, ref_shape)
            run.pred_mask_file_id = db_mask.id
            run.coverage_file_id = db_coverage.id
            run.coverage_json = coverage_json
            run.metrics_json = metrics_json
            run.inference_duration_ms = duration_ms
            run.state = "succeeded"
            run.stage = "done"
            run.completed_slices = final_completed
            run.total_slices = final_total
            run.finished_at = now
            run.result_digest = digest
            run.error_code = None

            worker = self.db.get(WorkerInstance, worker_id)
            if worker is not None and worker.current_job_id == run.id:
                worker.current_job_id = None
                worker.last_heartbeat_at = now

            self.audits.record_event(
                actor_type="worker",
                actor_id=None,
                action="admin_benchmark.completed",
                resource_type="admin_benchmark_run",
                resource_id=str(run.id),
                outcome="success",
                request_id=request_id,
                safe_diff={
                    "worker_id": worker_id,
                    "mean_dice_brats": metrics_json.get("mean_dice_brats"),
                    "inference_duration_ms": duration_ms,
                },
            )
            result_out = _to_worker_job_out(run)
            self.db.commit()
            committed_to_db = True
            return result_out
        except Exception:
            if not committed_to_db:
                with contextlib.suppress(Exception):
                    self.db.rollback()
                    self._rollback_cleanup_committed(committed_keys)
            raise
        finally:
            for staged in (incoming, coverage_stage, metadata_stage, mask_staged, coverage_staged):
                if staged is not None:
                    self.storage.staging_root.joinpath(staged.staging_key).unlink(missing_ok=True)
            if canonical_temp is not None:
                canonical_temp.unlink(missing_ok=True)

    def fail(
        self,
        *,
        job_id: uuid.UUID,
        worker_id: str,
        attempt_id: uuid.UUID,
        lease_token: str,
        error_code: str,
        request_id: str,
    ) -> InferenceJobOut | None:
        run = self._active_run(
            benchmark_id=job_id,
            attempt_id=attempt_id,
            lease_token=lease_token,
            worker_id=worker_id,
            lock=True,
        )
        if run is None:
            return None
        safe_code = error_code if error_code in _SAFE_ERROR_CODES else "worker_error"
        now = datetime.now(UTC)
        run.state = "failed"
        run.error_code = safe_code
        run.finished_at = now

        worker = self.db.get(WorkerInstance, worker_id)
        if worker is not None and worker.current_job_id == run.id:
            worker.current_job_id = None
            worker.last_heartbeat_at = now

        self.audits.record_event(
            actor_type="worker",
            actor_id=None,
            action="admin_benchmark.failed",
            resource_type="admin_benchmark_run",
            resource_id=str(run.id),
            outcome="failure",
            request_id=request_id,
            safe_diff={"worker_id": worker_id, "error_code": safe_code},
        )
        self.db.commit()
        return _to_worker_job_out(run)

    @staticmethod
    def reap_expired_runs(db: Session, now: datetime) -> int:
        runs = list(
            db.scalars(
                select(AdminBenchmarkRun)
                .where(
                    AdminBenchmarkRun.state == "running",
                    AdminBenchmarkRun.lease_expires_at.is_not(None),
                    AdminBenchmarkRun.lease_expires_at <= now,
                )
                .order_by(AdminBenchmarkRun.lease_expires_at)
                .with_for_update(skip_locked=True)
                .execution_options(populate_existing=True)
                .limit(100)
            ).all()
        )
        count = 0
        for run in runs:
            run.state = "failed"
            run.error_code = "worker_lease_expired"
            run.finished_at = now
            if run.executed_worker_id:
                worker = db.get(WorkerInstance, run.executed_worker_id)
                if worker is not None and worker.current_job_id == run.id:
                    worker.current_job_id = None
            count += 1
        return count


def list_active_benchmark_ids(db: Session, candidate_ids: list[uuid.UUID]) -> set[uuid.UUID]:
    """Return subset of candidate IDs that belong to currently running AdminBenchmarkRuns."""
    if not candidate_ids:
        return set()
    return set(
        db.scalars(
            select(AdminBenchmarkRun.id).where(
                AdminBenchmarkRun.id.in_(candidate_ids),
                or_(AdminBenchmarkRun.state == "running",),
            )
        ).all()
    )
