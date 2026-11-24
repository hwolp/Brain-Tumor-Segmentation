"""Idempotent file cleanup service for deleting StoredFiles and expired staging orphans."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, date, datetime, timedelta

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core.storage import LocalStorageAdapter
from app.models.case import Case
from app.models.mask_version import MaskVersion
from app.models.patient import Patient
from app.models.stored_file import StoredFile
from app.models.volume import Volume
from app.repositories.file_repo import FileRepository
from app.repositories.session_repo import SessionRepository

logger = logging.getLogger(__name__)


def cleanup_deleting_files(
    db: Session,
    storage: LocalStorageAdapter,
    *,
    files: list[StoredFile] | None = None,
    now: datetime | None = None,
) -> int:
    """Delete physical objects for StoredFile rows in 'deleting' state and mark them 'deleted'."""
    ts = now if now is not None else datetime.now(UTC)
    target_files = files if files is not None else FileRepository(db).list_deleting_files()
    cleaned = 0
    for sf in target_files:
        if sf.state == "deleted":
            continue
        if sf.storage_key is not None:
            try:
                storage.delete(str(sf.storage_key))
            except Exception as exc:
                logger.warning(
                    "Failed to delete storage object during cleanup",
                    extra={"file_id": str(sf.id), "error_class": type(exc).__name__},
                )
                continue
        sf.state = "deleted"
        sf.deleted_at = ts
        cleaned += 1
    db.flush()
    return cleaned


def run_orphan_cleanup(
    db: Session,
    storage: LocalStorageAdapter,
    *,
    max_age_seconds: int = 86400,
    login_attempt_max_age_seconds: int | None = None,
    now: float | None = None,
) -> dict[str, int]:
    """Run idempotent cleanup for staging orphans, unreferenced objects, and 'deleting' files."""
    staging_removed = storage.cleanup_orphans(max_age_seconds=max_age_seconds, now=now)
    deleting_finalized = cleanup_deleting_files(db, storage)

    orphan_objects_removed = 0
    candidate_strs = storage.iter_object_keys_older_than(
        max_age_seconds=max_age_seconds,
        now=now,
    )
    if candidate_strs:
        candidate_uuids = [uuid.UUID(k) for k in candidate_strs]
        referenced = FileRepository(db).get_referenced_storage_keys(candidate_uuids)
        for key_uuid in candidate_uuids:
            if key_uuid not in referenced:
                if storage.delete(str(key_uuid)):
                    orphan_objects_removed += 1

    ref_dt = datetime.fromtimestamp(now, tz=UTC) if now is not None else datetime.now(UTC)
    effective_login_window = (
        login_attempt_max_age_seconds
        if login_attempt_max_age_seconds is not None
        else max_age_seconds
    )
    login_attempts_removed = SessionRepository(db).delete_expired_login_attempts(
        before=ref_dt - timedelta(seconds=effective_login_window)
    )

    return {
        "staging_orphans_removed": staging_removed,
        "deleting_files_finalized": deleting_finalized,
        "orphan_objects_removed": orphan_objects_removed,
        "deleting_cases_finalized": _finalize_deleting_cases_and_patients(db),
        "login_attempts_removed": login_attempts_removed,
    }


def _finalize_deleting_cases_and_patients(db: Session) -> int:
    """Finalize Case/Patient rows in 'deleting' state once all linked files are deleted."""
    now = datetime.now(UTC)
    finalized = 0

    pending_cases = list(
        db.scalars(
            select(Case).where(Case.deleting_at.is_not(None), Case.deleted_at.is_(None))
        ).all()
    )
    for case in pending_cases:
        pending_vol_file_id = db.scalar(
            select(StoredFile.id)
            .join(Volume, Volume.file_id == StoredFile.id)
            .where(Volume.case_id == case.id, StoredFile.state != "deleted")
        )
        pending_mask_file_id = db.scalar(
            select(StoredFile.id)
            .join(
                MaskVersion,
                or_(
                    MaskVersion.file_id == StoredFile.id,
                    MaskVersion.coverage_file_id == StoredFile.id,
                ),
            )
            .where(MaskVersion.case_id == case.id, StoredFile.state != "deleted")
        )
        if pending_vol_file_id is None and pending_mask_file_id is None:
            case.deleted_at = now
            case.notes = None
            case.study_date = date(1900, 1, 1)
            case.latest_mask_version_id = None
            finalized += 1

    db.flush()

    pending_patients = list(
        db.scalars(
            select(Patient).where(
                Patient.deleting_at.is_not(None), Patient.deleted_at.is_(None)
            )
        ).all()
    )
    for patient in pending_patients:
        open_case_id = db.scalar(
            select(Case.id).where(Case.patient_id == patient.id, Case.deleted_at.is_(None))
        )
        pending_vol_file_id = db.scalar(
            select(StoredFile.id)
            .join(Volume, Volume.file_id == StoredFile.id)
            .join(Case, Case.id == Volume.case_id)
            .where(Case.patient_id == patient.id, StoredFile.state != "deleted")
        )
        pending_mask_file_id = db.scalar(
            select(StoredFile.id)
            .join(
                MaskVersion,
                or_(
                    MaskVersion.file_id == StoredFile.id,
                    MaskVersion.coverage_file_id == StoredFile.id,
                ),
            )
            .join(Case, Case.id == MaskVersion.case_id)
            .where(Case.patient_id == patient.id, StoredFile.state != "deleted")
        )
        if open_case_id is None and pending_vol_file_id is None and pending_mask_file_id is None:
            patient.deleted_at = now
            patient.patient_code = f"deleted-{patient.id}"
            patient.full_name = "[deleted]"
            patient.birth_year = 1900
            patient.sex = "unknown"
            finalized += 1

    db.flush()
    return finalized
