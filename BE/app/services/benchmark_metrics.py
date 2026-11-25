"""Quantitative BraTS evaluation metrics for Admin AI benchmarks."""

from __future__ import annotations

import gzip
import io
import math
from typing import Any, BinaryIO

import nibabel as nib
import numpy as np

_BRATS_LABELS: tuple[str, ...] = ("1", "2", "4")


def compute_binary_metrics(
    pred_mask: np.ndarray,
    gt_mask: np.ndarray,
    voxel_volume_mm3: float,
) -> dict[str, Any]:
    """Compute Dice, IoU, Precision, Recall, voxel counts, and physical mL volumes."""
    pred = np.asarray(pred_mask, dtype=bool)
    gt = np.asarray(gt_mask, dtype=bool)
    if pred.shape != gt.shape:
        raise ValueError(f"Mask shapes must match, got pred={pred.shape} vs gt={gt.shape}")

    tp = int(np.count_nonzero(pred & gt))
    fp = int(np.count_nonzero(pred & (~gt)))
    fn = int(np.count_nonzero((~pred) & gt))
    pred_voxels = tp + fp
    gt_voxels = tp + fn
    both_empty = gt_voxels == 0 and pred_voxels == 0

    if both_empty:
        dice = 1.0
        iou = 1.0
        precision = 1.0
        recall = 1.0
    else:
        union = tp + fp + fn
        dice = (2.0 * tp) / (pred_voxels + gt_voxels)
        iou = (tp / union) if union > 0 else 0.0
        precision = (tp / pred_voxels) if pred_voxels > 0 else 0.0
        recall = (tp / gt_voxels) if gt_voxels > 0 else 0.0

    gt_volume_ml = (gt_voxels * voxel_volume_mm3) / 1000.0
    pred_volume_ml = (pred_voxels * voxel_volume_mm3) / 1000.0
    volume_diff_ml = pred_volume_ml - gt_volume_ml

    return {
        "dice": round(dice, 6),
        "iou": round(iou, 6),
        "precision": round(precision, 6),
        "recall": round(recall, 6),
        "gt_voxels": gt_voxels,
        "pred_voxels": pred_voxels,
        "tp_voxels": tp,
        "fp_voxels": fp,
        "fn_voxels": fn,
        "gt_volume_ml": round(gt_volume_ml, 4),
        "pred_volume_ml": round(pred_volume_ml, 4),
        "volume_diff_ml": round(volume_diff_ml, 4),
        "both_empty": both_empty,
    }


def _compute_crop_capture(
    gt_arr: np.ndarray,
    coverage_json: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if not isinstance(coverage_json, dict):
        return None
    slice_crops = coverage_json.get("slice_crops")
    if not isinstance(slice_crops, list):
        return None

    hx, wy, dz = gt_arr.shape
    in_crop_mask = np.zeros_like(gt_arr, dtype=bool)
    has_bounds = False

    for crop in slice_crops:
        if not isinstance(crop, dict) or not crop.get("evaluated"):
            continue
        z_raw = crop.get("z")
        x0_raw, y0_raw, x1_raw, y1_raw = (
            crop.get("x0"),
            crop.get("y0"),
            crop.get("x1"),
            crop.get("y1"),
        )
        if any(
            isinstance(v, bool) or not isinstance(v, int)
            for v in (z_raw, x0_raw, y0_raw, x1_raw, y1_raw)
        ):
            continue
        z = int(z_raw)
        if z < 0 or z >= dz:
            continue
        y0 = max(0, int(y0_raw))
        y1 = min(hx, int(y1_raw))
        x0 = max(0, int(x0_raw))
        x1 = min(wy, int(x1_raw))
        if y1 > y0 and x1 > x0:
            in_crop_mask[y0:y1, x0:x1, z] = True
            has_bounds = True

    if not has_bounds:
        # Also support single 3D bbox format if ever emitted (`crop_bbox` / `bbox`).
        bbox = coverage_json.get("crop_bbox") or coverage_json.get("bbox")
        if isinstance(bbox, dict) and all(
            not isinstance(bbox.get(k), bool) and isinstance(bbox.get(k), int)
            for k in ("x_start", "x_end", "y_start", "y_end", "z_start", "z_end")
        ):
            y0 = max(0, int(bbox["y_start"]))
            y1 = min(hx, int(bbox["y_end"]))
            x0 = max(0, int(bbox["x_start"]))
            x1 = min(wy, int(bbox["x_end"]))
            z0 = max(0, int(bbox["z_start"]))
            z1 = min(dz, int(bbox["z_end"]))
            if y1 > y0 and x1 > x0 and z1 > z0:
                in_crop_mask[y0:y1, x0:x1, z0:z1] = True
                has_bounds = True

    if not has_bounds:
        return None

    gt_wt = gt_arr > 0
    total_gt_wt = int(np.count_nonzero(gt_wt))
    inside = int(np.count_nonzero(gt_wt & in_crop_mask))
    outside = total_gt_wt - inside
    capture_recall = (inside / total_gt_wt) if total_gt_wt > 0 else 1.0
    return {
        "gt_wt_voxels": total_gt_wt,
        "inside_crop_voxels": inside,
        "outside_crop_voxels": outside,
        "capture_recall": round(capture_recall, 6),
    }


def evaluate_benchmark_masks(
    pred_arr: np.ndarray,
    gt_arr: np.ndarray,
    affine_mm: list[list[float]],
    coverage_json: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Compute full BraTS quantitative metrics comparing AI mask against doctor GT mask."""
    pred = np.asarray(pred_arr, dtype=np.uint8)
    gt = np.asarray(gt_arr, dtype=np.uint8)
    if pred.ndim != 3 or gt.ndim != 3 or pred.shape != gt.shape:
        raise ValueError(
            f"Expected matching 3D label arrays, got pred={pred.shape} and gt={gt.shape}"
        )

    affine_arr = np.asarray(affine_mm, dtype=np.float64)
    voxel_volume_mm3 = abs(float(np.linalg.det(affine_arr[:3, :3])))
    if not math.isfinite(voxel_volume_mm3) or voxel_volume_mm3 <= 0.0:
        raise ValueError("Affine matrix determinant must be positive and finite")

    regions: dict[str, dict[str, Any]] = {
        "WT": compute_binary_metrics(pred > 0, gt > 0, voxel_volume_mm3),
        "TC": compute_binary_metrics(
            np.isin(pred, (1, 4)),
            np.isin(gt, (1, 4)),
            voxel_volume_mm3,
        ),
        "ET": compute_binary_metrics(pred == 4, gt == 4, voxel_volume_mm3),
    }

    labels: dict[str, dict[str, Any]] = {
        lbl: compute_binary_metrics(pred == int(lbl), gt == int(lbl), voxel_volume_mm3)
        for lbl in _BRATS_LABELS
    }

    mean_dice_brats = round(
        (regions["WT"]["dice"] + regions["TC"]["dice"] + regions["ET"]["dice"]) / 3.0,
        6,
    )

    union_fg = (gt > 0) | (pred > 0)
    per_slice_fg = union_fg.sum(axis=(0, 1))
    max_fg = int(per_slice_fg.max()) if per_slice_fg.size > 0 else 0
    best_slice_z = int(np.argmax(per_slice_fg)) if max_fg > 0 else int(pred.shape[2] // 2)

    crop_capture = _compute_crop_capture(gt, coverage_json)

    return {
        "voxel_volume_mm3": round(voxel_volume_mm3, 6),
        "mean_dice_brats": mean_dice_brats,
        "best_slice_z": best_slice_z,
        "regions": regions,
        "labels": labels,
        "crop_capture": crop_capture,
    }


def _load_canonical_nii_gz_array(handle: BinaryIO) -> np.ndarray:
    with gzip.GzipFile(fileobj=handle, mode="rb") as gz:
        bio = io.BytesIO(gz.read())
    fh = nib.FileHolder(fileobj=bio)
    img = nib.Nifti1Image.from_file_map({"header": fh, "image": fh}, mmap=False)
    try:
        return np.rint(np.asarray(img.dataobj)).astype(np.uint8)
    finally:
        img.uncache()


def evaluate_benchmark_mask_streams(
    *,
    pred_stream: BinaryIO,
    gt_stream: BinaryIO,
    affine_mm: list[list[float]],
    coverage_json: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Load canonical .nii.gz mask streams and compute full BraTS metrics."""
    pred_arr = _load_canonical_nii_gz_array(pred_stream)
    gt_arr = _load_canonical_nii_gz_array(gt_stream)
    return evaluate_benchmark_masks(
        pred_arr=pred_arr,
        gt_arr=gt_arr,
        affine_mm=affine_mm,
        coverage_json=coverage_json,
    )
