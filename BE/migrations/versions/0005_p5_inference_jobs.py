"""P5 verified-model registry, job queue, worker leases, and idempotency.

Revision ID: 0005_p5_inference_jobs
Revises: 0004_p4_mask_versions
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0005_p5_inference_jobs"
down_revision: str | Sequence[str] | None = "0004_p4_mask_versions"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    json_type = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")
    op.create_table(
        "model_versions",
        sa.Column("id", sa.String(128), nullable=False),
        sa.Column("model_id", sa.String(96), nullable=False),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("version", sa.String(96), nullable=False),
        sa.Column("pipeline_version", sa.String(96), nullable=False),
        sa.Column("checkpoint_sha256", sa.CHAR(64), nullable=False),
        sa.Column("expected_shape_json", json_type, nullable=False),
        sa.Column("expected_spacing_mm_json", json_type, nullable=False),
        sa.Column("manifest_json", json_type, nullable=False),
        sa.Column("verified", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.CheckConstraint(
            "expected_shape_json IS NOT NULL", name="ck_model_versions_expected_shape_required"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_model_versions"),
    )
    op.create_index("ix_model_versions_active", "model_versions", ["is_active"])

    op.create_table(
        "inference_jobs",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("case_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("doctor_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("model_version_id", sa.String(128), nullable=False),
        sa.Column("state", sa.String(16), nullable=False, server_default="queued"),
        sa.Column("stage", sa.String(24), nullable=False, server_default="queued"),
        sa.Column("completed_slices", sa.Integer(), nullable=True),
        sa.Column("total_slices", sa.Integer(), nullable=True),
        sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("auto_retry_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_auto_retries", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("error_code", sa.String(64), nullable=True),
        sa.Column("result_mask_version_id", sa.Uuid(as_uuid=True), nullable=True),
        sa.Column("result_digest", sa.CHAR(64), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')",
            name="ck_inference_jobs_state",
        ),
        sa.CheckConstraint(
            "stage IN ('queued', 'loading', 'preprocessing', 'inference', 'reconstructing', 'saving', 'done')",
            name="ck_inference_jobs_stage",
        ),
        sa.CheckConstraint(
            "attempt_count >= 0 AND auto_retry_count >= 0", name="ck_inference_jobs_attempt_counts"
        ),
        sa.ForeignKeyConstraint(
            ["case_id"], ["cases.id"], name="fk_inference_jobs_case_id_cases", ondelete="RESTRICT"
        ),
        sa.ForeignKeyConstraint(
            ["doctor_id"],
            ["users.id"],
            name="fk_inference_jobs_doctor_id_users",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["model_version_id"],
            ["model_versions.id"],
            name="fk_inference_jobs_model_version_id_model_versions",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_inference_jobs"),
    )
    op.create_index(
        "ux_inference_jobs_active_case",
        "inference_jobs",
        ["case_id"],
        unique=True,
        postgresql_where=sa.text("state IN ('queued', 'running')"),
    )
    op.create_index("ix_inference_jobs_state_created", "inference_jobs", ["state", "created_at"])
    op.create_index(
        "ix_inference_jobs_case_created", "inference_jobs", ["case_id", sa.text("created_at DESC")]
    )

    op.create_table(
        "job_attempts",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("job_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("attempt_number", sa.Integer(), nullable=False),
        sa.Column("worker_id", sa.String(128), nullable=False),
        sa.Column("state", sa.String(16), nullable=False, server_default="running"),
        sa.Column("lease_token_hash", sa.CHAR(64), nullable=False),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("stage", sa.String(24), nullable=False, server_default="loading"),
        sa.Column("completed_slices", sa.Integer(), nullable=True),
        sa.Column("total_slices", sa.Integer(), nullable=True),
        sa.Column("error_code", sa.String(64), nullable=True),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "state IN ('running', 'succeeded', 'failed', 'expired')", name="ck_job_attempts_state"
        ),
        sa.ForeignKeyConstraint(
            ["job_id"],
            ["inference_jobs.id"],
            name="fk_job_attempts_job_id_inference_jobs",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_job_attempts"),
        sa.UniqueConstraint("job_id", "attempt_number", name="uq_job_attempts_number"),
    )
    op.create_index(
        "ix_job_attempts_expiry",
        "job_attempts",
        ["lease_expires_at"],
        postgresql_where=sa.text("state = 'running'"),
    )

    op.create_table(
        "worker_instances",
        sa.Column("worker_id", sa.String(128), nullable=False),
        sa.Column("device_type", sa.String(16), nullable=False),
        sa.Column("model_version_id", sa.String(128), nullable=True),
        sa.Column("current_job_id", sa.Uuid(as_uuid=True), nullable=True),
        sa.Column("last_heartbeat_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("worker_id", name="pk_worker_instances"),
    )

    op.create_table(
        "job_create_idempotency_keys",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("doctor_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("case_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("idempotency_key", sa.String(128), nullable=False),
        sa.Column("request_digest", sa.CHAR(64), nullable=False),
        sa.Column("job_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.ForeignKeyConstraint(
            ["case_id"],
            ["cases.id"],
            name="fk_job_create_idempotency_keys_case_id_cases",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["doctor_id"],
            ["users.id"],
            name="fk_job_create_idempotency_keys_doctor_id_users",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["job_id"],
            ["inference_jobs.id"],
            name="fk_job_create_idempotency_keys_job_id_inference_jobs",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_job_create_idempotency_keys"),
        sa.UniqueConstraint(
            "doctor_id", "case_id", "idempotency_key", name="uq_job_idempotency_scope"
        ),
    )

    op.create_foreign_key(
        "fk_mask_versions_job_id_inference_jobs",
        "mask_versions",
        "inference_jobs",
        ["job_id"],
        ["id"],
        ondelete="RESTRICT",
    )
    op.create_unique_constraint("uq_mask_versions_job_id", "mask_versions", ["job_id"])


def downgrade() -> None:
    op.drop_constraint("uq_mask_versions_job_id", "mask_versions", type_="unique")
    op.drop_constraint(
        "fk_mask_versions_job_id_inference_jobs", "mask_versions", type_="foreignkey"
    )
    op.drop_table("job_create_idempotency_keys")
    op.drop_table("worker_instances")
    op.drop_index("ix_job_attempts_expiry", table_name="job_attempts")
    op.drop_table("job_attempts")
    op.drop_index("ix_inference_jobs_case_created", table_name="inference_jobs")
    op.drop_index("ix_inference_jobs_state_created", table_name="inference_jobs")
    op.drop_index("ux_inference_jobs_active_case", table_name="inference_jobs")
    op.drop_table("inference_jobs")
    op.drop_index("ix_model_versions_active", table_name="model_versions")
    op.drop_table("model_versions")
