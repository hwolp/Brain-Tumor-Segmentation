import {
  BRATS_ALL_LABEL_IDS,
  BRATS_LABELS,
  type BraTSLabelId,
} from '@/shared/lib/labels';
import type {
  BraTSColorMapDefinition,
  EditorCapability,
  VolumeGeometry,
} from './types';

export const DESKTOP_EDITOR_MIN_WIDTH_PX = 1024;
export const COMPACT_SINGLE_PANE_MAX_WIDTH_PX = 767;

export const DEFAULT_BRUSH_RADIUS_VOXEL = 3;
export const MIN_BRUSH_RADIUS_VOXEL = 1;
export const MAX_BRUSH_RADIUS_VOXEL = 20;
export const DEFAULT_MASK_OPACITY_PERCENT = 40;

/**
 * Giới hạn chỉ số lát 0-based trong khoảng [0, totalSlices - 1].
 */
export function clampSliceIndex(
  zeroBasedIndex: number,
  totalSlices: number,
): number {
  if (!Number.isFinite(totalSlices) || totalSlices <= 0) {
    return 0;
  }
  const maxIndex = Math.floor(totalSlices) - 1;
  if (!Number.isFinite(zeroBasedIndex)) {
    return 0;
  }
  const integerIndex = Math.trunc(zeroBasedIndex);
  if (integerIndex < 0) return 0;
  if (integerIndex > maxIndex) return maxIndex;
  return integerIndex;
}

/**
 * Chuyển đổi chỉ số lát nội bộ 0-based sang chỉ số hiển thị UI 1-based.
 */
export function toOneBasedSlice(
  zeroBasedIndex: number,
  totalSlices: number,
): number {
  if (!Number.isFinite(totalSlices) || totalSlices <= 0) {
    return 0;
  }
  return clampSliceIndex(zeroBasedIndex, totalSlices) + 1;
}

/**
 * Chuyển đổi số lát người dùng nhập (1-based) sang chỉ số voxel 0-based.
 */
export function toZeroBasedSlice(
  oneBasedIndex: number,
  totalSlices: number,
): number {
  if (!Number.isFinite(totalSlices) || totalSlices <= 0) {
    return 0;
  }
  if (!Number.isFinite(oneBasedIndex)) {
    return 0;
  }
  return clampSliceIndex(Math.trunc(oneBasedIndex) - 1, totalSlices);
}

/**
 * Trả về bộ ba lát lân cận [k-1, k, k+1] dạng 0-based.
 * Ở đầu/cuối khối ảnh trả về `null` cho khung ngoài biên, tuyệt đối không wrap-around.
 */
export function getAdjacentSliceIndices(
  currentZeroBased: number,
  totalSlices: number,
): [number | null, number | null, number | null] {
  if (!Number.isFinite(totalSlices) || totalSlices <= 0) {
    return [null, null, null];
  }
  const maxIndex = Math.floor(totalSlices) - 1;
  const center = clampSliceIndex(currentZeroBased, totalSlices);
  const prev = center > 0 ? center - 1 : null;
  const next = center < maxIndex ? center + 1 : null;
  return [prev, center, next];
}

export function clampBrushRadius(radius: number): number {
  if (!Number.isFinite(radius)) {
    return DEFAULT_BRUSH_RADIUS_VOXEL;
  }
  const intRadius = Math.round(radius);
  return Math.min(
    MAX_BRUSH_RADIUS_VOXEL,
    Math.max(MIN_BRUSH_RADIUS_VOXEL, intRadius),
  );
}

export function clampOpacityPercent(opacity: number): number {
  if (!Number.isFinite(opacity)) {
    return DEFAULT_MASK_OPACITY_PERCENT;
  }
  return Math.min(100, Math.max(0, Math.round(opacity)));
}

/**
 * Kiểm tra ma trận affine 4x4 có thẳng hàng với trục tọa độ (hỗ trợ hoán vị/đảo dấu trục)
 * trong sai số cho phép hay là ma trận nghiêng (oblique).
 */
export function isAffineAxisAligned(
  affine: number[][],
  tolerance = 1e-4,
): boolean {
  if (affine.length < 3) {
    return false;
  }
  const usedCols = new Set<number>();

  for (let rowIdx = 0; rowIdx < 3; rowIdx += 1) {
    const row = affine[rowIdx];
    if (!row || row.length < 3) {
      return false;
    }

    let dominantCol = -1;
    let maxAbs = 0;
    let nonZeroCount = 0;

    for (let colIdx = 0; colIdx < 3; colIdx += 1) {
      const val = row[colIdx];
      if (val === undefined || !Number.isFinite(val)) {
        return false;
      }
      const absVal = Math.abs(val);
      if (absVal > tolerance) {
        nonZeroCount += 1;
        if (absVal > maxAbs) {
          maxAbs = absVal;
          dominantCol = colIdx;
        }
      }
    }

    if (nonZeroCount !== 1 || dominantCol === -1 || usedCols.has(dominantCol)) {
      return false;
    }
    usedCols.add(dominantCol);
  }

  return usedCols.size === 3;
}

/**
 * Kiểm tra điều kiện hình học có cho phép chỉnh sửa mask trực tiếp trên lưới gốc hay không.
 */
export function checkVolumeGeometryEditable(
  geometry: VolumeGeometry,
): EditorCapability {
  if (geometry.isOblique || !isAffineAxisAligned(geometry.affine)) {
    return {
      canEdit: false,
      reason:
        'Khối MRI có hướng nghiêng (oblique) không thể ánh xạ trực tiếp vào lưới voxel gốc trong bản v1. Chỉ hỗ trợ chế độ xem.',
    };
  }
  return { canEdit: true, reason: null };
}

/**
 * Kiểm tra cổng desktop >= 1024px và hình học volume để quyết định bật/tắt công cụ tô/xóa.
 */
export function checkViewportEditorCapability(
  viewportWidthPx: number,
  geometry?: VolumeGeometry | null,
): EditorCapability {
  if (!Number.isFinite(viewportWidthPx) || viewportWidthPx < DESKTOP_EDITOR_MIN_WIDTH_PX) {
    return {
      canEdit: false,
      reason: `Công cụ chỉnh sửa mask chỉ mở trên màn hình desktop từ ${DESKTOP_EDITOR_MIN_WIDTH_PX} px trở lên. Đang ở chế độ chỉ đọc.`,
    };
  }
  if (geometry) {
    return checkVolumeGeometryEditable(geometry);
  }
  return { canEdit: true, reason: null };
}

const PERMUTATIONS_3: ReadonlyArray<
  readonly [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2]
> = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

interface DominantAxisEntry {
  axis: 0 | 1 | 2;
  coeff: number;
}

/**
 * Chuẩn hóa từng cột của `affine[:3, :3]` theo độ dài cột và tìm hoán vị 1-1
 * giữa 3 trục thế giới (X, Y, Z) với 3 trục voxel (0, 1, 2) có tổng trị tuyệt đối hệ số lớn nhất.
 */
function resolveWorldAxisPermutation(
  affine: number[][] | null | undefined,
): {
  x: DominantAxisEntry;
  y: DominantAxisEntry;
  z: DominantAxisEntry;
} {
  if (!affine || affine.length < 3) {
    return {
      x: { axis: 0, coeff: 1 },
      y: { axis: 1, coeff: 1 },
      z: { axis: 2, coeff: 1 },
    };
  }

  const raw: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];

  for (const r of [0, 1, 2] as const) {
    const row = affine[r];
    for (const c of [0, 1, 2] as const) {
      const val = row?.[c];
      raw[r][c] = val !== undefined && Number.isFinite(val) ? val : 0;
    }
  }

  const colNorms: [number, number, number] = [
    Math.hypot(raw[0][0], raw[1][0], raw[2][0]),
    Math.hypot(raw[0][1], raw[1][1], raw[2][1]),
    Math.hypot(raw[0][2], raw[1][2], raw[2][2]),
  ];

  const unit: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];

  for (const c of [0, 1, 2] as const) {
    const n = colNorms[c];
    if (n > 0) {
      unit[0][c] = raw[0][c] / n;
      unit[1][c] = raw[1][c] / n;
      unit[2][c] = raw[2][c] / n;
    }
  }

  let bestPerm: readonly [0 | 1 | 2, 0 | 1 | 2, 0 | 1 | 2] = PERMUTATIONS_3[0]!;
  let bestScore = -1;

  for (const perm of PERMUTATIONS_3) {
    const score =
      Math.abs(unit[0][perm[0]]) +
      Math.abs(unit[1][perm[1]]) +
      Math.abs(unit[2][perm[2]]);
    if (score > bestScore + 1e-12) {
      bestScore = score;
      bestPerm = perm;
    }
  }

  const coeffFor = (rowIdx: 0 | 1 | 2, colIdx: 0 | 1 | 2): number => {
    const v = unit[rowIdx][colIdx];
    return v === 0 ? 1 : v;
  };

  return {
    x: { axis: bestPerm[0], coeff: coeffFor(0, bestPerm[0]) },
    y: { axis: bestPerm[1], coeff: coeffFor(1, bestPerm[1]) },
    z: { axis: bestPerm[2], coeff: coeffFor(2, bestPerm[2]) },
  };
}

/**
 * Xác định chỉ số trục voxel tương ứng với phương axial (world-Z) theo hoán vị 1-1 chuẩn hóa cột.
 * Tránh giả định cứng `shape[2]` luôn là số lát axial khi volume có hoán vị trục hoặc anisotropic/oblique.
 */
export function getAxialAxisIndex(
  affine: number[][] | null | undefined,
): 0 | 1 | 2 {
  return resolveWorldAxisPermutation(affine).z.axis;
}

/**
 * Lấy tổng số lát axial dựa trên `shape` và ma trận `affine` (fallback trục 2).
 */
export function getAxialSliceCount(
  shape: readonly [number, number, number],
  affine?: number[][] | null,
): number {
  const axisIdx = getAxialAxisIndex(affine);
  const count = shape[axisIdx];
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

/**
 * Tạo bảng màu chuẩn NiiVue bảo toàn nguyên giá trị nhãn BraTS {0, 1, 2, 4}.
 * Không nén nhãn 4 thành 3.
 */
export function buildBraTSColorMap(): BraTSColorMapDefinition {
  const R: number[] = [];
  const G: number[] = [];
  const B: number[] = [];
  const A: number[] = [];
  const I: number[] = [];
  const labels: string[] = [];

  for (const id of BRATS_ALL_LABEL_IDS) {
    const spec = BRATS_LABELS[id as BraTSLabelId];
    I.push(spec.id);
    R.push(spec.rgba[0]);
    G.push(spec.rgba[1]);
    B.push(spec.rgba[2]);
    A.push(spec.rgba[3]);
    labels.push(spec.shortName);
  }

  return { R, G, B, A, I, labels };
}

export type SlicePlaneType = 'axial' | 'coronal' | 'sagittal';

export interface AxialSliceAxesInfo {
  axialAxis: 0 | 1 | 2;
  rowAxis: 0 | 1 | 2;
  colAxis: 0 | 1 | 2;
  totalSlices: number;
  rowDim: number;
  colDim: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
  leftRightAnnotation: { left: string; right: string };
  antPostAnnotation: { top: string; bottom: string };
}

/**
 * Chuyển tọa độ voxel (vx, vy, vz) sang chỉ số phẳng trong buffer NIfTI (Fortran order).
 */
export function voxelCoordToFlatIndex(
  vx: number,
  vy: number,
  vz: number,
  shape: readonly [number, number, number],
): number {
  return vx + vy * shape[0] + vz * shape[0] * shape[1];
}

/**
 * Suy luận trục hiển thị axial, hướng lật và nhãn giải phẫu L/R, A/P từ ma trận affine.
 * Quy ước hiển thị X-quang chuẩn (radiological): Phải (R) bên trái màn hình, Trái (L) bên phải;
 * Trước (A) ở trên, Sau (P) ở dưới.
 */
export function resolveAxialSliceAxes(
  affine: number[][] | null | undefined,
  shape: readonly [number, number, number],
): AxialSliceAxesInfo {
  const { x: xDom, y: yDom, z: zDom } = resolveWorldAxisPermutation(affine);

  const colAxis = xDom.axis;
  const rowAxis = yDom.axis;
  const axialAxis = zDom.axis;

  const colDim = Math.max(1, Math.floor(shape[colAxis]));
  const rowDim = Math.max(1, Math.floor(shape[rowAxis]));
  const totalSlices = Math.max(1, Math.floor(shape[axialAxis]));

  // Trong RAS: +X là Right, -X là Left. Muốn R ở bên trái (displayX=0) thì khi coeff > 0 cần lật ngang.
  const flipHorizontal = xDom.coeff > 0;
  // Trong RAS: +Y là Anterior, -Y là Posterior. Muốn A ở trên (displayY=0) thì khi coeff > 0 cần lật dọc.
  const flipVertical = yDom.coeff > 0;

  return {
    axialAxis,
    rowAxis,
    colAxis,
    totalSlices,
    rowDim,
    colDim,
    flipHorizontal,
    flipVertical,
    leftRightAnnotation: { left: 'R', right: 'L' },
    antPostAnnotation: { top: 'A', bottom: 'P' },
  };
}

export interface PlaneSliceAxesInfo {
  sliceAxis: 0 | 1 | 2;
  rowAxis: 0 | 1 | 2;
  colAxis: 0 | 1 | 2;
  totalSlices: number;
  rowDim: number;
  colDim: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
  leftRightAnnotation: { left: string; right: string };
  topBottomAnnotation: { top: string; bottom: string };
}

/**
 * Suy luận trục hiển thị cho cả 3 mặt phẳng Axial / Coronal / Sagittal từ affine.
 * Đảm bảo (colAxis, rowAxis, sliceAxis) luôn là một hoán vị 1-1 của [0, 1, 2].
 */
export function resolvePlaneAxes(
  plane: SlicePlaneType,
  affine: number[][] | null | undefined,
  shape: readonly [number, number, number],
): PlaneSliceAxesInfo {
  if (plane === 'axial') {
    const axial = resolveAxialSliceAxes(affine, shape);
    return {
      sliceAxis: axial.axialAxis,
      rowAxis: axial.rowAxis,
      colAxis: axial.colAxis,
      totalSlices: axial.totalSlices,
      rowDim: axial.rowDim,
      colDim: axial.colDim,
      flipHorizontal: axial.flipHorizontal,
      flipVertical: axial.flipVertical,
      leftRightAnnotation: axial.leftRightAnnotation,
      topBottomAnnotation: axial.antPostAnnotation,
    };
  }

  const { x: xDom, y: yDom, z: zDom } = resolveWorldAxisPermutation(affine);

  if (plane === 'coronal') {
    // Coronal: slice theo Y (A/P), ngang là X (R/L), dọc là Z (S trên / I dưới)
    return {
      sliceAxis: yDom.axis,
      colAxis: xDom.axis,
      rowAxis: zDom.axis,
      totalSlices: Math.max(1, Math.floor(shape[yDom.axis])),
      colDim: Math.max(1, Math.floor(shape[xDom.axis])),
      rowDim: Math.max(1, Math.floor(shape[zDom.axis])),
      flipHorizontal: xDom.coeff > 0,
      flipVertical: zDom.coeff > 0,
      leftRightAnnotation: { left: 'R', right: 'L' },
      topBottomAnnotation: { top: 'S', bottom: 'I' },
    };
  }

  // Sagittal: slice theo X (R/L), ngang là Y (A trái / P phải), dọc là Z (S trên / I dưới)
  return {
    sliceAxis: xDom.axis,
    colAxis: yDom.axis,
    rowAxis: zDom.axis,
    totalSlices: Math.max(1, Math.floor(shape[xDom.axis])),
    colDim: Math.max(1, Math.floor(shape[yDom.axis])),
    rowDim: Math.max(1, Math.floor(shape[zDom.axis])),
    flipHorizontal: yDom.coeff > 0,
    flipVertical: zDom.coeff > 0,
    leftRightAnnotation: { left: 'A', right: 'P' },
    topBottomAnnotation: { top: 'S', bottom: 'I' },
  };
}

/**
 * Ánh xạ tọa độ điểm hiển thị 2D (displayX, displayY) trên mặt phẳng bất kỳ (axial / coronal / sagittal)
 * sang tọa độ voxel 3D [vx, vy, vz].
 */
export function planeDisplayPointToVoxelCoord(
  plane: SlicePlaneType,
  displayX: number,
  displayY: number,
  sliceIndex: number,
  affine: number[][] | null | undefined,
  shape: readonly [number, number, number],
): [number, number, number] {
  const axes = resolvePlaneAxes(plane, affine, shape);
  const clampedSlice = clampSliceIndex(sliceIndex, axes.totalSlices);
  const safeX = Number.isFinite(displayX) ? Math.round(displayX) : 0;
  const safeY = Number.isFinite(displayY) ? Math.round(displayY) : 0;
  const clampedX = Math.min(axes.colDim - 1, Math.max(0, safeX));
  const clampedY = Math.min(axes.rowDim - 1, Math.max(0, safeY));

  const colCoord = axes.flipHorizontal ? axes.colDim - 1 - clampedX : clampedX;
  const rowCoord = axes.flipVertical ? axes.rowDim - 1 - clampedY : clampedY;

  const coord: [number, number, number] = [0, 0, 0];
  coord[axes.colAxis] = colCoord;
  coord[axes.rowAxis] = rowCoord;
  coord[axes.sliceAxis] = clampedSlice;
  return coord;
}

/**
 * Ánh xạ tọa độ điểm hiển thị 2D (displayX, displayY) trên lát axial sang tọa độ voxel 3D [vx, vy, vz].
 */
export function displayPointToVoxelCoord(
  displayX: number,
  displayY: number,
  sliceIndex: number,
  affine: number[][] | null | undefined,
  shape: readonly [number, number, number],
): [number, number, number] {
  return planeDisplayPointToVoxelCoord(
    'axial',
    displayX,
    displayY,
    sliceIndex,
    affine,
    shape,
  );
}

/**
 * Ánh xạ ngược tọa độ voxel 3D [vx, vy, vz] sang tọa độ hiển thị 2D trên mặt phẳng chỉ định.
 */
export function voxelCoordToDisplayPoint(
  voxel: readonly [number, number, number],
  plane: SlicePlaneType,
  affine: number[][] | null | undefined,
  shape: readonly [number, number, number],
): { displayX: number; displayY: number; sliceIndex: number } {
  const axes = resolvePlaneAxes(plane, affine, shape);
  const colCoord = voxel[axes.colAxis];
  const rowCoord = voxel[axes.rowAxis];
  const sliceIndex = voxel[axes.sliceAxis];

  const displayX = axes.flipHorizontal
    ? axes.colDim - 1 - colCoord
    : colCoord;
  const displayY = axes.flipVertical
    ? axes.rowDim - 1 - rowCoord
    : rowCoord;

  return { displayX, displayY, sliceIndex };
}

/**
 * Tính danh sách chỉ số voxel phẳng thuộc hình tròn cọ vẽ (dx² + dy² <= r²)
 * chỉ trên lát axial `sliceIndex` hiện tại, không bao giờ chạm vào lát k-1 hay k+1.
 */
export function computeSliceBrushIndices(
  centerVoxel: readonly [number, number, number],
  radiusVoxels: number,
  sliceIndex: number,
  affine: number[][] | null | undefined,
  shape: readonly [number, number, number],
): number[] {
  const axes = resolveAxialSliceAxes(affine, shape);
  const clampedSlice = clampSliceIndex(sliceIndex, axes.totalSlices);
  const r = clampBrushRadius(radiusVoxels);
  const rSq = r * r;

  const centerCol = centerVoxel[axes.colAxis];
  const centerRow = centerVoxel[axes.rowAxis];

  const minCol = Math.max(0, centerCol - r);
  const maxCol = Math.min(axes.colDim - 1, centerCol + r);
  const minRow = Math.max(0, centerRow - r);
  const maxRow = Math.min(axes.rowDim - 1, centerRow + r);

  const indices: number[] = [];
  const coord: [number, number, number] = [0, 0, 0];
  coord[axes.axialAxis] = clampedSlice;

  for (let row = minRow; row <= maxRow; row += 1) {
    const dy = row - centerRow;
    for (let col = minCol; col <= maxCol; col += 1) {
      const dx = col - centerCol;
      if (dx * dx + dy * dy <= rSq) {
        coord[axes.colAxis] = col;
        coord[axes.rowAxis] = row;
        indices.push(voxelCoordToFlatIndex(coord[0], coord[1], coord[2], shape));
      }
    }
  }

  return indices;
}

/**
 * Nội suy đường thẳng Bresenham giữa hai điểm hiển thị để kéo chuột nhanh không bị đứt nét.
 */
export function interpolateDisplayStroke(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
): Array<{ x: number; y: number }> {
  if (
    !Number.isFinite(p0.x) ||
    !Number.isFinite(p0.y) ||
    !Number.isFinite(p1.x) ||
    !Number.isFinite(p1.y)
  ) {
    return [];
  }
  let x0 = Math.round(p0.x);
  let y0 = Math.round(p0.y);
  const x1 = Math.round(p1.x);
  const y1 = Math.round(p1.y);

  const points: Array<{ x: number; y: number }> = [];
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;

  while (true) {
    points.push({ x: x0, y: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }

  return points;
}

/**
 * Tính thể tích 1 voxel (mm³) = |det(affine[:3, :3])|.
 */
export function computeVoxelVolumeMm3(
  affine: number[][] | null | undefined,
): number {
  if (!affine || affine.length < 3) return 1;
  const r0 = affine[0];
  const r1 = affine[1];
  const r2 = affine[2];
  if (!r0 || !r1 || !r2) return 1;

  const a = r0[0] ?? 0;
  const b = r0[1] ?? 0;
  const c = r0[2] ?? 0;
  const d = r1[0] ?? 0;
  const e = r1[1] ?? 0;
  const f = r1[2] ?? 0;
  const g = r2[0] ?? 0;
  const h = r2[1] ?? 0;
  const i = r2[2] ?? 0;

  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  const absDet = Math.abs(det);
  return Number.isFinite(absDet) && absDet > 0 ? absDet : 1;
}

export interface ComputedMaskStatistics {
  counts: { 1: number; 2: number; 4: number };
  volumesMm3: { 1: number; 2: number; 4: number };
  compositeMm3: { WT: number; TC: number; ET: number };
  occupiedSlices: Set<number>;
}

/**
 * Tính thống kê số voxel, thể tích mm³ theo nhãn BraTS và tập các lát axial có mask.
 */
export function computeMaskStatistics(
  maskBuffer: Uint8Array,
  affine: number[][] | null | undefined,
  shape: readonly [number, number, number],
): ComputedMaskStatistics {
  const axes = resolveAxialSliceAxes(affine, shape);
  const [nx, ny, nz] = shape;
  const counts = { 1: 0, 2: 0, 4: 0 };
  const occupiedSlices = new Set<number>();

  const sliceStride = nx * ny;
  for (let z = 0; z < nz; z += 1) {
    const zOffset = z * sliceStride;
    for (let y = 0; y < ny; y += 1) {
      const rowOffset = zOffset + y * nx;
      for (let x = 0; x < nx; x += 1) {
        const val = maskBuffer[rowOffset + x];
        if (val === 0) continue;
        if (val === 1 || val === 2 || val === 4) {
          counts[val] += 1;
        }
        const axialSlice =
          axes.axialAxis === 0 ? x : axes.axialAxis === 1 ? y : z;
        occupiedSlices.add(axialSlice);
      }
    }
  }

  const voxelVol = computeVoxelVolumeMm3(affine);
  const volumesMm3 = {
    1: counts[1] * voxelVol,
    2: counts[2] * voxelVol,
    4: counts[4] * voxelVol,
  };
  const compositeMm3 = {
    WT: volumesMm3[1] + volumesMm3[2] + volumesMm3[4],
    TC: volumesMm3[1] + volumesMm3[4],
    ET: volumesMm3[4],
  };

  return {
    counts,
    volumesMm3,
    compositeMm3,
    occupiedSlices,
  };
}

/**
 * Tìm lát có mask gần nhất theo hướng trước/sau từ cache các lát có mask.
 */
export function findNextMaskSlice(
  occupiedSlices: ReadonlySet<number>,
  dirtySlices: ReadonlySet<number>,
  currentSlice: number,
  direction: 'prev' | 'next',
): number | null {
  let candidate: number | null = null;
  const checkSlice = (s: number) => {
    if (direction === 'prev') {
      if (s < currentSlice && (candidate === null || s > candidate)) {
        candidate = s;
      }
    } else if (s > currentSlice && (candidate === null || s < candidate)) {
      candidate = s;
    }
  };

  for (const s of occupiedSlices) {
    checkSlice(s);
  }
  for (const s of dirtySlices) {
    if (occupiedSlices.has(s)) {
      checkSlice(s);
    }
  }
  return candidate;
}
