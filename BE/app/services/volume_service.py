"""Volume upload, geometry verification, quota enforcement, and deletion service."""

from __future__ import annotations

import contextlib
import ntpath
import posixpath
import uuid
from datetime import UTC, datetime

from fastapi import UploadFile
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.errors import AppError
from app.core.storage import LocalStorageAdapter
from app.models.case import Case
from app.models.stored_file import StoredFile
from app.models.volume import Volume
from app.repositories.audit_repo import AuditRepository
from app.repositories.case_repo import CaseRepository
from app.repositories.file_repo import FileRepository
from app.repositories.system_setting_repo import SystemSettingRepository
from app.repositories.volume_repo import VolumeRepository
from app.schemas.patient import DeletionStatusOut
from app.schemas.volume import VolumeModality, VolumeOut
from app.services.case_service import compute_case_inference_status
from app.services.stored_file_service import StoredFileService
from app.validators.nifti_validator import (
    VolumeGeometry,
    check_geometry_compatibility,
    check_model_profile,
    validate_and_stage_nifti_upload,
)

_GIB = 1024**3


def _as_utc_dt(value: datetime | None) -> datetime:
    if value is None:
        return datetime.min.replace(tzinfo=UTC)
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _extract_positive_int(raw: object) -> int | None:
    if isinstance(raw, int) and not isinstance(raw, bool) and raw > 0:
        return raw
    return None


def _extract_quota_bytes(value_json: object, fallback: int) -> int:
    opt = _extract_quota_bytes_opt(value_json)
    return opt if opt is not None else fallback


def _extract_quota_bytes_opt(value_json: object) -> int | None:
    direct = _extract_positive_int(value_json)
    if direct is not None:
        return direct
    if isinstance(value_json, dict):
        for key in ("bytes", "value"):
            cand = _extract_positive_int(value_json.get(key))
            if cand is not None:
                return cand
    return None


def resolve_effective_quotas(
    system_settings: SystemSettingRepository,
    settings: Settings,
) -> tuple[int, int]:
    """Read quotas from admin_settings (with legacy *_quota_bytes fallback) clamped to hard caps."""
    admin_row = system_settings.get_by_key("admin_settings")
    admin_values = (
        admin_row.value_json
        if admin_row is not None and isinstance(admin_row.value_json, dict)
        else {}
    )
    admin_ts = _as_utc_dt(admin_row.updated_at) if admin_row is not None else _as_utc_dt(None)

    admin_doc_gib = _extract_positive_int(admin_values.get("default_doctor_quota_gib"))
    admin_sys_gib = _extract_positive_int(admin_values.get("system_quota_gib"))
    admin_doc_bytes = admin_doc_gib * _GIB if admin_doc_gib is not None else None
    admin_sys_bytes = admin_sys_gib * _GIB if admin_sys_gib is not None else None

    doc_row = system_settings.get_by_key("doctor_quota_bytes")
    sys_row = system_settings.get_by_key("system_quota_bytes")
    legacy_doc_bytes = _extract_quota_bytes_opt(doc_row.value_json) if doc_row is not None else None
    legacy_sys_bytes = _extract_quota_bytes_opt(sys_row.value_json) if sys_row is not None else None

    if admin_doc_bytes is not None and legacy_doc_bytes is not None and doc_row is not None:
        doc_quota = (
            legacy_doc_bytes
            if _as_utc_dt(doc_row.updated_at) >= admin_ts
            else admin_doc_bytes
        )
    elif admin_doc_bytes is not None:
        doc_quota = admin_doc_bytes
    elif legacy_doc_bytes is not None:
        doc_quota = legacy_doc_bytes
    else:
        doc_quota = settings.DOCTOR_QUOTA_BYTES

    if admin_sys_bytes is not None and legacy_sys_bytes is not None and sys_row is not None:
        sys_quota = (
            legacy_sys_bytes
            if _as_utc_dt(sys_row.updated_at) >= admin_ts
            else admin_sys_bytes
        )
    elif admin_sys_bytes is not None:
        sys_quota = admin_sys_bytes
    elif legacy_sys_bytes is not None:
        sys_quota = legacy_sys_bytes
    else:
        sys_quota = settings.SYSTEM_QUOTA_BYTES

    return min(doc_quota, settings.DOCTOR_QUOTA_BYTES), min(
        sys_quota, settings.SYSTEM_QUOTA_BYTES
    )


def _select_reference_volume_id(active_volumes: list[Volume]) -> uuid.UUID | None:
    flair = next((v for v in active_volumes if v.modality == "flair"), None)
    if flair is not None:
        return flair.id
    t1ce = next((v for v in active_volumes if v.modality == "t1ce"), None)
    if t1ce is not None:
        return t1ce.id
    return None


def _sanitize_upload_filename(raw_name: str | None) -> str:
    """Strip paths and control characters while keeping a safe display filename."""
    if not raw_name:
        return "volume.nii.gz"
    cleaned = "".join(ch for ch in raw_name if ord(ch) >= 32 and ch != "\x7f")
    base = ntpath.basename(posixpath.basename(cleaned)).strip()
    if not base or base in {".", ".."}:
        return "volume.nii.gz"
    return base[:255]


class VolumeService:
    """Service layer for Case NIfTI Volume upload, listing, and deletion."""

    def __init__(
        self,
        db: Session,
        storage: LocalStorageAdapter,
        settings: Settings,
    ) -> None:
        self.db = db
        self.storage = storage
        self.settings = settings
        self.cases = CaseRepository(db)
        self.volumes = VolumeRepository(db)
        self.files = FileRepository(db)
        self.system_settings = SystemSettingRepository(db)
        self.audits = AuditRepository(db)

    def _to_volume_out(self, vol: Volume, *, filename: str | None = None) -> VolumeOut:
        compatible, warnings = check_model_profile(
            shape=[int(v) for v in vol.shape],
            spacing_mm=[float(v) for v in vol.spacing_mm],
            affine=[[float(c) for c in row] for row in vol.affine],
            orientation=vol.orientation,
            manifest_path=self.settings.MODEL_MANIFEST_PATH,
        )
        return VolumeOut.model_validate(vol).model_copy(
            update={
                "filename": filename,
                "model_profile_compatible": compatible,
                "model_profile_warnings": warnings,
            }
        )

    def _assert_inputs_unlocked(self, case: Case) -> None:
        if (
            case.inputs_locked_at is not None
            or case.latest_mask_version_id is not None
            or self.cases.has_locking_job(case.id)
        ):
            raise AppError(
                status_code=409,
                code="inputs_locked",
                message="Ca chụp đã khóa dữ liệu đầu vào (đã có job hoặc mask).",
            )

    def list_volumes(self, *, doctor_id: uuid.UUID, case_id: uuid.UUID) -> list[VolumeOut]:
        case = self.cases.get_active_for_owner(case_id, doctor_id)
        if case is None:
            raise AppError(
                status_code=404,
                code="case_not_found",
                message="Không tìm thấy ca chụp.",
            )
        rows = self.volumes.list_active_with_filenames_for_case(case.id)
        return [self._to_volume_out(vol, filename=fname) for vol, fname in rows]

    def _effective_quotas(self) -> tuple[int, int]:
        return resolve_effective_quotas(self.system_settings, self.settings)

    def _effective_upload_limits(self) -> tuple[int, int]:
        row = self.system_settings.get_by_key("admin_settings")
        values = row.value_json if row is not None else {}
        max_upload_mib = values.get("max_upload_mib") if isinstance(values, dict) else None
        max_decompressed_mib = (
            values.get("max_decompressed_mib") if isinstance(values, dict) else None
        )
        upload_bytes = (
            int(max_upload_mib) * 1024 * 1024
            if isinstance(max_upload_mib, int) and max_upload_mib > 0
            else self.settings.MAX_UPLOAD_BYTES
        )
        decompressed_bytes = (
            int(max_decompressed_mib) * 1024 * 1024
            if isinstance(max_decompressed_mib, int) and max_decompressed_mib > 0
            else self.settings.MAX_DECOMPRESSED_BYTES
        )
        return min(upload_bytes, self.settings.MAX_UPLOAD_BYTES), min(
            decompressed_bytes, self.settings.MAX_DECOMPRESSED_BYTES
        )

    async def upload_volume(
        self,
        *,
        doctor_id: uuid.UUID,
        case_id: uuid.UUID,
        modality: VolumeModality,
        file: UploadFile,
        request_id: str,
        ip_address: str,
    ) -> VolumeOut:
        case = self.cases.get_active_for_owner(case_id, doctor_id)
        if case is None:
            raise AppError(
                status_code=404,
                code="case_not_found",
                message="Không tìm thấy ca chụp.",
            )

        self._assert_inputs_unlocked(case)

        if self.volumes.get_active_by_modality(case.id, modality) is not None:
            raise AppError(
                status_code=409,
                code="modality_exists",
                message=(
                    f"Ca chụp đã có xung {modality.upper()}. "
                    "Vui lòng xóa xung cũ trước khi tải lên lại."
                ),
            )

        # Release DB transaction/connection before slow streaming & NIfTI validation
        self.db.rollback()

        max_upload_bytes, max_decompressed_bytes = self._effective_upload_limits()
        self.db.rollback()
        validated = await validate_and_stage_nifti_upload(
            upload=file,
            storage=self.storage,
            max_upload_bytes=max_upload_bytes,
            max_decompressed_bytes=max_decompressed_bytes,
        )

        staging_key = validated.staged_file.staging_key
        committed_key: str | None = None
        committed_to_db = False
        volume: Volume | None = None
        try:
            # Lock the case row before checking state, sibling geometry, or committing
            locked_case = self.cases.get_active_for_owner_for_update(case_id, doctor_id)
            if locked_case is None:
                raise AppError(
                    status_code=404,
                    code="case_not_found",
                    message="Không tìm thấy ca chụp.",
                )
            self._assert_inputs_unlocked(locked_case)
            if self.volumes.get_active_by_modality(locked_case.id, modality) is not None:
                raise AppError(
                    status_code=409,
                    code="modality_exists",
                    message=(
                        f"Ca chụp đã có xung {modality.upper()}. "
                        "Vui lòng xóa xung cũ trước khi tải lên lại."
                    ),
                )

            existing_volumes = self.volumes.list_active_for_case(locked_case.id)
            if existing_volumes:
                sibling = existing_volumes[0]
                check_geometry_compatibility(
                    VolumeGeometry(
                        shape=[int(v) for v in sibling.shape],
                        spacing_mm=[float(v) for v in sibling.spacing_mm],
                        affine=[[float(c) for c in row] for row in sibling.affine],
                    ),
                    VolumeGeometry(
                        shape=validated.shape,
                        spacing_mm=validated.spacing_mm,
                        affine=validated.affine,
                    ),
                )

            # Atomic quota check under DB transaction locks
            self.files.acquire_quota_locks(doctor_id)
            doc_quota, sys_quota = self._effective_quotas()
            owner_used, system_used = self.files.get_committed_usage_bytes(doctor_id)
            if owner_used + validated.size_bytes > doc_quota:
                raise AppError(
                    status_code=413,
                    code="storage_quota_exceeded",
                    message="Dung lượng lưu trữ của bác sĩ đã vượt quá hạn mức.",
                )
            if system_used + validated.size_bytes > sys_quota:
                raise AppError(
                    status_code=413,
                    code="storage_quota_exceeded",
                    message="Dung lượng lưu trữ toàn hệ thống đã đạt giới hạn.",
                )

            stored_obj = self.storage.commit(staging_key)
            committed_key = stored_obj.storage_key

            safe_orig_name = _sanitize_upload_filename(file.filename)
            stored_file = StoredFile(
                storage_key=uuid.UUID(committed_key),
                original_name=safe_orig_name,
                size_bytes=validated.size_bytes,
                sha256=validated.sha256,
                media_type=validated.media_type,
                state="committed",
                owner_id=doctor_id,
            )
            self.db.add(stored_file)
            self.db.flush()

            volume = Volume(
                case_id=locked_case.id,
                modality=modality,
                file_id=stored_file.id,
                shape=validated.shape,
                spacing_mm=validated.spacing_mm,
                affine=validated.affine,
                orientation=validated.orientation,
                datatype=validated.datatype,
                size_bytes=validated.size_bytes,
                sha256=validated.sha256,
                validation_status="valid",
                validation_errors=[],
            )
            self.db.add(volume)
            try:
                self.db.flush()
            except IntegrityError as exc:
                raise AppError(
                    status_code=409,
                    code="modality_exists",
                    message=f"Ca chụp đã có xung {modality.upper()}.",
                ) from exc

            all_volumes = [*existing_volumes, volume]
            if locked_case.inputs_locked_at is None and locked_case.latest_mask_version_id is None:
                locked_case.reference_volume_id = _select_reference_volume_id(all_volumes)
            locked_case.input_revision += 1
            readiness, _, _ = compute_case_inference_status(
                all_volumes,
                manifest_path=self.settings.MODEL_MANIFEST_PATH,
            )
            locked_case.readiness = readiness

            self.audits.record_event(
                actor_type="user",
                actor_id=doctor_id,
                action="volume_uploaded",
                resource_type="volume",
                resource_id=str(volume.id),
                outcome="success",
                request_id=request_id,
                ip_address=ip_address,
                safe_diff={
                    "case_id": str(locked_case.id),
                    "modality": modality,
                    "size_bytes": validated.size_bytes,
                    "shape": validated.shape,
                },
            )
            result_out = self._to_volume_out(volume, filename=safe_orig_name)
            self.db.commit()
            committed_to_db = True
            return result_out
        except Exception:
            if not committed_to_db:
                rollback_ok = False
                try:
                    self.db.rollback()
                    rollback_ok = True
                except Exception:
                    pass
                if committed_key is not None:
                    if volume is None:
                        with contextlib.suppress(OSError):
                            self.storage.delete(committed_key)
                    elif rollback_ok:
                        vol_id = volume.id
                        should_delete = False
                        try:
                            self.db.expunge_all()
                            persisted_vol = self.db.get(Volume, vol_id) if vol_id else None
                            should_delete = persisted_vol is None
                            self.db.rollback()
                        except Exception:
                            with contextlib.suppress(Exception):
                                self.db.rollback()
                            should_delete = False
                        if should_delete:
                            with contextlib.suppress(OSError):
                                self.storage.delete(committed_key)
            raise
        finally:
            staging_path = self.storage.staging_root / staging_key
            staging_path.unlink(missing_ok=True)

    def delete_volume(
        self,
        *,
        doctor_id: uuid.UUID,
        case_id: uuid.UUID,
        volume_id: uuid.UUID,
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

        self._assert_inputs_unlocked(case)

        volume = self.volumes.get_active_in_case(case.id, volume_id)
        if volume is None:
            raise AppError(
                status_code=404,
                code="volume_not_found",
                message="Không tìm thấy volume.",
            )

        now = datetime.now(UTC)
        volume.deleted_at = now
        stored_files = list(
            self.db.scalars(
                select(StoredFile)
                .where(StoredFile.id == volume.file_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            ).all()
        )
        pending_files: list[StoredFile] = []
        for sf in stored_files:
            if sf.state != "deleted":
                sf.state = "deleting"
                sf.original_name = f"deleted-{sf.id}"
                pending_files.append(sf)

        remaining = [v for v in self.volumes.list_active_for_case(case.id) if v.id != volume.id]
        case.reference_volume_id = _select_reference_volume_id(remaining)
        case.input_revision += 1
        readiness, _, _ = compute_case_inference_status(
            remaining,
            manifest_path=self.settings.MODEL_MANIFEST_PATH,
        )
        case.readiness = readiness
        self.db.commit()

        cleaned = StoredFileService(self.db, self.storage).cleanup_deleting_files(
            files=pending_files, now=now
        )
        all_cleaned = all(sf.state == "deleted" for sf in stored_files)

        self.audits.record_event(
            actor_type="user",
            actor_id=doctor_id,
            action="volume_deleted",
            resource_type="volume",
            resource_id=str(volume.id),
            outcome="success",
            request_id=request_id,
            ip_address=ip_address,
            safe_diff={
                "case_id": str(case.id),
                "modality": volume.modality,
                "files_cleaned": cleaned,
            },
        )
        self.db.commit()

        return DeletionStatusOut(
            resource_type="volume",
            resource_id=volume.id,
            status="deleted" if all_cleaned else "deleting",
            files_cleaned=cleaned,
            message="Đã xóa volume và cập nhật trạng thái ca chụp.",
        )
