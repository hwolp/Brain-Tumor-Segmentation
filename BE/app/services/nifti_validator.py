"""NIfTI upload streaming, decompression bomb guard, and geometry validation."""

from __future__ import annotations

import gzip
import hashlib
import json
import math
import os
import struct
import tempfile
import uuid
import zlib
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import nibabel as nib
import numpy as np
from fastapi import UploadFile

from app.core.errors import AppError
from app.core.storage import LocalStorageAdapter, StagedFile

DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024
DEFAULT_MAX_DECOMPRESSED_BYTES = 256 * 1024 * 1024
_CHUNK_SIZE = 65536
_SPATIAL_UNIT_SCALE_TO_MM: dict[str, float] = {
    "mm": 1.0,
    "meter": 1000.0,
    "micron": 0.001,
    "unknown": 1.0,
}
_VALID_AXCODES = frozenset({"R", "L", "A", "P", "S", "I"})
_AXCODE_AXIS_GROUP: dict[str, str] = {
    "R": "LR",
    "L": "LR",
    "A": "AP",
    "P": "AP",
    "S": "SI",
    "I": "SI",
}
_NIFTI_HEADER_ERRORS = (
    nib.filebasedimages.ImageFileError,
    nib.spatialimages.HeaderDataError,
    nib.spatialimages.HeaderTypeError,
    OSError,
    ValueError,
    TypeError,
    OverflowError,
    EOFError,
    struct.error,
)
_DEFAULT_MANIFEST_PATH = Path(__file__).resolve().parents[2] / "worker" / "manifest.json"


@dataclass(frozen=True, slots=True)
class VolumeGeometry:
    """Normalized 3D volume geometry in millimeters."""

    shape: list[int]
    spacing_mm: list[float]
    affine: list[list[float]]


@dataclass(frozen=True, slots=True)
class ValidatedNiftiUpload:
    """Result of streaming, decompressing, and validating an uploaded NIfTI volume."""

    staged_file: StagedFile
    media_type: str
    shape: list[int]
    spacing_mm: list[float]
    affine: list[list[float]]
    orientation: str
    datatype: str
    size_bytes: int
    sha256: str


def is_axis_aligned_affine(
    affine: list[list[float]] | np.ndarray,
    *,
    tol: float = 1e-4,
) -> bool:
    """Return True if the 3x3 linear block of affine has no oblique rotation or shear."""
    arr = np.asarray(affine, dtype=np.float64)
    if arr.ndim != 2 or arr.shape[0] < 3 or arr.shape[1] < 3:
        return False
    mat = arr[:3, :3]
    if not np.isfinite(mat).all():
        return False
    dom_rows: set[int] = set()
    for col_idx in range(3):
        col_abs = np.abs(mat[:, col_idx])
        dom_row = int(np.argmax(col_abs))
        dom_val = float(col_abs[dom_row])
        if dom_val <= 0.0:
            return False
        for row_idx in range(3):
            if row_idx != dom_row and float(col_abs[row_idx]) > tol:
                return False
        dom_rows.add(dom_row)
    return len(dom_rows) == 3


def extract_valid_orientation(affine_mm: np.ndarray) -> tuple[tuple[str, str, str], str]:
    """Extract 3 independent anatomical axis codes from affine_mm or raise 422 invalid_nifti."""
    try:
        axcodes = nib.orientations.aff2axcodes(affine_mm, tol=1e-3)
    except Exception as exc:
        raise AppError(
            status_code=422,
            code="invalid_nifti",
            message="Không thể xác định hướng giải phẫu từ affine.",
        ) from exc

    if (
        len(axcodes) != 3
        or any(not isinstance(code, str) or code not in _VALID_AXCODES for code in axcodes)
        or len({_AXCODE_AXIS_GROUP[str(code)] for code in axcodes}) != 3
    ):
        raise AppError(
            status_code=422,
            code="invalid_nifti",
            message="Không thể xác định 3 trục hướng giải phẫu độc lập từ affine.",
        )
    typed_codes = (str(axcodes[0]), str(axcodes[1]), str(axcodes[2]))
    return typed_codes, "".join(typed_codes)


@lru_cache(maxsize=4)
def _load_manifest_profile(manifest_path_str: str) -> tuple[list[int], list[float], float, int]:
    path = Path(manifest_path_str)
    if not path.is_file():
        return [240, 240, 155], [1.0, 1.0, 1.0], 1e-4, 2
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        profile = data.get("input_profile", {})
        shape = [int(v) for v in profile.get("shape", [240, 240, 155])]
        spacing = [float(v) for v in profile.get("spacing_mm", [1.0, 1.0, 1.0])]
        tol = float(profile.get("geometry_tolerance_mm", 1e-4))
        slice_axis = int(profile.get("slice_axis", 2))
        return shape, spacing, tol, slice_axis
    except (OSError, json.JSONDecodeError, ValueError, TypeError, KeyError):
        return [240, 240, 155], [1.0, 1.0, 1.0], 1e-4, 2


def check_model_profile(
    *,
    shape: list[int],
    spacing_mm: list[float],
    affine: list[list[float]] | None = None,
    orientation: str | None = None,
    manifest_path: Path | None = None,
) -> tuple[bool, list[str]]:
    """Compare validated NIfTI geometry against the active AI model input profile."""
    resolved_manifest = manifest_path if manifest_path is not None else _DEFAULT_MANIFEST_PATH
    expected_shape, expected_spacing, tol, slice_axis = _load_manifest_profile(
        str(resolved_manifest)
    )

    warnings: list[str] = []
    if shape != expected_shape:
        warnings.append(
            f"Kích thước volume {tuple(shape)} khác cấu hình mô hình AI {tuple(expected_shape)}."
        )
    if not np.allclose(
        np.asarray(spacing_mm, dtype=np.float64),
        np.asarray(expected_spacing, dtype=np.float64),
        rtol=0.0,
        atol=tol,
    ):
        warnings.append(
            f"Voxel spacing {spacing_mm} mm khác cấu hình mô hình AI {expected_spacing} mm."
        )
    if affine is not None and not is_axis_aligned_affine(affine, tol=tol):
        warnings.append(
            "Ma trận affine bị nghiêng (oblique/shear), không thẳng trục với cấu hình mô hình AI."
        )
    else:
        resolved_orientation = orientation
        if resolved_orientation is None and affine is not None:
            try:
                _, resolved_orientation = extract_valid_orientation(
                    np.asarray(affine, dtype=np.float64)
                )
            except AppError:
                resolved_orientation = None
        if resolved_orientation is not None and (
            len(resolved_orientation) != 3
            or not (0 <= slice_axis < 3)
            or resolved_orientation[slice_axis] not in {"S", "I"}
        ):
            warnings.append(
                f"Hướng giải phẫu ({resolved_orientation}) không có trục lát cắt axial (S/I) "
                f"tại slice_axis={slice_axis}."
            )
    return len(warnings) == 0, warnings


def check_geometry_compatibility(
    expected: VolumeGeometry,
    actual: VolumeGeometry,
    *,
    tol_mm: float = 1e-4,
) -> None:
    """Ensure a sibling modality matches the existing volume's shape, spacing, and affine."""
    if expected.shape != actual.shape:
        raise AppError(
            status_code=422,
            code="geometry_mismatch",
            message="Hình dạng volume (shape) không khớp với modality đã có của ca.",
            details=[
                {
                    "field": "shape",
                    "reason": f"expected {expected.shape}, got {actual.shape}",
                    "type": "geometry_mismatch",
                }
            ],
        )

    if not np.allclose(
        np.asarray(expected.spacing_mm, dtype=np.float64),
        np.asarray(actual.spacing_mm, dtype=np.float64),
        rtol=0.0,
        atol=tol_mm,
    ):
        raise AppError(
            status_code=422,
            code="geometry_mismatch",
            message="Voxel spacing (mm) không khớp với modality đã có của ca.",
            details=[
                {
                    "field": "spacing_mm",
                    "reason": "Voxel spacing exceeds 1e-4 mm tolerance",
                    "type": "geometry_mismatch",
                }
            ],
        )

    if not np.allclose(
        np.asarray(expected.affine, dtype=np.float64),
        np.asarray(actual.affine, dtype=np.float64),
        rtol=0.0,
        atol=tol_mm,
    ):
        raise AppError(
            status_code=422,
            code="geometry_mismatch",
            message="Ma trận tọa độ affine (mm) không khớp với modality đã có của ca.",
            details=[
                {
                    "field": "affine",
                    "reason": "Affine matrix exceeds 1e-4 mm tolerance",
                    "type": "geometry_mismatch",
                }
            ],
        )


def _detect_nifti_extension(filename: str | None) -> tuple[bool, str]:
    if not filename or not filename.strip():
        raise AppError(
            status_code=422,
            code="invalid_file_extension",
            message="Tên tệp tải lên không hợp lệ; chỉ chấp nhận .nii hoặc .nii.gz.",
        )
    lower_name = Path(filename.strip()).name.lower()
    if lower_name.endswith(".nii.gz"):
        return True, "application/gzip"
    if lower_name.endswith(".nii"):
        return False, "application/octet-stream"
    raise AppError(
        status_code=422,
        code="invalid_file_extension",
        message="Định dạng tệp không hợp lệ; chỉ chấp nhận .nii hoặc .nii.gz.",
    )


async def _stream_upload_to_staging(
    *,
    upload: UploadFile,
    storage: LocalStorageAdapter,
    max_upload_bytes: int,
) -> tuple[StagedFile, Path]:
    staging_key = str(uuid.uuid4())
    validated_key, staged_path = storage._resolve_under(storage.staging_root, staging_key)
    storage._ensure_layout()

    digest = hashlib.sha256()
    total_bytes = 0
    try:
        with open(staged_path, "wb") as handle:
            while True:
                chunk = await upload.read(_CHUNK_SIZE)
                if not chunk:
                    break
                total_bytes += len(chunk)
                if total_bytes > max_upload_bytes:
                    raise AppError(
                        status_code=413,
                        code="payload_too_large",
                        message="Dung lượng tệp tải lên vượt quá giới hạn cho phép.",
                    )
                handle.write(chunk)
                digest.update(chunk)
            handle.flush()
            os.fsync(handle.fileno())
        storage._chmod_file(staged_path)
    except Exception:
        staged_path.unlink(missing_ok=True)
        raise

    if total_bytes == 0:
        staged_path.unlink(missing_ok=True)
        raise AppError(
            status_code=422,
            code="invalid_nifti",
            message="Tệp NIfTI rỗng.",
        )

    return (
        StagedFile(
            staging_key=validated_key,
            sha256=digest.hexdigest(),
            size_bytes=total_bytes,
        ),
        staged_path,
    )


def _decompress_gzip_bounded(
    src_path: Path,
    *,
    max_decompressed_bytes: int,
    temp_dir: Path | None = None,
) -> Path:
    with open(src_path, "rb") as magic_probe:
        magic = magic_probe.read(2)
    if magic != b"\x1f\x8b":
        raise AppError(
            status_code=422,
            code="invalid_nifti",
            message="Tệp .nii.gz không đúng chữ ký nén gzip.",
        )

    if temp_dir is not None:
        temp_dir.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix="nifti-decomp-",
        suffix=".nii",
        dir=str(temp_dir) if temp_dir is not None else None,
    )
    os.close(fd)
    tmp_path = Path(tmp_name)
    if os.name != "nt":
        os.chmod(tmp_path, 0o600)
    total_out = 0
    try:
        with gzip.GzipFile(filename=src_path, mode="rb") as gz, open(tmp_path, "wb") as out_file:
            while True:
                try:
                    chunk = gz.read(_CHUNK_SIZE)
                except (EOFError, OSError, gzip.BadGzipFile, zlib.error) as exc:
                    raise AppError(
                        status_code=422,
                        code="invalid_nifti",
                        message="Tệp .nii.gz bị hỏng hoặc cắt cụt.",
                    ) from exc
                if not chunk:
                    break
                total_out += len(chunk)
                if total_out > max_decompressed_bytes:
                    raise AppError(
                        status_code=413,
                        code="payload_too_large",
                        message="Kích thước sau giải nén vượt quá giới hạn an toàn.",
                    )
                out_file.write(chunk)
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise
    return tmp_path


def _probe_single_file_nifti_class(nii_path: Path) -> type[nib.Nifti1Image | nib.Nifti2Image]:
    """Verify sizeof_hdr and single-file NIfTI magic bytes (n+1\\0 or n+2\\0\\r\\n\\x1a\\n)."""
    with open(nii_path, "rb") as probe:
        head = probe.read(540)
    if len(head) < 4:
        raise AppError(
            status_code=422,
            code="invalid_nifti",
            message="Tệp NIfTI quá ngắn, không có header hợp lệ.",
        )
    size_le = struct.unpack("<i", head[:4])[0]
    size_be = struct.unpack(">i", head[:4])[0]
    if 348 in (size_le, size_be):
        if len(head) < 348 or head[344:348] != b"n+1\x00":
            raise AppError(
                status_code=422,
                code="invalid_nifti",
                message="Tệp NIfTI-1 không đúng chữ ký single-file (n+1\\x00).",
            )
        return nib.Nifti1Image
    if 540 in (size_le, size_be):
        if len(head) < 540 or head[4:12] != b"n+2\x00\r\n\x1a\n":
            raise AppError(
                status_code=422,
                code="invalid_nifti",
                message="Tệp NIfTI-2 không đúng chữ ký single-file (n+2).",
            )
        return nib.Nifti2Image
    raise AppError(
        status_code=422,
        code="invalid_nifti",
        message="Header NIfTI không đúng kích thước chuẩn (348 hoặc 540 bytes).",
    )


def _inspect_nifti_file(
    nii_path: Path,
    *,
    max_decompressed_bytes: int = DEFAULT_MAX_DECOMPRESSED_BYTES,
) -> tuple[list[int], list[float], list[list[float]], str, str]:
    image_cls = _probe_single_file_nifti_class(nii_path)

    with open(nii_path, "rb") as fh_obj:
        fh = nib.FileHolder(fileobj=fh_obj)
        file_map = {"header": fh, "image": fh}
        try:
            img = image_cls.from_file_map(file_map, mmap=False)
        except _NIFTI_HEADER_ERRORS as exc:
            raise AppError(
                status_code=422,
                code="invalid_nifti",
                message="Không thể đọc header NIfTI hợp lệ.",
            ) from exc

        try:
            try:
                shape = [int(dim) for dim in img.shape]
                if len(shape) != 3 or any(dim <= 0 for dim in shape):
                    raise AppError(
                        status_code=422,
                        code="invalid_nifti",
                        message="Chỉ chấp nhận ảnh NIfTI scalar 3D có kích thước dương.",
                    )

                dtype = img.get_data_dtype()
                if dtype.fields is not None or dtype.kind not in {"i", "u", "f"}:
                    raise AppError(
                        status_code=422,
                        code="invalid_nifti",
                        message=(
                            "Chỉ chấp nhận dữ liệu cường độ số thực hoặc số nguyên "
                            "(không nhận RGB/complex)."
                        ),
                    )

                spatial_unit, _ = img.header.get_xyzt_units()
                unit_scale = _SPATIAL_UNIT_SCALE_TO_MM.get(str(spatial_unit))
                if unit_scale is None:
                    raise AppError(
                        status_code=422,
                        code="invalid_nifti",
                        message="Đơn vị không gian NIfTI không xác định hoặc không được hỗ trợ.",
                    )

                qform_raw, qcode = img.header.get_qform(coded=True)
                sform_raw, scode = img.header.get_sform(coded=True)
                qcode_int = int(qcode)
                scode_int = int(scode)
                if qcode_int < 0 or scode_int < 0:
                    raise AppError(
                        status_code=422,
                        code="invalid_nifti",
                        message="Mã qform_code/sform_code của NIfTI không hợp lệ.",
                    )
                if qcode_int == 0 and scode_int == 0:
                    raise AppError(
                        status_code=422,
                        code="invalid_nifti",
                        message="Tệp NIfTI thiếu hệ tọa độ không gian vật lý (qform/sform).",
                    )

                raw_vox_offset = int(img.header.get_data_offset())
                single_vox_offset = int(img.header.single_vox_offset)
            except AppError:
                raise
            except _NIFTI_HEADER_ERRORS as exc:
                raise AppError(
                    status_code=422,
                    code="invalid_nifti",
                    message="Header NIfTI chứa trường dữ liệu không hợp lệ hoặc bị hỏng.",
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
                        code="invalid_nifti",
                        message="Ma trận qform và sform của NIfTI mâu thuẫn đáng kể.",
                    )

            affine_mm = sform_mm if sform_mm is not None else qform_mm
            if affine_mm is None or affine_mm.shape != (4, 4) or not np.isfinite(affine_mm).all():
                raise AppError(
                    status_code=422,
                    code="invalid_nifti",
                    message="Ma trận affine không hợp lệ.",
                )

            det = abs(float(np.linalg.det(affine_mm[:3, :3])))
            if not np.isfinite(det) or det <= 1e-8:
                raise AppError(
                    status_code=422,
                    code="invalid_nifti",
                    message="Ma trận affine suy biến (không khả nghịch).",
                )

            spacing_mm = [float(np.linalg.norm(affine_mm[:3, idx])) for idx in range(3)]
            if any(not np.isfinite(s) or s <= 0.0 for s in spacing_mm):
                raise AppError(
                    status_code=422,
                    code="invalid_nifti",
                    message="Voxel spacing phải dương và hữu hạn.",
                )

            _, orientation = extract_valid_orientation(affine_mm)

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
            file_size = nii_path.stat().st_size
            if effective_vox_offset + raw_voxel_bytes > file_size:
                raise AppError(
                    status_code=422,
                    code="invalid_nifti",
                    message=(
                        "Header NIfTI khai báo kích thước voxel vượt quá dung lượng tệp thực tế."
                    ),
                )
            if raw_voxel_bytes > max_decompressed_bytes:
                raise AppError(
                    status_code=413,
                    code="payload_too_large",
                    message="Kích thước dữ liệu voxel vượt quá giới hạn an toàn.",
                )

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
                                message="Dữ liệu voxel NIfTI bị hỏng hoặc cắt cụt.",
                            ) from exc

                        if slab.shape != (x1 - x0, y1 - y0, z1 - z0):
                            raise AppError(
                                status_code=422,
                                code="invalid_nifti",
                                message="Kích thước dữ liệu voxel không khớp với header.",
                            )

                        if not np.isfinite(slab).all():
                            raise AppError(
                                status_code=422,
                                code="non_finite_intensity",
                                message="Dữ liệu cường độ chứa giá trị NaN hoặc Inf không hợp lệ.",
                            )
                        del slab

            return (
                shape,
                [float(s) for s in spacing_mm],
                [[float(cell) for cell in row] for row in affine_mm.tolist()],
                orientation,
                str(dtype),
            )
        finally:
            img.uncache()


async def validate_and_stage_nifti_upload(
    *,
    upload: UploadFile,
    storage: LocalStorageAdapter,
    max_upload_bytes: int = DEFAULT_MAX_UPLOAD_BYTES,
    max_decompressed_bytes: int = DEFAULT_MAX_DECOMPRESSED_BYTES,
) -> ValidatedNiftiUpload:
    """Stream an uploaded NIfTI file to staging, decompress safely if .nii.gz, and validate."""
    is_gzip, media_type = _detect_nifti_extension(upload.filename)
    staged_file, staged_path = await _stream_upload_to_staging(
        upload=upload,
        storage=storage,
        max_upload_bytes=max_upload_bytes,
    )

    temp_nii: Path | None = None
    try:
        if is_gzip:
            temp_nii = _decompress_gzip_bounded(
                staged_path,
                max_decompressed_bytes=max_decompressed_bytes,
                temp_dir=storage.staging_root,
            )
            inspect_path = temp_nii
        else:
            inspect_path = staged_path

        shape, spacing_mm, affine, orientation, datatype = _inspect_nifti_file(
            inspect_path,
            max_decompressed_bytes=max_decompressed_bytes,
        )
    except Exception:
        staged_path.unlink(missing_ok=True)
        raise
    finally:
        if temp_nii is not None:
            temp_nii.unlink(missing_ok=True)

    return ValidatedNiftiUpload(
        staged_file=staged_file,
        media_type=media_type,
        shape=shape,
        spacing_mm=spacing_mm,
        affine=affine,
        orientation=orientation,
        datatype=datatype,
        size_bytes=staged_file.size_bytes,
        sha256=staged_file.sha256,
    )
