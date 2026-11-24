"""P3 patients, cases, case_create_idempotency_keys, stored_files, and volumes.

Revision ID: 0003_p3_patients_cases_volumes
Revises: 0002_p2_auth_and_accounts
Create Date: 2026-11-17 02:00:00+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0003_p3_patients_cases_volumes"
down_revision: str | Sequence[str] | None = "0002_p2_auth_and_accounts"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "patients",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("owner_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("patient_code", sa.String(length=50), nullable=False),
        sa.Column("full_name", sa.String(length=150), nullable=False),
        sa.Column("birth_year", sa.Integer(), nullable=False),
        sa.Column("sex", sa.String(length=16), nullable=False),
        sa.Column("deleting_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_patients"),
        sa.ForeignKeyConstraint(
            ["owner_id"],
            ["users.id"],
            name="fk_patients_owner_id_users",
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint("birth_year >= 1900", name="birth_year_min"),
        sa.CheckConstraint(
            "sex IN ('male', 'female', 'other', 'unknown')",
            name="sex",
        ),
    )
    op.create_index(
        "ux_patients_owner_code_lower",
        "patients",
        ["owner_id", sa.text("lower(patient_code)")],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL AND deleting_at IS NULL"),
    )
    op.create_index(
        "ix_patients_owner_updated_at_id",
        "patients",
        ["owner_id", sa.text("updated_at DESC"), "id"],
        unique=False,
    )

    op.create_table(
        "cases",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("patient_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("owner_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("study_date", sa.Date(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("reference_volume_id", sa.Uuid(as_uuid=True), nullable=True),
        sa.Column(
            "readiness",
            sa.String(length=24),
            server_default=sa.text("'missing_inputs'"),
            nullable=False,
        ),
        sa.Column(
            "input_revision",
            sa.Integer(),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column("inputs_locked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("latest_mask_version_id", sa.Uuid(as_uuid=True), nullable=True),
        sa.Column("deleting_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_cases"),
        sa.ForeignKeyConstraint(
            ["patient_id"],
            ["patients.id"],
            name="fk_cases_patient_id_patients",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["owner_id"],
            ["users.id"],
            name="fk_cases_owner_id_users",
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint(
            "readiness IN ('missing_inputs', 'validating', 'ready', 'invalid')",
            name="readiness",
        ),
    )
    op.create_index(
        "ix_cases_owner_patient_study_date_id",
        "cases",
        ["owner_id", "patient_id", sa.text("study_date DESC"), "id"],
        unique=False,
    )
    op.create_index(
        "ix_cases_owner_created_at_id",
        "cases",
        ["owner_id", sa.text("created_at DESC"), "id"],
        unique=False,
    )

    op.create_table(
        "case_create_idempotency_keys",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("doctor_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("patient_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("idempotency_key", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("request_digest", sa.CHAR(length=64), nullable=False),
        sa.Column("case_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column(
            "case_deleted",
            sa.Boolean(),
            server_default=sa.text("false"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id", name="pk_case_create_idempotency_keys"),
        sa.ForeignKeyConstraint(
            ["doctor_id"],
            ["users.id"],
            name="fk_case_create_idempotency_keys_doctor_id_users",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["patient_id"],
            ["patients.id"],
            name="fk_case_create_idempotency_keys_patient_id_patients",
            ondelete="RESTRICT",
        ),
        sa.UniqueConstraint(
            "doctor_id",
            "patient_id",
            "idempotency_key",
            name="uq_case_create_idempotency_keys_scope",
        ),
    )

    op.create_table(
        "stored_files",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("storage_key", sa.Uuid(as_uuid=True), nullable=True),
        sa.Column("original_name", sa.String(length=255), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.CHAR(length=64), nullable=False),
        sa.Column("media_type", sa.String(length=128), nullable=False),
        sa.Column("state", sa.String(length=16), nullable=False),
        sa.Column("owner_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_stored_files"),
        sa.ForeignKeyConstraint(
            ["owner_id"],
            ["users.id"],
            name="fk_stored_files_owner_id_users",
            ondelete="RESTRICT",
        ),
        sa.UniqueConstraint("storage_key", name="uq_stored_files_storage_key"),
        sa.CheckConstraint("size_bytes >= 0", name="size_bytes_non_negative"),
        sa.CheckConstraint(
            "state IN ('staging', 'committed', 'deleting', 'deleted')",
            name="state",
        ),
    )
    op.create_index(
        "ix_stored_files_owner_state",
        "stored_files",
        ["owner_id", "state"],
        unique=False,
    )
    op.create_index(
        "ix_stored_files_state",
        "stored_files",
        ["state"],
        unique=False,
    )

    op.create_table(
        "volumes",
        sa.Column("id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("case_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column("modality", sa.String(length=16), nullable=False),
        sa.Column("file_id", sa.Uuid(as_uuid=True), nullable=False),
        sa.Column(
            "shape",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column(
            "spacing_mm",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column(
            "affine",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column("orientation", sa.String(length=16), nullable=False),
        sa.Column("datatype", sa.String(length=64), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.CHAR(length=64), nullable=False),
        sa.Column("validation_status", sa.String(length=16), nullable=False),
        sa.Column(
            "validation_errors",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_volumes"),
        sa.ForeignKeyConstraint(
            ["case_id"],
            ["cases.id"],
            name="fk_volumes_case_id_cases",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["file_id"],
            ["stored_files.id"],
            name="fk_volumes_file_id_stored_files",
            ondelete="RESTRICT",
        ),
        sa.CheckConstraint("modality IN ('flair', 't1ce')", name="modality"),
        sa.CheckConstraint(
            "validation_status IN ('validating', 'valid', 'invalid')",
            name="validation_status",
        ),
    )
    op.create_index(
        "ux_volumes_case_modality_active",
        "volumes",
        ["case_id", "modality"],
        unique=True,
        postgresql_where=sa.text("deleted_at IS NULL"),
    )
    op.create_index("ix_volumes_file_id", "volumes", ["file_id"], unique=False)


def downgrade() -> None:
    op.drop_index("ix_volumes_file_id", table_name="volumes")
    op.drop_index("ux_volumes_case_modality_active", table_name="volumes")
    op.drop_table("volumes")

    op.drop_index("ix_stored_files_state", table_name="stored_files")
    op.drop_index("ix_stored_files_owner_state", table_name="stored_files")
    op.drop_table("stored_files")

    op.drop_table("case_create_idempotency_keys")

    op.drop_index("ix_cases_owner_created_at_id", table_name="cases")
    op.drop_index("ix_cases_owner_patient_study_date_id", table_name="cases")
    op.drop_table("cases")

    op.drop_index("ix_patients_owner_updated_at_id", table_name="patients")
    op.drop_index("ux_patients_owner_code_lower", table_name="patients")
    op.drop_table("patients")
