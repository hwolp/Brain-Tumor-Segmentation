"""Inference queue, worker lease, and model registry ORM models."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    CHAR,
    JSON,
    Boolean,
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


class ModelVersion(Base):
    """Allowlisted model manifest; private manifest paths stay server-side."""

    __tablename__ = "model_versions"
    __table_args__ = (
        CheckConstraint("expected_shape_json IS NOT NULL", name="expected_shape_required"),
        Index("ix_model_versions_active", "is_active"),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    model_id: Mapped[str] = mapped_column(String(96), nullable=False)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    version: Mapped[str] = mapped_column(String(96), nullable=False)
    pipeline_version: Mapped[str] = mapped_column(String(96), nullable=False)
    checkpoint_sha256: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    expected_shape_json: Mapped[list[int]] = mapped_column(
        JSON().with_variant(JSONB(astext_type=Text()), "postgresql"), nullable=False
    )
    expected_spacing_mm_json: Mapped[list[float]] = mapped_column(
        JSON().with_variant(JSONB(astext_type=Text()), "postgresql"), nullable=False
    )
    manifest_json: Mapped[dict[str, Any]] = mapped_column(
        JSON().with_variant(JSONB(astext_type=Text()), "postgresql"), nullable=False
    )
    verified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class InferenceJob(Base):
    """One immutable inference request and its public progress state."""

    __tablename__ = "inference_jobs"
    __table_args__ = (
        CheckConstraint(
            "state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')",
            name="state",
        ),
        CheckConstraint(
            "stage IN ('queued', 'loading', 'preprocessing', 'inference', "
            "'reconstructing', 'saving', 'done')",
            name="stage",
        ),
        CheckConstraint("attempt_count >= 0 AND auto_retry_count >= 0", name="attempt_counts"),
        Index(
            "ux_inference_jobs_active_case",
            "case_id",
            unique=True,
            postgresql_where=text("state IN ('queued', 'running')"),
        ),
        Index("ix_inference_jobs_state_created", "state", "created_at"),
        Index("ix_inference_jobs_case_created", "case_id", text("created_at DESC")),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    case_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("cases.id", ondelete="RESTRICT"), nullable=False
    )
    doctor_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    model_version_id: Mapped[str] = mapped_column(
        String(128), ForeignKey("model_versions.id", ondelete="RESTRICT"), nullable=False
    )
    state: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")
    stage: Mapped[str] = mapped_column(String(24), nullable=False, default="queued")
    completed_slices: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_slices: Mapped[int | None] = mapped_column(Integer, nullable=True)
    attempt_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    auto_retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    max_auto_retries: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    result_mask_version_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), nullable=True
    )
    result_digest: Mapped[str | None] = mapped_column(CHAR(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        default=lambda: datetime.now(UTC),
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class JobAttempt(Base):
    """Worker attempt with hashed lease token and heartbeat expiry."""

    __tablename__ = "job_attempts"
    __table_args__ = (
        UniqueConstraint("job_id", "attempt_number", name="uq_job_attempts_number"),
        CheckConstraint("state IN ('running', 'succeeded', 'failed', 'expired')", name="state"),
        Index(
            "ix_job_attempts_expiry", "lease_expires_at", postgresql_where=text("state = 'running'")
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    job_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("inference_jobs.id", ondelete="CASCADE"), nullable=False
    )
    attempt_number: Mapped[int] = mapped_column(Integer, nullable=False)
    worker_id: Mapped[str] = mapped_column(String(128), nullable=False)
    state: Mapped[str] = mapped_column(String(16), nullable=False, default="running")
    lease_token_hash: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    lease_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    stage: Mapped[str] = mapped_column(String(24), nullable=False, default="loading")
    completed_slices: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_slices: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class WorkerInstance(Base):
    """Last heartbeat and basic technical capability of an inference worker."""

    __tablename__ = "worker_instances"

    worker_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    device_type: Mapped[str] = mapped_column(String(16), nullable=False)
    model_version_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    current_job_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    last_heartbeat_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class JobCreateIdempotencyKey(Base):
    """Receipt for a doctor submitting the same job request more than once."""

    __tablename__ = "job_create_idempotency_keys"
    __table_args__ = (
        UniqueConstraint(
            "doctor_id", "case_id", "idempotency_key", name="uq_job_idempotency_scope"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    doctor_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    case_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("cases.id", ondelete="RESTRICT"), nullable=False
    )
    idempotency_key: Mapped[str] = mapped_column(String(128), nullable=False)
    request_digest: Mapped[str] = mapped_column(CHAR(64), nullable=False)
    job_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("inference_jobs.id", ondelete="RESTRICT"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
