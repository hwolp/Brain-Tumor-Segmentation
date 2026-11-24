"""Case management and idempotent case creation business logic."""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, date, datetime
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.errors import AppError
from app.core.storage import LocalStorageAdapter
from app.models.case import Case, CaseCreateIdempotencyKey
from app.models.inference_job import InferenceJob
from app.models.patient import Patient
from app.models.stored_file import StoredFile
from app.models.volume import Volume
from app.repositories.audit_repo import AuditRepository
from app.repositories.case_repo import CaseRepository
from app.repositories.file_repo import FileRepository
from app.repositories.mask_version_repo import MaskVersionRepository
from app.repositories.patient_repo import PatientRepository
from app.repositories.volume_repo import VolumeRepository
from app.schemas.case import CaseCreateRequest, CaseOut, CaseUpdateRequest
from app.schemas.common import PaginatedResponse
from app.schemas.patient import DeletionStatusOut
from app.services.file_cleanup_service import cleanup_deleting_files
from app.services.nifti_validator import check_model_profile


def compute_case_request_digest(payload: CaseCreateRequest) -> str:
    """Compute canonical SHA-256 digest of validated case creation body."""
    canonical = json.dumps(
        {
            "study_date": payload.study_date.isoformat(),
            "notes": payload.notes,
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def compute_case_inference_status(
    active_volumes: list[Volume],
    *,
    manifest_path: Path | None = None,
) -> tuple[str, bool, list[str]]:
    """Compute case readiness, can_run_inference, and blocking_reasons from active volumes."""
    valid_by_modality = {
        vol.modality: vol for vol in active_volumes if vol.validation_status == "valid"
    }
    missing = [mod for mod in ("flair", "t1ce") if mod not in valid_by_modality]
    if missing:
        reasons = [f"Thiếu xung MRI {mod.upper()} hợp lệ." for mod in missing]
        return "missing_inputs", False, reasons

    warnings: list[str] = []
    for mod in ("flair", "t1ce"):
        vol = valid_by_modality[mod]
        compatible, mod_warnings = check_model_profile(
            shape=[int(v) for v in vol.shape],
            spacing_mm=[float(v) for v in vol.spacing_mm],
            affine=[[float(c) for c in row] for row in vol.affine],
            orientation=vol.orientation,
            manifest_path=manifest_path,
        )
        if not compatible:
            for item in mod_warnings:
                msg = f"{mod.upper()}: {item}"
                if msg not in warnings:
                    warnings.append(msg)

    if warnings:
        return "invalid", False, warnings
    return "ready", True, []


def build_case_out(
    case: Case,
    active_volumes: list[Volume],
    *,
    manifest_path: Path | None = None,
    patient_code: str | None = None,
) -> CaseOut:
    """Construct CaseOut with live readiness, can_run_inference, and blocking_reasons."""
    computed_readiness, can_run, blocking_reasons = compute_case_inference_status(
        active_volumes,
        manifest_path=manifest_path,
    )
    effective_readiness = (
        case.readiness if case.readiness == "validating" else computed_readiness
    )
    return CaseOut.model_validate(case).model_copy(
        update={
            "patient_code": patient_code,
            "readiness": effective_readiness,
            "can_run_inference": can_run,
            "blocking_reasons": blocking_reasons,
        }
    )


class CaseService:
    """Service layer for Case CRUD, idempotency, and safe deletion."""

    def __init__(
        self,
        db: Session,
        storage: LocalStorageAdapter,
        settings: Settings,
    ) -> None:
        self.db = db
        self.storage = storage
        self.settings = settings
        self.patients = PatientRepository(db)
        self.cases = CaseRepository(db)
        self.volumes = VolumeRepository(db)
        self.files = FileRepository(db)
        self.mask_versions = MaskVersionRepository(db)
        self.audits = AuditRepository(db)

    def _to_case_out(
        self,
        case: Case,
        *,
        patient_code: str | None = None,
    ) -> CaseOut:
        resolved_patient_code = (
            patient_code
            if patient_code is not None
            else self.db.scalar(
                select(Patient.patient_code).where(Patient.id == case.patient_id)
            )
        )
        vols = self.volumes.list_active_for_case(case.id)
        latest_job_state = self.db.scalar(
            select(InferenceJob.state)
            .where(InferenceJob.case_id == case.id)
            .order_by(InferenceJob.created_at.desc(), InferenceJob.id.desc())
            .limit(1)
        )
        return build_case_out(
            case,
            vols,
            manifest_path=self.settings.MODEL_MANIFEST_PATH,
            patient_code=resolved_patient_code,
        ).model_copy(
            update={
                "latest_job_state": latest_job_state,
                "is_inputs_locked": case.inputs_locked_at is not None
                or case.latest_mask_version_id is not None
                or self.cases.has_locking_job(case.id),
            }
        )

    def list_doctor_cases(
        self,
        *,
        doctor_id: uuid.UUID,
        page: int = 1,
        page_size: int = 20,
    ) -> PaginatedResponse[CaseOut]:
        rows, total = self.cases.list_for_owner_with_patient_code(
            owner_id=doctor_id,
            page=page,
            page_size=page_size,
        )
        items = [
            self._to_case_out(c, patient_code=pat_code) for c, pat_code in rows
        ]
        return PaginatedResponse[CaseOut](
            items=items,
            total=total,
            page=page,
            page_size=page_size,
        )

    def list_patient_cases(
        self,
        *,
        doctor_id: uuid.UUID,
        patient_id: uuid.UUID,
        page: int = 1,
        page_size: int = 20,
    ) -> PaginatedResponse[CaseOut]:
        patient = self.patients.get_active_for_owner(patient_id, doctor_id)
        if patient is None:
            raise AppError(
                status_code=404,
                code="patient_not_found",
                message="Không tìm thấy hồ sơ bệnh nhân.",
            )
        cases, total = self.cases.list_for_patient_owner(
            patient_id=patient.id,
            owner_id=doctor_id,
            page=page,
            page_size=page_size,
        )
        items = [
            self._to_case_out(c, patient_code=patient.patient_code)
            for c in cases
        ]
        return PaginatedResponse[CaseOut](
            items=items,
            total=total,
            page=page,
            page_size=page_size,
        )

    def create_case(
        self,
        *,
        doctor_id: uuid.UUID,
        patient_id: uuid.UUID,
        idempotency_key: uuid.UUID,
        payload: CaseCreateRequest,
        request_id: str,
        ip_address: str,
    ) -> CaseOut:
        # Check and lock patient row FIRST before looking up idempotency keys
        patient = self.patients.get_active_for_owner_for_update(patient_id, doctor_id)
        if patient is None:
            raise AppError(
                status_code=404,
                code="patient_not_found",
                message="Không tìm thấy hồ sơ bệnh nhân.",
            )

        digest = compute_case_request_digest(payload)
        existing = self.cases.get_idempotency_record(
            doctor_id=doctor_id,
            patient_id=patient.id,
            idempotency_key=idempotency_key,
        )
        if existing is not None:
            return self._resolve_existing_idempotency(existing, digest)

        new_case = Case(
            patient_id=patient.id,
            owner_id=doctor_id,
            study_date=payload.study_date,
            notes=payload.notes,
            readiness="missing_inputs",
            input_revision=0,
        )
        try:
            with self.db.begin_nested():
                self.db.add(new_case)
                self.db.flush()
                receipt = CaseCreateIdempotencyKey(
                    doctor_id=doctor_id,
                    patient_id=patient.id,
                    idempotency_key=idempotency_key,
                    request_digest=digest,
                    case_id=new_case.id,
                    case_deleted=False,
                )
                self.db.add(receipt)
                self.db.flush()

            self.audits.record_event(
                actor_type="user",
                actor_id=doctor_id,
                action="case_created",
                resource_type="case",
                resource_id=str(new_case.id),
                outcome="success",
                request_id=request_id,
                ip_address=ip_address,
                safe_diff={
                    "fields": ["study_date"] if payload.notes is None else ["study_date", "notes"]
                },
            )
            self.db.commit()
        except IntegrityError:
            self.db.rollback()
            raced = self.cases.get_idempotency_record(
                doctor_id=doctor_id,
                patient_id=patient.id,
                idempotency_key=idempotency_key,
            )
            if raced is None:
                raise
            return self._resolve_existing_idempotency(raced, digest)

        self.db.refresh(new_case)
        return self._to_case_out(new_case, patient_code=patient.patient_code)

    def _resolve_existing_idempotency(
        self,
        record: CaseCreateIdempotencyKey,
        digest: str,
    ) -> CaseOut:
        if record.request_digest != digest:
            raise AppError(
                status_code=409,
                code="idempotency_conflict",
                message="Khóa Idempotency-Key đã được dùng với nội dung khác.",
            )
        if record.case_deleted:
            raise AppError(
                status_code=409,
                code="case_deleted",
                message="Ca chụp gắn với Idempotency-Key này đã bị xóa.",
            )
        case = self.cases.get_by_id_unfiltered(record.case_id)
        if case is None or case.deleting_at is not None or case.deleted_at is not None:
            raise AppError(
                status_code=409,
                code="case_deleted",
                message="Ca chụp gắn với Idempotency-Key này đã bị xóa.",
            )
        return self._to_case_out(case)

    def get_case(self, *, doctor_id: uuid.UUID, case_id: uuid.UUID) -> CaseOut:
        case = self.cases.get_active_for_owner(case_id, doctor_id)
        if case is None:
            raise AppError(
                status_code=404,
                code="case_not_found",
                message="Không tìm thấy ca chụp.",
            )
        return self._to_case_out(case)

    def update_case(
        self,
        *,
        doctor_id: uuid.UUID,
        case_id: uuid.UUID,
        payload: CaseUpdateRequest,
        request_id: str,
        ip_address: str,
    ) -> CaseOut:
        case = self.cases.get_active_for_owner_for_update(case_id, doctor_id)
        if case is None:
            raise AppError(
                status_code=404,
                code="case_not_found",
                message="Không tìm thấy ca chụp.",
            )

        changed_fields: list[str] = []
        if payload.study_date is not None and payload.study_date != case.study_date:
            case.study_date = payload.study_date
            changed_fields.append("study_date")
        if "notes" in payload.model_fields_set and payload.notes != case.notes:
            case.notes = payload.notes
            changed_fields.append("notes")

        if changed_fields:
            self.audits.record_event(
                actor_type="user",
                actor_id=doctor_id,
                action="case_updated",
                resource_type="case",
                resource_id=str(case.id),
                outcome="success",
                request_id=request_id,
                ip_address=ip_address,
                safe_diff={"fields": changed_fields},
            )
        self.db.commit()
        self.db.refresh(case)
        return self._to_case_out(case)

    def delete_case(
        self,
        *,
        doctor_id: uuid.UUID,
        case_id: uuid.UUID,
        request_id: str,
        ip_address: str,
    ) -> DeletionStatusOut:
        case = self.cases.get_active_for_owner_for_update(case_id, doctor_id)
        if case is None:
            raise AppError(
                status_code=404,
                code="case_not_found",
                message="Không tìm thấy ca chụp.",
            )

        if self.cases.has_active_job(case.id):
            raise AppError(
                status_code=409,
                code="active_job_conflict",
                message="Không thể xóa ca chụp khi có tác vụ AI đang chờ hoặc đang chạy.",
            )

        now = datetime.now(UTC)
        case.deleting_at = now
        case.notes = None
        case.study_date = date(1900, 1, 1)
        case.latest_mask_version_id = None

        all_volumes = self.volumes.list_all_for_case(case.id)
        active_count = sum(1 for v in all_volumes if v.deleted_at is None)
        mask_file_ids = self.mask_versions.list_file_ids_for_cases([case.id])
        self.mask_versions.scrub_notes_for_cases([case.id])
        file_ids = list({v.file_id for v in all_volumes} | set(mask_file_ids))
        for vol in all_volumes:
            if vol.deleted_at is None:
                vol.deleted_at = now

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

        self.cases.mark_idempotency_keys_deleted_for_case(case.id)
        self.db.commit()

        cleaned = cleanup_deleting_files(self.db, self.storage, files=pending_files, now=now)
        all_cleaned = all(sf.state == "deleted" for sf in stored_files)
        if all_cleaned:
            case.deleted_at = now

        self.audits.record_event(
            actor_type="user",
            actor_id=doctor_id,
            action="case_deleted",
            resource_type="case",
            resource_id=str(case.id),
            outcome="success",
            request_id=request_id,
            ip_address=ip_address,
            safe_diff={
                "volumes_count": active_count,
                "files_cleaned": cleaned,
            },
        )
        self.db.commit()

        return DeletionStatusOut(
            resource_type="case",
            resource_id=case.id,
            status="deleted" if all_cleaned else "deleting",
            files_cleaned=cleaned,
            message="Đã xóa ca chụp và thu hồi quyền truy cập.",
        )
