"""Case and CaseCreateIdempotencyKey ORM models."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime

from sqlalchemy import (
    CHAR,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Case(Base):
    """Clinical MRI study case belonging to a patient and doctor."""

    __tablename__ = "cases"
    __table_args__ = (
        CheckConstraint(
            "readiness IN ('missing_inputs', 'validating', 'ready', 'invalid')",
            name="readiness",
        ),
        Index(
            "ix_cases_owner_patient_study_date_id",
            "owner_id",
            "patient_id",
            text("study_date DESC"),
            "id",
        ),
        Index(
            "ix_cases_owner_created_at_id",
            "owner_id",
            text("created_at DESC"),
            "id",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    patient_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("patients.id", ondelete="RESTRICT"),
        nullable=False,
    )
    owner_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    study_date: Mapped[date] = mapped_column(Date, nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    reference_volume_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True),
        nullable=True,
    )
    readiness: Mapped[str] = mapped_column(
        String(24),
        nullable=False,
        server_default=text("'missing_inputs'"),
        default="missing_inputs",
    )
    input_revision: Mapped[int] = mapped_column(
        Integer,
        nullable=False,
        server_default=text("0"),
        default=0,
    )
    inputs_locked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    latest_mask_version_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True),
        nullable=True,
    )
    deleting_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        default=lambda: datetime.now(UTC),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
        default=lambda: datetime.now(UTC),
    )


class CaseCreateIdempotencyKey(Base):
    """Idempotency receipt for POST /patients/{id}/cases."""

    __tablename__ = "case_create_idempotency_keys"
    __table_args__ = (
        UniqueConstraint(
            "doctor_id",
            "patient_id",
            "idempotency_key",
            name="uq_case_create_idempotency_keys_scope",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    doctor_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
    )
    patient_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("patients.id", ondelete="RESTRICT"),
        nullable=False,
    )
    idempotency_key: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    request_digest: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    case_id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    case_deleted: Mapped[bool] = mapped_column(
        Boolean,
        nullable=False,
        server_default=text("false"),
        default=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        default=lambda: datetime.now(UTC),
    )
