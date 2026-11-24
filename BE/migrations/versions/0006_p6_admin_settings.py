"""P6 allowlisted operations settings seed.

Revision ID: 0006_p6_admin_settings
Revises: 0005_p5_inference_jobs
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006_p6_admin_settings"
down_revision: str | Sequence[str] | None = "0005_p5_inference_jobs"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    settings = sa.table(
        "system_settings",
        sa.column("key", sa.Text()),
        sa.column("value_json", sa.JSON()),
        sa.column("updated_by", sa.Uuid(as_uuid=True)),
    )
    op.bulk_insert(
        settings,
        [
            {
                "key": "admin_settings",
                "value_json": {
                    "version": 1,
                    "accepting_jobs": True,
                    "max_upload_mib": 100,
                    "max_decompressed_mib": 256,
                    "default_doctor_quota_gib": 2,
                    "system_quota_gib": 20,
                },
                "updated_by": None,
            }
        ],
        multiinsert=False,
    )


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM system_settings WHERE key = 'admin_settings'"))
