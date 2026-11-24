"""System monitoring service covering health checks, workers, models, and overview."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import Engine, func, select
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.db import check_database_health
from app.core.errors import AppError
from app.core.storage import LocalStorageAdapter
from app.models.inference_job import InferenceJob, ModelVersion, WorkerInstance
from app.models.stored_file import StoredFile
from app.models.user import User
from app.schemas.health import LivenessResponse, ReadinessChecks, ReadinessResponse
from app.schemas.jobs import AdminModelOut, AdminOverviewOut, AdminWorkerOut
from app.services.inference_job_service import _read_manifest
from app.services.system_setting_service import SystemSettingService

_GIB = 1024**3


def _as_utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)


class SystemMonitoringService:
    """Service layer for runtime health probes and technical admin overview views."""

    def __init__(self, db: Session, storage: LocalStorageAdapter, settings: Settings) -> None:
        self.db = db
        self.storage = storage
        self.settings = settings
        self.system_settings = SystemSettingService(db, settings)

    @staticmethod
    def get_liveness(settings: Settings) -> LivenessResponse:
        """Return process liveness metadata without touching external dependencies."""
        return LivenessResponse(
            status="ok",
            service=settings.SERVICE_NAME,
            environment=settings.APP_ENV,
        )

    @staticmethod
    def get_readiness(db_engine: Engine | None, storage: LocalStorageAdapter) -> ReadinessResponse:
        """Verify PostgreSQL connectivity and private storage writability."""
        db_ok = check_database_health(db_engine)
        storage_ok = storage.is_writable()

        checks = ReadinessChecks(
            database="ok" if db_ok else "error",
            storage="ok" if storage_ok else "error",
        )

        if not (db_ok and storage_ok):
            raise AppError(
                status_code=503,
                code="service_unavailable",
                message="Hệ thống tạm thời chưa sẵn sàng phục vụ.",
                details=checks.model_dump(),
            )

        return ReadinessResponse(status="ready", checks=checks)

    def list_models(self) -> list[AdminModelOut]:
        """List registered model versions and active manifest verification status."""
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
        """List registered inference workers and online/active status."""
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
        """Return aggregate doctor, job, storage, and worker health counts."""
        values, _ = self.system_settings.get_current_values()
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
