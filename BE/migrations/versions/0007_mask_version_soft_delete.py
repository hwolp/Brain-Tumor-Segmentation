"""MaskVersion soft-delete support.

Revision ID: 0007_mask_version_soft_delete
Revises: 0006_p6_admin_settings
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007_mask_version_soft_delete"
down_revision: str | Sequence[str] | None = "0006_p6_admin_settings"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "mask_versions",
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("mask_versions", "deleted_at")
