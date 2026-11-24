"""P1 foundation: create system_settings table.

Revision ID: 0001_p1_foundation
Revises:
Create Date: 2026-11-17 00:00:00+00:00
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001_p1_foundation"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "system_settings",
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column(
            "value_json",
            sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("updated_by", sa.Uuid(as_uuid=True), nullable=True),
        sa.PrimaryKeyConstraint("key", name="pk_system_settings"),
    )


def downgrade() -> None:
    op.drop_table("system_settings")
