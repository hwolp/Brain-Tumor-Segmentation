"""Patient repository."""

from __future__ import annotations

import uuid

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.models.case import Case
from app.models.patient import Patient


def escape_like(value: str) -> str:
    """Escape LIKE/ILIKE wildcards (\\, %, _) for safe substring matching."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


class PatientRepository:
    """Data access helpers for doctor-owned Patient records."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def get_active_for_owner(self, patient_id: uuid.UUID, owner_id: uuid.UUID) -> Patient | None:
        return self.db.scalar(
            select(Patient).where(
                Patient.id == patient_id,
                Patient.owner_id == owner_id,
                Patient.deleting_at.is_(None),
                Patient.deleted_at.is_(None),
            )
        )

    def get_active_for_owner_for_update(
        self, patient_id: uuid.UUID, owner_id: uuid.UUID
    ) -> Patient | None:
        return self.db.scalar(
            select(Patient)
            .where(
                Patient.id == patient_id,
                Patient.owner_id == owner_id,
                Patient.deleting_at.is_(None),
                Patient.deleted_at.is_(None),
            )
            .with_for_update()
            .execution_options(populate_existing=True)
        )

    def count_active_cases(self, patient_id: uuid.UUID) -> int:
        count = self.db.scalar(
            select(func.count(Case.id)).where(
                Case.patient_id == patient_id,
                Case.deleting_at.is_(None),
                Case.deleted_at.is_(None),
            )
        )
        return int(count or 0)

    def exists_active_code_for_owner(
        self,
        *,
        owner_id: uuid.UUID,
        patient_code: str,
        exclude_patient_id: uuid.UUID | None = None,
    ) -> bool:
        stmt = select(Patient.id).where(
            Patient.owner_id == owner_id,
            func.lower(Patient.patient_code) == patient_code.lower(),
            Patient.deleting_at.is_(None),
            Patient.deleted_at.is_(None),
        )
        if exclude_patient_id is not None:
            stmt = stmt.where(Patient.id != exclude_patient_id)
        return self.db.scalar(stmt) is not None

    def list_for_owner(
        self,
        *,
        owner_id: uuid.UUID,
        q: str | None = None,
        page: int = 1,
        page_size: int = 20,
    ) -> tuple[list[tuple[Patient, int]], int]:
        base_filter = [
            Patient.owner_id == owner_id,
            Patient.deleting_at.is_(None),
            Patient.deleted_at.is_(None),
        ]
        if q is not None and q.strip():
            escaped = escape_like(q.strip())
            pattern = f"%{escaped}%"
            base_filter.append(
                or_(
                    Patient.patient_code.ilike(pattern, escape="\\"),
                    Patient.full_name.ilike(pattern, escape="\\"),
                )
            )

        total = int(
            self.db.scalar(select(func.count(Patient.id)).where(*base_filter)) or 0
        )

        case_count_subq = (
            select(
                Case.patient_id.label("patient_id"),
                func.count(Case.id).label("case_count"),
            )
            .where(Case.deleting_at.is_(None), Case.deleted_at.is_(None))
            .group_by(Case.patient_id)
            .subquery()
        )

        stmt = (
            select(
                Patient,
                func.coalesce(case_count_subq.c.case_count, 0).label("case_count"),
            )
            .outerjoin(case_count_subq, case_count_subq.c.patient_id == Patient.id)
            .where(*base_filter)
            .order_by(Patient.updated_at.desc(), Patient.id.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        )
        rows = [(row[0], int(row[1])) for row in self.db.execute(stmt).all()]
        return rows, total
