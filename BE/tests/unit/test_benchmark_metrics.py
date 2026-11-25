"""Unit tests for BraTS AI-vs-GT benchmark metrics evaluation."""

from __future__ import annotations

import numpy as np
import pytest

from app.services.benchmark_metrics import compute_binary_metrics, evaluate_benchmark_masks

_EYE_AFFINE = [
    [1.0, 0.0, 0.0, 0.0],
    [0.0, 1.0, 0.0, 0.0],
    [0.0, 0.0, 1.0, 0.0],
    [0.0, 0.0, 0.0, 1.0],
]


def test_compute_binary_metrics_both_empty_returns_ones() -> None:
    gt = np.zeros((4, 4, 4), dtype=np.uint8)
    pred = np.zeros((4, 4, 4), dtype=np.uint8)
    m = compute_binary_metrics(pred > 0, gt > 0, voxel_volume_mm3=1.0)
    assert m["both_empty"] is True
    assert m["dice"] == 1.0
    assert m["iou"] == 1.0
    assert m["precision"] == 1.0
    assert m["recall"] == 1.0
    assert m["gt_voxels"] == 0
    assert m["pred_voxels"] == 0


def test_compute_binary_metrics_partial_overlap_and_volumes() -> None:
    gt = np.zeros((4, 4, 2), dtype=bool)
    pred = np.zeros((4, 4, 2), dtype=bool)
    # GT = 4 voxels, Pred = 4 voxels, TP = 2, FP = 2, FN = 2
    gt[0:2, 0:2, 0] = True
    pred[0:2, 1:3, 0] = True

    # Each voxel = 2.0 mm^3 -> GT = 0.008 mL, Pred = 0.008 mL
    m = compute_binary_metrics(pred, gt, voxel_volume_mm3=2.0)
    assert m["both_empty"] is False
    assert m["tp_voxels"] == 2
    assert m["fp_voxels"] == 2
    assert m["fn_voxels"] == 2
    assert m["dice"] == pytest.approx(0.5)
    assert m["iou"] == pytest.approx(2.0 / 6.0, rel=1e-5)
    assert m["precision"] == pytest.approx(0.5)
    assert m["recall"] == pytest.approx(0.5)
    assert m["gt_volume_ml"] == pytest.approx(0.008)
    assert m["pred_volume_ml"] == pytest.approx(0.008)
    assert m["volume_diff_ml"] == pytest.approx(0.0)


def test_evaluate_benchmark_masks_regions_labels_crop_capture_and_best_slice() -> None:
    gt = np.zeros((10, 10, 5), dtype=np.uint8)
    pred = np.zeros((10, 10, 5), dtype=np.uint8)

    # Slice z=1: small lesion
    gt[1, 1, 1] = 2
    pred[1, 1, 1] = 2

    # Slice z=3: larger lesion across labels 1, 2, 4 -> should win best_slice_z=3
    gt[2:4, 2:4, 3] = 2  # 4 voxels ED
    gt[4, 4, 3] = 1  # 1 voxel NCR/NET
    gt[5, 5, 3] = 4  # 1 voxel ET (TC = {1, 4} = 2 voxels; WT = 6 voxels on z=3, 7 total)
    # Outside crop GT voxel at y=9, x=9, z=3 -> 1 voxel ED missed by crop (total GT WT = 8)
    gt[9, 9, 3] = 2

    pred[2:4, 2:4, 3] = 2
    pred[4, 4, 3] = 1
    pred[5, 5, 3] = 4
    # No ET/TC/ED mismatches at y=9,x=9 on pred

    coverage = {
        "original_shape": [10, 10, 5],
        "pipeline_version": "tda-test-v1",
        "slice_crops": [
            {"z": 1, "x0": 0, "y0": 0, "x1": 6, "y1": 6, "evaluated": True},
            {"z": 3, "x0": 0, "y0": 0, "x1": 7, "y1": 7, "evaluated": True},
        ],
    }

    scaled_affine = [
        [2.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]
    metrics = evaluate_benchmark_masks(pred, gt, scaled_affine, coverage_json=coverage)

    assert metrics["voxel_volume_mm3"] == pytest.approx(2.0)
    assert metrics["best_slice_z"] == 3
    assert metrics["regions"]["ET"]["dice"] == 1.0
    assert metrics["regions"]["TC"]["dice"] == 1.0
    assert metrics["regions"]["WT"]["gt_voxels"] == 8
    assert metrics["regions"]["WT"]["pred_voxels"] == 7
    assert metrics["regions"]["WT"]["tp_voxels"] == 7
    assert metrics["regions"]["WT"]["fn_voxels"] == 1
    assert metrics["regions"]["WT"]["dice"] == pytest.approx(14.0 / 15.0, rel=1e-5)

    assert metrics["labels"]["1"]["dice"] == 1.0
    assert metrics["labels"]["2"]["fn_voxels"] == 1
    assert metrics["labels"]["4"]["dice"] == 1.0

    crop = metrics["crop_capture"]
    assert crop is not None
    assert crop["gt_wt_voxels"] == 8
    assert crop["inside_crop_voxels"] == 7
    assert crop["outside_crop_voxels"] == 1
    assert crop["capture_recall"] == pytest.approx(7.0 / 8.0, rel=1e-5)


def test_evaluate_benchmark_masks_empty_fallback_best_slice() -> None:
    gt = np.zeros((8, 8, 6), dtype=np.uint8)
    pred = np.zeros((8, 8, 6), dtype=np.uint8)
    metrics = evaluate_benchmark_masks(pred, gt, _EYE_AFFINE, coverage_json=None)
    assert metrics["best_slice_z"] == 3
    assert metrics["mean_dice_brats"] == 1.0
    assert metrics["crop_capture"] is None
