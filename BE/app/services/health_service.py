"""Health check application service."""

from __future__ import annotations

from sqlalchemy import Engine

from app.core.config import Settings
from app.core.db import check_database_health
from app.core.errors import AppError
from app.core.storage import LocalStorageAdapter
from app.schemas.health import LivenessResponse, ReadinessChecks, ReadinessResponse


def get_liveness(settings: Settings) -> LivenessResponse:
    """Return process liveness metadata without touching external dependencies."""
    return LivenessResponse(
        status="ok",
        service=settings.SERVICE_NAME,
        environment=settings.APP_ENV,
    )


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
