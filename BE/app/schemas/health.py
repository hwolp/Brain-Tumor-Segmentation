"""Health endpoint response schemas."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class LivenessResponse(BaseModel):
    """Liveness check payload."""

    status: Literal["ok"] = "ok"
    service: str
    environment: Literal["local", "test", "production"]


class ReadinessChecks(BaseModel):
    """Individual dependency readiness statuses."""

    database: Literal["ok", "error"]
    storage: Literal["ok", "error"]


class ReadinessResponse(BaseModel):
    """Readiness check payload when all critical dependencies are healthy."""

    status: Literal["ready"] = "ready"
    checks: ReadinessChecks
