"""Shared Pydantic schemas and UTC datetime helpers."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated

from pydantic import BaseModel, Field, PlainSerializer, WithJsonSchema


def _serialize_utc_datetime(dt: datetime) -> str:
    utc_dt = dt.replace(tzinfo=UTC) if dt.tzinfo is None else dt.astimezone(UTC)
    return utc_dt.isoformat().replace("+00:00", "Z")


UTCDatetime = Annotated[
    datetime,
    PlainSerializer(_serialize_utc_datetime, return_type=str, when_used="json"),
    WithJsonSchema({"type": "string", "format": "date-time"}),
]


class PaginatedResponse[T](BaseModel):
    """Standard paginated collection envelope."""

    items: list[T]
    total: int = Field(ge=0)
    page: int = Field(ge=1)
    page_size: int = Field(ge=1, le=100)
