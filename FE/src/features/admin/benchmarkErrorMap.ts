import {
  clampSliceIndex,
  planeDisplayPointToVoxelCoord,
  resolvePlaneAxes,
  voxelCoordToFlatIndex,
  type SlicePlaneType,
  type ViewerWindowLevel,
} from '@/viewer-adapter';

export type ErrorMapScope = 'WT' | 'TC' | 'ET' | '1' | '2' | '4';

/** Mã voxel trong buffer bản đồ sai khác: 0 = bình thường, 1 = TP, 2 = FP, 3 = FN */
export const ERROR_CODE_NONE = 0;
export const ERROR_CODE_TP = 1;
export const ERROR_CODE_FP = 2;
export const ERROR_CODE_FN = 3;

export const ERROR_MAP_COLORS: Record<1 | 2 | 3, readonly [number, number, number]> = {
  1: [34, 197, 94], // TP: xanh lá
  2: [239, 68, 68], // FP: đỏ (AI đoán thừa)
  3: [245, 158, 11], // FN: vàng cam (AI bỏ sót)
};

export function isVoxelInScope(label: number, scope: ErrorMapScope): boolean {
  switch (scope) {
    case 'WT':
      return label > 0;
    case 'TC':
      return label === 1 || label === 4;
    case 'ET':
      return label === 4;
    case '1':
      return label === 1;
    case '2':
      return label === 2;
    case '4':
      return label === 4;
  }
}

export function computeErrorMapVolume(
  pred: Uint8Array,
  gt: Uint8Array,
  scope: ErrorMapScope,
): Uint8Array {
  const len = Math.min(pred.length, gt.length);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    const p = isVoxelInScope(pred[i] ?? 0, scope);
    const g = isVoxelInScope(gt[i] ?? 0, scope);
    if (p && g) {
      out[i] = ERROR_CODE_TP;
    } else if (p && !g) {
      out[i] = ERROR_CODE_FP;
    } else if (!p && g) {
      out[i] = ERROR_CODE_FN;
    }
  }
  return out;
}

export function computeSliceErrorCounts(
  errorMap: Uint8Array,
  plane: SlicePlaneType,
  sliceIndex: number,
  shape: readonly [number, number, number],
  affine: number[][] | null | undefined,
): { tp: number; fp: number; fn: number } {
  const axes = resolvePlaneAxes(plane, affine, shape);
  const clamped = clampSliceIndex(sliceIndex, axes.totalSlices);
  let tp = 0;
  let fp = 0;
  let fn = 0;

  for (let dy = 0; dy < axes.rowDim; dy += 1) {
    for (let dx = 0; dx < axes.colDim; dx += 1) {
      const coord = planeDisplayPointToVoxelCoord(
        plane,
        dx,
        dy,
        clamped,
        affine,
        shape,
      );
      const flat = voxelCoordToFlatIndex(coord[0], coord[1], coord[2], shape);
      const code = errorMap[flat] ?? 0;
      if (code === ERROR_CODE_TP) tp += 1;
      else if (code === ERROR_CODE_FP) fp += 1;
      else if (code === ERROR_CODE_FN) fn += 1;
    }
  }

  return { tp, fp, fn };
}

export function computeAutoWindowLevel(mri: Float32Array): ViewerWindowLevel {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < mri.length; i += 1) {
    const val = mri[i] ?? 0;
    if (!Number.isFinite(val) || val === 0) continue;
    if (val < min) min = val;
    if (val > max) max = val;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return { center: 0.5, width: 1 };
  }
  return {
    center: (min + max) / 2,
    width: Math.max(1e-3, max - min),
  };
}
