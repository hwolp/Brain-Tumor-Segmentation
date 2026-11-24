"""Health liveness and readiness endpoints."""

from __future__ import annotations

from fastapi import APIRouter

from app.dependencies import DbEngineDep, SettingsDep, StorageDep
from app.schemas.error import ErrorResponse
from app.schemas.health import LivenessResponse, ReadinessResponse
from app.services.system_monitoring_service import SystemMonitoringService

router = APIRouter(
    prefix="/api/v1/health",
    tags=["health"],
    responses={
        500: {"model": ErrorResponse, "description": "Internal server error"},
    },
)


@router.get("/live")
def liveness(settings: SettingsDep) -> LivenessResponse:
    """Verify the API process is alive without touching external dependencies."""
    return SystemMonitoringService.get_liveness(settings)


@router.get(
    "/ready",
    responses={
        503: {
            "model": ErrorResponse,
            "description": "Database or private storage is unavailable",
        }
    },
)
def readiness(db_engine: DbEngineDep, storage: StorageDep) -> ReadinessResponse:
    """Verify PostgreSQL connectivity and private storage writability."""
    return SystemMonitoringService.get_readiness(db_engine, storage)
