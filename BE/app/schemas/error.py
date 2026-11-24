"""Standardized error envelope schemas."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel


class ErrorDetailItem(BaseModel):
    """Structured field validation detail without echoing sensitive input values."""

    field: str | None = None
    reason: str
    type: str | None = None


class ErrorBody(BaseModel):
    """Standard error payload body per docs/CONTRACTS.md."""

    code: str
    message: str
    details: list[ErrorDetailItem] | dict[str, Any] | None = None
    request_id: str


class ErrorResponse(BaseModel):
    """Standard top-level error envelope."""

    error: ErrorBody
