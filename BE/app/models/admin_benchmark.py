"""Admin AI benchmark & ground-truth evaluation run ORM model."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    CHAR,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Uuid,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class AdminBenchmarkRun(Base):
    """Isolated technical evaluation comparing a selected AI worker against doctor seg.nii."""

    __tablename__ = "admin_benchmark_runs"
    __table_args__ = (
        CheckConstraint(
            "state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')",
            name="ck_admin_benchmark_runs_state",
        ),
        CheckConstraint(
            "stage IN ('queued', 'loading', 'preprocessing', 'inference', "
            "'reconstructing', 'saving', 'done')",
            name="ck_admin_benchmark_runs_stage",
        ),
        Index(
            "ix_admin_benchmark_runs_claim",
            "target_worker_id",
            "state",
            "created_at",
        ),
        Index("ix_admin_benchmark_runs_created_at", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True, default=uuid.uuid4)
    created_by: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(160), nullable=False)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    target_worker_id: Mapped[str] = mapped_column(String(128), nullable=False)
    executed_worker_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    worker_device_type: Mapped[str | None] = mapped_column(String(16), nullable=True)
    model_version_id: Mapped[str | None] = mapped_column(String(128), nullable=True)

    state: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")
    stage: Mapped[str] = mapped_column(String(24), nullable=False, default="queued")
    completed_slices: Mapped[int | None] = mapped_column(Integer, nullable=True)
    total_slices: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)

    attempt_id: Mapped[uuid.UUID | None] = mapped_column(Uuid(as_uuid=True), nullable=True)
    lease_token_hash: Mapped[str | None] = mapped_column(CHAR(64), nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    result_digest: Mapped[str | None] = mapped_column(CHAR(64), nullable=True)

    flair_file_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("stored_files.id", ondelete="RESTRICT"), nullable=False
    )
    t1ce_file_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("stored_files.id", ondelete="RESTRICT"), nullable=False
    )
    gt_mask_file_id: Mapped[uuid.UUID] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("stored_files.id", ondelete="RESTRICT"), nullable=False
    )
    pred_mask_file_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("stored_files.id", ondelete="SET NULL"), nullable=True
    )
    coverage_file_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid(as_uuid=True), ForeignKey("stored_files.id", ondelete="SET NULL"), nullable=True
    )

    shape_json: Mapped[list[int]] = mapped_column(JSONB, nullable=False)
    spacing_mm_json: Mapped[list[float]] = mapped_column(JSONB, nullable=False)
    affine_json: Mapped[list[list[float]]] = mapped_column(JSONB, nullable=False)
    metrics_json: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    coverage_json: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)

    inference_duration_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
