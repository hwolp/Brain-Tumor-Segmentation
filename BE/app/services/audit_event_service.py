"""AuditEvent query service with technical-only allowlist filtering."""

from __future__ import annotations

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models.audit_event import AuditEvent
from app.models.user import User
from app.schemas.common import PaginatedResponse
from app.schemas.jobs import AuditEventOut

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


class AuditEventService:
    """Service layer for querying redacted technical audit events."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def list_audit_events(
        self, *, q: str | None, page: int, page_size: int
    ) -> PaginatedResponse[AuditEventOut]:
        """List allowlisted technical audit events without patient PII."""
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
