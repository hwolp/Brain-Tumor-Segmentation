"""StoredFile repository with atomic quota locking."""

from __future__ import annotations

import uuid

from sqlalchemy import func, or_, select, text
from sqlalchemy.orm import Session

from app.models.case import Case
from app.models.mask_version import MaskVersion
from app.models.patient import Patient
from app.models.stored_file import StoredFile
from app.models.user import User
from app.models.volume import Volume

_SYSTEM_QUOTA_ADVISORY_LOCK_ID = 700001


class FileRepository:
    """Data access helpers for StoredFile records and quota enforcement."""

    def __init__(self, db: Session) -> None:
        self.db = db

    def acquire_quota_locks(self, owner_id: uuid.UUID) -> None:
        """Acquire deterministic system advisory lock and owner row lock for quota checks."""
        self.db.execute(
            text("SELECT pg_advisory_xact_lock(:lock_id)"),
            {"lock_id": _SYSTEM_QUOTA_ADVISORY_LOCK_ID},
        )
        self.db.scalar(select(User.id).where(User.id == owner_id).with_for_update())

    def get_committed_usage_bytes(self, owner_id: uuid.UUID) -> tuple[int, int]:
        """Return (owner_used_bytes, system_used_bytes) including 'committed' and 'deleting'."""
        owner_bytes = self.db.scalar(
            select(func.coalesce(func.sum(StoredFile.size_bytes), 0)).where(
                StoredFile.owner_id == owner_id,
                StoredFile.state.in_(("committed", "deleting")),
            )
        )
        system_bytes = self.db.scalar(
            select(func.coalesce(func.sum(StoredFile.size_bytes), 0)).where(
                StoredFile.state.in_(("committed", "deleting")),
            )
        )
        return int(owner_bytes or 0), int(system_bytes or 0)

    def get_committed_for_owner(
        self, file_id: uuid.UUID, owner_id: uuid.UUID
    ) -> StoredFile | None:
        """Return committed StoredFile if owned and not linked to a deleting/deleted resource."""
        sf = self.db.scalar(
            select(StoredFile).where(
                StoredFile.id == file_id,
                StoredFile.owner_id == owner_id,
                StoredFile.state == "committed",
                StoredFile.deleted_at.is_(None),
            )
        )
        if sf is None:
            return None

        # Ensure any associated volume or mask version (and its case/patient) is still active
        active_vol = self.db.scalar(
            select(Volume.id)
            .join(Case, Case.id == Volume.case_id)
            .join(Patient, Patient.id == Case.patient_id)
            .where(
                Volume.file_id == sf.id,
                Volume.deleted_at.is_(None),
                Case.deleting_at.is_(None),
                Case.deleted_at.is_(None),
                Patient.deleting_at.is_(None),
                Patient.deleted_at.is_(None),
            )
        )
        if active_vol is not None:
            return sf

        active_mask = self.db.scalar(
            select(MaskVersion.id)
            .join(Case, Case.id == MaskVersion.case_id)
            .join(Patient, Patient.id == Case.patient_id)
            .where(
                or_(MaskVersion.file_id == sf.id, MaskVersion.coverage_file_id == sf.id),
                Case.deleting_at.is_(None),
                Case.deleted_at.is_(None),
                Patient.deleting_at.is_(None),
                Patient.deleted_at.is_(None),
            )
        )
        if active_mask is not None:
            return sf
        return None

    def list_by_ids(self, file_ids: list[uuid.UUID]) -> list[StoredFile]:
        if not file_ids:
            return []
        return list(
            self.db.scalars(select(StoredFile).where(StoredFile.id.in_(file_ids))).all()
        )

    def list_deleting_files(self) -> list[StoredFile]:
        return list(
            self.db.scalars(select(StoredFile).where(StoredFile.state == "deleting")).all()
        )

    def get_referenced_storage_keys(self, candidate_keys: list[uuid.UUID]) -> set[uuid.UUID]:
        """Return subset of candidate storage keys referenced by non-deleted StoredFile rows."""
        if not candidate_keys:
            return set()
        referenced: set[uuid.UUID] = set()
        batch_size = 1000
        for start in range(0, len(candidate_keys), batch_size):
            batch = candidate_keys[start : start + batch_size]
            rows = self.db.scalars(
                select(StoredFile.storage_key).where(
                    StoredFile.storage_key.in_(batch),
                    StoredFile.state != "deleted",
                )
            ).all()
            referenced.update(k for k in rows if k is not None)
        return referenced
