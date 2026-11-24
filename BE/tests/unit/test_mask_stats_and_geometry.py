"""Unit tests for Phase P4 mask validation, geometry verification, and volume stats."""

from __future__ import annotations

import gzip
import io
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest

from app.core.errors import AppError
from app.services.mask_version_service import (
    compute_mask_statistics,
    validate_and_canonicalize_mask,
)


def _write_nii_gz(tmp_path: Path, name: str, data: np.ndarray, affine: np.ndarray) -> Path:
    img = nib.Nifti1Image(data, affine)
    img.header.set_xyzt_units("mm", "sec")
    img.set_qform(affine, code=1)
    img.set_sform(affine, code=1)
    bio = io.BytesIO()
    fmap = img.make_file_map({"image": bio, "header": bio})
    img.to_file_map(fmap)
    out = tmp_path / name
    out.write_bytes(gzip.compress(bio.getvalue()))
    return out


def _ref_geom(
    shape: list[int], affine: np.ndarray
) -> tuple[list[int], list[float], list[list[float]]]:
    spacing = [float(np.linalg.norm(affine[:3, i])) for i in range(3)]
    return shape, spacing, [[float(c) for c in row] for row in affine.tolist()]


def test_validate_mask_accepts_uint8_and_integral_float(tmp_path: Path) -> None:
    affine = np.diag([1.0, 1.0, 1.0, 1.0])
    data = np.zeros((6, 6, 6), dtype=np.float32)
    data[1, 1, 1] = 1.0
    data[2, 2, 2] = 2.0
    data[3, 3, 3] = 4.0
    nii_gz = _write_nii_gz(tmp_path, "mask_f32.nii.gz", data, affine)

    shape, spacing, aff_list = _ref_geom([6, 6, 6], affine)
    result = validate_and_canonicalize_mask(
        file_path=nii_gz,
        is_gzip=True,
        ref_shape=shape,
        ref_spacing_mm=spacing,
        ref_affine_mm=aff_list,
    )
    assert result.label_voxel_counts == {"1": 1, "2": 1, "4": 1}

    reloaded = nib.load(str(result.canonical_nii_gz_path))
    try:
        assert reloaded.get_data_dtype() == np.uint8
        arr = np.asarray(reloaded.dataobj)
        assert arr.dtype == np.uint8
        assert int(arr[1, 1, 1]) == 1
        assert int(arr[2, 2, 2]) == 2
        assert int(arr[3, 3, 3]) == 4
        assert np.allclose(reloaded.affine, affine, rtol=0.0, atol=1e-4)
    finally:
        reloaded.uncache()
        result.canonical_nii_gz_path.unlink(missing_ok=True)


def test_validate_mask_rejects_invalid_labels_and_fractional_values(tmp_path: Path) -> None:
    affine = np.eye(4, dtype=np.float64)
    shape, spacing, aff_list = _ref_geom([4, 4, 4], affine)

    # Label 3
    d3 = np.zeros((4, 4, 4), dtype=np.uint8)
    d3[0, 0, 0] = 3
    p3 = _write_nii_gz(tmp_path, "label3.nii.gz", d3, affine)
    with pytest.raises(AppError) as exc3:
        validate_and_canonicalize_mask(
            file_path=p3,
            is_gzip=True,
            ref_shape=shape,
            ref_spacing_mm=spacing,
            ref_affine_mm=aff_list,
        )
    assert exc3.value.status_code == 422
    assert exc3.value.code == "invalid_mask_labels"

    # Fractional float 1.5
    df = np.zeros((4, 4, 4), dtype=np.float32)
    df[1, 1, 1] = 1.5
    pf = _write_nii_gz(tmp_path, "frac.nii.gz", df, affine)
    with pytest.raises(AppError) as excf:
        validate_and_canonicalize_mask(
            file_path=pf,
            is_gzip=True,
            ref_shape=shape,
            ref_spacing_mm=spacing,
            ref_affine_mm=aff_list,
        )
    assert excf.value.status_code == 422
    assert excf.value.code == "invalid_mask_labels"

    # NaN
    dn = np.zeros((4, 4, 4), dtype=np.float32)
    dn[0, 0, 0] = np.nan
    pn = _write_nii_gz(tmp_path, "nan.nii.gz", dn, affine)
    with pytest.raises(AppError) as excn:
        validate_and_canonicalize_mask(
            file_path=pn,
            is_gzip=True,
            ref_shape=shape,
            ref_spacing_mm=spacing,
            ref_affine_mm=aff_list,
        )
    assert excn.value.status_code == 422


def test_validate_mask_rejects_flipped_affine_and_shape_mismatch(tmp_path: Path) -> None:
    ref_aff = np.diag([1.0, 1.0, 1.0, 1.0])
    shape, spacing, aff_list = _ref_geom([4, 4, 4], ref_aff)

    # Flipped X axis
    flipped_aff = np.diag([-1.0, 1.0, 1.0, 1.0])
    d = np.zeros((4, 4, 4), dtype=np.uint8)
    p_flip = _write_nii_gz(tmp_path, "flip.nii.gz", d, flipped_aff)
    with pytest.raises(AppError) as exc_flip:
        validate_and_canonicalize_mask(
            file_path=p_flip,
            is_gzip=True,
            ref_shape=shape,
            ref_spacing_mm=spacing,
            ref_affine_mm=aff_list,
        )
    assert exc_flip.value.status_code == 422
    assert exc_flip.value.code == "geometry_mismatch"

    # Shape mismatch
    d_bad_shape = np.zeros((4, 4, 5), dtype=np.uint8)
    p_shape = _write_nii_gz(tmp_path, "bad_shape.nii.gz", d_bad_shape, ref_aff)
    with pytest.raises(AppError) as exc_shape:
        validate_and_canonicalize_mask(
            file_path=p_shape,
            is_gzip=True,
            ref_shape=shape,
            ref_spacing_mm=spacing,
            ref_affine_mm=aff_list,
        )
    assert exc_shape.value.status_code == 422
    assert exc_shape.value.code == "geometry_mismatch"


def test_compute_mask_statistics_anisotropic_and_rotated_affine() -> None:
    # Anisotropic spacing (1.5, 2.0, 3.0) rotated by 30 deg around Z -> det = 9.0 mm^3
    theta = np.deg2rad(30.0)
    rot = np.array(
        [
            [np.cos(theta), -np.sin(theta), 0.0],
            [np.sin(theta), np.cos(theta), 0.0],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )
    scale = np.diag([1.5, 2.0, 3.0])
    affine = np.eye(4, dtype=np.float64)
    affine[:3, :3] = rot @ scale

    counts = {"1": 10, "2": 20, "4": 5}
    stats = compute_mask_statistics(
        label_voxel_counts=counts,
        affine_mm=[[float(c) for c in row] for row in affine.tolist()],
    )

    assert stats["voxel_volume_mm3"] == pytest.approx(9.0, rel=1e-9)
    assert stats["label_volumes_mm3"]["1"] == pytest.approx(90.0, rel=1e-9)
    assert stats["label_volumes_mm3"]["2"] == pytest.approx(180.0, rel=1e-9)
    assert stats["label_volumes_mm3"]["4"] == pytest.approx(45.0, rel=1e-9)
    # WT={1,2,4}=35*9=315, TC={1,4}=15*9=135, ET={4}=5*9=45
    assert stats["composite_volumes_mm3"]["WT"] == pytest.approx(315.0, rel=1e-9)
    assert stats["composite_volumes_mm3"]["TC"] == pytest.approx(135.0, rel=1e-9)
    assert stats["composite_volumes_mm3"]["ET"] == pytest.approx(45.0, rel=1e-9)
    assert stats["total_foreground_voxels"] == 35
    assert stats["total_foreground_volume_mm3"] == pytest.approx(315.0, rel=1e-9)
    assert stats["total_foreground_volume_ml"] == pytest.approx(0.315, rel=1e-9)


def test_validate_mask_sheared_sform_roundtrip_without_qform_conflict(tmp_path: Path) -> None:
    # Sheared affine cannot be represented by a rigid quaternion qform
    sheared_aff = np.array(
        [
            [1.0, 0.25, 0.0, -10.0],
            [0.0, 1.0, 0.0, -20.0],
            [0.0, 0.0, 1.5, -5.0],
            [0.0, 0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )
    mask_data = np.zeros((6, 6, 4), dtype=np.uint8)
    mask_data[1, 2, 1] = 1
    mask_data[3, 4, 2] = 4

    img = nib.Nifti1Image(mask_data, sheared_aff)
    img.header.set_xyzt_units("unknown", "unknown")
    img.set_qform(None, code=0)
    img.set_sform(sheared_aff, code=2)
    src_path = tmp_path / "sheared_mask.nii.gz"
    bio = io.BytesIO()
    img.to_file_map(img.make_file_map({"image": bio, "header": bio}))
    src_path.write_bytes(gzip.compress(bio.getvalue()))

    shape, spacing, aff_list = _ref_geom([6, 6, 4], sheared_aff)
    staging_dir = tmp_path / "staging"
    canon1 = validate_and_canonicalize_mask(
        file_path=src_path,
        is_gzip=True,
        ref_shape=shape,
        ref_spacing_mm=spacing,
        ref_affine_mm=aff_list,
        temp_dir=staging_dir,
    )
    try:
        assert canon1.canonical_nii_gz_path.parent == staging_dir
        reloaded = nib.load(str(canon1.canonical_nii_gz_path))
        try:
            _, qcode = reloaded.header.get_qform(coded=True)
            sform_out, scode = reloaded.header.get_sform(coded=True)
            assert int(qcode) == 0
            assert int(scode) == 2
            assert np.allclose(sform_out, sheared_aff, rtol=0.0, atol=1e-4)
        finally:
            reloaded.uncache()

        # Re-uploading the canonical exported mask must succeed cleanly with zero qform/sform clash
        canon2 = validate_and_canonicalize_mask(
            file_path=canon1.canonical_nii_gz_path,
            is_gzip=True,
            ref_shape=shape,
            ref_spacing_mm=spacing,
            ref_affine_mm=aff_list,
            temp_dir=staging_dir,
        )
        try:
            assert canon2.label_voxel_counts == {"1": 1, "2": 0, "4": 1}
        finally:
            canon2.canonical_nii_gz_path.unlink(missing_ok=True)
    finally:
        canon1.canonical_nii_gz_path.unlink(missing_ok=True)


def test_validate_mask_rejects_bad_magic_and_corrupt_quaternion(tmp_path: Path) -> None:
    import struct

    affine = np.eye(4, dtype=np.float64)
    shape, spacing, aff_list = _ref_geom([4, 4, 4], affine)
    img = nib.Nifti1Image(np.zeros((4, 4, 4), dtype=np.uint8), affine)
    img.set_qform(affine, code=1)
    img.set_sform(affine, code=1)
    bio = io.BytesIO()
    img.to_file_map(img.make_file_map({"image": bio, "header": bio}))
    raw = bytearray(bio.getvalue())

    bad_magic = bytearray(raw)
    bad_magic[344:348] = b"ni1\x00"
    p_magic = tmp_path / "bad_magic.nii"
    p_magic.write_bytes(bytes(bad_magic))
    with pytest.raises(AppError) as exc_magic:
        validate_and_canonicalize_mask(
            file_path=p_magic,
            is_gzip=False,
            ref_shape=shape,
            ref_spacing_mm=spacing,
            ref_affine_mm=aff_list,
        )
    assert exc_magic.value.status_code == 422
    assert exc_magic.value.code == "invalid_nifti"

    bad_quat = bytearray(raw)
    struct.pack_into("<f", bad_quat, 256, 2.0)
    p_quat = tmp_path / "bad_quat.nii"
    p_quat.write_bytes(bytes(bad_quat))
    with pytest.raises(AppError) as exc_quat:
        validate_and_canonicalize_mask(
            file_path=p_quat,
            is_gzip=False,
            ref_shape=shape,
            ref_spacing_mm=spacing,
            ref_affine_mm=aff_list,
        )
    assert exc_quat.value.status_code == 422
    assert exc_quat.value.code == "invalid_nifti"
