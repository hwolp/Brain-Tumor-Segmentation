"""Case and CaseCreateIdempotencyKey repository."""

from __future__ import annotations

import uuid

from sqlalchemy import func, select, text, update
from sqlalchemy.orm import Session

from app.models.case import Case, CaseCreateIdempotencyKey
from app.models.patient import Patient


class CaseRepository:
    """Data access helpers for clinical Case records and idempotency keys."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def get_active_for_owner(self, case_id: uuid.UUID, owner_id: uuid.UUID) -> Case | None:
        return self.db.scalar(
            select(Case)
            .join(Patient, Patient.id == Case.patient_id)
            .where(
                Case.id == case_id,
                Case.owner_id == owner_id,
                Case.deleting_at.is_(None),
                Case.deleted_at.is_(None),
                Patient.deleting_at.is_(None),
                Patient.deleted_at.is_(None),
            )
        )

    def get_active_for_owner_for_update(
        self, case_id: uuid.UUID, owner_id: uuid.UUID
    ) -> Case | None:
        return self.db.scalar(
            select(Case)
            .join(Patient, Patient.id == Case.patient_id)
            .where(
                Case.id == case_id,
                Case.owner_id == owner_id,
                Case.deleting_at.is_(None),
                Case.deleted_at.is_(None),
                Patient.deleting_at.is_(None),
                Patient.deleted_at.is_(None),
            )
            .with_for_update(of=Case)
            .execution_options(populate_existing=True)
        )

    def list_for_owner(
        self,
        *,
        owner_id: uuid.UUID,
        page: int = 1,
        page_size: int = 20,
    ) -> tuple[list[Case], int]:
        filters = [
            Case.owner_id == owner_id,
            Case.deleting_at.is_(None),
            Case.deleted_at.is_(None),
            Patient.deleting_at.is_(None),
            Patient.deleted_at.is_(None),
        ]
        total = int(
            self.db.scalar(
                select(func.count(Case.id))
                .select_from(Case)
                .join(Patient, Patient.id == Case.patient_id)
                .where(*filters)
            )
            or 0
        )
        items = list(
            self.db.scalars(
                select(Case)
                .join(Patient, Patient.id == Case.patient_id)
                .where(*filters)
                .order_by(Case.created_at.desc(), Case.id.desc())
                .offset((page - 1) * page_size)
                .limit(page_size)
            ).all()
        )
        return items, total

    def list_for_owner_with_patient_code(
        self,
        *,
        owner_id: uuid.UUID,
        page: int = 1,
        page_size: int = 20,
    ) -> tuple[list[tuple[Case, str]], int]:
        filters = [
            Case.owner_id == owner_id,
            Case.deleting_at.is_(None),
            Case.deleted_at.is_(None),
            Patient.deleting_at.is_(None),
            Patient.deleted_at.is_(None),
        ]
        total = int(
            self.db.scalar(
                select(func.count(Case.id))
                .select_from(Case)
                .join(Patient, Patient.id == Case.patient_id)
                .where(*filters)
            )
            or 0
        )
        rows = self.db.execute(
            select(Case, Patient.patient_code)
            .join(Patient, Patient.id == Case.patient_id)
            .where(*filters)
            .order_by(Case.created_at.desc(), Case.id.desc())
            .offset((page - 1) * page_size)
            .limit(page_size)
        ).all()
        items = [(row[0], str(row[1])) for row in rows]
        return items, total

    def list_for_patient_owner(
        self,
        *,
        patient_id: uuid.UUID,
        owner_id: uuid.UUID,
        page: int = 1,
        page_size: int = 20,
    ) -> tuple[list[Case], int]:
        filters = [
            Case.patient_id == patient_id,
            Case.owner_id == owner_id,
            Case.deleting_at.is_(None),
            Case.deleted_at.is_(None),
        ]
        total = int(self.db.scalar(select(func.count(Case.id)).where(*filters)) or 0)
        items = list(
            self.db.scalars(
                select(Case)
                .where(*filters)
                .order_by(Case.study_date.desc(), Case.created_at.desc(), Case.id.desc())
                .offset((page - 1) * page_size)
                .limit(page_size)
            ).all()
        )
        return items, total

    def list_active_for_patient(self, patient_id: uuid.UUID) -> list[Case]:
        return list(
            self.db.scalars(
                select(Case).where(
                    Case.patient_id == patient_id,
                    Case.deleting_at.is_(None),
                    Case.deleted_at.is_(None),
                )
            ).all()
        )

    def list_active_for_patient_for_update(self, patient_id: uuid.UUID) -> list[Case]:
        return list(
            self.db.scalars(
                select(Case)
                .where(
                    Case.patient_id == patient_id,
                    Case.deleting_at.is_(None),
                    Case.deleted_at.is_(None),
                )
                .order_by(Case.id.asc())
                .with_for_update()
                .execution_options(populate_existing=True)
            ).all()
        )

    def get_idempotency_record(
        self,
        *,
        doctor_id: uuid.UUID,
        patient_id: uuid.UUID,
        idempotency_key: uuid.UUID,
    ) -> CaseCreateIdempotencyKey | None:
        return self.db.scalar(
            select(CaseCreateIdempotencyKey).where(
                CaseCreateIdempotencyKey.doctor_id == doctor_id,
                CaseCreateIdempotencyKey.patient_id == patient_id,
                CaseCreateIdempotencyKey.idempotency_key == idempotency_key,
            )
        )

    def get_by_id_unfiltered(self, case_id: uuid.UUID) -> Case | None:
        return self.db.get(Case, case_id)

    def mark_idempotency_keys_deleted_for_case(self, case_id: uuid.UUID) -> None:
        self.db.execute(
            update(CaseCreateIdempotencyKey)
            .where(CaseCreateIdempotencyKey.case_id == case_id)
            .values(case_deleted=True)
        )

    def mark_idempotency_keys_deleted_for_patient(self, patient_id: uuid.UUID) -> None:
        self.db.execute(
            update(CaseCreateIdempotencyKey)
            .where(CaseCreateIdempotencyKey.patient_id == patient_id)
            .values(case_deleted=True)
        )

    def has_active_job(self, case_id: uuid.UUID) -> bool:
        """Check if an inference_jobs table exists and has queued/running jobs for this case."""
        reg = self.db.scalar(text("SELECT to_regclass('public.inference_jobs')"))
        if reg is None:
            return False
        count = self.db.scalar(
            text(
                "SELECT COUNT(1) FROM inference_jobs "
                "WHERE case_id = :case_id AND state IN ('queued', 'running')"
            ),
            {"case_id": case_id},
        )
        return bool(count and int(count) > 0)

    def has_locking_job(self, case_id: uuid.UUID) -> bool:
        """Check if case has any queued/running job or any job that has started execution."""
        reg = self.db.scalar(text("SELECT to_regclass('public.inference_jobs')"))
        if reg is None:
            return False
        count = self.db.scalar(
            text(
                "SELECT COUNT(1) FROM inference_jobs "
                "WHERE case_id = :case_id "
                "AND (state IN ('queued', 'running') OR attempt_count > 0)"
            ),
            {"case_id": case_id},
        )
        return bool(count and int(count) > 0)
