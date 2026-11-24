"""MaskVersion validation, canonicalization, physical volume stats, and idempotent save."""

from __future__ import annotations

import contextlib
import gzip
import hashlib
import io
import json
import math
import os
import shutil
import tempfile
import uuid
import zlib
from dataclasses import dataclass
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path
from typing import Any

import nibabel as nib
import numpy as np
from fastapi import UploadFile
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.errors import AppError
from app.core.storage import LocalStorageAdapter
from app.models.mask_version import MaskSaveIdempotencyKey, MaskVersion
from app.models.stored_file import StoredFile
from app.repositories.audit_repo import AuditRepository
from app.repositories.case_repo import CaseRepository
from app.repositories.file_repo import FileRepository
from app.repositories.mask_version_repo import MaskVersionRepository
from app.repositories.system_setting_repo import SystemSettingRepository
from app.repositories.user_repo import UserRepository
from app.repositories.volume_repo import VolumeRepository
from app.schemas.common import PaginatedResponse
from app.schemas.mask_version import (
    MaskCompositeStatOut,
    MaskCoverageOut,
    MaskGeometryOut,
    MaskLabelStatOut,
    MaskMetadataExportOut,
    MaskStatisticsOut,
    MaskVersionOut,
)
from app.services.nifti_validator import (
    _NIFTI_HEADER_ERRORS,
    DEFAULT_MAX_DECOMPRESSED_BYTES,
    DEFAULT_MAX_UPLOAD_BYTES,
    _decompress_gzip_bounded,
    _detect_nifti_extension,
    _probe_single_file_nifti_class,
    _stream_upload_to_staging,
    extract_valid_orientation,
)
from app.services.volume_service import resolve_effective_quotas

_SPATIAL_UNIT_SCALE_TO_MM: dict[str, float] = {
    "mm": 1.0,
    "meter": 1000.0,
    "micron": 0.001,
    "unknown": 1.0,
}
_VALID_MASK_LABELS = (0, 1, 2, 4)
_DEFAULT_MANIFEST_PATH = Path(__file__).resolve().parents[2] / "worker" / "manifest.json"
_DEFAULT_BRATS_LABELS: dict[str, str] = {
    "0": "background",
    "1": "NCR/NET",
    "2": "ED",
    "4": "ET",
}


@dataclass(frozen=True, slots=True)
class CanonicalMaskResult:
    """Validated and canonicalized uint8 .nii.gz mask artifact and voxel counts."""

    canonical_nii_gz_path: Path
    size_bytes: int
    sha256: str
    label_voxel_counts: dict[str, int]


@lru_cache(maxsize=4)
def _load_manifest_labels(manifest_path_str: str) -> dict[str, str]:
    path = Path(manifest_path_str)
    if not path.is_file():
        return dict(_DEFAULT_BRATS_LABELS)
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, ValueError, TypeError):
        return dict(_DEFAULT_BRATS_LABELS)
    labels = data.get("class_mapping", {}).get("labels") if isinstance(data, dict) else None
    if isinstance(labels, dict) and labels:
        return {str(k): str(v) for k, v in labels.items()}
    return dict(_DEFAULT_BRATS_LABELS)


def compute_mask_statistics(
    *,
    label_voxel_counts: dict[str, int],
    affine_mm: list[list[float]],
) -> dict[str, Any]:
    """Compute physical volume statistics in mm^3 and mL from voxel counts and affine_mm."""
    affine_arr = np.asarray(affine_mm, dtype=np.float64)
    voxel_volume_mm3 = abs(float(np.linalg.det(affine_arr[:3, :3])))

    c1 = int(label_voxel_counts.get("1", 0))
    c2 = int(label_voxel_counts.get("2", 0))
    c4 = int(label_voxel_counts.get("4", 0))

    label_volumes_mm3 = {
        "1": float(c1 * voxel_volume_mm3),
        "2": float(c2 * voxel_volume_mm3),
        "4": float(c4 * voxel_volume_mm3),
    }
    composite_volumes_mm3 = {
        "WT": float((c1 + c2 + c4) * voxel_volume_mm3),
        "TC": float((c1 + c4) * voxel_volume_mm3),
        "ET": float(c4 * voxel_volume_mm3),
    }
    total_fg_voxels = c1 + c2 + c4
    total_fg_mm3 = float(total_fg_voxels * voxel_volume_mm3)
    total_fg_ml = total_fg_mm3 / 1000.0

    return {
        "voxel_volume_mm3": voxel_volume_mm3,
        "label_volumes_mm3": label_volumes_mm3,
        "composite_volumes_mm3": composite_volumes_mm3,
        "total_foreground_voxels": total_fg_voxels,
        "total_foreground_volume_mm3": total_fg_mm3,
        "total_foreground_volume_ml": total_fg_ml,
    }


def validate_and_canonicalize_mask(
    *,
    file_path: Path,
    is_gzip: bool,
    ref_shape: list[int],
    ref_spacing_mm: list[float],
    ref_affine_mm: list[list[float]],
    max_decompressed_bytes: int = DEFAULT_MAX_DECOMPRESSED_BYTES,
    tol_mm: float = 1e-4,
    temp_dir: Path | None = None,
) -> CanonicalMaskResult:
    """Validate a 3D NIfTI mask against reference geometry and serialize canonical uint8 .nii.gz."""
    temp_decomp: Path | None = None
    inspect_path = file_path
    if is_gzip:
        temp_decomp = _decompress_gzip_bounded(
            file_path,
            max_decompressed_bytes=max_decompressed_bytes,
            temp_dir=temp_dir,
        )
        inspect_path = temp_decomp

    try:
        image_cls = _probe_single_file_nifti_class(inspect_path)

        with open(inspect_path, "rb") as fh_obj:
            fh = nib.FileHolder(fileobj=fh_obj)
            file_map = {"header": fh, "image": fh}
            try:
                img = image_cls.from_file_map(file_map, mmap=False)
            except _NIFTI_HEADER_ERRORS as exc:
                raise AppError(
                    status_code=422,
                    code="invalid_nifti",
                    message="Không thể đọc header mask NIfTI hợp lệ.",
                ) from exc

            try:
                try:
                    shape = [int(dim) for dim in img.shape]
                    if len(shape) != 3 or any(dim <= 0 for dim in shape):
                        raise AppError(
                            status_code=422,
                            code="invalid_nifti",
                            message="Chỉ chấp nhận mask NIfTI scalar 3D.",
                        )

                    dtype = img.get_data_dtype()
                    if dtype.fields is not None or dtype.kind not in {"i", "u", "f"}:
                        raise AppError(
                            status_code=422,
                            code="invalid_mask_labels",
                            message="Mask chỉ chấp nhận dữ liệu số nguyên nhãn {0, 1, 2, 4}.",
                        )

                    spatial_unit, _ = img.header.get_xyzt_units()
                    unit_scale = _SPATIAL_UNIT_SCALE_TO_MM.get(str(spatial_unit))
                    if unit_scale is None:
                        raise AppError(
                            status_code=422,
                            code="invalid_nifti",
                            message=(
                                "Đơn vị không gian NIfTI không xác định hoặc không được hỗ trợ."
                            ),
                        )

                    qform_raw, qcode = img.header.get_qform(coded=True)
                    sform_raw, scode = img.header.get_sform(coded=True)
                    qcode_int = int(qcode)
                    scode_int = int(scode)
                    if qcode_int < 0 or scode_int < 0:
                        raise AppError(
                            status_code=422,
                            code="invalid_nifti",
                            message="Mã qform_code/sform_code của mask NIfTI không hợp lệ.",
                        )
                    if qcode_int == 0 and scode_int == 0:
                        raise AppError(
                            status_code=422,
                            code="invalid_nifti",
                            message="Mask NIfTI thiếu hệ tọa độ không gian vật lý (qform/sform).",
                        )

                    raw_vox_offset = int(img.header.get_data_offset())
                    single_vox_offset = int(img.header.single_vox_offset)
                except AppError:
                    raise
                except _NIFTI_HEADER_ERRORS as exc:
                    raise AppError(
                        status_code=422,
                        code="invalid_nifti",
                        message="Header mask NIfTI chứa trường dữ liệu không hợp lệ hoặc bị hỏng.",
                    ) from exc

                qform_mm: np.ndarray | None = None
                if qcode_int > 0 and qform_raw is not None:
                    qform_mm = np.array(qform_raw, dtype=np.float64, copy=True)
                    qform_mm[:3, :] *= unit_scale

                sform_mm: np.ndarray | None = None
                if scode_int > 0 and sform_raw is not None:
                    sform_mm = np.array(sform_raw, dtype=np.float64, copy=True)
                    sform_mm[:3, :] *= unit_scale

                if qform_mm is not None and sform_mm is not None:
                    if not np.allclose(qform_mm, sform_mm, rtol=0.0, atol=1e-2):
                        raise AppError(
                            status_code=422,
                            code="geometry_mismatch",
                            message="Ma trận qform và sform của mask mâu thuẫn đáng kể.",
                        )

                affine_mm = sform_mm if sform_mm is not None else qform_mm
                if (
                    affine_mm is None
                    or affine_mm.shape != (4, 4)
                    or not np.isfinite(affine_mm).all()
                ):
                    raise AppError(
                        status_code=422,
                        code="invalid_nifti",
                        message="Ma trận affine của mask không hợp lệ.",
                    )

                det = abs(float(np.linalg.det(affine_mm[:3, :3])))
                if not np.isfinite(det) or det <= 1e-8:
                    raise AppError(
                        status_code=422,
                        code="invalid_nifti",
                        message="Ma trận affine của mask suy biến (không khả nghịch).",
                    )

                spacing_mm = [float(np.linalg.norm(affine_mm[:3, idx])) for idx in range(3)]
                ref_affine_arr = np.asarray(ref_affine_mm, dtype=np.float64)

                mask_axcodes, _ = extract_valid_orientation(affine_mm)
                ref_axcodes, _ = extract_valid_orientation(ref_affine_arr)

                if shape != ref_shape:
                    raise AppError(
                        status_code=422,
                        code="geometry_mismatch",
                        message="Kích thước lưới mask (shape) không khớp với volume tham chiếu.",
                        details=[
                            {
                                "field": "shape",
                                "reason": f"expected {ref_shape}, got {shape}",
                                "type": "geometry_mismatch",
                            }
                        ],
                    )
                if not np.allclose(
                    np.asarray(spacing_mm, dtype=np.float64),
                    np.asarray(ref_spacing_mm, dtype=np.float64),
                    rtol=0.0,
                    atol=tol_mm,
                ):
                    raise AppError(
                        status_code=422,
                        code="geometry_mismatch",
                        message="Voxel spacing của mask không khớp với volume tham chiếu.",
                    )
                if not np.allclose(affine_mm, ref_affine_arr, rtol=0.0, atol=tol_mm):
                    raise AppError(
                        status_code=422,
                        code="geometry_mismatch",
                        message="Ma trận affine của mask không khớp với volume tham chiếu.",
                    )

                if mask_axcodes != ref_axcodes:
                    raise AppError(
                        status_code=422,
                        code="geometry_mismatch",
                        message="Hướng giải phẫu (axis codes) của mask bị đảo so với tham chiếu.",
                    )

                num_voxels = math.prod(shape)
                raw_voxel_bytes = num_voxels * max(1, int(dtype.itemsize))
                min_hdr = 348 if image_cls is nib.Nifti1Image else 540
                if raw_vox_offset < 0 or (0 < raw_vox_offset < min_hdr):
                    raise AppError(
                        status_code=422,
                        code="invalid_nifti",
                        message="Header NIfTI có vox_offset không hợp lệ.",
                    )
                effective_vox_offset = raw_vox_offset if raw_vox_offset > 0 else single_vox_offset
                file_size = inspect_path.stat().st_size
                if effective_vox_offset + raw_voxel_bytes > file_size:
                    raise AppError(
                        status_code=422,
                        code="invalid_nifti",
                        message="Header NIfTI khai báo kích thước voxel vượt quá dung lượng tệp.",
                    )
                if raw_voxel_bytes > max_decompressed_bytes:
                    raise AppError(
                        status_code=413,
                        code="payload_too_large",
                        message="Kích thước dữ liệu voxel vượt quá giới hạn an toàn.",
                    )

                canonical_arr = np.empty(shape, dtype=np.uint8)
                count_1 = 0
                count_2 = 0
                count_4 = 0

                max_tile_elems = 1_048_576
                sx, sy, sz = shape
                z_step = max(1, min(sz, max_tile_elems))
                y_step = max(1, min(sy, max(1, max_tile_elems // z_step)))
                x_step = max(1, min(sx, max(1, max_tile_elems // (y_step * z_step))))

                for z0 in range(0, sz, z_step):
                    z1 = min(sz, z0 + z_step)
                    for y0 in range(0, sy, y_step):
                        y1 = min(sy, y0 + y_step)
                        for x0 in range(0, sx, x_step):
                            x1 = min(sx, x0 + x_step)
                            try:
                                slab = np.asanyarray(img.dataobj[x0:x1, y0:y1, z0:z1])
                            except (*_NIFTI_HEADER_ERRORS, zlib.error) as exc:
                                raise AppError(
                                    status_code=422,
                                    code="invalid_nifti",
                                    message="Dữ liệu voxel mask NIfTI bị hỏng hoặc cắt cụt.",
                                ) from exc

                            if slab.shape != (x1 - x0, y1 - y0, z1 - z0):
                                raise AppError(
                                    status_code=422,
                                    code="invalid_nifti",
                                    message="Kích thước dữ liệu voxel không khớp với header.",
                                )

                            if slab.dtype.kind == "f":
                                if not np.isfinite(slab).all():
                                    raise AppError(
                                        status_code=422,
                                        code="invalid_mask_labels",
                                        message="Mask chứa giá trị NaN hoặc Inf không hợp lệ.",
                                    )
                                if not np.equal(np.floor(slab), slab).all():
                                    raise AppError(
                                        status_code=422,
                                        code="invalid_mask_labels",
                                        message="Mask chỉ chấp nhận nhãn số nguyên {0, 1, 2, 4}.",
                                    )

                            slab_int = slab.astype(np.int64, copy=False)
                            if not np.isin(slab_int, _VALID_MASK_LABELS).all():
                                raise AppError(
                                    status_code=422,
                                    code="invalid_mask_labels",
                                    message="Mask chứa nhãn ngoài tập hợp hợp lệ {0, 1, 2, 4}.",
                                )

                            count_1 += int(np.count_nonzero(slab_int == 1))
                            count_2 += int(np.count_nonzero(slab_int == 2))
                            count_4 += int(np.count_nonzero(slab_int == 4))
                            canonical_arr[x0:x1, y0:y1, z0:z1] = slab_int.astype(
                                np.uint8, copy=False
                            )
                            del slab, slab_int
            finally:
                img.uncache()

        out_img = nib.Nifti1Image(canonical_arr, ref_affine_arr)
        out_img.set_data_dtype(np.uint8)
        out_img.header.set_xyzt_units("mm", "sec")
        scode_out = scode_int if scode_int in {1, 2, 3, 4} else 1
        qcode_out = qcode_int if qcode_int in {1, 2, 3, 4} else 1
        out_img.set_sform(ref_affine_arr, code=scode_out)
        try:
            out_img.set_qform(ref_affine_arr, code=qcode_out)
            qf_check = out_img.header.get_qform()
        except Exception:
            qf_check = None
        if qf_check is None or not np.allclose(qf_check, ref_affine_arr, rtol=0.0, atol=1e-3):
            out_img.set_qform(None, code=0)
        bio = io.BytesIO()
        fmap = out_img.make_file_map({"image": bio, "header": bio})
        out_img.to_file_map(fmap)
        raw_nii_bytes = bio.getvalue()

        if temp_dir is not None:
            temp_dir.mkdir(parents=True, exist_ok=True)
        fd, out_name = tempfile.mkstemp(
            prefix="mask-canon-",
            suffix=".nii.gz",
            dir=str(temp_dir) if temp_dir is not None else None,
        )
        os.close(fd)
        out_path = Path(out_name)
        try:
            with open(out_path, "wb") as f_out:
                with gzip.GzipFile(filename="", mode="wb", fileobj=f_out, mtime=0) as gz_out:
                    gz_out.write(raw_nii_bytes)
                f_out.flush()
                os.fsync(f_out.fileno())
            if os.name != "nt":
                os.chmod(out_path, 0o600)

            digest = hashlib.sha256()
            size_bytes = 0
            with open(out_path, "rb") as f_in:
                while True:
                    chunk = f_in.read(65536)
                    if not chunk:
                        break
                    digest.update(chunk)
                    size_bytes += len(chunk)
        except Exception:
            out_path.unlink(missing_ok=True)
            raise

        return CanonicalMaskResult(
            canonical_nii_gz_path=out_path,
            size_bytes=size_bytes,
            sha256=digest.hexdigest(),
            label_voxel_counts={"1": count_1, "2": count_2, "4": count_4},
        )
    finally:
        if temp_decomp is not None:
            temp_decomp.unlink(missing_ok=True)


def _extract_quota_bytes(value_json: object, fallback: int) -> int:
    if isinstance(value_json, int):
        return value_json
    if isinstance(value_json, dict):
        for key in ("bytes", "value"):
            raw = value_json.get(key)
            if isinstance(raw, int) and raw > 0:
                return raw
    return fallback


def _compute_save_request_digest(
    *,
    raw_mask_sha256: str,
    base_version_id: uuid.UUID | None,
    reference_volume_id: uuid.UUID,
    note: str | None,
) -> str:
    canonical = json.dumps(
        {
            "mask_sha256": raw_mask_sha256,
            "base_version_id": str(base_version_id) if base_version_id is not None else None,
            "reference_volume_id": str(reference_volume_id),
            "note": note,
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


class MaskVersionService:
    """Service layer for immutable MaskVersion listing, saving, export, and metadata."""

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
        self.mask_versions = MaskVersionRepository(db)
        self.system_settings = SystemSettingRepository(db)
        self.users = UserRepository(db)
        self.audits = AuditRepository(db)

    def _to_out(self, mv: MaskVersion, created_by_name: str | None) -> MaskVersionOut:
        return MaskVersionOut.model_validate(mv).model_copy(
            update={"created_by_name": created_by_name}
        )

    def _effective_quotas(self) -> tuple[int, int]:
        return resolve_effective_quotas(self.system_settings, self.settings)

    def list_mask_versions(
        self,
        *,
        doctor_id: uuid.UUID,
        case_id: uuid.UUID,
        page: int = 1,
        page_size: int = 20,
    ) -> PaginatedResponse[MaskVersionOut]:
        case = self.cases.get_active_for_owner(case_id, doctor_id)
        if case is None:
            raise AppError(
                status_code=404,
                code="case_not_found",
                message="Không tìm thấy ca chụp.",
            )
        rows, total = self.mask_versions.list_for_case(
            case_id=case.id,
            page=page,
            page_size=page_size,
        )
        return PaginatedResponse[MaskVersionOut](
            items=[self._to_out(mv, author_name) for mv, author_name in rows],
            total=total,
            page=page,
            page_size=page_size,
        )

    def get_mask_version(
        self,
        *,
        doctor_id: uuid.UUID,
        mask_version_id: uuid.UUID,
    ) -> MaskVersionOut:
        row = self.mask_versions.get_by_id_for_owner(mask_version_id, doctor_id)
        if row is None:
            raise AppError(
                status_code=404,
                code="mask_version_not_found",
                message="Không tìm thấy phiên bản mask.",
            )
        mv, _, author_name = row
        return self._to_out(mv, author_name)

    def get_mask_export_file(
        self,
        *,
        doctor_id: uuid.UUID,
        mask_version_id: uuid.UUID,
    ) -> tuple[StoredFile, MaskVersion]:
        row = self.mask_versions.get_by_id_for_owner(mask_version_id, doctor_id)
        if row is None:
            raise AppError(
                status_code=404,
                code="mask_version_not_found",
                message="Không tìm thấy phiên bản mask.",
            )
        mv, _, _ = row
        stored_files = self.files.list_by_ids([mv.file_id])
        sf = stored_files[0] if stored_files else None
        if sf is None or sf.state != "committed" or sf.storage_key is None:
            raise AppError(
                status_code=404,
                code="file_not_found",
                message="Không tìm thấy tệp mask.",
            )
        try:
            with self.storage.open(str(sf.storage_key), "rb"):
                pass
        except FileNotFoundError as exc:
            raise AppError(
                status_code=404,
                code="file_not_found",
                message="Không tìm thấy tệp mask.",
            ) from exc
        return sf, mv

    def get_mask_metadata(
        self,
        *,
        doctor_id: uuid.UUID,
        mask_version_id: uuid.UUID,
    ) -> MaskMetadataExportOut:
        row = self.mask_versions.get_by_id_for_owner(mask_version_id, doctor_id)
        if row is None:
            raise AppError(
                status_code=404,
                code="mask_version_not_found",
                message="Không tìm thấy phiên bản mask.",
            )
        mv, case, author_name = row
        ref_vol = self.volumes.get_active_in_case(case.id, mv.reference_volume_id)
        if ref_vol is None:
            raise AppError(
                status_code=404,
                code="volume_not_found",
                message="Không tìm thấy volume tham chiếu của phiên bản mask.",
            )

        resolved_manifest = self.settings.MODEL_MANIFEST_PATH or _DEFAULT_MANIFEST_PATH
        manifest_labels = _load_manifest_labels(str(resolved_manifest))
        stats_dict = compute_mask_statistics(
            label_voxel_counts=mv.label_voxel_counts,
            affine_mm=[[float(c) for c in r] for r in ref_vol.affine],
        )

        per_label = [
            MaskLabelStatOut(
                label=lbl,
                name=manifest_labels.get(str(lbl), str(lbl)),
                voxel_count=int(mv.label_voxel_counts.get(str(lbl), 0)),
                volume_mm3=float(mv.label_volumes_mm3.get(str(lbl), 0.0)),
                volume_ml=float(mv.label_volumes_mm3.get(str(lbl), 0.0)) / 1000.0,
            )
            for lbl in (1, 2, 4)
        ]

        comp_mm3 = mv.composite_volumes_mm3 or stats_dict["composite_volumes_mm3"]
        composite_groups = [
            MaskCompositeStatOut(
                group="WT",
                labels=[1, 2, 4],
                volume_mm3=float(comp_mm3.get("WT", 0.0)),
                volume_ml=float(comp_mm3.get("WT", 0.0)) / 1000.0,
            ),
            MaskCompositeStatOut(
                group="TC",
                labels=[1, 4],
                volume_mm3=float(comp_mm3.get("TC", 0.0)),
                volume_ml=float(comp_mm3.get("TC", 0.0)) / 1000.0,
            ),
            MaskCompositeStatOut(
                group="ET",
                labels=[4],
                volume_mm3=float(comp_mm3.get("ET", 0.0)),
                volume_ml=float(comp_mm3.get("ET", 0.0)) / 1000.0,
            ),
        ]

        if mv.coverage_file_id is not None:
            cov_status = "ai_crop_evaluated" if mv.source == "ai" else "inherited_from_ai_crop"
            cov_note = (
                "Vùng đánh giá AI dựa trên crop; các voxel bác sĩ chỉnh sửa ngoài vùng crop "
                "được tính trong thống kê mask nhưng không phải vùng AI đã đánh giá."
            )
        else:
            cov_status = "manual_only_no_ai_coverage"
            cov_note = "Mask tạo thủ công từ đầu, không có dữ liệu vùng đánh giá AI."

        return MaskMetadataExportOut(
            version_id=mv.id,
            case_id=mv.case_id,
            study_date=case.study_date,
            version_number=mv.version_number,
            source=mv.source,  # type: ignore[arg-type]
            base_version_id=mv.base_version_id,
            reference_volume_id=mv.reference_volume_id,
            model_version_id=mv.model_version_id,
            job_id=mv.job_id,
            coverage=MaskCoverageOut(
                status=cov_status,
                coverage_file_id=mv.coverage_file_id,
                note=cov_note,
            ),
            geometry=MaskGeometryOut(
                shape=[int(v) for v in ref_vol.shape],
                spacing_mm=[float(v) for v in ref_vol.spacing_mm],
                affine=[[float(c) for c in r] for r in ref_vol.affine],
                orientation=ref_vol.orientation,
                units="mm",
            ),
            labels=manifest_labels,
            statistics=MaskStatisticsOut(
                voxel_volume_mm3=float(stats_dict["voxel_volume_mm3"]),
                per_label=per_label,
                composite_groups=composite_groups,
                total_foreground_voxels=int(stats_dict["total_foreground_voxels"]),
                total_foreground_volume_mm3=float(stats_dict["total_foreground_volume_mm3"]),
                total_foreground_volume_ml=float(stats_dict["total_foreground_volume_ml"]),
            ),
            sha256=mv.sha256,
            created_by_name=author_name,
            created_at=mv.created_at,
        )

    def _resolve_existing_idempotency(
        self,
        *,
        record: MaskSaveIdempotencyKey,
        digest: str,
        doctor_id: uuid.UUID,
        case_id: uuid.UUID,
    ) -> MaskVersionOut:
        case = self.cases.get_active_for_owner(case_id, doctor_id)
        if case is None:
            raise AppError(
                status_code=404,
                code="case_not_found",
                message="Không tìm thấy ca chụp.",
            )

        if record.request_digest != digest:
            raise AppError(
                status_code=409,
                code="idempotency_conflict",
                message="Khóa Idempotency-Key đã được dùng với nội dung mask hoặc metadata khác.",
            )
        row = self.mask_versions.get_by_id_with_author(record.mask_version_id)
        if row is None:
            raise AppError(
                status_code=404,
                code="mask_version_not_found",
                message="Không tìm thấy phiên bản mask gắn với Idempotency-Key.",
            )
        mv, author_name = row
        if mv.case_id != case_id:
            raise AppError(
                status_code=404,
                code="mask_version_not_found",
                message="Không tìm thấy phiên bản mask gắn với Idempotency-Key.",
            )
        return self._to_out(mv, author_name)

    async def save_manual_mask_version(
        self,
        *,
        doctor_id: uuid.UUID,
        case_id: uuid.UUID,
        idempotency_key: uuid.UUID,
        mask_file: UploadFile,
        base_version_id: uuid.UUID | None,
        reference_volume_id: uuid.UUID,
        note: str | None,
        request_id: str,
        ip_address: str,
    ) -> MaskVersionOut:
        normalized_note = note.strip() if note is not None else None
        if normalized_note == "":
            normalized_note = None
        if normalized_note is not None and len(normalized_note) > 2000:
            raise AppError(
                status_code=422,
                code="validation_error",
                message="Ghi chú phiên bản mask không được vượt quá 2000 ký tự.",
                details=[
                    {
                        "field": "note",
                        "reason": "String should have at most 2000 characters",
                        "type": "string_too_long",
                    }
                ],
            )

        case = self.cases.get_active_for_owner(case_id, doctor_id)
        if case is None:
            raise AppError(
                status_code=404,
                code="case_not_found",
                message="Không tìm thấy ca chụp.",
            )

        admin_setting = self.system_settings.get_by_key("admin_settings")
        admin_values = admin_setting.value_json if admin_setting is not None else {}
        upload_mib = admin_values.get("max_upload_mib") if isinstance(admin_values, dict) else None
        decompressed_mib = (
            admin_values.get("max_decompressed_mib") if isinstance(admin_values, dict) else None
        )
        max_upload_bytes = (
            min(int(upload_mib) * 1024 * 1024, self.settings.MAX_UPLOAD_BYTES)
            if isinstance(upload_mib, int) and upload_mib > 0
            else getattr(self.settings, "MAX_UPLOAD_BYTES", DEFAULT_MAX_UPLOAD_BYTES)
        )
        max_decompressed_bytes = (
            min(int(decompressed_mib) * 1024 * 1024, self.settings.MAX_DECOMPRESSED_BYTES)
            if isinstance(decompressed_mib, int) and decompressed_mib > 0
            else getattr(self.settings, "MAX_DECOMPRESSED_BYTES", DEFAULT_MAX_DECOMPRESSED_BYTES)
        )
        # Release DB connection before streaming & NIfTI validation
        self.db.rollback()

        is_gzip, _ = _detect_nifti_extension(mask_file.filename)
        staged_raw, staged_raw_path = await _stream_upload_to_staging(
            upload=mask_file,
            storage=self.storage,
            max_upload_bytes=max_upload_bytes,
        )

        canonical_path: Path | None = None
        canonical_staging_key: str | None = None
        committed_key: str | None = None
        committed_to_db = False
        mask_version: MaskVersion | None = None

        try:
            request_digest = _compute_save_request_digest(
                raw_mask_sha256=staged_raw.sha256,
                base_version_id=base_version_id,
                reference_volume_id=reference_volume_id,
                note=normalized_note,
            )

            # Lookup idempotency key BEFORE checking reference_volume_id or base_version_id
            existing_idem = self.mask_versions.get_idempotency_record(
                doctor_id=doctor_id,
                case_id=case_id,
                idempotency_key=idempotency_key,
            )
            if existing_idem is not None:
                return self._resolve_existing_idempotency(
                    record=existing_idem,
                    digest=request_digest,
                    doctor_id=doctor_id,
                    case_id=case_id,
                )

            case = self.cases.get_active_for_owner(case_id, doctor_id)
            if case is None:
                raise AppError(
                    status_code=404,
                    code="case_not_found",
                    message="Không tìm thấy ca chụp.",
                )

            ref_vol = self.volumes.get_active_in_case(case.id, reference_volume_id)
            if ref_vol is None or ref_vol.validation_status != "valid":
                raise AppError(
                    status_code=422,
                    code="invalid_reference_volume",
                    message="Volume tham chiếu không thuộc ca chụp hoặc chưa hợp lệ.",
                )

            if (
                case.reference_volume_id is not None
                and case.reference_volume_id != reference_volume_id
            ):
                raise AppError(
                    status_code=409,
                    code="reference_volume_mismatch",
                    message="Volume tham chiếu của ca chụp đã được cố định và không thể thay đổi.",
                )

            ref_shape = [int(v) for v in ref_vol.shape]
            ref_spacing_mm = [float(v) for v in ref_vol.spacing_mm]
            ref_affine_mm = [[float(c) for c in row] for row in ref_vol.affine]
            self.db.rollback()

            canonical = validate_and_canonicalize_mask(
                file_path=staged_raw_path,
                is_gzip=is_gzip,
                ref_shape=ref_shape,
                ref_spacing_mm=ref_spacing_mm,
                ref_affine_mm=ref_affine_mm,
                max_decompressed_bytes=max_decompressed_bytes,
                temp_dir=self.storage.staging_root,
            )
            canonical_path = canonical.canonical_nii_gz_path

            # Lock Case row for atomic version head & quota check
            locked_case = self.cases.get_active_for_owner_for_update(case_id, doctor_id)
            if locked_case is None:
                raise AppError(
                    status_code=404,
                    code="case_not_found",
                    message="Không tìm thấy ca chụp.",
                )

            # Re-check idempotency inside lock in case of concurrent identical retries
            raced_idem = self.mask_versions.get_idempotency_record(
                doctor_id=doctor_id,
                case_id=locked_case.id,
                idempotency_key=idempotency_key,
            )
            if raced_idem is not None:
                return self._resolve_existing_idempotency(
                    record=raced_idem,
                    digest=request_digest,
                    doctor_id=doctor_id,
                    case_id=case_id,
                )

            locked_ref_vol = self.volumes.get_active_in_case(locked_case.id, reference_volume_id)
            if locked_ref_vol is None or locked_ref_vol.validation_status != "valid":
                raise AppError(
                    status_code=422,
                    code="invalid_reference_volume",
                    message="Volume tham chiếu không thuộc ca chụp hoặc chưa hợp lệ.",
                )
            if (
                locked_case.reference_volume_id is not None
                and locked_case.reference_volume_id != reference_volume_id
            ):
                raise AppError(
                    status_code=409,
                    code="reference_volume_mismatch",
                    message="Volume tham chiếu của ca chụp đã được cố định và không thể thay đổi.",
                )
            if [int(v) for v in locked_ref_vol.shape] != ref_shape or not np.allclose(
                np.asarray(locked_ref_vol.affine, dtype=np.float64),
                np.asarray(ref_affine_mm, dtype=np.float64),
                rtol=0.0,
                atol=1e-4,
            ):
                raise AppError(
                    status_code=409,
                    code="reference_volume_mismatch",
                    message="Hình học volume tham chiếu đã thay đổi trong lúc lưu mask.",
                )

            coverage_file_id: uuid.UUID | None = None
            if base_version_id is not None:
                base_mv = self.mask_versions.get_by_id_in_case(base_version_id, locked_case.id)
                if base_mv is None:
                    raise AppError(
                        status_code=404,
                        code="mask_version_not_found",
                        message="Không tìm thấy phiên bản mask nền.",
                    )
                coverage_file_id = base_mv.coverage_file_id

            if base_version_id != locked_case.latest_mask_version_id:
                raise AppError(
                    status_code=409,
                    code="mask_version_conflict",
                    message=(
                        "Phiên bản mask nền đã cũ so với phiên bản mới nhất của ca chụp. "
                        "Vui lòng tải lại lịch sử phiên bản."
                    ),
                    details={
                        "latest_mask_version_id": (
                            str(locked_case.latest_mask_version_id)
                            if locked_case.latest_mask_version_id is not None
                            else None
                        )
                    },
                )

            # Atomic quota check
            self.files.acquire_quota_locks(doctor_id)
            doc_quota, sys_quota = self._effective_quotas()
            owner_used, system_used = self.files.get_committed_usage_bytes(doctor_id)
            if owner_used + canonical.size_bytes > doc_quota:
                raise AppError(
                    status_code=413,
                    code="storage_quota_exceeded",
                    message="Dung lượng lưu trữ của bác sĩ đã vượt quá hạn mức.",
                )
            if system_used + canonical.size_bytes > sys_quota:
                raise AppError(
                    status_code=413,
                    code="storage_quota_exceeded",
                    message="Dung lượng lưu trữ toàn hệ thống đã đạt giới hạn.",
                )

            # Move canonical uint8 .nii.gz into staging and commit to storage
            canonical_staging_key = str(uuid.uuid4())
            validated_key, canon_stage_path = self.storage._resolve_under(
                self.storage.staging_root, canonical_staging_key
            )
            self.storage._ensure_layout()
            shutil.move(str(canonical_path), str(canon_stage_path))
            canonical_path = None
            self.storage._chmod_file(canon_stage_path)

            stored_obj = self.storage.commit(validated_key)
            committed_key = stored_obj.storage_key
            canonical_staging_key = None

            next_version = self.mask_versions.get_next_version_number(locked_case.id)
            stored_file = StoredFile(
                storage_key=uuid.UUID(committed_key),
                original_name=f"mask-case-{locked_case.id}-v{next_version}.nii.gz",
                size_bytes=canonical.size_bytes,
                sha256=canonical.sha256,
                media_type="application/gzip",
                state="committed",
                owner_id=doctor_id,
            )
            self.db.add(stored_file)
            self.db.flush()

            stats = compute_mask_statistics(
                label_voxel_counts=canonical.label_voxel_counts,
                affine_mm=ref_affine_mm,
            )

            mask_version = MaskVersion(
                case_id=locked_case.id,
                version_number=next_version,
                source="manual",
                base_version_id=base_version_id,
                reference_volume_id=reference_volume_id,
                file_id=stored_file.id,
                created_by=doctor_id,
                job_id=None,
                model_version_id=None,
                coverage_file_id=coverage_file_id,
                note=normalized_note,
                label_voxel_counts=canonical.label_voxel_counts,
                label_volumes_mm3=stats["label_volumes_mm3"],
                composite_volumes_mm3=stats["composite_volumes_mm3"],
                sha256=canonical.sha256,
            )
            self.db.add(mask_version)
            self.db.flush()

            locked_case.latest_mask_version_id = mask_version.id
            if locked_case.reference_volume_id is None:
                locked_case.reference_volume_id = reference_volume_id
            if locked_case.inputs_locked_at is None:
                locked_case.inputs_locked_at = datetime.now(UTC)

            idem_receipt = MaskSaveIdempotencyKey(
                doctor_id=doctor_id,
                case_id=locked_case.id,
                idempotency_key=idempotency_key,
                request_digest=request_digest,
                mask_version_id=mask_version.id,
            )
            self.db.add(idem_receipt)
            try:
                self.db.flush()
            except IntegrityError:
                self.db.rollback()
                if committed_key is not None:
                    self.storage.delete(committed_key)
                    committed_key = None
                raced = self.mask_versions.get_idempotency_record(
                    doctor_id=doctor_id,
                    case_id=locked_case.id,
                    idempotency_key=idempotency_key,
                )
                if raced is None:
                    raise
                return self._resolve_existing_idempotency(
                    record=raced,
                    digest=request_digest,
                    doctor_id=doctor_id,
                    case_id=case_id,
                )

            self.audits.record_event(
                actor_type="user",
                actor_id=doctor_id,
                action="mask_version.save_manual",
                resource_type="mask_version",
                resource_id=str(mask_version.id),
                outcome="success",
                request_id=request_id,
                ip_address=ip_address,
                safe_diff={
                    "case_id": str(locked_case.id),
                    "version_number": next_version,
                    "source": "manual",
                    "reference_volume_id": str(reference_volume_id),
                    "base_version_id": str(base_version_id) if base_version_id else None,
                    "has_note": normalized_note is not None,
                    "total_foreground_voxels": stats["total_foreground_voxels"],
                },
            )

            author = self.users.get_by_id(doctor_id)
            author_name = author.display_name if author is not None else None
            result_out = self._to_out(mask_version, author_name)
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
                    if mask_version is None:
                        with contextlib.suppress(OSError):
                            self.storage.delete(committed_key)
                    elif rollback_ok:
                        # A commit may persist before raising.
                        # Expunge cached state and check DB before deleting the object.
                        mv_id = mask_version.id
                        try:
                            self.db.expunge_all()
                            persisted_mask = (
                                self.mask_versions.get_by_id_with_author(mv_id)
                                if mv_id is not None
                                else None
                            )
                            self.db.rollback()
                        except Exception:
                            with contextlib.suppress(Exception):
                                self.db.rollback()
                        else:
                            if persisted_mask is None:
                                with contextlib.suppress(OSError):
                                    self.storage.delete(committed_key)
            raise
        finally:
            staged_raw_path.unlink(missing_ok=True)
            if canonical_path is not None:
                canonical_path.unlink(missing_ok=True)
            if canonical_staging_key is not None:
                (self.storage.staging_root / canonical_staging_key).unlink(missing_ok=True)
