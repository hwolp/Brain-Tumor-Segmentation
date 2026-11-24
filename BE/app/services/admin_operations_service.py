"""P6 technical-only admin operations, settings, worker/model views, and audit filtering."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import String, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.errors import AppError
from app.core.storage import LocalStorageAdapter
from app.models.audit_event import AuditEvent
from app.models.inference_job import InferenceJob, JobAttempt, ModelVersion, WorkerInstance
from app.models.stored_file import StoredFile
from app.models.system_setting import SystemSetting
from app.models.user import User
from app.repositories.audit_repo import AuditRepository
from app.repositories.case_repo import CaseRepository
from app.repositories.system_setting_repo import SystemSettingRepository
from app.repositories.volume_repo import VolumeRepository
from app.schemas.common import PaginatedResponse
from app.schemas.jobs import (
    AdminJobAttemptOut,
    AdminJobDetailOut,
    AdminJobOut,
    AdminModelOut,
    AdminOverviewOut,
    AdminSettingsOut,
    AdminSettingsUpdate,
    AdminWorkerOut,
    AuditEventOut,
)
from app.services.case_service import compute_case_inference_status
from app.services.job_service import (
    JobService,
    _manifest_path,
    _read_manifest,
    sync_active_model,
)

_MIB = 1024**2
_GIB = 1024**3


def _as_utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)
_AUDIT_RESOURCE_ALLOWLIST = (
    "inference_job",
    "admin_settings",
    "system_setting",
    "worker",
    "session",
    "auth",
    "user",
    "user_account",
    "model_version",
)


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _number(value_json: object, name: str, fallback: int) -> int:
    if isinstance(value_json, dict):
        value = value_json.get(name)
        if isinstance(value, int) and value > 0:
            return value
    return fallback


def _safe_model_out(row: ModelVersion) -> AdminModelOut:
    return AdminModelOut(
        id=row.id,
        name=row.name,
        version=row.version,
        checkpoint_sha256=row.checkpoint_sha256,
        expected_shape=[int(v) for v in row.expected_shape_json],
        expected_spacing_mm=[float(v) for v in row.expected_spacing_mm_json],
        is_active=row.is_active,
        verified=row.verified,
    )


class AdminOperationsService:
    def __init__(self, db: Session, storage: LocalStorageAdapter, settings: Settings) -> None:
        self.db = db
        self.storage = storage
        self.settings = settings
        self.system_settings = SystemSettingRepository(db)
        self.cases = CaseRepository(db)
        self.volumes = VolumeRepository(db)
        self.jobs = JobService(db, storage, settings)
        self.audits = AuditRepository(db)

    def _current_settings(self) -> tuple[dict[str, object], datetime]:
        row = self.system_settings.get_by_key("admin_settings")
        values = dict(row.value_json) if row is not None else {}
        values.setdefault("version", 1)
        values.setdefault("accepting_jobs", True)
        values.setdefault("max_upload_mib", max(1, self.settings.MAX_UPLOAD_BYTES // _MIB))
        values.setdefault(
            "max_decompressed_mib", max(1, self.settings.MAX_DECOMPRESSED_BYTES // _MIB)
        )
        values.setdefault(
            "default_doctor_quota_gib", max(1, self.settings.DOCTOR_QUOTA_BYTES // _GIB)
        )
        values.setdefault("system_quota_gib", max(1, self.settings.SYSTEM_QUOTA_BYTES // _GIB))
        return values, row.updated_at if row is not None else datetime.now(UTC)

    def get_settings(self) -> AdminSettingsOut:
        values, updated_at = self._current_settings()
        return AdminSettingsOut(**values, updated_at=updated_at)

    def _validate_settings_hard_limits(self, payload: AdminSettingsUpdate) -> None:
        violations: list[dict[str, str]] = []
        if int(payload.max_upload_mib) * _MIB > self.settings.MAX_UPLOAD_BYTES:
            violations.append(
                {
                    "field": "max_upload_mib",
                    "reason": (
                        "Giới hạn tải lên vượt quá trần phần cứng MAX_UPLOAD_BYTES của máy chủ."
                    ),
                    "type": "value_error",
                }
            )
        if int(payload.max_decompressed_mib) * _MIB > self.settings.MAX_DECOMPRESSED_BYTES:
            violations.append(
                {
                    "field": "max_decompressed_mib",
                    "reason": (
                        "Giới hạn giải nén vượt quá trần MAX_DECOMPRESSED_BYTES của máy chủ."
                    ),
                    "type": "value_error",
                }
            )
        if int(payload.default_doctor_quota_gib) * _GIB > self.settings.DOCTOR_QUOTA_BYTES:
            violations.append(
                {
                    "field": "default_doctor_quota_gib",
                    "reason": "Hạn mức bác sĩ vượt quá trần DOCTOR_QUOTA_BYTES của máy chủ.",
                    "type": "value_error",
                }
            )
        if int(payload.system_quota_gib) * _GIB > self.settings.SYSTEM_QUOTA_BYTES:
            violations.append(
                {
                    "field": "system_quota_gib",
                    "reason": "Hạn mức hệ thống vượt quá trần SYSTEM_QUOTA_BYTES của máy chủ.",
                    "type": "value_error",
                }
            )
        if int(payload.default_doctor_quota_gib) > int(payload.system_quota_gib):
            violations.append(
                {
                    "field": "default_doctor_quota_gib",
                    "reason": (
                        "Hạn mức mặc định của bác sĩ không được vượt quá hạn mức toàn hệ thống."
                    ),
                    "type": "value_error",
                }
            )
        if violations:
            raise AppError(
                status_code=422,
                code="validation_error",
                message="Cấu hình vượt quá giới hạn phần cứng hoặc không hợp lệ.",
                details=violations,
            )

    def update_settings(
        self, *, actor_id: uuid.UUID, payload: AdminSettingsUpdate, request_id: str, ip_address: str
    ) -> AdminSettingsOut:
        self._validate_settings_hard_limits(payload)
        row = self.db.scalar(
            select(SystemSetting)
            .where(SystemSetting.key == "admin_settings")
            .with_for_update()
            .execution_options(populate_existing=True)
        )
        current, _ = self._current_settings()
        current_version = int(current["version"])
        if payload.version != current_version:
            raise AppError(
                status_code=409,
                code="settings_version_conflict",
                message=(
                    "Cấu hình đã được thay đổi bởi quản trị viên khác. "
                    "Hãy tải lại trước khi lưu."
                ),
            )
        previous = current.copy()
        values = payload.model_dump(exclude={"version"})
        doc_bytes = int(payload.default_doctor_quota_gib) * _GIB
        system_bytes = int(payload.system_quota_gib) * _GIB
        next_values = {
            **values,
            "version": current_version + 1,
        }
        try:
            if row is None:
                row = SystemSetting(
                    key="admin_settings", value_json=next_values, updated_by=actor_id
                )
                self.db.add(row)
            else:
                row.value_json = next_values
                row.updated_by = actor_id
            self.system_settings.upsert(
                key="doctor_quota_bytes", value_json={"bytes": doc_bytes}, updated_by=actor_id
            )
            self.system_settings.upsert(
                key="system_quota_bytes", value_json={"bytes": system_bytes}, updated_by=actor_id
            )
            changed = {
                key: value for key, value in next_values.items() if previous.get(key) != value
            }
            self.audits.record_event(
                actor_type="user",
                actor_id=actor_id,
                action="admin.settings_update",
                resource_type="admin_settings",
                resource_id="admin_settings",
                outcome="success",
                request_id=request_id,
                ip_address=ip_address,
                safe_diff={"changed_fields": sorted(changed), "version": next_values["version"]},
            )
            self.db.commit()
        except IntegrityError as exc:
            self.db.rollback()
            raise AppError(
                status_code=409,
                code="settings_version_conflict",
                message=(
                    "Cấu hình đã được thay đổi bởi quản trị viên khác. "
                    "Hãy tải lại trước khi lưu."
                ),
            ) from exc
        return self.get_settings()

    def list_models(self) -> list[AdminModelOut]:
        try:
            manifest, _ = _read_manifest(self.settings)
            active_registry_id: str | None = f"{manifest['model_id']}:{manifest['version']}"
            active_sha: str | None = str(manifest["checkpoint_sha256"]).lower()
        except AppError:
            manifest = None
            active_registry_id = None
            active_sha = None

        rows = list(
            self.db.scalars(select(ModelVersion).order_by(ModelVersion.created_at.desc())).all()
        )
        out: list[AdminModelOut] = []
        seen_active_manifest = False
        for row in rows:
            matches_manifest = (
                manifest is not None
                and row.id == active_registry_id
                and row.checkpoint_sha256.lower() == active_sha
            )
            if row.id == active_registry_id:
                seen_active_manifest = True
            is_active = bool(matches_manifest)
            verified = bool(
                matches_manifest
                if (row.id == active_registry_id or row.is_active)
                else row.verified
            )
            out.append(
                AdminModelOut(
                    id=row.id,
                    name=row.name,
                    version=row.version,
                    checkpoint_sha256=row.checkpoint_sha256,
                    expected_shape=[int(v) for v in row.expected_shape_json],
                    expected_spacing_mm=[float(v) for v in row.expected_spacing_mm_json],
                    is_active=is_active,
                    verified=verified,
                )
            )

        if manifest is not None and active_registry_id is not None and not seen_active_manifest:
            out.insert(
                0,
                AdminModelOut(
                    id=active_registry_id,
                    name=str(manifest.get("display_name") or manifest["model_id"]),
                    version=str(manifest["version"]),
                    checkpoint_sha256=str(manifest["checkpoint_sha256"]),
                    expected_shape=[int(v) for v in manifest["input_profile"]["shape"]],
                    expected_spacing_mm=[
                        float(v) for v in manifest["input_profile"]["spacing_mm"]
                    ],
                    is_active=True,
                    verified=True,
                ),
            )
        return out

    def list_workers(self) -> list[AdminWorkerOut]:
        now = datetime.now(UTC)
        rows = list(
            self.db.scalars(select(WorkerInstance).order_by(WorkerInstance.worker_id)).all()
        )
        candidate_job_ids = [
            row.current_job_id for row in rows if row.current_job_id is not None
        ]
        running_job_ids: set[uuid.UUID] = set()
        if candidate_job_ids:
            running_job_ids = set(
                self.db.scalars(
                    select(InferenceJob.id).where(
                        InferenceJob.id.in_(candidate_job_ids),
                        InferenceJob.state == "running",
                    )
                ).all()
            )
        out: list[AdminWorkerOut] = []
        for row in rows:
            hb_utc = _as_utc(row.last_heartbeat_at)
            is_online = hb_utc >= now - timedelta(seconds=90)
            has_running_job = (
                is_online
                and row.current_job_id is not None
                and row.current_job_id in running_job_ids
            )
            out.append(
                AdminWorkerOut(
                    worker_id=row.worker_id,
                    online=is_online,
                    device_type="GPU" if row.device_type.upper() in {"GPU", "CUDA"} else "CPU",
                    active_jobs=1 if has_running_job else 0,
                    last_heartbeat_at=hb_utc,
                    model_version=row.model_version_id or "unknown",
                )
            )
        return out

    def overview(self) -> AdminOverviewOut:
        values, _ = self._current_settings()
        status_counts = dict(
            self.db.execute(
                select(InferenceJob.state, func.count(InferenceJob.id)).group_by(InferenceJob.state)
            ).all()
        )
        doctor_counts = dict(
            self.db.execute(
                select(User.is_active, func.count(User.id))
                .where(User.role == "doctor")
                .group_by(User.is_active)
            ).all()
        )
        used = int(
            self.db.scalar(
                select(func.coalesce(func.sum(StoredFile.size_bytes), 0)).where(
                    StoredFile.state.in_(("committed", "deleting"))
                )
            )
            or 0
        )
        workers = self.list_workers()
        return AdminOverviewOut(
            active_doctors=int(doctor_counts.get(True, 0)),
            locked_doctors=int(doctor_counts.get(False, 0)),
            queued_jobs=int(status_counts.get("queued", 0)),
            running_jobs=int(status_counts.get("running", 0)),
            failed_jobs=int(status_counts.get("failed", 0)),
            storage_used_bytes=used,
            storage_quota_bytes=min(
                int(values["system_quota_gib"]) * _GIB,
                self.settings.SYSTEM_QUOTA_BYTES,
            ),
            worker_online=any(worker.online for worker in workers),
            updated_at=datetime.now(UTC),
        )

    def list_jobs(
        self, *, q: str | None, state: str | None, page: int, page_size: int
    ) -> PaginatedResponse[AdminJobOut]:
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
        if not self.jobs._accepting_jobs():
            raise AppError(
                status_code=503,
                code="not_accepting_jobs",
                message="Hệ thống đang tạm dừng nhận tác vụ AI mới.",
            )

        # Lock Case FIRST to match JobService.create_job lock ordering
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

    def list_audit_events(
        self, *, q: str | None, page: int, page_size: int
    ) -> PaginatedResponse[AuditEventOut]:
        conditions = [AuditEvent.resource_type.in_(_AUDIT_RESOURCE_ALLOWLIST)]
        search = (q or "").strip()
        if search:
            pattern = f"%{_escape_like(search)}%"
            conditions.append(
                or_(
                    AuditEvent.action.ilike(pattern, escape="\\"),
                    AuditEvent.request_id.ilike(pattern, escape="\\"),
                    AuditEvent.resource_id.ilike(pattern, escape="\\"),
                    User.username.ilike(pattern, escape="\\"),
                )
            )
        base = select(AuditEvent).outerjoin(User, User.id == AuditEvent.actor_id).where(*conditions)
        total_query = (
            select(func.count(AuditEvent.id))
            .outerjoin(User, User.id == AuditEvent.actor_id)
            .where(*conditions)
        )
        total = int(self.db.scalar(total_query) or 0)
        rows = self.db.execute(
            base.add_columns(User.username)
            .order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()
        items = [
            AuditEventOut(
                id=event.id,
                created_at=event.created_at,
                actor_username=username
                or ("worker" if event.actor_type == "worker" else event.actor_type),
                action=event.action,
                target_id=event.resource_id or "-",
                outcome=event.outcome,
                request_id=event.request_id,
            )
            for event, username in rows
        ]
        return PaginatedResponse[AuditEventOut](
            items=items, total=total, page=page, page_size=page_size
        )
