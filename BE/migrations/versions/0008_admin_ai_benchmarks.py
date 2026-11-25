"""Admin AI benchmark & ground-truth evaluation table.

Revision ID: 0008_admin_ai_benchmarks
Revises: 0007_mask_version_soft_delete
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0008_admin_ai_benchmarks"
down_revision: str | Sequence[str] | None = "0007_mask_version_soft_delete"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "admin_benchmark_runs",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("created_by", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("title", sa.String(length=160), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("target_worker_id", sa.String(length=128), nullable=False),
        sa.Column("executed_worker_id", sa.String(length=128), nullable=True),
        sa.Column("worker_device_type", sa.String(length=16), nullable=True),
        sa.Column("model_version_id", sa.String(length=128), nullable=True),
        sa.Column("state", sa.String(length=16), nullable=False, server_default="queued"),
        sa.Column("stage", sa.String(length=24), nullable=False, server_default="queued"),
        sa.Column("completed_slices", sa.Integer(), nullable=True),
        sa.Column("total_slices", sa.Integer(), nullable=True),
        sa.Column("error_code", sa.String(length=64), nullable=True),
        sa.Column("attempt_id", sa.Uuid(as_uuid=True), nullable=True),
        sa.Column("lease_token_hash", sa.CHAR(length=64), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("result_digest", sa.CHAR(length=64), nullable=True),
        sa.Column("flair_file_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("t1ce_file_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("gt_mask_file_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("pred_mask_file_id", sa.Uuid(as_uuid=True), nullable=True),
        sa.Column("coverage_file_id", sa.Uuid(as_uuid=True), nullable=True),
        sa.Column("shape_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("spacing_mm_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("affine_json", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("metrics_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("coverage_json", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("inference_duration_ms", sa.Integer(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')",
            name=op.f("ck_admin_benchmark_runs_state"),
        ),
        sa.CheckConstraint(
            "stage IN ('queued', 'loading', 'preprocessing', 'inference', "
            "'reconstructing', 'saving', 'done')",
            name=op.f("ck_admin_benchmark_runs_stage"),
        ),
        sa.ForeignKeyConstraint(
            ["coverage_file_id"],
            ["stored_files.id"],
            name=op.f("fk_admin_benchmark_runs_coverage_file_id_stored_files"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
            name=op.f("fk_admin_benchmark_runs_created_by_users"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["flair_file_id"],
            ["stored_files.id"],
            name=op.f("fk_admin_benchmark_runs_flair_file_id_stored_files"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["gt_mask_file_id"],
            ["stored_files.id"],
            name=op.f("fk_admin_benchmark_runs_gt_mask_file_id_stored_files"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["pred_mask_file_id"],
            ["stored_files.id"],
            name=op.f("fk_admin_benchmark_runs_pred_mask_file_id_stored_files"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["t1ce_file_id"],
            ["stored_files.id"],
            name=op.f("fk_admin_benchmark_runs_t1ce_file_id_stored_files"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_admin_benchmark_runs")),
    )
    op.create_index(
        "ix_admin_benchmark_runs_claim",
        "admin_benchmark_runs",
        ["target_worker_id", "state", "created_at"],
        unique=False,
    )
    op.create_index(
        "ix_admin_benchmark_runs_created_at",
        "admin_benchmark_runs",
        ["created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_admin_benchmark_runs_created_at", table_name="admin_benchmark_runs")
    op.drop_index("ix_admin_benchmark_runs_claim", table_name="admin_benchmark_runs")
    op.drop_table("admin_benchmark_runs")
