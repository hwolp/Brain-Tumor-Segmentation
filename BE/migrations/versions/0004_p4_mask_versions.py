"""P4 mask_versions and mask_save_idempotency_keys.

Revision ID: 0004_p4_mask_versions
Revises: 0003_p3_patients_cases_volumes
Create Date: 2026-11-17 03:00:00+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0004_p4_mask_versions"
down_revision: str | Sequence[str] | None = "0003_p3_patients_cases_volumes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "mask_versions",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("case_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("version_number", sa.Integer(), nullable=False),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("base_version_id", sa.Uuid(as_uuid=True), nullable=True),
        sa.Column("reference_volume_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("file_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("created_by", sa.Uuid(as_uuid=True), nullable=True),
        sa.Column("job_id", sa.Uuid(as_uuid=True), nullable=True),
        sa.Column("model_version_id", sa.String(length=128), nullable=True),
        sa.Column("coverage_file_id", sa.Uuid(as_uuid=True), nullable=True),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column(
            "label_voxel_counts",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column(
            "label_volumes_mm3",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column(
            "composite_volumes_mm3",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=True,
        ),
        sa.Column("sha256", sa.CHAR(length=64), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_mask_versions"),
        sa.ForeignKeyConstraint(
            ["case_id"],
            ["cases.id"],
            name="fk_mask_versions_case_id_cases",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["base_version_id"],
            ["mask_versions.id"],
            name="fk_mask_versions_base_version_id_mask_versions",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["reference_volume_id"],
            ["volumes.id"],
            name="fk_mask_versions_reference_volume_id_volumes",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["file_id"],
            ["stored_files.id"],
            name="fk_mask_versions_file_id_stored_files",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
            name="fk_mask_versions_created_by_users",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["coverage_file_id"],
            ["stored_files.id"],
            name="fk_mask_versions_coverage_file_id_stored_files",
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint("version_number >= 1", name="version_number_min"),
        sa.CheckConstraint("source IN ('ai', 'manual')", name="source"),
        sa.CheckConstraint(
            "note IS NULL OR char_length(note) <= 2000",
            name="note_max_length",
        ),
        sa.UniqueConstraint(
            "case_id",
            "version_number",
            name="uq_mask_versions_case_version",
        ),
    )
    op.create_index(
        "ix_mask_versions_case_created_at",
        "mask_versions",
        ["case_id", sa.text("version_number DESC")],
        unique=False,
    )

    op.create_table(
        "mask_save_idempotency_keys",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("doctor_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("case_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("idempotency_key", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("request_digest", sa.CHAR(length=64), nullable=False),
        sa.Column("mask_version_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_mask_save_idempotency_keys"),
        sa.ForeignKeyConstraint(
            ["doctor_id"],
            ["users.id"],
            name="fk_mask_save_idempotency_keys_doctor_id_users",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["case_id"],
            ["cases.id"],
            name="fk_mask_save_idempotency_keys_case_id_cases",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["mask_version_id"],
            ["mask_versions.id"],
            name="fk_mask_save_idempotency_keys_mask_version_id_mask_versions",
            ondelete="RESTRICT",
        ),
        sa.UniqueConstraint(
            "doctor_id",
            "case_id",
            "idempotency_key",
            name="uq_mask_save_idem_doctor_case_key",
        ),
    )


def downgrade() -> None:
    op.drop_table("mask_save_idempotency_keys")
    op.drop_index("ix_mask_versions_case_created_at", table_name="mask_versions")
    op.drop_table("mask_versions")
