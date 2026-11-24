"""MaskVersion and MaskSaveIdempotencyKey repository."""

from __future__ import annotations

import uuid

from sqlalchemy import func, or_, select, update
from sqlalchemy.orm import Session

from app.models.case import Case
from app.models.mask_version import MaskSaveIdempotencyKey, MaskVersion
from app.models.patient import Patient
from app.models.user import User


class MaskVersionRepository:
    """Data access helpers for immutable MaskVersion records and save idempotency."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def get_by_id_for_owner(
        self, mask_version_id: uuid.UUID, owner_id: uuid.UUID
    ) -> tuple[MaskVersion, Case, str | None] | None:
        """Return (MaskVersion, Case, created_by_name) if owned by doctor and active."""
        row = self.db.execute(
            select(MaskVersion, Case, User.display_name)
            .join(Case, Case.id == MaskVersion.case_id)
            .join(Patient, Patient.id == Case.patient_id)
            .outerjoin(User, User.id == MaskVersion.created_by)
            .where(
                MaskVersion.id == mask_version_id,
                Case.owner_id == owner_id,
                Case.deleting_at.is_(None),
                Case.deleted_at.is_(None),
                Patient.deleting_at.is_(None),
                Patient.deleted_at.is_(None),
            )
        ).first()
        if row is None:
            return None
        return row[0], row[1], row[2]

    def get_by_id_with_author(
        self, mask_version_id: uuid.UUID
    ) -> tuple[MaskVersion, str | None] | None:
        row = self.db.execute(
            select(MaskVersion, User.display_name)
            .outerjoin(User, User.id == MaskVersion.created_by)
            .where(MaskVersion.id == mask_version_id)
        ).first()
        if row is None:
            return None
        return row[0], row[1]

    def get_by_id_in_case(
        self, mask_version_id: uuid.UUID, case_id: uuid.UUID
    ) -> MaskVersion | None:
        return self.db.scalar(
            select(MaskVersion).where(
                MaskVersion.id == mask_version_id,
                MaskVersion.case_id == case_id,
            )
        )

    def list_for_case(
        self,
        *,
        case_id: uuid.UUID,
        page: int = 1,
        page_size: int = 20,
    ) -> tuple[list[tuple[MaskVersion, str | None]], int]:
        total = int(
            self.db.scalar(
                select(func.count(MaskVersion.id)).where(MaskVersion.case_id == case_id)
            )
            or 0
        )
        rows = self.db.execute(
            select(MaskVersion, User.display_name)
            .outerjoin(User, User.id == MaskVersion.created_by)
            .where(MaskVersion.case_id == case_id)
            .order_by(MaskVersion.version_number.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()
        return [(row[0], row[1]) for row in rows], total

    def get_next_version_number(self, case_id: uuid.UUID) -> int:
        current_max = self.db.scalar(
            select(func.coalesce(func.max(MaskVersion.version_number), 0)).where(
                MaskVersion.case_id == case_id
            )
        )
        return int(current_max or 0) + 1

    def get_idempotency_record(
        self,
        *,
        doctor_id: uuid.UUID,
        case_id: uuid.UUID,
        idempotency_key: uuid.UUID,
    ) -> MaskSaveIdempotencyKey | None:
        return self.db.scalar(
            select(MaskSaveIdempotencyKey).where(
                MaskSaveIdempotencyKey.doctor_id == doctor_id,
                MaskSaveIdempotencyKey.case_id == case_id,
                MaskSaveIdempotencyKey.idempotency_key == idempotency_key,
            )
        )

    def list_file_ids_for_cases(self, case_ids: list[uuid.UUID]) -> list[uuid.UUID]:
        if not case_ids:
            return []
        rows = self.db.execute(
            select(MaskVersion.file_id, MaskVersion.coverage_file_id).where(
                MaskVersion.case_id.in_(case_ids)
            )
        ).all()
        ids: set[uuid.UUID] = set()
        for file_id, coverage_file_id in rows:
            if file_id is not None:
                ids.add(file_id)
            if coverage_file_id is not None:
                ids.add(coverage_file_id)
        return list(ids)

    def scrub_notes_for_cases(self, case_ids: list[uuid.UUID]) -> None:
        if not case_ids:
            return
        self.db.execute(
            update(MaskVersion)
            .where(MaskVersion.case_id.in_(case_ids), or_(MaskVersion.note.is_not(None)))
            .values(note=None)
        )
