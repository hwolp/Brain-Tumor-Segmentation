from __future__ import annotations

import argparse
import importlib.metadata
import json
import os
import platform
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any

import nibabel as nib
import numpy as np
import psutil
import torch

WORKSPACE_ROOT = Path(__file__).resolve().parents[2]
if str(WORKSPACE_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKSPACE_ROOT))

from BE.worker.adapter import load_manifest, run_case


DEFAULT_CASE_DIR = Path(
    r"D:\Nam4\Ky1\PBL6\BraTS2020_TrainingData\MICCAI_BraTS2020_TrainingData\BraTS20_Training_001"
)
DEFAULT_MANIFEST_PATH = Path(__file__).resolve().with_name("manifest.json")


def _compute_binary_metrics(gt: np.ndarray, pred: np.ndarray) -> dict[str, Any]:
    tp = int(np.count_nonzero(gt & pred))
    fp = int(np.count_nonzero((~gt) & pred))
    fn = int(np.count_nonzero(gt & (~pred)))
    gt_sum = tp + fn
    pred_sum = tp + fp
    union = tp + fp + fn
    dice = (2.0 * tp / (gt_sum + pred_sum)) if (gt_sum + pred_sum) > 0 else 1.0
    iou = (tp / union) if union > 0 else 1.0
    precision = (tp / pred_sum) if pred_sum > 0 else (1.0 if gt_sum == 0 else 0.0)
    recall = (tp / gt_sum) if gt_sum > 0 else 1.0
    return {
        "dice": round(dice, 6),
        "iou": round(iou, 6),
        "precision": round(precision, 6),
        "recall": round(recall, 6),
        "gt_voxels": gt_sum,
        "pred_voxels": pred_sum,
        "tp_voxels": tp,
    }


def _evaluate_against_reference(pred_mask: np.ndarray, seg_path: Path, coverage: dict[str, Any]) -> dict[str, Any]:
    gt_img = nib.load(str(seg_path))
    gt = np.asarray(gt_img.get_fdata(), dtype=np.uint8)
    regions = {
        "WT": (gt > 0, pred_mask > 0),
        "TC": (np.isin(gt, [1, 4]), np.isin(pred_mask, [1, 4])),
        "ET": (gt == 4, pred_mask == 4),
    }
    region_metrics = {name: _compute_binary_metrics(g, p) for name, (g, p) in regions.items()}

    # Measure how many GT tumor voxels fall inside vs outside the automatic 128x128 crops.
    in_crop_mask = np.zeros_like(gt, dtype=bool)
    for crop in coverage["slice_crops"]:
        if crop["evaluated"]:
            z = int(crop["z"])
            x0, y0, x1, y1 = int(crop["x0"]), int(crop["y0"]), int(crop["x1"]), int(crop["y1"])
            in_crop_mask[y0:y1, x0:x1, z] = True

    gt_wt = gt > 0
    total_gt_wt = int(np.count_nonzero(gt_wt))
    gt_inside_crop = int(np.count_nonzero(gt_wt & in_crop_mask))
    gt_outside_crop = total_gt_wt - gt_inside_crop

    return {
        "seg_file": str(seg_path),
        "regions": region_metrics,
        "crop_capture": {
            "total_gt_wt_voxels": total_gt_wt,
            "gt_wt_inside_crop_voxels": gt_inside_crop,
            "gt_wt_outside_crop_voxels": gt_outside_crop,
            "gt_wt_crop_recall": round(gt_inside_crop / total_gt_wt, 6) if total_gt_wt > 0 else 1.0,
        },
    }


def _collect_environment_info() -> dict[str, Any]:
    pkgs = {}
    for name in ("torch", "numpy", "scipy", "nibabel", "gudhi", "scikit-image", "pandas", "psutil", "pytest"):
        try:
            pkgs[name] = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError:
            pkgs[name] = "not-installed"
    return {
        "platform": platform.platform(),
        "python": sys.version.split()[0],
        "processor": platform.processor(),
        "cpu_count_logical": os.cpu_count(),
        "system_ram_gb": round(psutil.virtual_memory().total / (1024.0**3), 2),
        "cuda_available": bool(torch.cuda.is_available()),
        "cuda_device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        "packages": pkgs,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify P0 AI adapter on all 155 slices without _seg at inference.")
    parser.add_argument("--case-dir", type=Path, default=DEFAULT_CASE_DIR)
    parser.add_argument("--case-id", type=str, default=None)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST_PATH)
    parser.add_argument("--checkpoint", type=Path, default=None)
    parser.add_argument("--device", type=str, default="cpu")
    parser.add_argument("--output-dir", type=Path, default=None)
    parser.add_argument("--report-json", type=Path, default=None)
    parser.add_argument("--skip-gt-eval", action="store_true")
    args = parser.parse_args()

    case_dir = args.case_dir.resolve()
    case_id = args.case_id or case_dir.name
    src_flair = case_dir / f"{case_id}_flair.nii"
    src_t1ce = case_dir / f"{case_id}_t1ce.nii"
    if not src_flair.is_file() or not src_t1ce.is_file():
        raise FileNotFoundError(f"Expected {src_flair} and {src_t1ce} to exist")

    manifest, _ = load_manifest(args.manifest.resolve())
    ckpt_arg = args.checkpoint or (Path(os.environ["MODEL_CHECKPOINT_PATH"]) if os.environ.get("MODEL_CHECKPOINT_PATH") else None)

    progress_events: list[dict[str, Any]] = []

    def on_progress(stage: str, completed: int, total: int) -> None:
        progress_events.append({"stage": stage, "completed": completed, "total": total})

    with tempfile.TemporaryDirectory(prefix="p0_verify_") as tmp_root_str:
        tmp_root = Path(tmp_root_str)
        isolated_input = tmp_root / "inputs"
        isolated_input.mkdir(parents=True, exist_ok=True)
        iso_flair = isolated_input / src_flair.name
        iso_t1ce = isolated_input / src_t1ce.name
        shutil.copy2(src_flair, iso_flair)
        shutil.copy2(src_t1ce, iso_t1ce)

        # Assert isolation: strictly FLAIR + T1ce only.
        isolated_names = sorted(p.name for p in isolated_input.iterdir())
        assert isolated_names == sorted([src_flair.name, src_t1ce.name]), (
            f"Isolated directory must contain only FLAIR and T1ce, got {isolated_names}"
        )

        out_dir = args.output_dir.resolve() if args.output_dir else (tmp_root / "outputs")
        result = run_case(
            flair_path=iso_flair,
            t1ce_path=iso_t1ce,
            model_manifest=args.manifest.resolve(),
            output_dir=out_dir,
            progress_callback=on_progress,
            device=args.device,
            slice_indices=None,
            checkpoint_path=ckpt_arg,
        )

        # Round-trip NIfTI verification
        ref_img = nib.load(str(iso_flair))
        out_img = nib.load(str(result.mask_path))
        pred_mask = np.asarray(out_img.dataobj)

        assert out_img.shape == (240, 240, 155), f"Unexpected mask shape: {out_img.shape}"
        assert pred_mask.dtype == np.uint8, f"Unexpected mask dtype: {pred_mask.dtype}"
        unique_labels = [int(v) for v in np.unique(pred_mask)]
        assert set(unique_labels).issubset({0, 1, 2, 4}), f"Invalid mask labels: {unique_labels}"
        assert np.allclose(out_img.affine, ref_img.affine, rtol=0.0, atol=1e-6), "Output affine mismatch"
        assert np.allclose(out_img.header.get_zooms()[:3], ref_img.header.get_zooms()[:3], rtol=0.0, atol=1e-6), (
            "Output zooms mismatch"
        )
        ref_q, ref_qc = ref_img.get_qform(coded=True)
        out_q, out_qc = out_img.get_qform(coded=True)
        assert int(out_qc) == int(ref_qc)
        if ref_qc > 0:
            assert np.allclose(out_q, ref_q, rtol=0.0, atol=1e-5), "Output qform mismatch"
        ref_s, ref_sc = ref_img.get_sform(coded=True)
        out_s, out_sc = out_img.get_sform(coded=True)
        assert int(out_sc) == int(ref_sc)
        if ref_sc > 0:
            assert np.allclose(out_s, ref_s, rtol=0.0, atol=1e-5), "Output sform mismatch"
        assert out_img.header.get_xyzt_units() == ref_img.header.get_xyzt_units(), "Output xyzt_units mismatch"

        coverage = json.loads(result.coverage_path.read_text(encoding="utf-8"))
        metadata = json.loads(result.metadata_path.read_text(encoding="utf-8"))
        assert len(coverage["slice_crops"]) == 155
        assert coverage["unevaluated_outside_crop"] is True
        assert all(entry["evaluated"] is True for entry in coverage["slice_crops"])
        assert progress_events[-1] == {"stage": "done", "completed": 155, "total": 155}

        gt_eval = None
        seg_candidate = case_dir / f"{case_id}_seg.nii"
        if not args.skip_gt_eval and seg_candidate.is_file():
            gt_eval = _evaluate_against_reference(pred_mask, seg_candidate, coverage)

        total_ms = round(sum(result.stage_timings_ms.values()), 3)
        report = {
            "case_id": case_id,
            "isolated_inputs": isolated_names,
            "manifest_model_id": manifest["model_id"],
            "manifest_version": manifest["version"],
            "checkpoint_sha256": metadata["checkpoint_sha256"],
            "device": metadata["device"],
            "environment": _collect_environment_info(),
            "output_verification": {
                "shape": list(out_img.shape),
                "dtype": str(pred_mask.dtype),
                "unique_labels": unique_labels,
                "affine_match": True,
                "zooms_match": True,
                "qform_match": True,
                "sform_match": True,
                "xyzt_units": list(out_img.header.get_xyzt_units()),
                "mask_nii_gz_bytes": result.mask_path.stat().st_size,
            },
            "coverage_summary": {
                "total_slices": coverage["total_slices"],
                "evaluated_slices": coverage["evaluated_slices"],
                "empty_slices": coverage["empty_slices"],
                "empty_slice_indices": [c["z"] for c in coverage["slice_crops"] if c["is_empty_slice"]],
                "unevaluated_outside_crop": coverage["unevaluated_outside_crop"],
            },
            "metadata_summary": {
                "label_voxel_counts": metadata["label_voxel_counts"],
                "label_volumes_mm3": metadata["label_volumes_mm3"],
                "group_volumes_mm3": metadata["group_volumes_mm3"],
                "stage_timings_ms": metadata["stage_timings_ms"],
                "total_elapsed_ms": total_ms,
                "peak_ram_mb": metadata["peak_ram_mb"],
            },
            "progress_stages_seen": list(dict.fromkeys(ev["stage"] for ev in progress_events)),
            "internal_gt_comparison_post_inference": gt_eval,
        }

        if args.report_json is not None:
            args.report_json.parent.mkdir(parents=True, exist_ok=True)
            args.report_json.write_text(json.dumps(report, indent=2), encoding="utf-8")

        print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
