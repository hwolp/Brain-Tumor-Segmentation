from __future__ import annotations

import json
import re
import shutil
import sys
from pathlib import Path

import nibabel as nib
import numpy as np
import pytest
import torch

try:
    from worker import (
        CheckpointVerificationError,
        InputGeometryError,
        ManifestValidationError,
        TDASegUNet,
        automatic_flair_center,
        compute_sha256,
        crop_centered,
        load_manifest,
        load_model_from_manifest,
        load_verified_model,
        make_tda_channels,
        restore_patch_to_slice,
        run_case,
        zscore_volume,
    )
except ModuleNotFoundError:
    from BE.worker import (
        CheckpointVerificationError,
        InputGeometryError,
        ManifestValidationError,
        TDASegUNet,
        automatic_flair_center,
        compute_sha256,
        crop_centered,
        load_manifest,
        load_model_from_manifest,
        load_verified_model,
        make_tda_channels,
        restore_patch_to_slice,
        run_case,
        zscore_volume,
    )


REPO_ROOT = Path(__file__).resolve().parents[3]
MANIFEST_PATH = REPO_ROOT / "BE" / "worker" / "manifest.json"
DEFAULT_CHECKPOINT = Path(r"D:\Nam4\Ky1\PBL6\Demo2\outputs\tda_seg_unet_cce_dice\best.pt")
BRATS_CASE_001_DIR = Path(
    r"D:\Nam4\Ky1\PBL6\BraTS2020_TrainingData\MICCAI_BraTS2020_TrainingData\BraTS20_Training_001"
)


def _write_nifti(
    path: Path,
    data: np.ndarray,
    affine: np.ndarray,
    *,
    xyz_unit: str = "mm",
    qform: np.ndarray | None = None,
    qform_code: int = 1,
    sform: np.ndarray | None = None,
    sform_code: int = 1,
) -> Path:
    img = nib.Nifti1Image(data, affine)
    img.header.set_xyzt_units(xyz_unit, "unknown")
    if qform_code > 0:
        img.set_qform(affine if qform is None else qform, code=qform_code)
    else:
        img.set_qform(None, code=0)
    if sform_code > 0:
        img.set_sform(affine if sform is None else sform, code=sform_code)
    else:
        img.set_sform(None, code=0)
    nib.save(img, str(path))
    return path


def _make_manifest_with_checkpoint(tmp_path: Path, ckpt_path: Path) -> dict:
    manifest, _ = load_manifest(MANIFEST_PATH)
    manifest["default_checkpoint_path"] = str(ckpt_path)
    manifest["checkpoint_sha256"] = compute_sha256(ckpt_path)
    return manifest


def _save_dummy_checkpoint(path: Path, state_dict: dict | None = None, zero_predict_empty: bool = False) -> Path:
    model = TDASegUNet(in_channels=6, num_classes=4, base=16)
    if zero_predict_empty:
        with torch.no_grad():
            model.out.weight.zero_()
            model.out.bias.copy_(torch.tensor([5.0, -5.0, -5.0, -5.0]))
    torch.save({"epoch": 1, "model": state_dict or model.state_dict()}, path)
    return path


# ---------------------------------------------------------------------------
# Checkpoint & Manifest Verification Tests
# ---------------------------------------------------------------------------


def test_load_verified_model_real_checkpoint() -> None:
    if not DEFAULT_CHECKPOINT.is_file():
        pytest.skip(f"Real checkpoint not available at {DEFAULT_CHECKPOINT}")

    manifest, _ = load_manifest(MANIFEST_PATH)
    expected_sha = manifest["checkpoint_sha256"]
    assert compute_sha256(DEFAULT_CHECKPOINT) == expected_sha

    model = load_model_from_manifest(MANIFEST_PATH, device="cpu", checkpoint_path=DEFAULT_CHECKPOINT)
    assert isinstance(model, TDASegUNet)
    assert not model.training
    assert sum(p.numel() for p in model.parameters()) == 1_943_060

    for attr in ("i", "d1", "d2", "d3", "d4", "u1", "u2", "u3", "u4", "out"):
        assert hasattr(model, attr)

    with torch.inference_mode():
        logits = model(torch.zeros((1, 6, 128, 128), dtype=torch.float32))
    assert logits.shape == (1, 4, 128, 128)
    assert torch.all(logits.argmax(dim=1) == 0)


def test_load_verified_model_rejects_bad_sha256(tmp_path: Path) -> None:
    ckpt = _save_dummy_checkpoint(tmp_path / "dummy.pt")
    with pytest.raises(CheckpointVerificationError, match="SHA-256 mismatch"):
        load_verified_model(ckpt, expected_sha256="0" * 64, device="cpu")


def test_load_verified_model_rejects_missing_model_key_and_shape_mismatch(tmp_path: Path) -> None:
    bad_dict_ckpt = tmp_path / "missing_model_key.pt"
    torch.save({"epoch": 1, "not_model": {"a": torch.ones(2)}}, bad_dict_ckpt)
    with pytest.raises(CheckpointVerificationError, match="missing 'model'"):
        load_verified_model(bad_dict_ckpt, compute_sha256(bad_dict_ckpt), device="cpu")

    sd = TDASegUNet().state_dict()
    sd["out.weight"] = torch.zeros((2, 16, 1, 1), dtype=torch.float32)
    bad_shape_ckpt = _save_dummy_checkpoint(tmp_path / "bad_shape.pt", state_dict=sd)
    with pytest.raises(CheckpointVerificationError, match="shape mismatch"):
        load_verified_model(bad_shape_ckpt, compute_sha256(bad_shape_ckpt), device="cpu")


def test_rejects_unverified_manifest_and_unavailable_cuda(tmp_path: Path) -> None:
    ckpt = _save_dummy_checkpoint(tmp_path / "dummy.pt")
    manifest = _make_manifest_with_checkpoint(tmp_path, ckpt)
    manifest["verification_status"] = "pending"

    flair = _write_nifti(tmp_path / "flair.nii.gz", np.zeros((240, 240, 155), dtype=np.float32), np.eye(4))
    t1ce = _write_nifti(tmp_path / "t1ce.nii.gz", np.zeros((240, 240, 155), dtype=np.float32), np.eye(4))

    with pytest.raises(ManifestValidationError, match="must be 'verified'"):
        run_case(flair, t1ce, manifest, tmp_path / "out", checkpoint_path=ckpt)

    if not torch.cuda.is_available():
        with pytest.raises(RuntimeError, match="CUDA is not available"):
            load_verified_model(ckpt, compute_sha256(ckpt), device="cuda")


# ---------------------------------------------------------------------------
# QA-AI-01: Inference without segmentation or T1/T2 + static code guard
# ---------------------------------------------------------------------------


def test_static_worker_inference_has_no_seg_or_ground_truth_references() -> None:
    worker_dir = REPO_ROOT / "BE" / "worker"
    forbidden_patterns = (
        r"_seg\b",
        r"_seg\.nii",
        r"seg_path",
        r"seg_slice",
        r"ground_truth",
        r"ground_truth_center",
        r"_t1\.nii",
        r"_t2\.nii",
    )
    inference_files = ["__init__.py", "model.py", "preprocess.py", "tda.py", "adapter.py", "manifest.json"]
    for filename in inference_files:
        text = (worker_dir / filename).read_text(encoding="utf-8").lower()
        for pattern in forbidden_patterns:
            assert not re.search(pattern, text), f"Forbidden pattern '{pattern}' found in BE/worker/{filename}"


def test_qa_ai_01_inference_without_seg_t1_t2(tmp_path: Path) -> None:
    src_flair = BRATS_CASE_001_DIR / "BraTS20_Training_001_flair.nii"
    src_t1ce = BRATS_CASE_001_DIR / "BraTS20_Training_001_t1ce.nii"
    if not (src_flair.is_file() and src_t1ce.is_file() and DEFAULT_CHECKPOINT.is_file()):
        pytest.skip("BraTS20_Training_001 or real checkpoint not available")

    isolated = tmp_path / "isolated_case"
    isolated.mkdir()
    iso_flair = isolated / src_flair.name
    iso_t1ce = isolated / src_t1ce.name
    shutil.copy2(src_flair, iso_flair)
    shutil.copy2(src_t1ce, iso_t1ce)

    files_in_dir = [p.name.lower() for p in isolated.iterdir()]
    assert not any("_seg" in name or "_t1." in name or "_t2." in name for name in files_in_dir)

    events: list[tuple[str, int, int]] = []
    out_dir = tmp_path / "out"
    result = run_case(
        flair_path=iso_flair,
        t1ce_path=iso_t1ce,
        model_manifest=MANIFEST_PATH,
        output_dir=out_dir,
        progress_callback=lambda stage, done, total: events.append((stage, done, total)),
        device="cpu",
        slice_indices=[0, 1, 70, 75, 154],
        checkpoint_path=DEFAULT_CHECKPOINT,
    )

    assert result.mask_path.is_file()
    assert result.coverage_path.is_file()
    assert result.metadata_path.is_file()
    assert result.evaluated_slices == 5
    assert result.total_slices == 155
    assert events[0][0] == "loading"
    assert events[-1] == ("done", 5, 5)
    stage_names = [s for s, _, _ in events]
    for required in ("loading", "preprocessing", "inference", "reconstructing", "saving", "done"):
        assert required in stage_names


# ---------------------------------------------------------------------------
# QA-AI-02: Edge-clamped crops, empty slices, and coordinate restoration
# ---------------------------------------------------------------------------


def test_qa_ai_02_crop_clamping_all_four_edges_and_restore() -> None:
    grid = np.zeros((240, 240), dtype=np.float32)
    edge_centers = [
        (0.0, 0.0),
        (5.0, 5.0),
        (235.0, 5.0),
        (5.0, 235.0),
        (235.0, 235.0),
        (239.0, 239.0),
    ]
    expected_top_lefts = [
        (0, 0),
        (0, 0),
        (112, 0),
        (0, 112),
        (112, 112),
        (112, 112),
    ]

    for idx, (center, exp_xy) in enumerate(zip(edge_centers, expected_top_lefts), start=1):
        patch_src = np.zeros_like(grid)
        # Put a unique marker inside the expected clamped window.
        x0_exp, y0_exp = exp_xy
        patch_src[y0_exp + 10, x0_exp + 15] = float(idx)
        patch, (x0, y0) = crop_centered(patch_src, center, patch_size=128)
        assert (x0, y0) == exp_xy
        assert 0 <= x0 <= 240 - 128
        assert 0 <= y0 <= 240 - 128
        assert patch.shape == (128, 128)

        restored = restore_patch_to_slice((patch > 0).astype(np.uint8) * 4, (x0, y0), (240, 240))
        assert restored.dtype == np.uint8
        assert restored[y0_exp + 10, x0_exp + 15] == 4
        assert np.count_nonzero(restored) == 1

    with pytest.raises(ValueError, match="out of range"):
        restore_patch_to_slice(np.ones((128, 128), dtype=np.uint8), (-1, 0), (240, 240))
    with pytest.raises(ValueError, match="out of range"):
        restore_patch_to_slice(np.ones((128, 128), dtype=np.uint8), (113, 0), (240, 240))


def test_qa_ai_02_empty_slice_tda_and_corner_hotspot_adapter(tmp_path: Path) -> None:
    if DEFAULT_CHECKPOINT.is_file():
        manifest, _ = load_manifest(MANIFEST_PATH)
        ckpt = DEFAULT_CHECKPOINT
    else:
        ckpt = _save_dummy_checkpoint(tmp_path / "dummy.pt", zero_predict_empty=True)
        manifest = _make_manifest_with_checkpoint(tmp_path, ckpt)

    # Verify TDA on an all-zero patch produces clean zeros without NaN/Inf.
    zero_tda = make_tda_channels(np.zeros((128, 128), dtype=np.float32), np.zeros((128, 128), dtype=np.float32))
    assert zero_tda.shape == (4, 128, 128)
    assert zero_tda.dtype == np.float32
    assert np.all(zero_tda == 0.0)
    assert np.all(np.isfinite(zero_tda))

    # Build a synthetic volume with:
    # - slice 0: completely empty (all-zero)
    # - slice 1: bright blob near top-left (y=12..24, x=10..22) -> clamps x0=0, y0=0
    # - slice 2: bright blob near bottom-right (y=216..228, x=214..226) -> clamps x0=112, y0=112
    flair_data = np.zeros((240, 240, 155), dtype=np.float32)
    t1ce_data = np.zeros((240, 240, 155), dtype=np.float32)
    flair_data[30:210, 30:210, 1:3] = 10.0
    flair_data[12:24, 10:22, 1] = 200.0
    flair_data[216:228, 214:226, 2] = 200.0
    t1ce_data[12:24, 10:22, 1] = 150.0
    t1ce_data[216:228, 214:226, 2] = 150.0

    # Non-identity BraTS-like affine (LPS reflection + shift).
    affine = np.array(
        [
            [-1.0, 0.0, 0.0, 0.0],
            [0.0, -1.0, 0.0, 239.0],
            [0.0, 0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )
    flair_path = _write_nifti(tmp_path / "flair.nii.gz", flair_data, affine)
    t1ce_path = _write_nifti(tmp_path / "t1ce.nii.gz", t1ce_data, affine)

    # Check zscore & automatic center directly
    norm_flair = zscore_volume(flair_data)
    assert np.all(norm_flair[:, :, 0] == 0.0)
    c_empty = automatic_flair_center(norm_flair[:, :, 0])
    assert c_empty == (120.0, 120.0)

    result = run_case(
        flair_path=flair_path,
        t1ce_path=t1ce_path,
        model_manifest=manifest,
        output_dir=tmp_path / "out",
        slice_indices=[0, 1, 2],
        checkpoint_path=ckpt,
    )

    crops_by_z = {item["z"]: item for item in result.coverage["slice_crops"]}
    assert crops_by_z[0]["is_empty_slice"] is True
    assert crops_by_z[0]["evaluated"] is True
    assert crops_by_z[0]["x0"] == 56 and crops_by_z[0]["y0"] == 56

    assert crops_by_z[1]["is_empty_slice"] is False
    assert crops_by_z[1]["x0"] == 0 and crops_by_z[1]["y0"] == 0

    assert crops_by_z[2]["is_empty_slice"] is False
    assert crops_by_z[2]["x0"] == 112 and crops_by_z[2]["y0"] == 112

    loaded_mask = np.asarray(nib.load(str(result.mask_path)).dataobj)
    assert np.all(loaded_mask[:, :, 0] == 0)


# ---------------------------------------------------------------------------
# QA-AI-03: Raw label mapping, dtype, NIfTI round-trip, and coverage metadata
# ---------------------------------------------------------------------------


def test_qa_ai_03_labels_dtype_nifti_roundtrip_and_coverage(tmp_path: Path) -> None:
    src_flair = BRATS_CASE_001_DIR / "BraTS20_Training_001_flair.nii"
    src_t1ce = BRATS_CASE_001_DIR / "BraTS20_Training_001_t1ce.nii"
    if not (src_flair.is_file() and src_t1ce.is_file() and DEFAULT_CHECKPOINT.is_file()):
        pytest.skip("BraTS20_Training_001 or real checkpoint not available")

    iso_dir = tmp_path / "case"
    iso_dir.mkdir()
    iso_flair = iso_dir / src_flair.name
    iso_t1ce = iso_dir / src_t1ce.name
    shutil.copy2(src_flair, iso_flair)
    shutil.copy2(src_t1ce, iso_t1ce)

    out_dir = tmp_path / "out"
    result = run_case(
        flair_path=iso_flair,
        t1ce_path=iso_t1ce,
        model_manifest=MANIFEST_PATH,
        output_dir=out_dir,
        device="cpu",
        slice_indices=[68, 70, 72, 75, 80],
        checkpoint_path=DEFAULT_CHECKPOINT,
    )

    ref_img = nib.load(str(iso_flair))
    out_img = nib.load(str(result.mask_path))
    mask_arr = np.asarray(out_img.dataobj)

    assert out_img.shape == (240, 240, 155)
    assert mask_arr.dtype == np.uint8
    unique = set(np.unique(mask_arr).tolist())
    assert unique.issubset({0, 1, 2, 4})
    assert 3 not in unique
    assert 4 in unique  # Real tumor core/ET slices in BraTS20_Training_001 include ET label 4

    assert np.allclose(out_img.affine, ref_img.affine, rtol=0.0, atol=1e-6)
    assert np.allclose(out_img.header.get_zooms()[:3], ref_img.header.get_zooms()[:3], rtol=0.0, atol=1e-6)
    assert out_img.header.get_xyzt_units() == ref_img.header.get_xyzt_units()
    ref_q, ref_qc = ref_img.get_qform(coded=True)
    out_q, out_qc = out_img.get_qform(coded=True)
    assert int(out_qc) == int(ref_qc)
    assert np.allclose(out_q, ref_q, rtol=0.0, atol=1e-5)
    ref_s, ref_sc = ref_img.get_sform(coded=True)
    out_s, out_sc = out_img.get_sform(coded=True)
    assert int(out_sc) == int(ref_sc)
    assert np.allclose(out_s, ref_s, rtol=0.0, atol=1e-5)

    cov = json.loads(result.coverage_path.read_text(encoding="utf-8"))
    assert cov["original_shape"] == [240, 240, 155]
    assert cov["unevaluated_outside_crop"] is True
    assert len(cov["slice_crops"]) == 155
    evaluated = [c for c in cov["slice_crops"] if c["evaluated"]]
    unevaluated = [c for c in cov["slice_crops"] if not c["evaluated"]]
    assert [c["z"] for c in evaluated] == [68, 70, 72, 75, 80]
    assert len(unevaluated) == 150
    assert all(c["x0"] is None and c["y0"] is None for c in unevaluated)

    meta = json.loads(result.metadata_path.read_text(encoding="utf-8"))
    assert set(meta["group_volumes_mm3"].keys()) == {"WT", "TC", "ET"}
    assert set(meta["label_voxel_counts"].keys()) == {"0", "1", "2", "4"}
    assert set(meta["label_volumes_mm3"].keys()) == {"0", "1", "2", "4"}
    assert set(meta["stage_timings_ms"].keys()) == {"load", "preprocess", "tda", "inference", "reconstruct", "save"}
    assert meta["peak_ram_mb"] > 0.0
    assert meta["device"] == "cpu"


def test_unit_conversion_meter_vs_mm_accepted(tmp_path: Path) -> None:
    ckpt = _save_dummy_checkpoint(tmp_path / "dummy.pt")
    manifest = _make_manifest_with_checkpoint(tmp_path, ckpt)

    affine_mm = np.eye(4, dtype=np.float64)
    affine_m = np.eye(4, dtype=np.float64)
    affine_m[:3, :] *= 0.001  # 1 mm expressed in meters

    flair = _write_nifti(tmp_path / "flair.nii.gz", np.zeros((240, 240, 155), dtype=np.float32), affine_mm, xyz_unit="mm")
    t1ce = _write_nifti(tmp_path / "t1ce.nii.gz", np.zeros((240, 240, 155), dtype=np.float32), affine_m, xyz_unit="meter")

    result = run_case(flair, t1ce, manifest, tmp_path / "out", slice_indices=[0], checkpoint_path=ckpt)
    assert result.output_shape == (240, 240, 155)


# ---------------------------------------------------------------------------
# Input & Geometry Rejection Tests
# ---------------------------------------------------------------------------


def test_rejects_geometry_and_input_mismatches(tmp_path: Path) -> None:
    ckpt = _save_dummy_checkpoint(tmp_path / "dummy.pt")
    manifest = _make_manifest_with_checkpoint(tmp_path, ckpt)

    valid_data = np.zeros((240, 240, 155), dtype=np.float32)
    affine_eye = np.eye(4, dtype=np.float64)
    valid_flair = _write_nifti(tmp_path / "valid_flair.nii.gz", valid_data, affine_eye)

    # 1. Wrong 3D shape (must not silently crop/resample)
    wrong_shape = _write_nifti(tmp_path / "wrong_shape.nii.gz", np.zeros((128, 128, 155), dtype=np.float32), affine_eye)
    with pytest.raises(InputGeometryError, match="does not match verified profile"):
        run_case(wrong_shape, valid_flair, manifest, tmp_path / "out1", slice_indices=[0], checkpoint_path=ckpt)

    # 2. 4D volume
    vol_4d = _write_nifti(tmp_path / "vol4d.nii.gz", np.zeros((240, 240, 155, 2), dtype=np.float32), affine_eye)
    with pytest.raises(InputGeometryError, match="3D scalar volume"):
        run_case(vol_4d, valid_flair, manifest, tmp_path / "out2", slice_indices=[0], checkpoint_path=ckpt)

    # 3. Non-finite voxel data (NaN)
    nan_data = np.zeros((240, 240, 155), dtype=np.float32)
    nan_data[10, 10, 0] = np.nan
    nan_vol = _write_nifti(tmp_path / "nan.nii.gz", nan_data, affine_eye)
    with pytest.raises(InputGeometryError, match="non-finite"):
        run_case(valid_flair, nan_vol, manifest, tmp_path / "out3", slice_indices=[0], checkpoint_path=ckpt)

    # 4. Spacing mismatch (1.0 mm vs 1.05 mm)
    bad_spacing_aff = np.diag([1.05, 1.0, 1.0, 1.0])
    bad_spacing = _write_nifti(tmp_path / "bad_spacing.nii.gz", valid_data, bad_spacing_aff)
    with pytest.raises(InputGeometryError, match="spacing"):
        run_case(valid_flair, bad_spacing, manifest, tmp_path / "out4", slice_indices=[0], checkpoint_path=ckpt)

    # 5. Same shape & 1mm spacing, but different affine (shifted/flipped axis)
    flipped_aff = np.diag([-1.0, 1.0, 1.0, 1.0])
    flipped_vol = _write_nifti(tmp_path / "flipped.nii.gz", valid_data, flipped_aff)
    with pytest.raises(InputGeometryError, match="Affine mismatch"):
        run_case(valid_flair, flipped_vol, manifest, tmp_path / "out5", slice_indices=[0], checkpoint_path=ckpt)

    # 6. Singular affine (det == 0, unit column norms so spacing is 1mm while matrix is rank-deficient)
    singular_aff = np.array(
        [[1.0, 1.0, 0.0, 0.0], [0.0, 0.0, 0.0, 0.0], [0.0, 0.0, 1.0, 0.0], [0.0, 0.0, 0.0, 1.0]],
        dtype=np.float64,
    )
    singular_img = nib.Nifti1Image(valid_data, affine_eye)
    singular_img.set_qform(None, code=0)
    singular_img.set_sform(singular_aff, code=2)
    singular_img.header.set_xyzt_units("mm", "unknown")
    singular_vol = tmp_path / "singular.nii.gz"
    nib.save(singular_img, str(singular_vol))
    with pytest.raises(InputGeometryError, match="singular"):
        run_case(valid_flair, singular_vol, manifest, tmp_path / "out6", slice_indices=[0], checkpoint_path=ckpt)

    # 7. Missing both qform and sform (qform_code=0 and sform_code=0)
    no_xform = _write_nifti(
        tmp_path / "no_xform.nii.gz",
        valid_data,
        affine_eye,
        qform_code=0,
        sform_code=0,
    )
    with pytest.raises(InputGeometryError, match="physical coordinate"):
        run_case(valid_flair, no_xform, manifest, tmp_path / "out7", slice_indices=[0], checkpoint_path=ckpt)


def test_run_case_with_preloaded_model_skips_checkpoint_resolution(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seed_ckpt = _save_dummy_checkpoint(tmp_path / "seed.pt", zero_predict_empty=True)
    expected_sha = compute_sha256(seed_ckpt)
    preloaded_model = load_verified_model(seed_ckpt, expected_sha256=expected_sha, device="cpu")
    assert preloaded_model.checkpoint_sha256 == expected_sha
    seed_ckpt.unlink()

    manifest, _ = load_manifest(MANIFEST_PATH)
    manifest["default_checkpoint_path"] = str(tmp_path / "nonexistent_checkpoint.pt")
    manifest["checkpoint_sha256"] = expected_sha
    monkeypatch.delenv("MODEL_CHECKPOINT_PATH", raising=False)

    affine = np.eye(4, dtype=np.float64)
    flair = _write_nifti(tmp_path / "flair.nii.gz", np.zeros((240, 240, 155), dtype=np.float32), affine)
    t1ce = _write_nifti(tmp_path / "t1ce.nii.gz", np.zeros((240, 240, 155), dtype=np.float32), affine)

    # First verify without monkeypatching that missing default_checkpoint_path does not fail.
    result = run_case(
        flair_path=flair,
        t1ce_path=t1ce,
        model_manifest=manifest,
        output_dir=tmp_path / "out_unpatched",
        device="cpu",
        slice_indices=[0],
        checkpoint_path=None,
        preloaded_model=preloaded_model,
    )
    assert result.mask_path.is_file()
    assert result.evaluated_slices == 1
    assert result.label_voxel_counts["0"] == 240 * 240 * 155

    # Unverified TDASegUNet or mismatched checkpoint_sha256 must be rejected!
    unverified_model = TDASegUNet(in_channels=6, num_classes=4, base=16)
    with pytest.raises(CheckpointVerificationError, match="checkpoint_sha256"):
        run_case(
            flair_path=flair,
            t1ce_path=t1ce,
            model_manifest=manifest,
            output_dir=tmp_path / "out_unverified",
            device="cpu",
            slice_indices=[0],
            checkpoint_path=None,
            preloaded_model=unverified_model,
        )

    # Also assert explicitly that resolve_checkpoint_path is never invoked.
    adapter_module = sys.modules[run_case.__module__]
    resolve_calls = 0

    def fail_if_resolved(*args, **kwargs):
        nonlocal resolve_calls
        resolve_calls += 1
        raise AssertionError("resolve_checkpoint_path must not be called when preloaded_model is provided")

    monkeypatch.setattr(adapter_module, "resolve_checkpoint_path", fail_if_resolved)
    result2 = run_case(
        flair_path=flair,
        t1ce_path=t1ce,
        model_manifest=manifest,
        output_dir=tmp_path / "out_spied",
        device="cpu",
        slice_indices=[0],
        checkpoint_path=None,
        preloaded_model=preloaded_model,
    )
    assert resolve_calls == 0
    assert result2.mask_path.is_file()


def test_adapter_slice_axis_oblique_rejection_tda_params_and_worker_service(
    tmp_path: Path,
) -> None:
    import httpx

    try:
        from worker.service import InferenceWorker
    except ModuleNotFoundError:
        from BE.worker.service import InferenceWorker

    ckpt = _save_dummy_checkpoint(tmp_path / "dummy.pt", zero_predict_empty=True)
    manifest = _make_manifest_with_checkpoint(tmp_path, ckpt)

    # 1. slice_axis != 2 rejected
    bad_axis_manifest = json.loads(json.dumps(manifest))
    bad_axis_manifest["input_profile"]["slice_axis"] = 0
    flair = _write_nifti(
        tmp_path / "flair.nii.gz", np.zeros((240, 240, 155), dtype=np.float32), np.eye(4)
    )
    t1ce = _write_nifti(
        tmp_path / "t1ce.nii.gz", np.zeros((240, 240, 155), dtype=np.float32), np.eye(4)
    )
    with pytest.raises(ManifestValidationError, match="slice_axis=2"):
        run_case(flair, t1ce, bad_axis_manifest, tmp_path / "out_ax", slice_indices=[0], checkpoint_path=ckpt)

    # 2. Oblique volume rejected by adapter
    theta = np.deg2rad(15.0)
    oblique_aff = np.eye(4, dtype=np.float64)
    oblique_aff[:3, :3] = np.array(
        [
            [1.0, 0.0, 0.0],
            [0.0, np.cos(theta), -np.sin(theta)],
            [0.0, np.sin(theta), np.cos(theta)],
        ],
        dtype=np.float64,
    )
    obl_flair = _write_nifti(
        tmp_path / "obl_flair.nii.gz", np.zeros((240, 240, 155), dtype=np.float32), oblique_aff
    )
    obl_t1ce = _write_nifti(
        tmp_path / "obl_t1ce.nii.gz", np.zeros((240, 240, 155), dtype=np.float32), oblique_aff
    )
    with pytest.raises(InputGeometryError, match="oblique"):
        run_case(obl_flair, obl_t1ce, manifest, tmp_path / "out_obl", slice_indices=[0], checkpoint_path=ckpt)

    # 3. Non-positive TDA parameters rejected
    patch_2d = np.ones((16, 16), dtype=np.float32)
    with pytest.raises(ValueError, match="bandwidth"):
        make_tda_channels(patch_2d, patch_2d, bandwidth=0.0)
    with pytest.raises(ValueError, match="grid_size"):
        make_tda_channels(patch_2d, patch_2d, grid_size=0)
    with pytest.raises(ValueError, match="tda_input_size"):
        make_tda_channels(patch_2d, patch_2d, tda_input_size=0)

    # 4. InferenceWorker 204 claim, 409 stale_attempt vs 422 result_invalid & download error classification
    manifest_file = tmp_path / "manifest.json"
    manifest_file.write_text(json.dumps(manifest), encoding="utf-8")

    fail_reports: list[dict] = []
    mode = {"scenario": "empty_204"}

    def _mock_handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/worker/claim"):
            if mode["scenario"] == "empty_204":
                return httpx.Response(204)
            return httpx.Response(
                200,
                json={
                    "job_id": "job-1",
                    "attempt_id": "att-1",
                    "attempt_number": 1,
                    "lease_token": "l" * 40,
                    "lease_expires_at": "2026-12-31T00:00:00Z",
                    "model_version_id": "tda-seg-unet:cce-dice-ep136",
                    "manifest": manifest,
                    "files": [
                        {
                            "volume_id": "v1",
                            "file_id": "f1",
                            "modality": "flair",
                            "sha256": "a" * 64,
                            "extension": "nii.gz",
                        },
                        {
                            "volume_id": "v2",
                            "file_id": "f2",
                            "modality": "t1ce",
                            "sha256": "b" * 64,
                            "extension": "nii.gz",
                        },
                    ],
                },
            )
        if "/files/" in path:
            if mode["scenario"] == "download_transport_err":
                raise httpx.ConnectError("connection dropped")
            if mode["scenario"] == "stale_409":
                return httpx.Response(409, json={"error": {"code": "stale_attempt"}})
            if mode["scenario"] == "other_409":
                return httpx.Response(409, json={"error": {"code": "unexpected_conflict"}})
            if mode["scenario"] == "invalid_422":
                return httpx.Response(422, json={"error": {"code": "invalid_result_metadata"}})
        if path.endswith("/fail"):
            fail_reports.append(json.loads(request.content.decode("utf-8")))
            return httpx.Response(200, json={"accepted": True})
        return httpx.Response(204)

    worker = InferenceWorker(
        api_base_url="http://worker.test",
        token="secret-worker-token",
        worker_id="w-unit",
        manifest_path=manifest_file,
        checkpoint_path=ckpt,
        device="cpu",
    )
    worker.api.client = httpx.Client(
        transport=httpx.MockTransport(_mock_handler),
        headers={"X-Worker-Token": "secret-worker-token"},
    )
    try:
        # 204 returns None
        assert worker._claim() is None

        # 409 stale_attempt does NOT call /fail
        mode["scenario"] = "stale_409"
        claim_obj = worker._claim()
        assert claim_obj is not None
        worker._run_claim(claim_obj)
        assert fail_reports == []

        # 409 non-stale calls /fail with worker_error
        mode["scenario"] = "other_409"
        worker._run_claim(claim_obj)
        assert fail_reports[-1]["error_code"] == "worker_error"

        # 422 calls /fail with result_invalid
        mode["scenario"] = "invalid_422"
        worker._run_claim(claim_obj)
        assert fail_reports[-1]["error_code"] == "result_invalid"

        # TransportError calls /fail with worker_error
        mode["scenario"] = "download_transport_err"
        worker._run_claim(claim_obj)
        assert fail_reports[-1]["error_code"] == "worker_error"
    finally:
        worker.api.close()
