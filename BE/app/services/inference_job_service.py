"""P5 inference job lifecycle, worker leases, and immutable AI result publication."""

from __future__ import annotations

import contextlib
import hashlib
import json
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, BinaryIO

from sqlalchemy import String, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.errors import AppError
from app.core.storage import LocalStorageAdapter
from app.models.case import Case
from app.models.inference_job import (
    InferenceJob,
    JobAttempt,
    JobCreateIdempotencyKey,
    ModelVersion,
    WorkerInstance,
)
from app.models.mask_version import MaskVersion
from app.models.patient import Patient
from app.models.stored_file import StoredFile
from app.models.system_setting import SystemSetting
from app.models.user import User
from app.models.volume import Volume
from app.repositories.audit_repo import AuditRepository
from app.repositories.case_repo import CaseRepository
from app.repositories.file_repo import FileRepository
from app.repositories.mask_version_repo import MaskVersionRepository
from app.repositories.system_setting_repo import SystemSettingRepository
from app.repositories.volume_repo import VolumeRepository
from app.schemas.common import PaginatedResponse
from app.schemas.jobs import (
    AdminJobAttemptOut,
    AdminJobDetailOut,
    AdminJobOut,
    InferenceJobOut,
    WorkerClaimOut,
    WorkerInputFile,
)
from app.services.case_service import compute_case_inference_status
from app.services.mask_version_service import (
    compute_mask_statistics,
    validate_and_canonicalize_mask,
)
from app.services.volume_service import resolve_effective_quotas

LEASE_SECONDS = 90
WORKER_ONLINE_SECONDS = 90
_REAPER_ADVISORY_LOCK_ID = 700005
_ACTIVE_WORKER_STAGES = frozenset(
    {"loading", "preprocessing", "inference", "reconstructing", "saving"}
)
_SAFE_ERROR_CODES = {
    "invalid_nifti",
    "input_geometry_mismatch",
    "model_unavailable",
    "model_error",
    "inference_error",
    "result_invalid",
    "worker_error",
}


def _manifest_path(settings: Settings) -> Path:
    return (
        settings.MODEL_MANIFEST_PATH
        or Path(__file__).resolve().parents[2] / "worker" / "manifest.json"
    )


def _raise(status: int, code: str, message: str) -> None:
    raise AppError(status_code=status, code=code, message=message)


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _read_manifest(settings: Settings) -> tuple[dict[str, Any], Path]:
    path = _manifest_path(settings)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict) or data.get("verification_status") != "verified":
            raise ValueError("manifest is not verified")
        input_profile = data["input_profile"]
        checkpoint_sha = str(data["checkpoint_sha256"])
        if len(checkpoint_sha) != 64:
            raise ValueError("manifest checkpoint fingerprint is invalid")
        if not isinstance(input_profile.get("shape"), list) or not isinstance(
            input_profile.get("spacing_mm"), list
        ):
            raise ValueError("manifest input profile is invalid")
        return data, path
    except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise AppError(
            status_code=503,
            code="model_unavailable",
            message="Chưa có model manifest hợp lệ để tiếp nhận tác vụ AI.",
        ) from exc


def sync_active_model(db: Session, settings: Settings) -> ModelVersion:
    """Persist safe model metadata while keeping raw paths hidden from API responses."""
    manifest, _ = _read_manifest(settings)
    model_id = str(manifest["model_id"])
    version = str(manifest["version"])
    registry_id = f"{model_id}:{version}"
    row = db.get(ModelVersion, registry_id)
    if row is None:
        try:
            with db.begin_nested():
                row = ModelVersion(
                    id=registry_id,
                    model_id=model_id,
                    name=str(manifest.get("display_name") or model_id),
                    version=version,
                    pipeline_version=str(manifest["pipeline_version"]),
                    checkpoint_sha256=str(manifest["checkpoint_sha256"]),
                    expected_shape_json=[int(v) for v in manifest["input_profile"]["shape"]],
                    expected_spacing_mm_json=[
                        float(v) for v in manifest["input_profile"]["spacing_mm"]
                    ],
                    manifest_json=manifest,
                    verified=True,
                    is_active=True,
                )
                db.add(row)
                db.flush()
        except IntegrityError:
            row = db.get(ModelVersion, registry_id)
            if row is None:
                raise
    row.name = str(manifest.get("display_name") or model_id)
    row.pipeline_version = str(manifest["pipeline_version"])
    row.checkpoint_sha256 = str(manifest["checkpoint_sha256"])
    row.expected_shape_json = [int(v) for v in manifest["input_profile"]["shape"]]
    row.expected_spacing_mm_json = [float(v) for v in manifest["input_profile"]["spacing_mm"]]
    row.manifest_json = manifest
    row.verified = True
    row.is_active = True
    db.query(ModelVersion).filter(ModelVersion.id != registry_id).update(
        {ModelVersion.is_active: False}, synchronize_session=False
    )
    db.flush()
    return row


def resolve_final_slice_counts(
    coverage_json: dict[str, Any],
    ref_shape: list[int],
) -> tuple[int, int]:
    """Resolve `(completed_slices, total_slices)` from coverage metadata or volume depth."""
    fallback_total = max(1, int(ref_shape[2]))
    raw_total = coverage_json.get("total_slices")
    final_total = (
        int(raw_total)
        if not isinstance(raw_total, bool) and isinstance(raw_total, int) and raw_total > 0
        else fallback_total
    )
    raw_eval = coverage_json.get("evaluated_slices")
    final_completed = (
        int(raw_eval)
        if not isinstance(raw_eval, bool) and isinstance(raw_eval, int) and raw_eval >= 0
        else final_total
    )
    return min(final_completed, final_total), final_total


def _get_job_out(job: InferenceJob) -> InferenceJobOut:
    return InferenceJobOut.model_validate(job)


class InferenceJobService:
    def __init__(self, db: Session, storage: LocalStorageAdapter, settings: Settings) -> None:
        self.db = db
        self.storage = storage
        self.settings = settings
        self.cases = CaseRepository(db)
        self.volumes = VolumeRepository(db)
        self.files = FileRepository(db)
        self.mask_versions = MaskVersionRepository(db)
        self.system_settings = SystemSettingRepository(db)
        self.audits = AuditRepository(db)

    def _accepting_jobs(self) -> bool:
        row = self.system_settings.get_by_key("admin_settings")
        if row is None:
            return True
        return bool(row.value_json.get("accepting_jobs", True))

    def create_job(
        self,
        *,
        doctor_id: uuid.UUID,
        case_id: uuid.UUID,
        idempotency_key: str,
        request_id: str,
        ip_address: str,
    ) -> InferenceJobOut:
        key = idempotency_key.strip()
        if not key or len(key) > 128:
            _raise(422, "validation_error", "Idempotency-Key phải có từ 1 đến 128 ký tự.")

        case = self.cases.get_active_for_owner_for_update(case_id, doctor_id)
        if case is None:
            _raise(404, "case_not_found", "Không tìm thấy ca chụp.")
        digest = hashlib.sha256(f"case:{case_id}".encode()).hexdigest()
        receipt = self.db.scalar(
            select(JobCreateIdempotencyKey).where(
                JobCreateIdempotencyKey.doctor_id == doctor_id,
                JobCreateIdempotencyKey.case_id == case_id,
                JobCreateIdempotencyKey.idempotency_key == key,
            )
        )
        if receipt is not None:
            if receipt.request_digest != digest:
                _raise(
                    409, "idempotency_conflict", "Idempotency-Key đã được dùng cho yêu cầu khác."
                )
            previous = self.db.get(InferenceJob, receipt.job_id)
            if previous is None:
                _raise(409, "idempotency_conflict", "Không thể khôi phục job đã gửi trước đó.")
            return _get_job_out(previous)

        intake_setting = self.db.scalar(
            select(SystemSetting).where(SystemSetting.key == "admin_settings").with_for_update()
        )
        if intake_setting is not None and not bool(
            intake_setting.value_json.get("accepting_jobs", True)
        ):
            _raise(503, "not_accepting_jobs", "Hệ thống đang tạm dừng nhận tác vụ AI mới.")

        model = sync_active_model(self.db, self.settings)
        volumes = self.volumes.list_active_for_case(case.id)
        readiness, can_run, reasons = compute_case_inference_status(
            volumes, manifest_path=_manifest_path(self.settings)
        )
        if not can_run:
            _raise(422, "case_not_ready", "Ca chụp chưa sẵn sàng: " + " ".join(reasons))
        if case.reference_volume_id is None or not any(
            v.id == case.reference_volume_id for v in volumes
        ):
            _raise(422, "invalid_reference_volume", "Ca chụp chưa có volume tham chiếu hợp lệ.")
        if any(v.validation_status != "valid" for v in volumes if v.modality in {"flair", "t1ce"}):
            _raise(422, "case_not_ready", "Các xung FLAIR và T1ce phải được xác thực hợp lệ.")

        active = self.db.scalar(
            select(InferenceJob.id).where(
                InferenceJob.case_id == case_id,
                InferenceJob.state.in_(("queued", "running")),
            )
        )
        if active is not None:
            _raise(409, "active_job_conflict", "Ca chụp đã có tác vụ AI đang chờ hoặc đang chạy.")

        try:
            job = InferenceJob(
                case_id=case_id,
                doctor_id=doctor_id,
                model_version_id=model.id,
                state="queued",
                stage="queued",
                attempt_count=0,
                auto_retry_count=0,
                max_auto_retries=1,
            )
            self.db.add(job)
            self.db.flush()
            self.db.add(
                JobCreateIdempotencyKey(
                    doctor_id=doctor_id,
                    case_id=case_id,
                    idempotency_key=key,
                    request_digest=digest,
                    job_id=job.id,
                )
            )
            case.inputs_locked_at = case.inputs_locked_at or datetime.now(UTC)
            case.readiness = readiness
            self.audits.record_event(
                actor_type="user",
                actor_id=doctor_id,
                action="job.create",
                resource_type="inference_job",
                resource_id=str(job.id),
                outcome="success",
                request_id=request_id,
                ip_address=ip_address,
                safe_diff={"case_id": str(case_id), "model_version_id": model.id},
            )
            self.db.flush()
            result_out = _get_job_out(job)
            self.db.commit()
            return result_out
        except IntegrityError:
            self.db.rollback()
            raced_receipt = self.db.scalar(
                select(JobCreateIdempotencyKey).where(
                    JobCreateIdempotencyKey.doctor_id == doctor_id,
                    JobCreateIdempotencyKey.case_id == case_id,
                    JobCreateIdempotencyKey.idempotency_key == key,
                )
            )
            if raced_receipt is not None:
                if raced_receipt.request_digest != digest:
                    _raise(
                        409,
                        "idempotency_conflict",
                        "Idempotency-Key đã được dùng cho yêu cầu khác.",
                    )
                previous = self.db.get(InferenceJob, raced_receipt.job_id)
                if previous is None:
                    _raise(
                        409,
                        "idempotency_conflict",
                        "Không thể khôi phục job đã gửi trước đó.",
                    )
                return _get_job_out(previous)
            _raise(
                409,
                "active_job_conflict",
                "Ca chụp đã có tác vụ AI đang chờ hoặc đang chạy.",
            )

    def list_case_jobs(
        self, *, doctor_id: uuid.UUID, case_id: uuid.UUID, page: int = 1, page_size: int = 20
    ) -> PaginatedResponse[InferenceJobOut]:
        if self.cases.get_active_for_owner(case_id, doctor_id) is None:
            _raise(404, "case_not_found", "Không tìm thấy ca chụp.")
        total = int(
            self.db.scalar(
                select(func.count())
                .select_from(InferenceJob)
                .where(InferenceJob.case_id == case_id)
            )
            or 0
        )
        rows = self.db.scalars(
            select(InferenceJob)
            .where(InferenceJob.case_id == case_id)
            .order_by(InferenceJob.created_at.desc(), InferenceJob.id.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()
        return PaginatedResponse[InferenceJobOut](
            items=[_get_job_out(job) for job in rows], total=total, page=page, page_size=page_size
        )

    def get_job(self, *, doctor_id: uuid.UUID, job_id: uuid.UUID) -> InferenceJobOut:
        job = self.db.scalar(
            select(InferenceJob)
            .join(Case, Case.id == InferenceJob.case_id)
            .join(Patient, Patient.id == Case.patient_id)
            .where(
                InferenceJob.id == job_id,
                InferenceJob.doctor_id == doctor_id,
                Case.deleting_at.is_(None),
                Case.deleted_at.is_(None),
                Patient.deleting_at.is_(None),
                Patient.deleted_at.is_(None),
            )
        )
        if job is None:
            _raise(404, "job_not_found", "Không tìm thấy tác vụ AI.")
        return _get_job_out(job)

    def cancel_job(
        self, *, doctor_id: uuid.UUID, job_id: uuid.UUID, request_id: str, ip_address: str
    ) -> InferenceJobOut:
        job = self.db.scalar(
            select(InferenceJob)
            .join(Case, Case.id == InferenceJob.case_id)
            .join(Patient, Patient.id == Case.patient_id)
            .where(
                InferenceJob.id == job_id,
                InferenceJob.doctor_id == doctor_id,
                Case.deleting_at.is_(None),
                Case.deleted_at.is_(None),
                Patient.deleting_at.is_(None),
                Patient.deleted_at.is_(None),
            )
            .with_for_update(of=InferenceJob)
            .execution_options(populate_existing=True)
        )
        if job is None:
            _raise(404, "job_not_found", "Không tìm thấy tác vụ AI.")
        if job.state != "queued":
            _raise(409, "job_not_cancellable", "Chỉ có thể hủy tác vụ đang ở trạng thái chờ.")
        case = self.db.scalar(
            select(Case)
            .where(Case.id == job.case_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        job.state = "cancelled"
        job.error_code = None
        job.completed_slices = None
        job.total_slices = None
        job.finished_at = datetime.now(UTC)
        if (
            case is not None
            and case.latest_mask_version_id is None
            and job.attempt_count == 0
        ):
            other_locking_job = self.db.scalar(
                select(InferenceJob.id)
                .where(
                    InferenceJob.case_id == case.id,
                    InferenceJob.id != job.id,
                    (InferenceJob.attempt_count > 0)
                    | InferenceJob.state.in_(("queued", "running")),
                )
                .limit(1)
            )
            if other_locking_job is None:
                case.inputs_locked_at = None
        self.audits.record_event(
            actor_type="user",
            actor_id=doctor_id,
            action="job.cancel",
            resource_type="inference_job",
            resource_id=str(job.id),
            outcome="success",
            request_id=request_id,
            ip_address=ip_address,
        )
        result_out = _get_job_out(job)
        self.db.commit()
        return result_out

    def _upsert_worker(
        self, *, worker_id: str, device_type: str, model_version_id: str | None, now: datetime
    ) -> WorkerInstance:
        row = self.db.get(WorkerInstance, worker_id)
        if row is None:
            try:
                with self.db.begin_nested():
                    row = WorkerInstance(
                        worker_id=worker_id,
                        device_type=device_type,
                        model_version_id=model_version_id,
                        current_job_id=None,
                        last_heartbeat_at=now,
                    )
                    self.db.add(row)
                    self.db.flush()
            except IntegrityError:
                row = self.db.get(WorkerInstance, worker_id)
                if row is None:
                    raise
        row.device_type = device_type
        row.model_version_id = model_version_id
        row.last_heartbeat_at = now
        return row

    def heartbeat_worker(
        self, *, worker_id: str, device_type: str, model_version_id: str | None
    ) -> None:
        now = datetime.now(UTC)
        self._upsert_worker(
            worker_id=worker_id,
            device_type=device_type,
            model_version_id=model_version_id,
            now=now,
        )
        self.db.commit()

    def availability(self) -> dict[str, object]:
        active_model: str | None = None
        try:
            manifest, _ = _read_manifest(self.settings)
            manifest_model_id = f"{manifest['model_id']}:{manifest['version']}"
            db_active = self.db.scalar(
                select(ModelVersion).where(ModelVersion.is_active.is_(True)).limit(1)
            )
            if db_active is not None:
                active_model = db_active.id if db_active.verified else None
            else:
                active_model = manifest_model_id
        except AppError:
            active_model = None
        online_cutoff = datetime.now(UTC) - timedelta(seconds=WORKER_ONLINE_SECONDS)
        worker_online = bool(
            self.db.scalar(
                select(func.count(WorkerInstance.worker_id)).where(
                    WorkerInstance.last_heartbeat_at >= online_cutoff
                )
            )
        )
        return {
            "accepting_jobs": self._accepting_jobs(),
            "worker_online": worker_online,
            "active_model_id": active_model,
            "updated_at": datetime.now(UTC),
        }

    def claim_job(
        self, *, worker_id: str, device_type: str, model_version_id: str | None
    ) -> WorkerClaimOut | None:
        from app.services.admin_benchmark_service import AdminBenchmarkService

        now = datetime.now(UTC)
        worker = self._upsert_worker(
            worker_id=worker_id,
            device_type=device_type,
            model_version_id=model_version_id,
            now=now,
        )
        worker.current_job_id = None
        if model_version_id:
            while True:
                job = self.db.scalar(
                    select(InferenceJob)
                    .join(Case, Case.id == InferenceJob.case_id)
                    .join(Patient, Patient.id == Case.patient_id)
                    .where(
                        InferenceJob.state == "queued",
                        InferenceJob.model_version_id == model_version_id,
                        Case.deleting_at.is_(None),
                        Case.deleted_at.is_(None),
                        Patient.deleting_at.is_(None),
                        Patient.deleted_at.is_(None),
                    )
                    .order_by(InferenceJob.created_at, InferenceJob.id)
                    .with_for_update(of=InferenceJob, skip_locked=True)
                    .execution_options(populate_existing=True)
                    .limit(1)
                )
                if job is None:
                    break

                volumes = self.volumes.list_active_for_case(job.case_id)
                required = {
                    v.modality: v
                    for v in volumes
                    if v.modality in {"flair", "t1ce"} and v.validation_status == "valid"
                }
                _, can_run, _ = compute_case_inference_status(
                    volumes,
                    manifest_path=_manifest_path(self.settings),
                )
                if set(required) != {"flair", "t1ce"} or not can_run:
                    job.state = "failed"
                    job.error_code = "input_changed"
                    job.finished_at = now
                    self.db.flush()
                    continue

                model = self.db.get(ModelVersion, job.model_version_id)
                if model is None or not model.verified:
                    job.state = "failed"
                    job.error_code = "model_unavailable"
                    job.finished_at = now
                    self.db.flush()
                    continue

                file_rows = {
                    row.id: row
                    for row in self.files.list_by_ids([v.file_id for v in required.values()])
                }
                if any(
                    v.file_id not in file_rows or file_rows[v.file_id].state != "committed"
                    for v in required.values()
                ):
                    job.state = "failed"
                    job.error_code = "input_changed"
                    job.finished_at = now
                    self.db.flush()
                    continue

                lease_token = secrets.token_urlsafe(32)
                attempt_number = job.attempt_count + 1
                attempt = JobAttempt(
                    job_id=job.id,
                    attempt_number=attempt_number,
                    worker_id=worker_id,
                    state="running",
                    lease_token_hash=_hash_token(lease_token),
                    lease_expires_at=now + timedelta(seconds=LEASE_SECONDS),
                    stage="loading",
                )
                self.db.add(attempt)
                job.state = "running"
                job.stage = "loading"
                job.attempt_count = attempt_number
                job.started_at = job.started_at or now
                job.error_code = None
                worker.current_job_id = job.id
                self.db.flush()
                result = WorkerClaimOut(
                    job_id=job.id,
                    attempt_id=attempt.id,
                    attempt_number=attempt_number,
                    lease_token=lease_token,
                    lease_expires_at=attempt.lease_expires_at,
                    model_version_id=job.model_version_id,
                    manifest=model.manifest_json,
                    files=[
                        WorkerInputFile(
                            volume_id=required[m].id,
                            file_id=required[m].file_id,
                            modality=m,
                            sha256=required[m].sha256,
                            extension="nii.gz"
                            if file_rows[required[m].file_id].media_type == "application/gzip"
                            else "nii",
                        )
                        for m in ("flair", "t1ce")
                    ],
                )
                self.db.commit()
                return result

        benchmark_claim = AdminBenchmarkService(
            self.db, self.storage, self.settings
        ).claim_for_worker(
            worker_id=worker_id,
            device_type=device_type,
            model_version_id=model_version_id,
            worker=worker,
        )
        if benchmark_claim is not None:
            return benchmark_claim
        self.db.commit()
        return None

    def _active_attempt(
        self,
        *,
        job_id: uuid.UUID,
        attempt_id: uuid.UUID,
        lease_token: str,
        worker_id: str,
        lock: bool = True,
    ) -> tuple[InferenceJob, JobAttempt]:
        stmt = (
            select(InferenceJob, JobAttempt)
            .join(JobAttempt, JobAttempt.job_id == InferenceJob.id)
            .where(
                InferenceJob.id == job_id,
                JobAttempt.id == attempt_id,
                JobAttempt.worker_id == worker_id,
                JobAttempt.state == "running",
            )
        )
        if lock:
            stmt = stmt.with_for_update(of=(InferenceJob, JobAttempt)).execution_options(
                populate_existing=True
            )
        pair = self.db.execute(stmt).first()
        now = datetime.now(UTC)
        if pair is None or not secrets.compare_digest(
            pair[1].lease_token_hash, _hash_token(lease_token)
        ):
            _raise(409, "stale_attempt", "Tác vụ worker không còn lease hợp lệ.")
        exp_utc = (
            pair[1].lease_expires_at.replace(tzinfo=UTC)
            if pair[1].lease_expires_at.tzinfo is None
            else pair[1].lease_expires_at.astimezone(UTC)
        )
        if exp_utc <= now or pair[0].state != "running":
            _raise(409, "stale_attempt", "Lease của tác vụ đã hết hạn.")
        return pair[0], pair[1]

    def heartbeat_job(
        self,
        *,
        job_id: uuid.UUID,
        worker_id: str,
        attempt_id: uuid.UUID,
        lease_token: str,
        stage: str,
        completed_slices: int | None,
        total_slices: int | None,
    ) -> InferenceJobOut:
        if stage not in _ACTIVE_WORKER_STAGES:
            _raise(
                422,
                "validation_error",
                "Trạng thái giai đoạn heartbeat của worker không hợp lệ.",
            )
        if completed_slices is not None and total_slices is None:
            _raise(
                422,
                "validation_error",
                "Phải cung cấp tổng số lát cắt khi báo cáo số lát cắt hoàn thành.",
            )
        if (
            completed_slices is not None
            and (
                completed_slices < 0
                or (total_slices is not None and completed_slices > total_slices)
            )
        ) or (total_slices is not None and total_slices < 1):
            _raise(
                422,
                "validation_error",
                "Số lát cắt hoàn thành không được vượt quá tổng số lát cắt.",
            )
        if self.db.get(InferenceJob, job_id) is None:
            from app.services.admin_benchmark_service import AdminBenchmarkService

            benchmark_out = AdminBenchmarkService(
                self.db, self.storage, self.settings
            ).heartbeat(
                job_id=job_id,
                worker_id=worker_id,
                attempt_id=attempt_id,
                lease_token=lease_token,
                stage=stage,
                completed_slices=completed_slices,
                total_slices=total_slices,
            )
            if benchmark_out is not None:
                return benchmark_out
        job, attempt = self._active_attempt(
            job_id=job_id, attempt_id=attempt_id, lease_token=lease_token, worker_id=worker_id
        )
        now = datetime.now(UTC)
        attempt.lease_expires_at = now + timedelta(seconds=LEASE_SECONDS)
        attempt.stage = stage
        attempt.completed_slices = completed_slices
        attempt.total_slices = total_slices
        job.stage = stage
        job.completed_slices = completed_slices
        job.total_slices = total_slices
        worker = self.db.get(WorkerInstance, worker_id)
        if worker is not None:
            worker.last_heartbeat_at = now
            worker.current_job_id = job.id
        self.db.commit()
        return _get_job_out(job)

    def authorize_input_file(
        self,
        *,
        file_id: uuid.UUID,
        job_id: uuid.UUID,
        attempt_id: uuid.UUID,
        worker_id: str,
        lease_token: str,
    ) -> StoredFile:
        if self.db.get(InferenceJob, job_id) is None:
            from app.services.admin_benchmark_service import AdminBenchmarkService

            bench_file = AdminBenchmarkService(
                self.db, self.storage, self.settings
            ).authorize_input_file(
                file_id=file_id,
                job_id=job_id,
                attempt_id=attempt_id,
                worker_id=worker_id,
                lease_token=lease_token,
            )
            if bench_file is not None:
                return bench_file
        job, _ = self._active_attempt(
            job_id=job_id,
            attempt_id=attempt_id,
            lease_token=lease_token,
            worker_id=worker_id,
            lock=False,
        )
        file_row = self.db.scalar(
            select(StoredFile)
            .join(Volume, Volume.file_id == StoredFile.id)
            .where(
                StoredFile.id == file_id,
                StoredFile.state == "committed",
                StoredFile.deleted_at.is_(None),
                Volume.case_id == job.case_id,
                Volume.deleted_at.is_(None),
                Volume.validation_status == "valid",
                Volume.modality.in_(("flair", "t1ce")),
            )
        )
        if file_row is None:
            _raise(404, "file_not_found", "Không tìm thấy tệp đầu vào của tác vụ.")
        return file_row

    def _verify_succeeded_attempt(
        self,
        *,
        job_id: uuid.UUID,
        attempt_id: uuid.UUID,
        worker_id: str,
        lease_token: str,
    ) -> None:
        previous_attempt = self.db.get(JobAttempt, attempt_id)
        if (
            previous_attempt is None
            or previous_attempt.job_id != job_id
            or previous_attempt.worker_id != worker_id
            or previous_attempt.state != "succeeded"
            or not secrets.compare_digest(
                previous_attempt.lease_token_hash, _hash_token(lease_token)
            )
        ):
            _raise(409, "stale_attempt", "Tác vụ worker không còn lease hợp lệ.")

    def _effective_max_decompressed_bytes(self) -> int:
        row = self.system_settings.get_by_key("admin_settings")
        values = row.value_json if row is not None else {}
        max_mib = values.get("max_decompressed_mib") if isinstance(values, dict) else None
        if isinstance(max_mib, int) and max_mib > 0:
            return min(max_mib * 1024 * 1024, self.settings.MAX_DECOMPRESSED_BYTES)
        return self.settings.MAX_DECOMPRESSED_BYTES

    def _fail_active_for_invalid_reference(
        self,
        *,
        job: InferenceJob,
        attempt: JobAttempt,
        worker_id: str,
    ) -> None:
        now = datetime.now(UTC)
        attempt.state = "failed"
        attempt.error_code = "invalid_reference_volume"
        attempt.finished_at = now
        job.state = "failed"
        job.error_code = "invalid_reference_volume"
        job.finished_at = now
        worker = self.db.get(WorkerInstance, worker_id)
        if worker is not None and worker.current_job_id == job.id:
            worker.current_job_id = None
            worker.last_heartbeat_at = now
        self.db.commit()

    async def complete_job(
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
    ) -> InferenceJobOut:
        if self.db.get(InferenceJob, job_id) is None:
            from app.services.admin_benchmark_service import AdminBenchmarkService

            benchmark_out = await AdminBenchmarkService(
                self.db, self.storage, self.settings
            ).complete(
                job_id=job_id,
                worker_id=worker_id,
                attempt_id=attempt_id,
                lease_token=lease_token,
                mask_file=mask_file,
                mask_filename=mask_filename,
                coverage_file=coverage_file,
                metadata_file=metadata_file,
                request_id=request_id,
            )
            if benchmark_out is not None:
                return benchmark_out
            _raise(404, "job_not_found", "Không tìm thấy tác vụ AI.")

        # Stage artifacts before taking database locks; parsing NIfTI can take several seconds.
        incoming = None
        coverage_stage = None
        metadata_stage = None
        mask_staged = None
        coverage_staged = None
        committed_keys: list[str] = []
        canonical_temp: Path | None = None
        committed_to_db = False
        try:
            incoming = self.storage.put_temp(mask_file)
            coverage_stage = self.storage.put_temp(coverage_file)
            metadata_stage = self.storage.put_temp(metadata_file)
            if (
                coverage_stage.size_bytes > 8 * 1024 * 1024
                or metadata_stage.size_bytes > 2 * 1024 * 1024
            ):
                _raise(413, "payload_too_large", "Metadata kết quả vượt quá giới hạn.")

            queued_job = self.db.get(InferenceJob, job_id)
            if queued_job is None:
                _raise(404, "job_not_found", "Không tìm thấy tác vụ AI.")
            already_succeeded = queued_job.state == "succeeded"
            case_id = queued_job.case_id
            if already_succeeded:
                self._verify_succeeded_attempt(
                    job_id=job_id,
                    attempt_id=attempt_id,
                    worker_id=worker_id,
                    lease_token=lease_token,
                )
            else:
                self._active_attempt(
                    job_id=job_id,
                    attempt_id=attempt_id,
                    lease_token=lease_token,
                    worker_id=worker_id,
                    lock=False,
                )
            case = self.db.get(Case, case_id)
            reference = (
                self.db.get(Volume, case.reference_volume_id)
                if case is not None
                and case.deleting_at is None
                and case.deleted_at is None
                and case.reference_volume_id is not None
                else None
            )
            if (
                reference is None
                or reference.deleted_at is not None
                or reference.validation_status != "valid"
            ):
                if not already_succeeded:
                    locked_job, locked_attempt = self._active_attempt(
                        job_id=job_id,
                        attempt_id=attempt_id,
                        lease_token=lease_token,
                        worker_id=worker_id,
                        lock=True,
                    )
                    self._fail_active_for_invalid_reference(
                        job=locked_job,
                        attempt=locked_attempt,
                        worker_id=worker_id,
                    )
                    committed_to_db = True
                _raise(
                    409, "invalid_reference_volume", "Ca chụp không còn volume tham chiếu hợp lệ."
                )
            reference_id = reference.id
            ref_shape = [int(v) for v in reference.shape]
            ref_spacing = [float(v) for v in reference.spacing_mm]
            ref_affine = [[float(c) for c in row] for row in reference.affine]
            max_decompressed_bytes = self._effective_max_decompressed_bytes()
            self.db.rollback()

            raw_mask_path = self.storage.staging_root / incoming.staging_key
            canonical = validate_and_canonicalize_mask(
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
                _raise(422, "invalid_result_metadata", "Metadata coverage của worker không hợp lệ.")
            # Metadata is intentionally parsed but not persisted or returned to admin.
            meta_path = self.storage.staging_root / metadata_stage.staging_key
            try:
                metadata_bytes = meta_path.read_bytes()
                meta = json.loads(metadata_bytes.decode("utf-8"))
                if not isinstance(meta, dict):
                    raise ValueError("metadata must be an object")
            except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
                _raise(422, "invalid_result_metadata", "Metadata kết quả của worker không hợp lệ.")

            cov_sha = hashlib.sha256(coverage_bytes).hexdigest()
            meta_sha = hashlib.sha256(metadata_bytes).hexdigest()
            digest = hashlib.sha256(f"{canonical.sha256}:{cov_sha}:{meta_sha}".encode()).hexdigest()
            completed_job = self.db.scalar(select(InferenceJob).where(InferenceJob.id == job_id))
            if completed_job is not None and completed_job.state == "succeeded":
                self._verify_succeeded_attempt(
                    job_id=job_id,
                    attempt_id=attempt_id,
                    worker_id=worker_id,
                    lease_token=lease_token,
                )
                if completed_job.result_digest == digest:
                    return _get_job_out(completed_job)
                _raise(
                    409,
                    "complete_digest_conflict",
                    "Kết quả hoàn tất của job đã khác payload hiện tại.",
                )
            self.db.rollback()

            _validate_worker_result_metadata(
                coverage_json=coverage_json,
                meta=meta,
                ref_shape=ref_shape,
            )

            with canonical_temp.open("rb") as canonical_handle:
                mask_staged = self.storage.put_temp(canonical_handle)
            coverage_staged = self.storage.put_temp(coverage_bytes)

            # Acquire attempt lock, Case lock, and verify reference + quota before storage.commit
            try:
                job, attempt = self._active_attempt(
                    job_id=job_id,
                    attempt_id=attempt_id,
                    lease_token=lease_token,
                    worker_id=worker_id,
                )
            except AppError:
                self.db.rollback()
                completed_job = self.db.scalar(
                    select(InferenceJob).where(InferenceJob.id == job_id)
                )
                if completed_job is not None and completed_job.state == "succeeded":
                    self._verify_succeeded_attempt(
                        job_id=job_id,
                        attempt_id=attempt_id,
                        worker_id=worker_id,
                        lease_token=lease_token,
                    )
                    if completed_job.result_digest == digest:
                        return _get_job_out(completed_job)
                    _raise(
                        409,
                        "complete_digest_conflict",
                        "Kết quả hoàn tất của job đã khác payload hiện tại.",
                    )
                raise

            case = self.db.scalar(
                select(Case)
                .where(Case.id == job.case_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
            reference = (
                self.db.get(Volume, reference_id)
                if case is not None
                and case.deleting_at is None
                and case.deleted_at is None
                and case.reference_volume_id == reference_id
                else None
            )
            if (
                reference is None
                or reference.deleted_at is not None
                or reference.validation_status != "valid"
            ):
                self._fail_active_for_invalid_reference(
                    job=job,
                    attempt=attempt,
                    worker_id=worker_id,
                )
                committed_to_db = True
                _raise(
                    409,
                    "invalid_reference_volume",
                    "Volume tham chiếu đã thay đổi hoặc không còn tồn tại trong lúc xử lý.",
                )

            doctor_id = job.doctor_id
            self.files.acquire_quota_locks(doctor_id)
            doc_quota, system_quota = self._effective_quotas()
            owner_used, system_used = self.files.get_committed_usage_bytes(doctor_id)
            result_total_bytes = mask_staged.size_bytes + coverage_staged.size_bytes
            if (
                owner_used + result_total_bytes > doc_quota
                or system_used + result_total_bytes > system_quota
            ):
                _raise(413, "storage_quota_exceeded", "Không đủ quota để lưu kết quả AI.")

            mask_obj = self.storage.commit(mask_staged.staging_key)
            mask_staged = None
            committed_keys.append(mask_obj.storage_key)
            coverage_obj = self.storage.commit(coverage_staged.staging_key)
            coverage_staged = None
            committed_keys.append(coverage_obj.storage_key)

            db_mask = StoredFile(
                storage_key=uuid.UUID(mask_obj.storage_key),
                original_name=f"ai-mask-{job.case_id}.nii.gz",
                size_bytes=mask_obj.size_bytes,
                sha256=mask_obj.sha256,
                media_type="application/gzip",
                state="committed",
                owner_id=doctor_id,
            )
            db_coverage = StoredFile(
                storage_key=uuid.UUID(coverage_obj.storage_key),
                original_name=f"ai-coverage-{job.id}.json",
                size_bytes=coverage_obj.size_bytes,
                sha256=coverage_obj.sha256,
                media_type="application/json",
                state="committed",
                owner_id=doctor_id,
            )
            self.db.add_all([db_mask, db_coverage])
            self.db.flush()
            next_version = self.mask_versions.get_next_version_number(case.id)
            stats = compute_mask_statistics(
                label_voxel_counts=canonical.label_voxel_counts,
                affine_mm=ref_affine,
            )
            version = MaskVersion(
                case_id=case.id,
                version_number=next_version,
                source="ai",
                base_version_id=None,
                reference_volume_id=reference.id,
                file_id=db_mask.id,
                created_by=None,
                job_id=job.id,
                model_version_id=job.model_version_id,
                coverage_file_id=db_coverage.id,
                note=None,
                label_voxel_counts=canonical.label_voxel_counts,
                label_volumes_mm3=stats["label_volumes_mm3"],
                composite_volumes_mm3=stats["composite_volumes_mm3"],
                sha256=canonical.sha256,
            )
            self.db.add(version)
            self.db.flush()
            case.latest_mask_version_id = version.id
            case.inputs_locked_at = case.inputs_locked_at or datetime.now(UTC)
            final_completed, final_total = resolve_final_slice_counts(coverage_json, ref_shape)
            job.state = "succeeded"
            job.stage = "done"
            job.completed_slices = final_completed
            job.total_slices = final_total
            job.finished_at = datetime.now(UTC)
            job.result_mask_version_id = version.id
            job.result_digest = digest
            job.error_code = None
            attempt.state = "succeeded"
            attempt.stage = "done"
            attempt.completed_slices = final_completed
            attempt.total_slices = final_total
            attempt.finished_at = datetime.now(UTC)
            worker = self.db.get(WorkerInstance, worker_id)
            if worker is not None:
                worker.current_job_id = None
                worker.last_heartbeat_at = datetime.now(UTC)
            self.audits.record_event(
                actor_type="worker",
                actor_id=None,
                action="job.complete",
                resource_type="inference_job",
                resource_id=str(job.id),
                outcome="success",
                request_id=request_id,
                safe_diff={
                    "case_id": str(case.id),
                    "mask_version_id": str(version.id),
                    "version_number": next_version,
                },
            )
            result_out = _get_job_out(job)
            self.db.commit()
            committed_to_db = True
            return result_out
        except Exception:
            if not committed_to_db:
                rollback_ok = False
                with contextlib.suppress(Exception):
                    self.db.rollback()
                    rollback_ok = True
                if committed_keys and rollback_ok:
                    referenced_keys: set[str] = set()
                    can_delete = False
                    try:
                        self.db.expunge_all()
                        key_uuids = [uuid.UUID(k) for k in committed_keys]
                        persisted_keys = self.db.scalars(
                            select(StoredFile.storage_key).where(
                                StoredFile.storage_key.in_(key_uuids),
                                StoredFile.state != "deleted",
                            )
                        ).all()
                        referenced_keys = {str(k) for k in persisted_keys if k is not None}
                        self.db.rollback()
                        can_delete = True
                    except Exception:
                        with contextlib.suppress(Exception):
                            self.db.rollback()
                        can_delete = False
                    if can_delete:
                        for storage_key in committed_keys:
                            if storage_key not in referenced_keys:
                                with contextlib.suppress(OSError):
                                    self.storage.delete(storage_key)
            raise
        finally:
            for staged in (incoming, coverage_stage, metadata_stage, mask_staged, coverage_staged):
                if staged is not None:
                    self.storage.staging_root.joinpath(staged.staging_key).unlink(missing_ok=True)
            if canonical_temp is not None:
                canonical_temp.unlink(missing_ok=True)

    def _effective_quotas(self) -> tuple[int, int]:
        return resolve_effective_quotas(self.system_settings, self.settings)

    def fail_job(
        self,
        *,
        job_id: uuid.UUID,
        worker_id: str,
        attempt_id: uuid.UUID,
        lease_token: str,
        error_code: str,
        request_id: str,
    ) -> InferenceJobOut:
        if self.db.get(InferenceJob, job_id) is None:
            from app.services.admin_benchmark_service import AdminBenchmarkService

            benchmark_out = AdminBenchmarkService(self.db, self.storage, self.settings).fail(
                job_id=job_id,
                worker_id=worker_id,
                attempt_id=attempt_id,
                lease_token=lease_token,
                error_code=error_code,
                request_id=request_id,
            )
            if benchmark_out is not None:
                return benchmark_out
        if error_code not in _SAFE_ERROR_CODES:
            error_code = "worker_error"
        job, attempt = self._active_attempt(
            job_id=job_id, attempt_id=attempt_id, lease_token=lease_token, worker_id=worker_id
        )
        now = datetime.now(UTC)
        attempt.state = "failed"
        attempt.error_code = error_code
        attempt.finished_at = now
        if error_code == "worker_error" and job.auto_retry_count < job.max_auto_retries:
            job.auto_retry_count += 1
            job.state = "queued"
            job.stage = "queued"
            job.completed_slices = None
            job.total_slices = None
            job.error_code = "worker_retry"
            job.finished_at = None
        else:
            job.state = "failed"
            job.error_code = error_code
            job.finished_at = now
        worker = self.db.get(WorkerInstance, worker_id)
        if worker is not None:
            worker.current_job_id = None
            worker.last_heartbeat_at = now
        self.audits.record_event(
            actor_type="worker",
            actor_id=None,
            action="job.fail",
            resource_type="inference_job",
            resource_id=str(job.id),
            outcome="failure",
            request_id=request_id,
            safe_diff={
                "error_code": error_code,
                "auto_requeued": job.state == "queued",
            },
        )
        self.db.commit()
        return _get_job_out(job)

    def list_jobs(
        self, *, q: str | None, state: str | None, page: int, page_size: int
    ) -> PaginatedResponse[AdminJobOut]:
        """List inference jobs across all doctors for technical operations."""
        conditions = []
        if state:
            conditions.append(InferenceJob.state == state)
        search = (q or "").strip()
        if search:
            pattern = f"%{_escape_like(search)}%"
            conditions.append(
                or_(
                    InferenceJob.id.cast(String).ilike(pattern, escape="\\"),
                    User.username.ilike(pattern, escape="\\"),
                )
            )
        query = (
            select(InferenceJob, User.username, ModelVersion.version)
            .join(User, User.id == InferenceJob.doctor_id)
            .join(ModelVersion, ModelVersion.id == InferenceJob.model_version_id)
            .where(*conditions)
        )
        count_query = (
            select(func.count(InferenceJob.id))
            .join(User, User.id == InferenceJob.doctor_id)
            .join(ModelVersion, ModelVersion.id == InferenceJob.model_version_id)
            .where(*conditions)
        )
        total = int(self.db.scalar(count_query) or 0)
        rows = self.db.execute(
            query.order_by(InferenceJob.created_at.desc(), InferenceJob.id.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()
        items = [
            AdminJobOut(
                id=job.id,
                case_id=job.case_id,
                doctor_username=username,
                model_version=model_version,
                state=job.state,
                stage=job.stage,
                attempt_count=job.attempt_count,
                error_code=job.error_code,
                created_at=job.created_at,
                started_at=job.started_at,
                finished_at=job.finished_at,
            )
            for job, username, model_version in rows
        ]
        return PaginatedResponse[AdminJobOut](
            items=items, total=total, page=page, page_size=page_size
        )

    def get_job_detail(self, job_id: uuid.UUID) -> AdminJobDetailOut:
        """Return technical details and attempt history for an inference job."""
        row = self.db.execute(
            select(InferenceJob, User.username, ModelVersion.version)
            .join(User, User.id == InferenceJob.doctor_id)
            .join(ModelVersion, ModelVersion.id == InferenceJob.model_version_id)
            .where(InferenceJob.id == job_id)
        ).first()
        if row is None:
            raise AppError(
                status_code=404, code="job_not_found", message="Không tìm thấy tác vụ AI."
            )
        job, username, model_version = row
        attempts = self.db.scalars(
            select(JobAttempt)
            .where(JobAttempt.job_id == job_id)
            .order_by(JobAttempt.attempt_number)
        ).all()
        return AdminJobDetailOut(
            id=job.id,
            case_id=job.case_id,
            doctor_username=username,
            model_version=model_version,
            state=job.state,
            stage=job.stage,
            attempt_count=job.attempt_count,
            error_code=job.error_code,
            created_at=job.created_at,
            started_at=job.started_at,
            finished_at=job.finished_at,
            attempts=[AdminJobAttemptOut.model_validate(item) for item in attempts],
        )

    def retry_failed_job(
        self, *, job_id: uuid.UUID, admin_id: uuid.UUID, request_id: str, ip_address: str
    ) -> AdminJobOut:
        """Enqueue a new job for a failed inference job while preserving lock ordering."""
        old_probe = self.db.get(InferenceJob, job_id)
        if old_probe is None:
            raise AppError(
                status_code=404, code="job_not_found", message="Không tìm thấy tác vụ AI."
            )
        if old_probe.state != "failed":
            raise AppError(
                status_code=409,
                code="job_not_retryable",
                message="Chỉ có thể gửi lại job thất bại.",
            )
        if not self._accepting_jobs():
            raise AppError(
                status_code=503,
                code="not_accepting_jobs",
                message="Hệ thống đang tạm dừng nhận tác vụ AI mới.",
            )

        # Lock Case FIRST to match InferenceJobService.create_job lock ordering
        case = self.cases.get_active_for_owner_for_update(old_probe.case_id, old_probe.doctor_id)
        owner = self.db.scalar(
            select(User)
            .where(User.id == old_probe.doctor_id)
            .execution_options(populate_existing=True)
        )
        if owner is None or not owner.is_active:
            raise AppError(
                status_code=409,
                code="retry_owner_inactive",
                message="Tài khoản bác sĩ sở hữu ca chụp hiện không còn hoạt động.",
            )
        if case is None:
            raise AppError(
                status_code=409,
                code="retry_case_deleted",
                message="Ca chụp không còn tồn tại hoặc đã bị xóa.",
            )

        old = self.db.scalar(
            select(InferenceJob)
            .where(InferenceJob.id == job_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if old is None:
            raise AppError(
                status_code=404, code="job_not_found", message="Không tìm thấy tác vụ AI."
            )
        if old.state != "failed":
            raise AppError(
                status_code=409,
                code="job_not_retryable",
                message="Chỉ có thể gửi lại job thất bại.",
            )

        intake_setting = self.db.scalar(
            select(SystemSetting)
            .where(SystemSetting.key == "admin_settings")
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        if intake_setting is not None and not bool(
            intake_setting.value_json.get("accepting_jobs", True)
        ):
            raise AppError(
                status_code=503,
                code="not_accepting_jobs",
                message="Hệ thống đang tạm dừng nhận tác vụ AI mới.",
            )
        volumes = self.volumes.list_active_for_case(case.id)
        _, can_run, _ = compute_case_inference_status(
            volumes, manifest_path=_manifest_path(self.settings)
        )
        if (
            not can_run
            or case.reference_volume_id is None
            or not any(v.id == case.reference_volume_id for v in volumes)
            or any(
                v.validation_status != "valid"
                for v in volumes
                if v.modality in {"flair", "t1ce"}
            )
        ):
            raise AppError(
                status_code=409,
                code="case_not_ready",
                message="Ca chụp không còn đủ đầu vào hợp lệ.",
            )
        if self.cases.has_active_job(case.id):
            raise AppError(
                status_code=409,
                code="active_job_conflict",
                message="Ca chụp đã có job đang hoạt động.",
            )
        model = sync_active_model(self.db, self.settings)
        try:
            job = InferenceJob(
                case_id=case.id,
                doctor_id=owner.id,
                model_version_id=model.id,
                state="queued",
                stage="queued",
                attempt_count=0,
                auto_retry_count=0,
                max_auto_retries=1,
            )
            self.db.add(job)
            self.db.flush()
            case.inputs_locked_at = case.inputs_locked_at or datetime.now(UTC)
            self.audits.record_event(
                actor_type="user",
                actor_id=admin_id,
                action="admin.job_retry",
                resource_type="inference_job",
                resource_id=str(job.id),
                outcome="success",
                request_id=request_id,
                ip_address=ip_address,
                safe_diff={"previous_job_id": str(old.id), "case_id": str(case.id)},
            )
            out = AdminJobOut(
                id=job.id,
                case_id=job.case_id,
                doctor_username=owner.username,
                model_version=model.version,
                state=job.state,
                stage=job.stage,
                attempt_count=job.attempt_count,
                error_code=job.error_code,
                created_at=job.created_at,
                started_at=job.started_at,
                finished_at=job.finished_at,
            )
            self.db.commit()
        except IntegrityError as exc:
            self.db.rollback()
            raise AppError(
                status_code=409,
                code="active_job_conflict",
                message="Ca chụp đã có job đang hoạt động.",
            ) from exc
        return out


def _validate_worker_result_metadata(
    *,
    coverage_json: dict[str, Any],
    meta: dict[str, Any],
    ref_shape: list[int],
) -> None:
    orig_shape = coverage_json.get("original_shape")
    if (
        not isinstance(orig_shape, list)
        or len(orig_shape) != 3
        or any(isinstance(v, bool) or not isinstance(v, int) for v in orig_shape)
        or orig_shape != ref_shape
    ):
        _raise(
            422,
            "invalid_result_metadata",
            "Metadata coverage thiếu hoặc sai original_shape so với volume tham chiếu.",
        )

    pipeline_version = coverage_json.get("pipeline_version")
    if not isinstance(pipeline_version, str) or not pipeline_version.strip():
        _raise(
            422,
            "invalid_result_metadata",
            "Metadata coverage thiếu pipeline_version hợp lệ.",
        )

    is_fake_worker = coverage_json.get("test_mode") == "deterministic_fake_worker"
    if "slice_crops" in coverage_json or not is_fake_worker:
        slice_crops = coverage_json.get("slice_crops")
        if (
            not isinstance(slice_crops, list)
            or len(slice_crops) != ref_shape[2]
            or any(
                not isinstance(item, dict)
                or isinstance(item.get("z"), bool)
                or not isinstance(item.get("z"), int)
                or not isinstance(item.get("evaluated"), bool)
                for item in slice_crops
            )
        ):
            _raise(
                422,
                "invalid_result_metadata",
                "Metadata coverage thiếu hoặc sai cấu trúc slice_crops.",
            )

    has_provenance = any(
        isinstance(meta.get(k), str) and str(meta.get(k)).strip()
        for k in ("model_id", "model_version", "model_version_id", "pipeline_version")
    )
    if not meta or not has_provenance:
        _raise(
            422,
            "invalid_result_metadata",
            "Metadata kết quả của worker thiếu thông tin định danh mô hình.",
        )

    geom = meta.get("geometry")
    if geom is not None:
        if not isinstance(geom, dict):
            _raise(
                422,
                "invalid_result_metadata",
                "Trường geometry trong metadata kết quả không hợp lệ.",
            )
        if "shape" in geom and geom["shape"] != ref_shape:
            _raise(
                422,
                "invalid_result_metadata",
                "Trường geometry.shape trong metadata không khớp volume tham chiếu.",
            )


def _quota_setting(value: object, fallback: int) -> int:
    if isinstance(value, int) and value > 0:
        return value
    if isinstance(value, dict):
        for key in ("bytes", "value"):
            raw = value.get(key)
            if isinstance(raw, int) and raw > 0:
                return raw
    return fallback


def reap_expired_attempts(db: Session) -> int:
    """Expire stale leases and retry once while serializing reaper instances with advisory lock."""
    if not db.scalar(select(func.pg_try_advisory_xact_lock(_REAPER_ADVISORY_LOCK_ID))):
        db.rollback()
        return 0
    now = datetime.now(UTC)
    pairs = list(
        db.execute(
            select(InferenceJob, JobAttempt)
            .join(JobAttempt, JobAttempt.job_id == InferenceJob.id)
            .where(JobAttempt.state == "running", JobAttempt.lease_expires_at <= now)
            .order_by(JobAttempt.lease_expires_at)
            .with_for_update(of=(InferenceJob, JobAttempt), skip_locked=True)
            .execution_options(populate_existing=True)
            .limit(100)
        ).all()
    )
    count = 0
    for job, attempt in pairs:
        attempt.state = "expired"
        attempt.error_code = "worker_lost"
        attempt.finished_at = now
        if job.state == "running":
            if job.auto_retry_count < job.max_auto_retries:
                job.auto_retry_count += 1
                job.state = "queued"
                job.stage = "queued"
                job.completed_slices = None
                job.total_slices = None
                job.error_code = "worker_retry"
            else:
                job.state = "failed"
                job.error_code = "worker_lost"
                job.finished_at = now
        worker = db.get(WorkerInstance, attempt.worker_id)
        if worker is not None and worker.current_job_id == attempt.job_id:
            worker.current_job_id = None
        count += 1
    from app.services.admin_benchmark_service import AdminBenchmarkService

    count += AdminBenchmarkService.reap_expired_runs(db, now)
    db.commit()
    return count
