from __future__ import annotations

import hmac
import json
import os
import time
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import nibabel as nib
import numpy as np
import psutil
import torch

from .model import TDASegUNet, load_verified_model
from .preprocess import (
    automatic_flair_center,
    crop_centered,
    restore_patches_to_volume,
    zscore_volume,
)
from .tda import make_tda_channels

ALLOWED_RAW_LABELS = frozenset({0, 1, 2, 4})
UNIT_TO_MM: dict[str, float] = {
    "mm": 1.0,
    "meter": 1000.0,
    "micron": 0.001,
    "unknown": 1.0,
}


class ManifestValidationError(ValueError):
    """Raised when a model manifest is missing required fields or is not verified."""


class InputGeometryError(ValueError):
    """Raised when input NIfTI volumes violate profile, finiteness, or geometry alignment contracts."""


@dataclass(frozen=True)
class AdapterResult:
    """Outputs and verification summary produced by `run_case`."""

    mask_path: Path
    coverage_path: Path
    metadata_path: Path
    output_shape: tuple[int, int, int]
    dtype: str
    affine: list[list[float]]
    zooms_mm: tuple[float, float, float]
    label_voxel_counts: dict[str, int]
    label_volumes_mm3: dict[str, float]
    group_volumes_mm3: dict[str, float]
    stage_timings_ms: dict[str, float]
    peak_ram_mb: float
    device: str
    evaluated_slices: int
    total_slices: int
    empty_slices: int
    metadata: dict[str, Any]
    coverage: dict[str, Any]


@dataclass(frozen=True)
class _LoadedVolume:
    img: nib.Nifti1Image
    data: np.ndarray
    shape: tuple[int, int, int]
    spacing_mm: np.ndarray
    affine_mm: np.ndarray
    xyzt_units: tuple[str, str]
    qform: np.ndarray | None
    qform_code: int
    sform: np.ndarray | None
    sform_code: int


class _RamTracker:
    """Track process working set / RSS across inference stages."""

    def __init__(self) -> None:
        self._process = psutil.Process(os.getpid())
        self._max_bytes = self._sample_bytes()

    def _sample_bytes(self) -> int:
        mem = self._process.memory_info()
        return int(mem.rss)

    def update(self) -> None:
        current = self._sample_bytes()
        if current > self._max_bytes:
            self._max_bytes = current

    @property
    def peak_mb(self) -> float:
        self.update()
        return round(self._max_bytes / (1024.0 * 1024.0), 3)


def load_manifest(model_manifest: Mapping[str, Any] | str | Path) -> tuple[dict[str, Any], Path | None]:
    """Load and return a model manifest dict along with its directory if loaded from disk."""
    if isinstance(model_manifest, (str, Path)):
        manifest_path = Path(model_manifest)
        if not manifest_path.is_file():
            raise FileNotFoundError(f"Model manifest file not found: {manifest_path}")
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ManifestValidationError("Model manifest JSON root must be an object")
        return payload, manifest_path.parent
    if isinstance(model_manifest, Mapping):
        return dict(model_manifest), None
    raise ManifestValidationError("model_manifest must be a dict/Mapping or path to manifest JSON")


def _validate_manifest(manifest: Mapping[str, Any]) -> dict[str, Any]:
    """Validate manifest verification status and required contract sections."""
    if manifest.get("verification_status") != "verified":
        raise ManifestValidationError(
            f"Refusing to run model with verification_status={manifest.get('verification_status')!r}; must be 'verified'"
        )

    required_keys = (
        "model_id",
        "version",
        "checkpoint_sha256",
        "architecture",
        "required_modalities",
        "input_profile",
        "normalization",
        "tda_config",
        "crop_config",
        "class_mapping",
    )
    missing = [key for key in required_keys if key not in manifest]
    if missing:
        raise ManifestValidationError(f"Model manifest missing required keys: {missing}")

    modalities = list(manifest["required_modalities"])
    if modalities != ["flair", "t1ce"]:
        raise ManifestValidationError(f"Unsupported required_modalities={modalities}; expected ['flair', 't1ce']")

    arch = manifest["architecture"]
    if int(arch.get("in_channels", -1)) != 6 or int(arch.get("num_classes", -1)) != 4:
        raise ManifestValidationError(f"Unsupported architecture channels/classes in manifest: {arch}")

    profile = manifest["input_profile"]
    shape = tuple(int(x) for x in profile["shape"])
    spacing_mm = tuple(float(x) for x in profile["spacing_mm"])
    if len(shape) != 3 or any(x <= 0 for x in shape):
        raise ManifestValidationError(f"Invalid input_profile.shape: {shape}")
    if len(spacing_mm) != 3 or any(x <= 0 for x in spacing_mm):
        raise ManifestValidationError(f"Invalid input_profile.spacing_mm: {spacing_mm}")

    raw_mapping = manifest["class_mapping"].get("contiguous_to_raw")
    if not isinstance(raw_mapping, Mapping) or len(raw_mapping) != int(arch["num_classes"]):
        raise ManifestValidationError("Invalid class_mapping.contiguous_to_raw in manifest")
    parsed_lut: dict[int, int] = {}
    for cls_idx_raw, raw_label_raw in raw_mapping.items():
        cls_idx = int(cls_idx_raw)
        raw_label = int(raw_label_raw)
        if raw_label not in ALLOWED_RAW_LABELS:
            raise ManifestValidationError(f"Disallowed target label {raw_label} in class_mapping")
        parsed_lut[cls_idx] = raw_label
    for expected_idx in range(int(arch["num_classes"])):
        if expected_idx not in parsed_lut:
            raise ManifestValidationError(f"Missing contiguous class {expected_idx} in class_mapping")

    slice_axis = int(profile.get("slice_axis", 2))
    if slice_axis != 2:
        raise ManifestValidationError(
            f"Unsupported input_profile.slice_axis={slice_axis}; 2D axial pipeline requires slice_axis=2"
        )
    geometry_tol = float(profile.get("geometry_tolerance_mm", 1e-4))
    if not np.isfinite(geometry_tol) or geometry_tol <= 0.0:
        raise ManifestValidationError(
            f"Invalid input_profile.geometry_tolerance_mm={geometry_tol!r}"
        )

    return {
        "shape": shape,
        "spacing_mm": np.asarray(spacing_mm, dtype=np.float64),
        "slice_axis": slice_axis,
        "geometry_tolerance_mm": geometry_tol,
        "lut": np.asarray([parsed_lut[idx] for idx in range(int(arch["num_classes"]))], dtype=np.uint8),
        "base": int(arch.get("base_channels", arch.get("base", 16))),
        "in_channels": int(arch["in_channels"]),
        "num_classes": int(arch["num_classes"]),
    }


def resolve_checkpoint_path(
    manifest: Mapping[str, Any],
    checkpoint_path: str | Path | None = None,
    manifest_dir: Path | None = None,
) -> Path:
    """Resolve checkpoint path from explicit parameter, env `MODEL_CHECKPOINT_PATH`, or manifest."""
    candidates: list[Path] = []
    if checkpoint_path is not None:
        candidates.append(Path(checkpoint_path))
    else:
        env_path = os.environ.get("MODEL_CHECKPOINT_PATH", "").strip()
        if env_path:
            candidates.append(Path(env_path))
        default_path = str(manifest.get("default_checkpoint_path", "")).strip()
        if default_path:
            p = Path(default_path)
            candidates.append(p)
            if not p.is_absolute() and manifest_dir is not None:
                candidates.append(manifest_dir / p)

    if not candidates:
        raise FileNotFoundError(
            "Checkpoint path was not provided and neither MODEL_CHECKPOINT_PATH nor default_checkpoint_path is set"
        )
    for cand in candidates:
        if cand.is_file():
            return cand
    raise FileNotFoundError(f"Checkpoint file does not exist: {candidates[0]}")


def load_model_from_manifest(
    model_manifest: Mapping[str, Any] | str | Path,
    device: str = "cpu",
    checkpoint_path: str | Path | None = None,
) -> TDASegUNet:
    """Validate manifest, resolve checkpoint, verify SHA-256, and load TDASegUNet."""
    manifest, manifest_dir = load_manifest(model_manifest)
    parsed = _validate_manifest(manifest)
    resolved_ckpt = resolve_checkpoint_path(manifest, checkpoint_path=checkpoint_path, manifest_dir=manifest_dir)
    return load_verified_model(
        checkpoint_path=resolved_ckpt,
        expected_sha256=str(manifest["checkpoint_sha256"]),
        device=device,
        in_channels=parsed["in_channels"],
        num_classes=parsed["num_classes"],
        base=parsed["base"],
    )


def _check_nifti_suffix(path: Path) -> None:
    lower = path.name.lower()
    if not (lower.endswith(".nii") or lower.endswith(".nii.gz")):
        raise InputGeometryError(f"Unsupported file extension for NIfTI input: {path.name}")


def _is_axis_aligned_affine(affine_mm: np.ndarray, *, tol: float = 1e-4) -> bool:
    mat = affine_mm[:3, :3]
    dom_rows: set[int] = set()
    for col_idx in range(3):
        col_abs = np.abs(mat[:, col_idx])
        dom_row = int(np.argmax(col_abs))
        if float(col_abs[dom_row]) <= 0.0:
            return False
        for row_idx in range(3):
            if row_idx != dom_row and float(col_abs[row_idx]) > tol:
                return False
        dom_rows.add(dom_row)
    return len(dom_rows) == 3


def _load_and_validate_nifti(
    path: Path,
    modality_label: str,
    expected_shape: tuple[int, int, int],
    expected_spacing_mm: np.ndarray,
    geometry_tol: float = 1e-4,
) -> _LoadedVolume:
    if not path.is_file():
        raise FileNotFoundError(f"Input {modality_label} file not found: {path}")
    _check_nifti_suffix(path)

    try:
        img = nib.load(str(path))
    except Exception as exc:
        raise InputGeometryError(f"Failed to read {modality_label} NIfTI file {path.name}: {exc}") from exc

    if img.ndim != 3 or len(img.shape) != 3:
        raise InputGeometryError(f"{modality_label} must be a 3D scalar volume; got shape {img.shape}")

    data_dtype = img.header.get_data_dtype()
    if data_dtype.fields is not None or np.issubdtype(data_dtype, np.complexfloating):
        raise InputGeometryError(f"{modality_label} must be scalar numeric, got dtype {data_dtype}")

    actual_shape = (int(img.shape[0]), int(img.shape[1]), int(img.shape[2]))
    if actual_shape != expected_shape:
        raise InputGeometryError(
            f"{modality_label} shape {actual_shape} does not match verified profile {expected_shape}"
        )

    xyzt_units = img.header.get_xyzt_units()
    spatial_unit = str(xyzt_units[0])
    if spatial_unit not in UNIT_TO_MM:
        raise InputGeometryError(f"{modality_label} has unsupported spatial unit '{spatial_unit}'")
    scale_to_mm = UNIT_TO_MM[spatial_unit]

    try:
        qform, qcode = img.get_qform(coded=True)
        sform, scode = img.get_sform(coded=True)
        qcode_int = int(qcode)
        scode_int = int(scode)
    except Exception as exc:
        raise InputGeometryError(
            f"{modality_label} has unreadable qform/sform header: {exc}"
        ) from exc

    if qcode_int < 0 or scode_int < 0 or (qcode_int == 0 and scode_int == 0):
        raise InputGeometryError(
            f"{modality_label} has no physical coordinate transform (qform_code=0 and sform_code=0)"
        )

    qform_mm: np.ndarray | None = None
    if qcode_int > 0 and qform is not None:
        qform_mm = np.asarray(qform, dtype=np.float64).copy()
        qform_mm[:3, :] *= scale_to_mm

    sform_mm: np.ndarray | None = None
    if scode_int > 0 and sform is not None:
        sform_mm = np.asarray(sform, dtype=np.float64).copy()
        sform_mm[:3, :] *= scale_to_mm

    if qform_mm is not None and sform_mm is not None:
        if not np.allclose(qform_mm, sform_mm, rtol=0.0, atol=1e-2):
            raise InputGeometryError(f"{modality_label} qform and sform disagree significantly")

    affine_mm = sform_mm if sform_mm is not None else qform_mm
    if affine_mm is None or affine_mm.shape != (4, 4) or not np.all(np.isfinite(affine_mm)):
        raise InputGeometryError(f"{modality_label} affine is missing or contains non-finite values")

    spacing_mm = np.asarray(
        [float(np.linalg.norm(affine_mm[:3, idx])) for idx in range(3)],
        dtype=np.float64,
    )
    if spacing_mm.shape != (3,) or not np.all(np.isfinite(spacing_mm)) or np.any(spacing_mm <= 0):
        raise InputGeometryError(f"{modality_label} has invalid voxel spacing {spacing_mm.tolist()}")
    if not np.allclose(spacing_mm, expected_spacing_mm, rtol=0.0, atol=geometry_tol):
        raise InputGeometryError(
            f"{modality_label} spacing {spacing_mm.tolist()} mm does not match profile {expected_spacing_mm.tolist()} mm"
        )

    det = abs(float(np.linalg.det(affine_mm[:3, :3])))
    if not np.isfinite(det) or det <= 1e-6:
        raise InputGeometryError(f"{modality_label} affine matrix is singular (|det|={det})")

    if not _is_axis_aligned_affine(affine_mm, tol=geometry_tol):
        raise InputGeometryError(
            f"{modality_label} affine matrix is oblique/sheared and not axis-aligned with 2D axial model"
        )

    try:
        axcodes = nib.orientations.aff2axcodes(affine_mm, tol=1e-3)
    except Exception as exc:
        raise InputGeometryError(
            f"{modality_label} anatomical axis codes could not be determined: {exc}"
        ) from exc
    axis_groups = {"R": "LR", "L": "LR", "A": "AP", "P": "AP", "S": "SI", "I": "SI"}
    if (
        len(axcodes) != 3
        or any(not isinstance(c, str) or c not in axis_groups for c in axcodes)
        or len({axis_groups[str(c)] for c in axcodes}) != 3
        or str(axcodes[2]) not in {"S", "I"}
    ):
        raise InputGeometryError(
            f"{modality_label} orientation {axcodes!r} does not have axial S/I slice axis at index 2"
        )

    try:
        data = np.asarray(img.get_fdata(dtype=np.float32), dtype=np.float32)
    except Exception as exc:
        raise InputGeometryError(f"Failed to decode {modality_label} voxel array: {exc}") from exc

    if data.shape != expected_shape:
        raise InputGeometryError(f"{modality_label} decoded shape {data.shape} != {expected_shape}")
    if not np.all(np.isfinite(data)):
        raise InputGeometryError(f"{modality_label} voxel data contains non-finite values (NaN or Inf)")

    return _LoadedVolume(
        img=img,
        data=data,
        shape=actual_shape,
        spacing_mm=spacing_mm,
        affine_mm=affine_mm,
        xyzt_units=(str(xyzt_units[0]), str(xyzt_units[1])),
        qform=None if qform is None else np.asarray(qform, dtype=np.float64),
        qform_code=qcode_int,
        sform=None if sform is None else np.asarray(sform, dtype=np.float64),
        sform_code=scode_int,
    )


def _validate_modality_alignment(flair: _LoadedVolume, t1ce: _LoadedVolume) -> None:
    if flair.shape != t1ce.shape:
        raise InputGeometryError(f"Shape mismatch: FLAIR {flair.shape} vs T1ce {t1ce.shape}")
    if not np.allclose(flair.spacing_mm, t1ce.spacing_mm, rtol=0.0, atol=1e-4):
        raise InputGeometryError(
            f"Spacing mismatch (mm): FLAIR {flair.spacing_mm.tolist()} vs T1ce {t1ce.spacing_mm.tolist()}"
        )
    if not np.allclose(flair.affine_mm, t1ce.affine_mm, rtol=0.0, atol=1e-4):
        raise InputGeometryError("Affine mismatch beyond tolerance (rtol=0, atol=1e-4 mm) between FLAIR and T1ce")


def _validate_slice_indices(slice_indices: Sequence[int] | None, depth: int) -> list[int]:
    if slice_indices is None:
        return list(range(depth))
    if isinstance(slice_indices, (str, bytes)):
        raise ValueError("slice_indices must be a sequence of integers, not string/bytes")
    resolved: list[int] = []
    seen: set[int] = set()
    for raw_idx in slice_indices:
        if isinstance(raw_idx, bool) or not isinstance(raw_idx, (int, np.integer)):
            raise ValueError(f"Invalid slice index {raw_idx!r}; expected integer")
        idx = int(raw_idx)
        if idx < 0 or idx >= depth:
            raise ValueError(f"Slice index {idx} out of bounds for depth={depth}")
        if idx in seen:
            raise ValueError(f"Duplicate slice index {idx} in slice_indices")
        seen.add(idx)
        resolved.append(idx)
    if not resolved:
        raise ValueError("slice_indices must not be empty")
    return sorted(resolved)


def _build_mask_nifti(mask_volume: np.ndarray, ref: _LoadedVolume) -> nib.Nifti1Image:
    hdr = ref.img.header.copy()
    hdr.set_data_dtype(np.uint8)
    hdr.set_slope_inter(1.0, 0.0)
    hdr.set_zooms(ref.img.header.get_zooms()[:3])
    hdr.set_xyzt_units(*ref.xyzt_units)

    out_img = nib.Nifti1Image(mask_volume.astype(np.uint8, copy=False), ref.img.affine, header=hdr)
    if ref.qform_code > 0 and ref.qform is not None:
        out_img.set_qform(ref.qform, code=ref.qform_code)
    else:
        out_img.set_qform(None, code=0)
    if ref.sform_code > 0 and ref.sform is not None:
        out_img.set_sform(ref.sform, code=ref.sform_code)
    else:
        out_img.set_sform(None, code=0)
    return out_img


def _atomic_write_outputs(
    output_dir: Path,
    mask_img: nib.Nifti1Image,
    coverage: Mapping[str, Any],
    metadata: Mapping[str, Any],
) -> tuple[Path, Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    tmp_mask = output_dir / f".tmp.{token}.mask.nii.gz"
    tmp_cov = output_dir / f".tmp.{token}.coverage.json"
    tmp_meta = output_dir / f".tmp.{token}.metadata.json"

    mask_path = output_dir / "mask.nii.gz"
    coverage_path = output_dir / "coverage.json"
    metadata_path = output_dir / "metadata.json"

    try:
        nib.save(mask_img, str(tmp_mask))
        tmp_cov.write_text(json.dumps(coverage, indent=2), encoding="utf-8")
        tmp_meta.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

        os.replace(tmp_mask, mask_path)
        os.replace(tmp_cov, coverage_path)
        os.replace(tmp_meta, metadata_path)
    finally:
        for tmp_file in (tmp_mask, tmp_cov, tmp_meta):
            if tmp_file.exists():
                tmp_file.unlink(missing_ok=True)

    return mask_path, coverage_path, metadata_path


def run_case(
    flair_path: str | Path,
    t1ce_path: str | Path,
    model_manifest: Mapping[str, Any] | str | Path,
    output_dir: str | Path,
    progress_callback: Callable[[str, int, int], None] | None = None,
    device: str = "cpu",
    slice_indices: Sequence[int] | None = None,
    checkpoint_path: str | Path | None = None,
    *,
    preloaded_model: TDASegUNet | None = None,
    batch_size: int = 16,
) -> AdapterResult:
    """Run verified TDA-SegUNet 2D inference over a BraTS FLAIR + T1ce pair and export mask + provenance."""
    if batch_size <= 0:
        raise ValueError("batch_size must be a positive integer")

    def notify(stage: str, completed: int, total: int) -> None:
        if progress_callback is not None:
            progress_callback(stage, completed, total)

    ram_tracker = _RamTracker()

    manifest, manifest_dir = load_manifest(model_manifest)
    parsed = _validate_manifest(manifest)
    expected_shape: tuple[int, int, int] = parsed["shape"]
    expected_spacing_mm: np.ndarray = parsed["spacing_mm"]
    geometry_tol: float = parsed["geometry_tolerance_mm"]
    depth = expected_shape[2]
    selected_indices = _validate_slice_indices(slice_indices, depth)
    total_slices = len(selected_indices)
    selected_set = set(selected_indices)

    notify("loading", 0, total_slices)
    t_load_start = time.perf_counter()

    if preloaded_model is None:
        resolved_ckpt = resolve_checkpoint_path(
            manifest,
            checkpoint_path=checkpoint_path,
            manifest_dir=manifest_dir,
        )
        model = load_verified_model(
            checkpoint_path=resolved_ckpt,
            expected_sha256=str(manifest["checkpoint_sha256"]),
            device=device,
            in_channels=parsed["in_channels"],
            num_classes=parsed["num_classes"],
            base=parsed["base"],
        )
    else:
        from .model import CheckpointVerificationError, _resolve_device

        if not isinstance(preloaded_model, TDASegUNet):
            raise CheckpointVerificationError("preloaded_model must be a verified TDASegUNet instance")
        if (
            preloaded_model.in_channels != parsed["in_channels"]
            or preloaded_model.num_classes != parsed["num_classes"]
            or preloaded_model.base != parsed["base"]
        ):
            raise CheckpointVerificationError("preloaded_model architecture does not match manifest")
        expected_ckpt_sha = str(manifest["checkpoint_sha256"]).strip().lower()
        preloaded_ckpt_sha = getattr(preloaded_model, "checkpoint_sha256", None)
        if not isinstance(preloaded_ckpt_sha, str) or not hmac.compare_digest(
            preloaded_ckpt_sha.strip().lower(), expected_ckpt_sha
        ):
            raise CheckpointVerificationError(
                "preloaded_model checkpoint_sha256 is missing or does not match manifest"
            )
        resolved_dev = _resolve_device(device)
        model = preloaded_model.to(resolved_dev)
        model.eval()

    flair_vol = _load_and_validate_nifti(
        Path(flair_path), "flair", expected_shape, expected_spacing_mm, geometry_tol
    )
    t1ce_vol = _load_and_validate_nifti(
        Path(t1ce_path), "t1ce", expected_shape, expected_spacing_mm, geometry_tol
    )
    _validate_modality_alignment(flair_vol, t1ce_vol)
    load_ms = (time.perf_counter() - t_load_start) * 1000.0
    ram_tracker.update()

    # Preprocessing + TDA
    norm_cfg = manifest["normalization"]
    nonzero_eps = float(norm_cfg.get("nonzero_eps", 1e-6))
    crop_cfg = manifest["crop_config"]
    patch_size = int(crop_cfg.get("patch_size", 128))
    min_component_size = int(crop_cfg.get("min_component_size", 20))

    tda_cfg = manifest["tda_config"]
    tda_output_size = int(tda_cfg.get("output_size", patch_size))
    tda_grid_size = int(tda_cfg.get("grid_size", 32))
    tda_input_size = int(tda_cfg.get("tda_input_size", 64))
    tda_bandwidth = float(tda_cfg.get("bandwidth", 0.30))
    tda_min_persistence = float(tda_cfg.get("min_persistence", 0.05))
    birth_range = (float(tda_cfg["birth_range"][0]), float(tda_cfg["birth_range"][1]))
    persistence_range = (
        float(tda_cfg["persistence_range"][0]),
        float(tda_cfg["persistence_range"][1]),
    )

    notify("preprocessing", 0, total_slices)
    t_prep_start = time.perf_counter()
    flair_norm = zscore_volume(flair_vol.data, nonzero_eps=nonzero_eps)
    t1ce_norm = zscore_volume(t1ce_vol.data, nonzero_eps=nonzero_eps)

    empty_flags: list[bool] = [
        bool(
            np.all(np.abs(flair_vol.data[:, :, z]) <= nonzero_eps)
            and np.all(np.abs(t1ce_vol.data[:, :, z]) <= nonzero_eps)
        )
        for z in range(depth)
    ]

    cropped_entries: list[
        tuple[int, np.ndarray, np.ndarray, tuple[int, int], tuple[float, float]]
    ] = []
    for z in selected_indices:
        flair_slice = flair_norm[:, :, z]
        t1ce_slice = t1ce_norm[:, :, z]
        center_x, center_y = automatic_flair_center(
            flair_slice, min_component_size=min_component_size
        )
        flair_patch, (x0, y0) = crop_centered(
            flair_slice, (center_x, center_y), patch_size=patch_size
        )
        t1ce_patch, _ = crop_centered(
            t1ce_slice, (center_x, center_y), patch_size=patch_size
        )
        cropped_entries.append((z, flair_patch, t1ce_patch, (x0, y0), (center_x, center_y)))

    preprocess_ms = (time.perf_counter() - t_prep_start) * 1000.0
    ram_tracker.update()

    t_tda_start = time.perf_counter()
    inputs_6ch: list[np.ndarray] = []
    for idx_pos, (_, flair_patch, t1ce_patch, _, _) in enumerate(cropped_entries, start=1):
        tda_channels = make_tda_channels(
            flair_patch=flair_patch,
            t1ce_patch=t1ce_patch,
            output_size=tda_output_size,
            grid_size=tda_grid_size,
            tda_input_size=tda_input_size,
            bandwidth=tda_bandwidth,
            min_persistence=tda_min_persistence,
            birth_range=birth_range,
            persistence_range=persistence_range,
        )
        sample_6ch = np.concatenate(
            [flair_patch[None, ...], t1ce_patch[None, ...], tda_channels],
            axis=0,
        ).astype(np.float32, copy=False)
        inputs_6ch.append(sample_6ch)
        if idx_pos == total_slices or idx_pos % 10 == 0:
            notify("preprocessing", idx_pos, total_slices)
    tda_ms = (time.perf_counter() - t_tda_start) * 1000.0
    ram_tracker.update()

    # Inference
    notify("inference", 0, total_slices)
    t_infer_start = time.perf_counter()
    model_device = next(model.parameters()).device
    lut: np.ndarray = parsed["lut"]
    predicted_patches: list[tuple[int, np.ndarray, tuple[int, int]]] = []

    with torch.inference_mode():
        for start in range(0, total_slices, batch_size):
            end = min(start + batch_size, total_slices)
            batch_np = np.stack(inputs_6ch[start:end], axis=0)
            batch_tensor = torch.from_numpy(np.ascontiguousarray(batch_np)).to(model_device)
            logits = model(batch_tensor)
            preds_contig = logits.argmax(dim=1).cpu().numpy()
            for offset in range(end - start):
                entry_z, _, _, top_left, _ = cropped_entries[start + offset]
                raw_patch = lut[preds_contig[offset]]
                predicted_patches.append((entry_z, raw_patch, top_left))
            notify("inference", end, total_slices)

    inference_ms = (time.perf_counter() - t_infer_start) * 1000.0
    ram_tracker.update()

    # Reconstruct 3D mask & compute statistics / coverage
    notify("reconstructing", 0, total_slices)
    t_recon_start = time.perf_counter()
    mask_volume = restore_patches_to_volume(
        slice_patches=predicted_patches,
        volume_shape=expected_shape,
        fill_value=0,
        dtype=np.uint8,
    )

    crop_by_z: dict[int, tuple[tuple[int, int], tuple[float, float]]] = {
        z: (top_left, center_xy) for z, _, _, top_left, center_xy in cropped_entries
    }
    slice_crops: list[dict[str, Any]] = []
    for z in range(depth):
        if z in selected_set:
            (x0, y0), (cx, cy) = crop_by_z[z]
            slice_crops.append(
                {
                    "z": z,
                    "x0": int(x0),
                    "y0": int(y0),
                    "x1": int(x0 + patch_size),
                    "y1": int(y0 + patch_size),
                    "center_x": float(cx),
                    "center_y": float(cy),
                    "is_empty_slice": empty_flags[z],
                    "evaluated": True,
                }
            )
        else:
            slice_crops.append(
                {
                    "z": z,
                    "x0": None,
                    "y0": None,
                    "x1": None,
                    "y1": None,
                    "center_x": None,
                    "center_y": None,
                    "is_empty_slice": empty_flags[z],
                    "evaluated": False,
                }
            )

    pipeline_version = str(
        manifest.get("pipeline_version")
        or norm_cfg.get("pipeline_version")
        or f"{manifest['model_id']}-{manifest['version']}"
    )

    coverage: dict[str, Any] = {
        "original_shape": list(expected_shape),
        "pipeline_version": pipeline_version,
        "unevaluated_outside_crop": True,
        "patch_size": patch_size,
        "slice_axis": parsed["slice_axis"],
        "total_slices": depth,
        "evaluated_slices": total_slices,
        "empty_slices": int(sum(1 for flag in empty_flags if flag)),
        "slice_crops": slice_crops,
    }

    voxel_volume_mm3 = abs(float(np.linalg.det(flair_vol.affine_mm[:3, :3])))
    label_voxel_counts = {
        str(lbl): int(np.count_nonzero(mask_volume == lbl)) for lbl in (0, 1, 2, 4)
    }
    label_volumes_mm3 = {
        lbl_key: float(count * voxel_volume_mm3) for lbl_key, count in label_voxel_counts.items()
    }
    wt_voxels = int(np.count_nonzero(mask_volume > 0))
    tc_voxels = int(np.count_nonzero((mask_volume == 1) | (mask_volume == 4)))
    et_voxels = int(np.count_nonzero(mask_volume == 4))
    group_volumes_mm3 = {
        "WT": float(wt_voxels * voxel_volume_mm3),
        "TC": float(tc_voxels * voxel_volume_mm3),
        "ET": float(et_voxels * voxel_volume_mm3),
    }

    reconstruct_ms = (time.perf_counter() - t_recon_start) * 1000.0
    ram_tracker.update()
    notify("reconstructing", total_slices, total_slices)

    # Save outputs atomically
    notify("saving", 0, total_slices)
    t_save_start = time.perf_counter()
    mask_img = _build_mask_nifti(mask_volume, flair_vol)

    stage_timings_ms: dict[str, float] = {
        "load": round(load_ms, 3),
        "preprocess": round(preprocess_ms, 3),
        "tda": round(tda_ms, 3),
        "inference": round(inference_ms, 3),
        "reconstruct": round(reconstruct_ms, 3),
        "save": 0.0,
    }

    ram_tracker.update()
    metadata: dict[str, Any] = {
        "model_id": str(manifest["model_id"]),
        "model_version": str(manifest["version"]),
        "checkpoint_sha256": str(manifest["checkpoint_sha256"]).lower(),
        "pipeline_version": pipeline_version,
        "device": str(model_device),
        "total_slices": depth,
        "evaluated_slices": total_slices,
        "empty_slices": int(sum(1 for flag in empty_flags if flag)),
        "voxel_volume_mm3": voxel_volume_mm3,
        "label_voxel_counts": label_voxel_counts,
        "label_volumes_mm3": label_volumes_mm3,
        "group_volumes_mm3": group_volumes_mm3,
        "group_definitions": {"WT": [1, 2, 4], "TC": [1, 4], "ET": [4]},
        "class_mapping": manifest["class_mapping"],
        "geometry": {
            "shape": list(expected_shape),
            "spacing_mm": [float(x) for x in flair_vol.spacing_mm.tolist()],
            "xyzt_units": list(flair_vol.xyzt_units),
            "affine_mm": [[float(v) for v in row] for row in flair_vol.affine_mm.tolist()],
        },
        "stage_timings_ms": stage_timings_ms,
        "peak_ram_mb": ram_tracker.peak_mb,
        "output_files": {
            "mask": "mask.nii.gz",
            "coverage": "coverage.json",
            "metadata": "metadata.json",
        },
    }

    out_path = Path(output_dir)
    mask_path, coverage_path, metadata_path = _atomic_write_outputs(
        output_dir=out_path,
        mask_img=mask_img,
        coverage=coverage,
        metadata=metadata,
    )
    save_ms = (time.perf_counter() - t_save_start) * 1000.0
    stage_timings_ms["save"] = round(save_ms, 3)
    metadata["peak_ram_mb"] = ram_tracker.peak_mb

    # Update metadata.json atomically with final save timing and peak RAM.
    tmp_meta_final = out_path / f".tmp.{uuid.uuid4().hex}.metadata.json"
    try:
        tmp_meta_final.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
        os.replace(tmp_meta_final, metadata_path)
    finally:
        if tmp_meta_final.exists():
            tmp_meta_final.unlink(missing_ok=True)

    notify("saving", total_slices, total_slices)
    notify("done", total_slices, total_slices)

    return AdapterResult(
        mask_path=mask_path,
        coverage_path=coverage_path,
        metadata_path=metadata_path,
        output_shape=(
            int(mask_volume.shape[0]),
            int(mask_volume.shape[1]),
            int(mask_volume.shape[2]),
        ),
        dtype="uint8",
        affine=[[float(v) for v in row] for row in flair_vol.img.affine.tolist()],
        zooms_mm=tuple(float(x) for x in flair_vol.spacing_mm.tolist()),
        label_voxel_counts=label_voxel_counts,
        label_volumes_mm3=label_volumes_mm3,
        group_volumes_mm3=group_volumes_mm3,
        stage_timings_ms=stage_timings_ms,
        peak_ram_mb=float(metadata["peak_ram_mb"]),
        device=str(model_device),
        evaluated_slices=total_slices,
        total_slices=depth,
        empty_slices=int(coverage["empty_slices"]),
        metadata=metadata,
        coverage=coverage,
    )
