from __future__ import annotations

import math
import warnings
from collections.abc import Sequence

import numpy as np
from scipy import ndimage as ndi
from skimage.filters import threshold_yen


def zscore_volume(volume: np.ndarray, nonzero_eps: float = 1e-6) -> np.ndarray:
    """Z-score a 3D volume over brain voxels (`abs(v) > nonzero_eps`) while keeping background at 0.0."""
    arr = np.asarray(volume, dtype=np.float32)
    if not np.all(np.isfinite(arr)):
        raise ValueError("Volume contains non-finite values (NaN or Inf)")

    brain = np.abs(arr) > nonzero_eps
    if not np.any(brain):
        return np.zeros_like(arr, dtype=np.float32)

    values = arr[brain]
    mean = float(values.mean())
    std = float(values.std())
    if not math.isfinite(std) or std < nonzero_eps:
        std = 1.0

    result = (arr - mean) / std
    result[~brain] = 0.0
    return result.astype(np.float32, copy=False)


def _largest_component_centroid(mask: np.ndarray, min_size: int = 20) -> tuple[float, float] | None:
    """Return `(center_x, center_y)` of the largest 8-connected component meeting `min_size`."""
    labeled, count = ndi.label(mask, structure=np.ones((3, 3), dtype=np.uint8))
    if count == 0:
        return None
    sizes = np.bincount(labeled.ravel())
    sizes[0] = 0
    component_id = int(np.argmax(sizes))
    if int(sizes[component_id]) < min_size:
        return None
    ys, xs = np.where(labeled == component_id)
    return float(xs.mean()), float(ys.mean())


def automatic_flair_center(flair_slice: np.ndarray, min_component_size: int = 20) -> tuple[float, float]:
    """Estimate the tumor ROI `(center_x, center_y)` solely from a 2D FLAIR slice."""
    image = np.asarray(flair_slice, dtype=np.float32)
    if image.ndim != 2:
        raise ValueError(f"Expected 2D FLAIR slice, got shape {image.shape}")

    brain = np.abs(image) > 1e-6
    if not np.any(brain):
        return (image.shape[1] / 2.0, image.shape[0] / 2.0)

    blurred = ndi.gaussian_filter(image, sigma=1.0)
    gx = ndi.sobel(blurred, axis=1, mode="nearest")
    gy = ndi.sobel(blurred, axis=0, mode="nearest")
    enhanced = blurred + 0.15 * np.hypot(gx, gy)
    values = enhanced[brain]
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            threshold = float(threshold_yen(values))
        if not math.isfinite(threshold):
            threshold = float(np.percentile(values, 90.0))
    except (ValueError, RuntimeError):
        threshold = float(np.percentile(values, 90.0))

    roi = (enhanced >= threshold) & brain
    roi = ndi.binary_opening(roi, structure=np.ones((3, 3), dtype=bool), iterations=1)
    roi = ndi.binary_closing(roi, structure=np.ones((5, 5), dtype=bool), iterations=1)
    roi = ndi.binary_fill_holes(roi)
    center = _largest_component_centroid(roi, min_size=min_component_size)
    if center is not None:
        return center

    ys, xs = np.where(brain)
    return float(xs.mean()), float(ys.mean())


def crop_centered(
    array: np.ndarray,
    center_xy: tuple[float, float],
    patch_size: int = 128,
) -> tuple[np.ndarray, tuple[int, int]]:
    """Crop a clamped `patch_size x patch_size` window around `(cx, cy)` and return `(patch, (x0, y0))`."""
    if array.ndim < 2:
        raise ValueError(f"Expected at least 2D array for cropping, got shape {array.shape}")
    height, width = array.shape[:2]
    if patch_size <= 0 or patch_size > height or patch_size > width:
        raise ValueError(f"patch_size={patch_size} is invalid for slice shape {(height, width)}")

    cx, cy = center_xy
    x0 = int(round(cx - patch_size / 2.0))
    y0 = int(round(cy - patch_size / 2.0))
    x0 = min(max(x0, 0), width - patch_size)
    y0 = min(max(y0, 0), height - patch_size)
    return array[y0 : y0 + patch_size, x0 : x0 + patch_size], (x0, y0)


def restore_patch_to_slice(
    patch: np.ndarray,
    top_left_xy: tuple[int, int],
    slice_shape: tuple[int, int],
    fill_value: int = 0,
    dtype: np.dtype | type = np.uint8,
) -> np.ndarray:
    """Restore a 2D cropped patch back into a full 2D slice grid with strict bounds checking."""
    patch_arr = np.asarray(patch)
    if patch_arr.ndim != 2:
        raise ValueError(f"Expected 2D patch, got shape {patch_arr.shape}")

    height, width = int(slice_shape[0]), int(slice_shape[1])
    patch_h, patch_w = patch_arr.shape
    x0, y0 = int(top_left_xy[0]), int(top_left_xy[1])

    if x0 < 0 or y0 < 0 or x0 + patch_w > width or y0 + patch_h > height:
        raise ValueError(
            f"Patch bounds (x0={x0}, y0={y0}, w={patch_w}, h={patch_h}) out of range for slice {(height, width)}"
        )

    out = np.full((height, width), fill_value, dtype=dtype)
    out[y0 : y0 + patch_h, x0 : x0 + patch_w] = patch_arr.astype(dtype, copy=False)
    return out


def restore_patches_to_volume(
    slice_patches: Sequence[tuple[int, np.ndarray, tuple[int, int]]],
    volume_shape: tuple[int, int, int],
    fill_value: int = 0,
    dtype: np.dtype | type = np.uint8,
) -> np.ndarray:
    """Restore per-slice cropped patches into a 3D `(H, W, D)` volume grid."""
    if len(volume_shape) != 3:
        raise ValueError(f"Expected 3D volume_shape, got {volume_shape}")
    height, width, depth = (int(volume_shape[0]), int(volume_shape[1]), int(volume_shape[2]))
    volume = np.full((height, width, depth), fill_value, dtype=dtype)

    for z, patch, (x0, y0) in slice_patches:
        z_idx = int(z)
        if z_idx < 0 or z_idx >= depth:
            raise ValueError(f"Slice index z={z_idx} out of bounds for depth={depth}")
        volume[:, :, z_idx] = restore_patch_to_slice(
            patch=patch,
            top_left_xy=(x0, y0),
            slice_shape=(height, width),
            fill_value=fill_value,
            dtype=dtype,
        )
    return volume
