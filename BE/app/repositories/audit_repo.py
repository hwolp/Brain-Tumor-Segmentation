"""AuditEvent repository."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any, Literal

from sqlalchemy.orm import Session

from app.models.audit_event import AuditEvent


class AuditRepository:
    """Append-only persistence helper for AuditEvent records."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def record_event(
        self,
        *,
        actor_type: Literal["user", "worker", "system"],
        actor_id: uuid.UUID | None,
        action: str,
        resource_type: str,
        resource_id: str | None,
        outcome: Literal["success", "failure"],
        request_id: str,
        ip_address: str | None = None,
        safe_diff: dict[str, Any] | None = None,
        now: datetime | None = None,
    ) -> AuditEvent:
        ts = now if now is not None else datetime.now(UTC)
        event = AuditEvent(
            created_at=ts,
            actor_type=actor_type,
            actor_id=actor_id,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            outcome=outcome,
            request_id=request_id,
            ip_address=ip_address,
            safe_diff=safe_diff,
        )
        self.db.add(event)
        self.db.flush()
        return event
