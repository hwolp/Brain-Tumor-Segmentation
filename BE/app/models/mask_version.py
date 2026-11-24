"""MaskVersion and MaskSaveIdempotencyKey ORM models."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    CHAR,
    JSON,
    CheckConstraint,
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
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class MaskVersion(Base):
    """Immutable 3D segmentation mask version belonging to a clinical case."""

    __tablename__ = "mask_versions"
    __table_args__ = (
        CheckConstraint("version_number >= 1", name="version_number_min"),
        CheckConstraint("source IN ('ai', 'manual')", name="source"),
        CheckConstraint(
            "note IS NULL OR char_length(note) <= 2000",
            name="note_max_length",
        ),
        UniqueConstraint("case_id", "version_number", name="uq_mask_versions_case_version"),
        UniqueConstraint("job_id", name="uq_mask_versions_job_id"),
        Index("ix_mask_versions_case_created_at", "case_id", text("version_number DESC")),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
    )
    case_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("cases.id", ondelete="RESTRICT"),
        nullable=False,
    )
    version_number: Mapped[int] = mapped_column(Integer, nullable=False)
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    base_version_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("mask_versions.id", ondelete="RESTRICT"),
        nullable=True,
    )
    reference_volume_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("volumes.id", ondelete="RESTRICT"),
        nullable=False,
    )
    file_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("stored_files.id", ondelete="RESTRICT"),
        nullable=False,
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=True,
    )
    job_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("inference_jobs.id", ondelete="RESTRICT"), nullable=True
    )
    model_version_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    coverage_file_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("stored_files.id", ondelete="RESTRICT"),
        nullable=True,
    )
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    label_voxel_counts: Mapped[dict[str, int]] = mapped_column(
        JSON().with_variant(JSONB(astext_type=Text()), "postgresql"),
        nullable=False,
    )
    label_volumes_mm3: Mapped[dict[str, float]] = mapped_column(
        JSON().with_variant(JSONB(astext_type=Text()), "postgresql"),
        nullable=False,
    )
    composite_volumes_mm3: Mapped[dict[str, float] | None] = mapped_column(
        JSON().with_variant(JSONB(astext_type=Text()), "postgresql"),
        nullable=True,
    )
    sha256: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        default=lambda: datetime.now(UTC),
    )


class MaskSaveIdempotencyKey(Base):
    """Idempotency receipt for POST /cases/{case_id}/mask-versions."""

    __tablename__ = "mask_save_idempotency_keys"
    __table_args__ = (
        UniqueConstraint(
            "doctor_id",
            "case_id",
            "idempotency_key",
            name="uq_mask_save_idem_doctor_case_key",
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
    case_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("cases.id", ondelete="RESTRICT"),
        nullable=False,
    )
    idempotency_key: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), nullable=False)
    request_digest: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    mask_version_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("mask_versions.id", ondelete="RESTRICT"),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        default=lambda: datetime.now(UTC),
    )
