"""Patient management business logic."""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import AppError
from app.core.storage import LocalStorageAdapter
from app.models.case import Case
from app.models.mask_version import MaskVersion
from app.models.patient import Patient
from app.models.stored_file import StoredFile
from app.repositories.audit_repo import AuditRepository
from app.repositories.case_repo import CaseRepository
from app.repositories.file_repo import FileRepository
from app.repositories.mask_version_repo import MaskVersionRepository
from app.repositories.patient_repo import PatientRepository
from app.repositories.volume_repo import VolumeRepository
from app.schemas.common import PaginatedResponse
from app.schemas.patient import (
    DeletionStatusOut,
    PatientCreateRequest,
    PatientOut,
    PatientUpdateRequest,
)
from app.services.file_cleanup_service import cleanup_deleting_files


class PatientService:
    """Service layer for doctor-scoped Patient CRUD and safe deletion."""

    def __init__(self, db: Session, storage: LocalStorageAdapter) -> None:
        self.db = db
        self.storage = storage
        self.patients = PatientRepository(db)
        self.cases = CaseRepository(db)
        self.volumes = VolumeRepository(db)
        self.files = FileRepository(db)
        self.mask_versions = MaskVersionRepository(db)
        self.audits = AuditRepository(db)

    def list_patients(
        self,
        *,
        doctor_id: uuid.UUID,
        q: str | None = None,
        page: int = 1,
        page_size: int = 20,
    ) -> PaginatedResponse[PatientOut]:
        rows, total = self.patients.list_for_owner(
            owner_id=doctor_id,
            q=q,
            page=page,
            page_size=page_size,
        )
        items = [
            PatientOut.model_validate(patient).model_copy(update={"case_count": case_count})
            for patient, case_count in rows
        ]
        return PaginatedResponse[PatientOut](
            items=items,
            total=total,
            page=page,
            page_size=page_size,
        )

    def create_patient(
        self,
        *,
        doctor_id: uuid.UUID,
        payload: PatientCreateRequest,
        request_id: str,
        ip_address: str,
    ) -> PatientOut:
        if self.patients.exists_active_code_for_owner(
            owner_id=doctor_id,
            patient_code=payload.patient_code,
        ):
            raise AppError(
                status_code=409,
                code="patient_code_exists",
                message="Mã bệnh nhân đã tồn tại trong danh sách của bạn.",
            )

        patient = Patient(
            owner_id=doctor_id,
            patient_code=payload.patient_code,
            full_name=payload.full_name,
            birth_year=payload.birth_year,
            sex=payload.sex,
        )
        self.db.add(patient)
        try:
            self.db.flush()
        except IntegrityError as exc:
            self.db.rollback()
            raise AppError(
                status_code=409,
                code="patient_code_exists",
                message="Mã bệnh nhân đã tồn tại trong danh sách của bạn.",
            ) from exc

        self.audits.record_event(
            actor_type="user",
            actor_id=doctor_id,
            action="patient_created",
            resource_type="patient",
            resource_id=str(patient.id),
            outcome="success",
            request_id=request_id,
            ip_address=ip_address,
            safe_diff={"fields": ["patient_code", "full_name", "birth_year", "sex"]},
        )
        self.db.commit()
        self.db.refresh(patient)
        return PatientOut.model_validate(patient).model_copy(update={"case_count": 0})

    def get_patient(self, *, doctor_id: uuid.UUID, patient_id: uuid.UUID) -> PatientOut:
        patient = self.patients.get_active_for_owner(patient_id, doctor_id)
        if patient is None:
            raise AppError(
                status_code=404,
                code="patient_not_found",
                message="Không tìm thấy hồ sơ bệnh nhân.",
            )
        case_count = self.patients.count_active_cases(patient.id)
        return PatientOut.model_validate(patient).model_copy(update={"case_count": case_count})

    def update_patient(
        self,
        *,
        doctor_id: uuid.UUID,
        patient_id: uuid.UUID,
        payload: PatientUpdateRequest,
        request_id: str,
        ip_address: str,
    ) -> PatientOut:
        patient = self.patients.get_active_for_owner_for_update(patient_id, doctor_id)
        if patient is None:
            raise AppError(
                status_code=404,
                code="patient_not_found",
                message="Không tìm thấy hồ sơ bệnh nhân.",
            )

        changed_fields: list[str] = []
        if payload.patient_code is not None and payload.patient_code != patient.patient_code:
            if self.patients.exists_active_code_for_owner(
                owner_id=doctor_id,
                patient_code=payload.patient_code,
                exclude_patient_id=patient.id,
            ):
                raise AppError(
                    status_code=409,
                    code="patient_code_exists",
                    message="Mã bệnh nhân đã tồn tại trong danh sách của bạn.",
                )
            patient.patient_code = payload.patient_code
            changed_fields.append("patient_code")

        if payload.full_name is not None and payload.full_name != patient.full_name:
            patient.full_name = payload.full_name
            changed_fields.append("full_name")
        if payload.birth_year is not None and payload.birth_year != patient.birth_year:
            patient.birth_year = payload.birth_year
            changed_fields.append("birth_year")
        if payload.sex is not None and payload.sex != patient.sex:
            patient.sex = payload.sex
            changed_fields.append("sex")

        try:
            self.db.flush()
        except IntegrityError as exc:
            self.db.rollback()
            raise AppError(
                status_code=409,
                code="patient_code_exists",
                message="Mã bệnh nhân đã tồn tại trong danh sách của bạn.",
            ) from exc

        if changed_fields:
            self.audits.record_event(
                actor_type="user",
                actor_id=doctor_id,
                action="patient_updated",
                resource_type="patient",
                resource_id=str(patient.id),
                outcome="success",
                request_id=request_id,
                ip_address=ip_address,
                safe_diff={"fields": changed_fields},
            )
        self.db.commit()
        self.db.refresh(patient)
        case_count = self.patients.count_active_cases(patient.id)
        return PatientOut.model_validate(patient).model_copy(update={"case_count": case_count})

    def delete_patient(
        self,
        *,
        doctor_id: uuid.UUID,
        patient_id: uuid.UUID,
        request_id: str,
        ip_address: str,
    ) -> DeletionStatusOut:
        patient = self.patients.get_active_for_owner_for_update(patient_id, doctor_id)
        if patient is None:
            raise AppError(
                status_code=404,
                code="patient_not_found",
                message="Không tìm thấy hồ sơ bệnh nhân.",
            )

        non_deleted_cases = list(
            self.db.scalars(
                select(Case)
                .where(Case.patient_id == patient.id, Case.deleted_at.is_(None))
                .order_by(Case.id.asc())
                .with_for_update()
                .execution_options(populate_existing=True)
            ).all()
        )
        active_cases = [c for c in non_deleted_cases if c.deleting_at is None]
        for case in non_deleted_cases:
            if self.cases.has_active_job(case.id):
                raise AppError(
                    status_code=409,
                    code="active_job_conflict",
                    message="Không thể xóa hồ sơ khi có tác vụ AI đang chờ hoặc đang chạy.",
                )

        now = datetime.now(UTC)
        patient.deleting_at = now
        patient.patient_code = f"deleted-{patient.id}"
        patient.full_name = "[deleted]"
        patient.birth_year = 1900
        patient.sex = "unknown"

        all_patient_cases = list(
            self.db.scalars(
                select(Case).where(Case.patient_id == patient.id).order_by(Case.id.asc())
            ).all()
        )
        case_ids = [c.id for c in all_patient_cases]
        for case in all_patient_cases:
            if case.deleting_at is None:
                case.deleting_at = now
            case.notes = None
            case.study_date = date(1900, 1, 1)
            case.latest_mask_version_id = None

        all_volumes = self.volumes.list_all_for_cases(case_ids)
        active_volumes_count = sum(1 for v in all_volumes if v.deleted_at is None)
        case_file_ids: dict[uuid.UUID, set[uuid.UUID]] = {cid: set() for cid in case_ids}
        for vol in all_volumes:
            case_file_ids.setdefault(vol.case_id, set()).add(vol.file_id)
            if vol.deleted_at is None:
                vol.deleted_at = now

        mask_file_ids: set[uuid.UUID] = set()
        if case_ids:
            mask_rows = self.db.execute(
                select(
                    MaskVersion.case_id,
                    MaskVersion.file_id,
                    MaskVersion.coverage_file_id,
                ).where(MaskVersion.case_id.in_(case_ids))
            ).all()
            for m_case_id, m_file_id, m_cov_id in mask_rows:
                bucket = case_file_ids.setdefault(m_case_id, set())
                if m_file_id is not None:
                    bucket.add(m_file_id)
                    mask_file_ids.add(m_file_id)
                if m_cov_id is not None:
                    bucket.add(m_cov_id)
                    mask_file_ids.add(m_cov_id)
        self.mask_versions.scrub_notes_for_cases(case_ids)
        file_ids = list({v.file_id for v in all_volumes} | mask_file_ids)

        stored_files = (
            list(
                self.db.scalars(
                    select(StoredFile)
                    .where(StoredFile.id.in_(file_ids))
                    .order_by(StoredFile.id.asc())
                    .with_for_update()
                    .execution_options(populate_existing=True)
                ).all()
            )
            if file_ids
            else []
        )
        pending_files: list[StoredFile] = []
        for sf in stored_files:
            if sf.state != "deleted":
                sf.state = "deleting"
                sf.original_name = f"deleted-{sf.id}"
                pending_files.append(sf)

        self.cases.mark_idempotency_keys_deleted_for_patient(patient.id)
        self.db.commit()

        cleaned = cleanup_deleting_files(self.db, self.storage, files=pending_files, now=now)
        sf_by_id = {sf.id: sf for sf in stored_files}
        for case in all_patient_cases:
            if case.deleted_at is None:
                c_fids = case_file_ids.get(case.id, set())
                if all(sf_by_id[fid].state == "deleted" for fid in c_fids if fid in sf_by_id):
                    case.deleted_at = now
        all_cleaned = all(sf.state == "deleted" for sf in stored_files)
        if all_cleaned:
            patient.deleted_at = now
        self.audits.record_event(
            actor_type="user",
            actor_id=doctor_id,
            action="patient_deleted",
            resource_type="patient",
            resource_id=str(patient.id),
            outcome="success",
            request_id=request_id,
            ip_address=ip_address,
            safe_diff={
                "cases_count": len(active_cases),
                "volumes_count": active_volumes_count,
                "files_cleaned": cleaned,
            },
        )
        self.db.commit()

        return DeletionStatusOut(
            resource_type="patient",
            resource_id=patient.id,
            status="deleted" if all_cleaned else "deleting",
            files_cleaned=cleaned,
            message="Đã xóa hồ sơ bệnh nhân và thu hồi quyền truy cập.",
        )
