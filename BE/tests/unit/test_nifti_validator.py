"""Unit tests for NIfTI validation, streaming limits, decompression guards, and geometry checks."""

from __future__ import annotations

import gzip
import io
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest
from starlette.datastructures import UploadFile

from app.core.errors import AppError
from app.core.storage import LocalStorageAdapter
from app.services.nifti_validator import (
    VolumeGeometry,
    check_geometry_compatibility,
    check_model_profile,
    is_axis_aligned_affine,
    validate_and_stage_nifti_upload,
)


@pytest.fixture()
def anyio_backend() -> str:
    return "asyncio"


def _make_nifti_bytes(
    data: np.ndarray,
    affine: np.ndarray | None = None,
    *,
    compressed: bool = True,
    qform_code: int = 1,
    sform_code: int = 1,
    xyzt_units: tuple[str, str] = ("mm", "sec"),
    qform: np.ndarray | None = None,
    sform: np.ndarray | None = None,
) -> bytes:
    if affine is None:
        affine = np.eye(4, dtype=np.float64)
    img = nib.Nifti1Image(data, affine)
    img.header.set_xyzt_units(xyzt_units[0], xyzt_units[1])
    img.set_qform(qform if qform is not None else affine, code=qform_code)
    img.set_sform(sform if sform is not None else affine, code=sform_code)
    raw_bio = io.BytesIO()
    file_map = img.make_file_map({"image": raw_bio, "header": raw_bio})
    img.to_file_map(file_map)
    raw_bytes = raw_bio.getvalue()
    if compressed:
        return gzip.compress(raw_bytes)
    return raw_bytes


def _make_upload_file(filename: str, payload: bytes) -> UploadFile:
    return UploadFile(filename=filename, file=io.BytesIO(payload))


@pytest.mark.anyio
async def test_valid_brats_nifti_gz_and_nii(tmp_path: Path) -> None:
    storage = LocalStorageAdapter(tmp_path / "storage")
    data = np.zeros((240, 240, 155), dtype=np.float32)
    affine = np.eye(4, dtype=np.float64)

    gz_bytes = _make_nifti_bytes(data, affine, compressed=True)
    result = await validate_and_stage_nifti_upload(
        upload=_make_upload_file("brain_flair.nii.gz", gz_bytes),
        storage=storage,
    )
    assert result.shape == [240, 240, 155]
    assert result.spacing_mm == pytest.approx([1.0, 1.0, 1.0], abs=1e-6)
    assert result.orientation == "RAS"
    assert result.size_bytes == len(gz_bytes)
    assert len(result.sha256) == 64
    compatible, warnings = check_model_profile(
        shape=result.shape,
        spacing_mm=result.spacing_mm,
    )
    assert compatible is True
    assert warnings == []
    assert (storage.staging_root / result.staged_file.staging_key).is_file()

    nii_bytes = _make_nifti_bytes(np.zeros((32, 32, 16), dtype=np.int16), affine, compressed=False)
    result2 = await validate_and_stage_nifti_upload(
        upload=_make_upload_file("small.nii", nii_bytes),
        storage=storage,
    )
    assert result2.shape == [32, 32, 16]
    compatible2, warnings2 = check_model_profile(
        shape=result2.shape,
        spacing_mm=result2.spacing_mm,
    )
    assert compatible2 is False
    assert len(warnings2) >= 1


@pytest.mark.anyio
@pytest.mark.parametrize("filename", ["scan.txt", "scan.dcm", "scan.nii.zip", "noext"])
async def test_rejects_invalid_extension(tmp_path: Path, filename: str) -> None:
    storage = LocalStorageAdapter(tmp_path / "storage")
    with pytest.raises(AppError) as exc_info:
        await validate_and_stage_nifti_upload(
            upload=_make_upload_file(filename, b"dummy"),
            storage=storage,
        )
    assert exc_info.value.status_code == 422
    assert exc_info.value.code == "invalid_file_extension"


@pytest.mark.anyio
async def test_rejects_fake_or_truncated_nifti_and_cleans_staging(tmp_path: Path) -> None:
    storage = LocalStorageAdapter(tmp_path / "storage")
    with pytest.raises(AppError) as exc_info:
        await validate_and_stage_nifti_upload(
            upload=_make_upload_file("fake.nii.gz", b"not a real gzip or nifti"),
            storage=storage,
        )
    assert exc_info.value.status_code == 422
    assert exc_info.value.code == "invalid_nifti"
    assert not storage.staging_root.exists() or list(storage.staging_root.iterdir()) == []

    valid = _make_nifti_bytes(np.ones((16, 16, 16), dtype=np.float32), compressed=True)
    truncated = valid[: len(valid) // 2]
    with pytest.raises(AppError) as exc_info2:
        await validate_and_stage_nifti_upload(
            upload=_make_upload_file("truncated.nii.gz", truncated),
            storage=storage,
        )
    assert exc_info2.value.status_code == 422
    assert exc_info2.value.code == "invalid_nifti"
    assert list(storage.staging_root.iterdir()) == []


@pytest.mark.anyio
async def test_rejects_4d_complex_and_rgb_nifti(tmp_path: Path) -> None:
    storage = LocalStorageAdapter(tmp_path / "storage")

    payload_4d = _make_nifti_bytes(np.zeros((8, 8, 8, 2), dtype=np.float32))
    with pytest.raises(AppError) as exc_4d:
        await validate_and_stage_nifti_upload(
            upload=_make_upload_file("4d.nii.gz", payload_4d),
            storage=storage,
        )
    assert exc_4d.value.status_code == 422
    assert exc_4d.value.code == "invalid_nifti"

    payload_complex = _make_nifti_bytes(np.zeros((8, 8, 8), dtype=np.complex64))
    with pytest.raises(AppError) as exc_complex:
        await validate_and_stage_nifti_upload(
            upload=_make_upload_file("complex.nii.gz", payload_complex),
            storage=storage,
        )
    assert exc_complex.value.status_code == 422
    assert exc_complex.value.code == "invalid_nifti"

    rgb_dtype = np.dtype([("R", "u1"), ("G", "u1"), ("B", "u1")])
    payload_rgb = _make_nifti_bytes(np.zeros((8, 8, 8), dtype=rgb_dtype))
    with pytest.raises(AppError) as exc_rgb:
        await validate_and_stage_nifti_upload(
            upload=_make_upload_file("rgb.nii.gz", payload_rgb),
            storage=storage,
        )
    assert exc_rgb.value.status_code == 422
    assert exc_rgb.value.code == "invalid_nifti"


@pytest.mark.anyio
async def test_rejects_nan_and_inf_intensities(tmp_path: Path) -> None:
    storage = LocalStorageAdapter(tmp_path / "storage")

    arr_nan = np.zeros((8, 8, 8), dtype=np.float32)
    arr_nan[1, 1, 1] = np.nan
    with pytest.raises(AppError) as exc_nan:
        await validate_and_stage_nifti_upload(
            upload=_make_upload_file("nan.nii.gz", _make_nifti_bytes(arr_nan)),
            storage=storage,
        )
    assert exc_nan.value.status_code == 422
    assert exc_nan.value.code == "non_finite_intensity"

    arr_inf = np.zeros((8, 8, 8), dtype=np.float32)
    arr_inf[2, 2, 2] = np.inf
    with pytest.raises(AppError) as exc_inf:
        await validate_and_stage_nifti_upload(
            upload=_make_upload_file("inf.nii.gz", _make_nifti_bytes(arr_inf)),
            storage=storage,
        )
    assert exc_inf.value.status_code == 422
    assert exc_inf.value.code == "non_finite_intensity"


@pytest.mark.anyio
async def test_rejects_missing_qform_sform_singular_affine_and_conflicting_forms(
    tmp_path: Path,
) -> None:
    storage = LocalStorageAdapter(tmp_path / "storage")
    arr = np.zeros((8, 8, 8), dtype=np.float32)

    no_space = _make_nifti_bytes(arr, qform_code=0, sform_code=0)
    with pytest.raises(AppError) as exc_no_space:
        await validate_and_stage_nifti_upload(
            upload=_make_upload_file("nospace.nii.gz", no_space),
            storage=storage,
        )
    assert exc_no_space.value.status_code == 422
    assert exc_no_space.value.code == "invalid_nifti"

    singular = np.diag([1.0, 0.0, 1.0, 1.0])
    with pytest.raises(AppError) as exc_singular:
        await validate_and_stage_nifti_upload(
            upload=_make_upload_file(
                "singular.nii.gz",
                _make_nifti_bytes(arr, np.eye(4), qform_code=0, sform_code=1, sform=singular),
            ),
            storage=storage,
        )
    assert exc_singular.value.status_code == 422
    assert exc_singular.value.code == "invalid_nifti"

    qform = np.eye(4, dtype=np.float64)
    sform = np.diag([-1.0, 1.0, 1.0, 1.0])
    conflict = _make_nifti_bytes(arr, qform=qform, sform=sform, qform_code=1, sform_code=1)
    with pytest.raises(AppError) as exc_conflict:
        await validate_and_stage_nifti_upload(
            upload=_make_upload_file("conflict.nii.gz", conflict),
            storage=storage,
        )
    assert exc_conflict.value.status_code == 422
    assert exc_conflict.value.code == "invalid_nifti"


@pytest.mark.anyio
async def test_converts_meter_units_to_mm(tmp_path: Path) -> None:
    storage = LocalStorageAdapter(tmp_path / "storage")
    arr = np.zeros((8, 8, 8), dtype=np.float32)
    affine_m = np.diag([0.001, 0.001, 0.001, 1.0])
    payload = _make_nifti_bytes(arr, affine_m, xyzt_units=("meter", "sec"))
    result = await validate_and_stage_nifti_upload(
        upload=_make_upload_file("meters.nii.gz", payload),
        storage=storage,
    )
    assert result.spacing_mm == pytest.approx([1.0, 1.0, 1.0], abs=1e-6)
    assert np.allclose(result.affine, np.eye(4), atol=1e-6)


@pytest.mark.anyio
async def test_enforces_streaming_upload_limit_and_decompression_bomb_limit(
    tmp_path: Path,
) -> None:
    storage = LocalStorageAdapter(tmp_path / "storage")
    payload = _make_nifti_bytes(np.zeros((16, 16, 16), dtype=np.float32), compressed=False)

    with pytest.raises(AppError) as exc_upload:
        await validate_and_stage_nifti_upload(
            upload=_make_upload_file("toolarge.nii", payload),
            storage=storage,
            max_upload_bytes=1024,
            max_decompressed_bytes=1024 * 1024,
        )
    assert exc_upload.value.status_code == 413
    assert exc_upload.value.code == "payload_too_large"
    assert list(storage.staging_root.iterdir()) == []

    # Highly compressible NIfTI payload simulating gzip bomb against small decompression limit
    big_zeros = np.zeros((128, 128, 128), dtype=np.float32)  # ~8 MiB uncompressed
    bomb_payload = _make_nifti_bytes(big_zeros, compressed=True)  # very small compressed
    assert len(bomb_payload) < 512 * 1024
    with pytest.raises(AppError) as exc_bomb:
        await validate_and_stage_nifti_upload(
            upload=_make_upload_file("bomb.nii.gz", bomb_payload),
            storage=storage,
            max_upload_bytes=1024 * 1024,
            max_decompressed_bytes=256 * 1024,
        )
    assert exc_bomb.value.status_code == 413
    assert exc_bomb.value.code == "payload_too_large"
    assert list(storage.staging_root.iterdir()) == []

    # Uncompressed .nii whose raw_voxel_bytes > max_decompressed_bytes -> 413 payload_too_large
    nii_2kb = _make_nifti_bytes(np.zeros((8, 8, 8), dtype=np.float32), compressed=False)
    with pytest.raises(AppError) as exc_raw_limit:
        await validate_and_stage_nifti_upload(
            upload=_make_upload_file("over_raw.nii", nii_2kb),
            storage=storage,
            max_upload_bytes=1024 * 1024,
            max_decompressed_bytes=1024,
        )
    assert exc_raw_limit.value.status_code == 413
    assert exc_raw_limit.value.code == "payload_too_large"
    assert list(storage.staging_root.iterdir()) == []


@pytest.mark.anyio
async def test_rejects_forged_giant_dim_header_without_oom(tmp_path: Path) -> None:
    import struct

    storage = LocalStorageAdapter(tmp_path / "storage")
    small_nii = bytearray(
        _make_nifti_bytes(np.zeros((8, 8, 8), dtype=np.float32), compressed=False)
    )
    # Forge dim[1..3] = 10000, 10000, 10000 in NIfTI-1 header (offset 42..48)
    struct.pack_into("<hhh", small_nii, 42, 10000, 10000, 10000)
    with pytest.raises(AppError) as exc_forged:
        await validate_and_stage_nifti_upload(
            upload=_make_upload_file("forged_giant.nii", bytes(small_nii)),
            storage=storage,
        )
    assert exc_forged.value.status_code == 422
    assert exc_forged.value.code == "invalid_nifti"
    assert list(storage.staging_root.iterdir()) == []


@pytest.mark.anyio
async def test_tiled_isfinite_handles_skewed_scaled_nifti(tmp_path: Path) -> None:
    storage = LocalStorageAdapter(tmp_path / "storage")
    # Skewed shape (1_200_000, 1, 1) > max_tile_elems (1_048_576) with slope/inter scaling
    arr = np.ones((1_200_000, 1, 1), dtype=np.float32)
    affine = np.eye(4, dtype=np.float64)
    img = nib.Nifti1Image(arr, affine)
    img.header.set_xyzt_units("mm", "sec")
    img.header.set_slope_inter(2.0, 1.0)
    img.set_qform(affine, code=1)
    img.set_sform(affine, code=1)
    bio = io.BytesIO()
    fmap = img.make_file_map({"image": bio, "header": bio})
    img.to_file_map(fmap)
    ok_payload = gzip.compress(bio.getvalue())

    res = await validate_and_stage_nifti_upload(
        upload=_make_upload_file("wide_ok.nii.gz", ok_payload),
        storage=storage,
    )
    assert res.shape == [1_200_000, 1, 1]

    # Now place NaN in the second tile
    arr_nan = arr.copy()
    arr_nan[1_100_000, 0, 0] = np.nan
    img_nan = nib.Nifti1Image(arr_nan, affine)
    img_nan.header.set_xyzt_units("mm", "sec")
    img_nan.header.set_slope_inter(2.0, 1.0)
    img_nan.set_qform(affine, code=1)
    img_nan.set_sform(affine, code=1)
    bio_nan = io.BytesIO()
    fmap_nan = img_nan.make_file_map({"image": bio_nan, "header": bio_nan})
    img_nan.to_file_map(fmap_nan)

    with pytest.raises(AppError) as exc_nan:
        await validate_and_stage_nifti_upload(
            upload=_make_upload_file("wide_nan.nii.gz", gzip.compress(bio_nan.getvalue())),
            storage=storage,
        )
    assert exc_nan.value.status_code == 422
    assert exc_nan.value.code == "non_finite_intensity"


def test_geometry_compatibility_checks() -> None:
    ref = VolumeGeometry(
        shape=[240, 240, 155],
        spacing_mm=[1.0, 1.0, 1.0],
        affine=np.eye(4).tolist(),
    )
    same_with_tiny_noise = VolumeGeometry(
        shape=[240, 240, 155],
        spacing_mm=[1.00001, 1.0, 1.0],
        affine=np.eye(4).tolist(),
    )
    check_geometry_compatibility(ref, same_with_tiny_noise)

    bad_shape = VolumeGeometry(
        shape=[240, 240, 154],
        spacing_mm=[1.0, 1.0, 1.0],
        affine=np.eye(4).tolist(),
    )
    with pytest.raises(AppError) as exc_shape:
        check_geometry_compatibility(ref, bad_shape)
    assert exc_shape.value.status_code == 422
    assert exc_shape.value.code == "geometry_mismatch"

    bad_spacing = VolumeGeometry(
        shape=[240, 240, 155],
        spacing_mm=[1.001, 1.0, 1.0],
        affine=np.eye(4).tolist(),
    )
    with pytest.raises(AppError) as exc_spacing:
        check_geometry_compatibility(ref, bad_spacing)
    assert exc_spacing.value.status_code == 422
    assert exc_spacing.value.code == "geometry_mismatch"

    shifted_affine = np.eye(4)
    shifted_affine[0, 3] = 0.005
    bad_affine = VolumeGeometry(
        shape=[240, 240, 155],
        spacing_mm=[1.0, 1.0, 1.0],
        affine=shifted_affine.tolist(),
    )
    with pytest.raises(AppError) as exc_affine:
        check_geometry_compatibility(ref, bad_affine)
    assert exc_affine.value.status_code == 422
    assert exc_affine.value.code == "geometry_mismatch"


@pytest.mark.anyio
async def test_accepts_unknown_spatial_units_as_1mm_scale(tmp_path: Path) -> None:
    storage = LocalStorageAdapter(tmp_path / "storage")
    arr = np.zeros((8, 8, 8), dtype=np.float32)
    affine = np.diag([1.25, 1.5, 2.0, 1.0])
    payload = _make_nifti_bytes(arr, affine, xyzt_units=("unknown", "unknown"))
    result = await validate_and_stage_nifti_upload(
        upload=_make_upload_file("unknown_unit.nii.gz", payload),
        storage=storage,
    )
    assert result.spacing_mm == pytest.approx([1.25, 1.5, 2.0], abs=1e-6)
    assert np.allclose(result.affine, affine, atol=1e-6)


@pytest.mark.anyio
async def test_rejects_bad_magic_bytes_corrupt_header_and_ambiguous_axcodes(
    tmp_path: Path,
) -> None:
    import struct

    storage = LocalStorageAdapter(tmp_path / "storage")
    valid_nii = bytearray(
        _make_nifti_bytes(np.zeros((6, 6, 6), dtype=np.float32), compressed=False)
    )

    # 1. NIfTI-1 pair .hdr magic ("ni1\x00" instead of single-file "n+1\x00") -> 422 invalid_nifti
    hdr_magic = bytearray(valid_nii)
    hdr_magic[344:348] = b"ni1\x00"
    with pytest.raises(AppError) as exc_magic:
        await validate_and_stage_nifti_upload(
            upload=_make_upload_file("pair_hdr.nii", bytes(hdr_magic)),
            storage=storage,
        )
    assert exc_magic.value.status_code == 422
    assert exc_magic.value.code == "invalid_nifti"

    # 2. Invalid quaternion (quatern_b = 2.0 -> HeaderDataError on get_qform) -> 422 invalid_nifti
    bad_quat = bytearray(valid_nii)
    struct.pack_into("<f", bad_quat, 256, 2.0)  # quatern_b at byte 256 in NIfTI-1
    with pytest.raises(AppError) as exc_quat:
        await validate_and_stage_nifti_upload(
            upload=_make_upload_file("bad_quat.nii", bytes(bad_quat)),
            storage=storage,
        )
    assert exc_quat.value.status_code == 422
    assert exc_quat.value.code == "invalid_nifti"

    # 3. Degenerate non-independent axis codes (two columns aligned to world X -> ('R', None, 'S'))
    ambig_sform = np.array(
        [
            [1.0, 1.0, 0.0, 0.0],
            [1e-4, -1e-4, 0.0, 0.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )
    ambig_payload = _make_nifti_bytes(
        np.zeros((6, 6, 6), dtype=np.float32),
        np.eye(4),
        qform_code=0,
        sform_code=1,
        sform=ambig_sform,
    )
    with pytest.raises(AppError) as exc_ax:
        await validate_and_stage_nifti_upload(
            upload=_make_upload_file("ambig_ax.nii.gz", ambig_payload),
            storage=storage,
        )
    assert exc_ax.value.status_code == 422
    assert exc_ax.value.code == "invalid_nifti"
    assert not storage.staging_root.exists() or list(storage.staging_root.iterdir()) == []


def test_is_axis_aligned_and_model_profile_blocks_oblique_and_non_axial() -> None:
    lps = [
        [-1.0, 0.0, 0.0, 120.0],
        [0.0, -1.0, 0.0, 120.0],
        [0.0, 0.0, 1.0, -78.0],
        [0.0, 0.0, 0.0, 1.0],
    ]
    assert is_axis_aligned_affine(lps) is True
    ok, warns = check_model_profile(
        shape=[240, 240, 155],
        spacing_mm=[1.0, 1.0, 1.0],
        affine=lps,
        orientation="LPS",
    )
    assert ok is True
    assert warns == []

    # Oblique 15-degree rotation around X with unit spacing & 240x240x155 shape
    theta = np.deg2rad(15.0)
    oblique = np.eye(4, dtype=np.float64)
    oblique[:3, :3] = np.array(
        [
            [1.0, 0.0, 0.0],
            [0.0, np.cos(theta), -np.sin(theta)],
            [0.0, np.sin(theta), np.cos(theta)],
        ],
        dtype=np.float64,
    )
    assert is_axis_aligned_affine(oblique) is False
    ok_obl, warns_obl = check_model_profile(
        shape=[240, 240, 155],
        spacing_mm=[1.0, 1.0, 1.0],
        affine=oblique.tolist(),
        orientation="RAS",
    )
    assert ok_obl is False
    assert any("oblique" in w.lower() for w in warns_obl)

    # Sagittal orientation (slice_axis=2 is R instead of S/I)
    sagittal = [
        [0.0, 0.0, 1.0, 0.0],
        [-1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]
    assert is_axis_aligned_affine(sagittal) is True
    ok_sag, warns_sag = check_model_profile(
        shape=[240, 240, 155],
        spacing_mm=[1.0, 1.0, 1.0],
        affine=sagittal,
        orientation="PSR",
    )
    assert ok_sag is False
    assert any("slice_axis" in w for w in warns_sag)
