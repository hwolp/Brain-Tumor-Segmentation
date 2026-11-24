"""Volume repository."""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.stored_file import StoredFile
from app.models.volume import Volume


class VolumeRepository:
    """Data access helpers for Volume records."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def list_active_for_case(self, case_id: uuid.UUID) -> list[Volume]:
        return list(
            self.db.scalars(
                select(Volume)
                .where(Volume.case_id == case_id, Volume.deleted_at.is_(None))
                .order_by(Volume.created_at.asc(), Volume.id.asc())
            ).all()
        )

    def list_active_with_filenames_for_case(
        self, case_id: uuid.UUID
    ) -> list[tuple[Volume, str | None]]:
        rows = self.db.execute(
            select(Volume, StoredFile.original_name)
            .outerjoin(StoredFile, StoredFile.id == Volume.file_id)
            .where(Volume.case_id == case_id, Volume.deleted_at.is_(None))
            .order_by(Volume.created_at.asc(), Volume.id.asc())
        ).all()
        return [(row[0], row[1]) for row in rows]

    def get_active_by_modality(self, case_id: uuid.UUID, modality: str) -> Volume | None:
        return self.db.scalar(
            select(Volume).where(
                Volume.case_id == case_id,
                Volume.modality == modality,
                Volume.deleted_at.is_(None),
            )
        )

    def get_active_in_case(self, case_id: uuid.UUID, volume_id: uuid.UUID) -> Volume | None:
        return self.db.scalar(
            select(Volume).where(
                Volume.id == volume_id,
                Volume.case_id == case_id,
                Volume.deleted_at.is_(None),
            )
        )

    def list_active_for_cases(self, case_ids: list[uuid.UUID]) -> list[Volume]:
        if not case_ids:
            return []
        return list(
            self.db.scalars(
                select(Volume).where(
                    Volume.case_id.in_(case_ids),
                    Volume.deleted_at.is_(None),
                )
            ).all()
        )

    def list_all_for_case(self, case_id: uuid.UUID) -> list[Volume]:
        return list(
            self.db.scalars(select(Volume).where(Volume.case_id == case_id)).all()
        )

    def list_all_for_cases(self, case_ids: list[uuid.UUID]) -> list[Volume]:
        if not case_ids:
            return []
        return list(
            self.db.scalars(select(Volume).where(Volume.case_id.in_(case_ids))).all()
        )
