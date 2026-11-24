from __future__ import annotations

import gudhi
import numpy as np
from scipy.ndimage import zoom


def _persistence_points(image: np.ndarray, homology: int, min_persistence: float) -> np.ndarray:
    """Extract finite `(birth, death)` persistence pairs for a 2D image via cubical complex."""
    filtration = np.asarray(image, dtype=np.float64)
    if not np.all(np.isfinite(filtration)):
        raise ValueError("Input slice for TDA contains non-finite values (NaN or Inf)")
    if np.all(np.abs(filtration) <= 1e-12) or float(np.ptp(filtration)) == 0.0:
        return np.empty((0, 2), dtype=np.float32)

    complex_ = gudhi.CubicalComplex(top_dimensional_cells=filtration)
    diagram = complex_.persistence(homology_coeff_field=2, min_persistence=min_persistence)
    points = [pair for dimension, pair in diagram if dimension == homology and np.isfinite(pair[1])]
    if not points:
        return np.empty((0, 2), dtype=np.float32)
    return np.asarray(points, dtype=np.float32)


def _validate_tda_params(
    *,
    grid_size: int,
    output_size: int,
    bandwidth: float,
    min_persistence: float,
    birth_range: tuple[float, float],
    persistence_range: tuple[float, float],
    tda_input_size: int | None = None,
) -> None:
    if isinstance(grid_size, bool) or int(grid_size) <= 0:
        raise ValueError(f"grid_size must be a positive integer, got {grid_size!r}")
    if isinstance(output_size, bool) or int(output_size) <= 0:
        raise ValueError(f"output_size must be a positive integer, got {output_size!r}")
    if tda_input_size is not None and (
        isinstance(tda_input_size, bool) or int(tda_input_size) <= 0
    ):
        raise ValueError(f"tda_input_size must be a positive integer, got {tda_input_size!r}")
    if not np.isfinite(bandwidth) or float(bandwidth) <= 0.0:
        raise ValueError(f"bandwidth must be finite and positive, got {bandwidth!r}")
    if not np.isfinite(min_persistence) or float(min_persistence) < 0.0:
        raise ValueError(
            f"min_persistence must be finite and non-negative, got {min_persistence!r}"
        )
    if (
        len(birth_range) != 2
        or not np.all(np.isfinite(birth_range))
        or float(birth_range[1]) <= float(birth_range[0])
    ):
        raise ValueError(f"birth_range must have finite low < high, got {birth_range!r}")
    if (
        len(persistence_range) != 2
        or not np.all(np.isfinite(persistence_range))
        or float(persistence_range[1]) <= float(persistence_range[0])
    ):
        raise ValueError(
            f"persistence_range must have finite low < high, got {persistence_range!r}"
        )


def persistence_image(
    image: np.ndarray,
    homology: int,
    grid_size: int = 32,
    output_size: int = 128,
    bandwidth: float = 0.30,
    birth_range: tuple[float, float] = (-6.0, 6.0),
    persistence_range: tuple[float, float] = (0.0, 12.0),
    min_persistence: float = 0.05,
) -> np.ndarray:
    """Compute a fixed-range 2D persistence image resized to `(output_size, output_size)`."""
    if isinstance(homology, bool) or int(homology) < 0:
        raise ValueError(f"homology must be a non-negative integer, got {homology!r}")
    _validate_tda_params(
        grid_size=grid_size,
        output_size=output_size,
        bandwidth=bandwidth,
        min_persistence=min_persistence,
        birth_range=birth_range,
        persistence_range=persistence_range,
    )
    points = _persistence_points(image, homology, min_persistence)
    if points.size == 0:
        return np.zeros((output_size, output_size), dtype=np.float32)

    births = points[:, 0]
    persistence = np.maximum(points[:, 1] - points[:, 0], 0.0)
    x = np.linspace(birth_range[0], birth_range[1], grid_size, dtype=np.float32)
    y = np.linspace(persistence_range[0], persistence_range[1], grid_size, dtype=np.float32)
    xx, yy = np.meshgrid(x, y, indexing="xy")
    surface = np.zeros_like(xx, dtype=np.float32)
    scale = 2.0 * bandwidth * bandwidth

    for birth, life in zip(births, persistence, strict=True):
        if (
            birth < birth_range[0]
            or birth > birth_range[1]
            or life < persistence_range[0]
            or life > persistence_range[1]
        ):
            continue
        surface += np.float32(life) * np.exp(-((xx - birth) ** 2 + (yy - life) ** 2) / scale)

    if output_size == grid_size:
        result = surface.astype(np.float32, copy=False)
    else:
        factor = output_size / grid_size
        result = zoom(surface, (factor, factor), order=1)
        result = result[:output_size, :output_size]
        if result.shape != (output_size, output_size):
            padded = np.zeros((output_size, output_size), dtype=np.float32)
            padded[: result.shape[0], : result.shape[1]] = result
            result = padded
        result = result.astype(np.float32, copy=False)

    if not np.all(np.isfinite(result)):
        raise FloatingPointError("Persistence image computation produced non-finite values")
    return result


def make_tda_channels(
    flair_patch: np.ndarray,
    t1ce_patch: np.ndarray,
    output_size: int = 128,
    grid_size: int = 32,
    tda_input_size: int = 64,
    bandwidth: float = 0.30,
    min_persistence: float = 0.05,
    birth_range: tuple[float, float] = (-6.0, 6.0),
    persistence_range: tuple[float, float] = (0.0, 12.0),
) -> np.ndarray:
    """Compute the 4 TDA channels `[FLAIR-H0, FLAIR-H1, T1ce-H0, T1ce-H1]`."""
    _validate_tda_params(
        grid_size=grid_size,
        output_size=output_size,
        bandwidth=bandwidth,
        min_persistence=min_persistence,
        birth_range=birth_range,
        persistence_range=persistence_range,
        tda_input_size=tda_input_size,
    )
    flair_arr = np.asarray(flair_patch, dtype=np.float32)
    t1ce_arr = np.asarray(t1ce_patch, dtype=np.float32)
    if (
        flair_arr.shape != t1ce_arr.shape
        or flair_arr.ndim != 2
        or flair_arr.shape[0] <= 0
        or flair_arr.shape[1] <= 0
    ):
        raise ValueError(
            "Expected matching non-empty 2D patches, "
            f"got FLAIR={flair_arr.shape} and T1ce={t1ce_arr.shape}"
        )

    if not np.all(np.isfinite(flair_arr)) or not np.all(np.isfinite(t1ce_arr)):
        raise ValueError("Patch input to make_tda_channels contains non-finite values")

    # Fast clean zero output when both patches are empty to skip interpolation on zeros.
    flair_empty = bool(np.all(np.abs(flair_arr) <= 1e-12))
    t1ce_empty = bool(np.all(np.abs(t1ce_arr) <= 1e-12))
    if flair_empty and t1ce_empty:
        return np.zeros((4, output_size, output_size), dtype=np.float32)

    if (tda_input_size, tda_input_size) != flair_arr.shape:
        factor_y = tda_input_size / flair_arr.shape[0]
        factor_x = tda_input_size / flair_arr.shape[1]
        flair_in = (
            np.zeros((tda_input_size, tda_input_size), dtype=np.float32)
            if flair_empty
            else zoom(flair_arr, (factor_y, factor_x), order=1)
        )
        t1ce_in = (
            np.zeros((tda_input_size, tda_input_size), dtype=np.float32)
            if t1ce_empty
            else zoom(t1ce_arr, (factor_y, factor_x), order=1)
        )
    else:
        flair_in = flair_arr
        t1ce_in = t1ce_arr

    channels = []
    for patch in (flair_in, t1ce_in):
        for homology in (0, 1):
            channels.append(
                persistence_image(
                    patch,
                    homology=homology,
                    grid_size=grid_size,
                    output_size=output_size,
                    bandwidth=bandwidth,
                    birth_range=birth_range,
                    persistence_range=persistence_range,
                    min_persistence=min_persistence,
                )
            )
    stacked = np.stack(channels, axis=0).astype(np.float32, copy=False)
    if not np.all(np.isfinite(stacked)):
        raise FloatingPointError("make_tda_channels produced non-finite values")
    return stacked
