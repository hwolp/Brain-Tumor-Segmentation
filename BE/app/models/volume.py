"""Volume ORM model."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import (
    CHAR,
    JSON,
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Volume(Base):
    """Validated 3D MRI NIfTI volume attached to a clinical case."""

    __tablename__ = "volumes"
    __table_args__ = (
        CheckConstraint("modality IN ('flair', 't1ce')", name="modality"),
        CheckConstraint(
            "validation_status IN ('validating', 'valid', 'invalid')",
            name="validation_status",
        ),
        Index(
            "ux_volumes_case_modality_active",
            "case_id",
            "modality",
            unique=True,
            postgresql_where=text("deleted_at IS NULL"),
        ),
        Index("ix_volumes_file_id", "file_id"),
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
    modality: Mapped[str] = mapped_column(String(16), nullable=False)
    file_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True),
        ForeignKey("stored_files.id", ondelete="RESTRICT"),
        nullable=False,
    )
    shape: Mapped[list[int]] = mapped_column(
        JSON().with_variant(JSONB(astext_type=Text()), "postgresql"),
        nullable=False,
    )
    spacing_mm: Mapped[list[float]] = mapped_column(
        JSON().with_variant(JSONB(astext_type=Text()), "postgresql"),
        nullable=False,
    )
    affine: Mapped[list[list[float]]] = mapped_column(
        JSON().with_variant(JSONB(astext_type=Text()), "postgresql"),
        nullable=False,
    )
    orientation: Mapped[str] = mapped_column(String(16), nullable=False)
    datatype: Mapped[str] = mapped_column(String(64), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    sha256: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    validation_status: Mapped[str] = mapped_column(String(16), nullable=False)
    validation_errors: Mapped[list[str]] = mapped_column(
        JSON().with_variant(JSONB(astext_type=Text()), "postgresql"),
        nullable=False,
        server_default=text("'[]'::jsonb"),
        default=list,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        default=lambda: datetime.now(UTC),
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
