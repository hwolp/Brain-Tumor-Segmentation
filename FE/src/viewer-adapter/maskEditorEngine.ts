import type { BraTSLabelId } from '@/shared/lib/labels';
import {
  computeVoxelVolumeMm3,
  resolveAxialSliceAxes,
  voxelCoordToFlatIndex,
  type AxialSliceAxesInfo,
  type ComputedMaskStatistics,
} from './geometry';

export const DEFAULT_MAX_STROKES_PER_SLICE = 100;
export const DEFAULT_MAX_HISTORY_BYTES = 64 * 1024 * 1024; // 64 MiB

export interface StrokeCommand {
  seq: number;
  sliceIndex: number;
  indices: Uint32Array;
  oldValues: Uint8Array;
  newValues: Uint8Array;
  byteSize: number;
}

export interface MaskEditorEngineOptions {
  maxStrokesPerSlice?: number;
  maxHistoryBytes?: number;
}

/**
 * Engine quản lý working mask 3D tách biệt với base mask bất biến,
 * undo/redo theo từng lát axial và giới hạn bộ nhớ lịch sử.
 */
export class MaskEditorEngine {
  private baseMaskBuffer: Uint8Array = new Uint8Array(0);
  private workingMaskBuffer: Uint8Array = new Uint8Array(0);
  private shape: [number, number, number] = [0, 0, 0];
  private affine: number[][] = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  private axesInfo: AxialSliceAxesInfo = resolveAxialSliceAxes(
    this.affine,
    [1, 1, 1],
  );
  private voxelVolumeMm3 = 1;
  private labelCounts: { 1: number; 2: number; 4: number } = {
    1: 0,
    2: 0,
    4: 0,
  };

  private undoStacks = new Map<number, StrokeCommand[]>();
  private redoStacks = new Map<number, StrokeCommand[]>();
  private occupiedSlices = new Set<number>();
  private dirtySlices = new Set<number>();

  private totalHistoryBytes = 0;
  private nextSeq = 1;
  private historyLimitMessage: string | null = null;
  private activeStroke: {
    sliceIndex: number;
    newValue: BraTSLabelId;
    seen: Set<number>;
    changedIndices: number[];
    oldValues: number[];
    newValues: number[];
  } | null = null;

  private readonly maxStrokesPerSlice: number;
  private readonly maxHistoryBytes: number;

  constructor(options: MaskEditorEngineOptions = {}) {
    this.maxStrokesPerSlice =
      options.maxStrokesPerSlice ?? DEFAULT_MAX_STROKES_PER_SLICE;
    this.maxHistoryBytes =
      options.maxHistoryBytes ?? DEFAULT_MAX_HISTORY_BYTES;
  }

  initialize(
    baseMask: Uint8Array,
    shape: readonly [number, number, number],
    affine: number[][],
  ): void {
    const expectedLen = shape[0] * shape[1] * shape[2];
    if (baseMask.length !== expectedLen) {
      throw new Error(
        `Mask length (${baseMask.length}) không khớp shape (${shape.join('x')}).`,
      );
    }

    this.shape = [shape[0], shape[1], shape[2]];
    this.affine = affine.map((r) => [...r]);
    this.axesInfo = resolveAxialSliceAxes(this.affine, this.shape);
    this.voxelVolumeMm3 = computeVoxelVolumeMm3(this.affine);

    this.baseMaskBuffer = new Uint8Array(baseMask);
    this.workingMaskBuffer = new Uint8Array(baseMask);

    this.activeStroke = null;
    this.undoStacks.clear();
    this.redoStacks.clear();
    this.dirtySlices.clear();
    this.totalHistoryBytes = 0;
    this.nextSeq = 1;
    this.historyLimitMessage = null;

    this.recomputeOccupiedSlices();
  }

  isInitialized(): boolean {
    return this.workingMaskBuffer.length > 0;
  }

  hasActiveStroke(): boolean {
    return this.activeStroke !== null;
  }

  getShape(): [number, number, number] {
    return [...this.shape];
  }

  getAffine(): number[][] {
    return this.affine.map((r) => [...r]);
  }

  getWorkingBuffer(): Uint8Array {
    return this.workingMaskBuffer;
  }

  getBaseBuffer(): Uint8Array {
    return this.baseMaskBuffer;
  }

  getWorkingMaskSnapshot(): Uint8Array {
    return new Uint8Array(this.workingMaskBuffer);
  }

  getOccupiedSlices(): Set<number> {
    return new Set(this.occupiedSlices);
  }

  getDirtySlices(): Set<number> {
    return new Set(this.dirtySlices);
  }

  isDirty(): boolean {
    return this.dirtySlices.size > 0;
  }

  canUndo(sliceIndex: number): boolean {
    const stack = this.undoStacks.get(sliceIndex);
    return Boolean(stack && stack.length > 0);
  }

  canRedo(sliceIndex: number): boolean {
    const stack = this.redoStacks.get(sliceIndex);
    return Boolean(stack && stack.length > 0);
  }

  getHistoryLimitMessage(): string | null {
    return this.historyLimitMessage;
  }

  getTotalHistoryBytes(): number {
    return this.totalHistoryBytes;
  }

  getLabelCounts(): { 1: number; 2: number; 4: number } {
    return {
      1: this.labelCounts[1],
      2: this.labelCounts[2],
      4: this.labelCounts[4],
    };
  }

  /**
   * Trả về thống kê thể tích O(1) tức thời từ bộ đếm `labelCounts` mà không quét lại toàn bộ 3D buffer.
   */
  getVolumeStatistics(
    overrideAffine?: number[][] | null,
  ): ComputedMaskStatistics {
    const voxelVol =
      overrideAffine !== undefined
        ? computeVoxelVolumeMm3(overrideAffine)
        : this.voxelVolumeMm3;
    const counts = this.getLabelCounts();
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
      occupiedSlices: new Set(this.occupiedSlices),
    };
  }

  private adjustLabelCount(oldVal: number, newVal: number): void {
    if (oldVal === newVal) return;
    if (oldVal === 1 || oldVal === 2 || oldVal === 4) {
      this.labelCounts[oldVal] = Math.max(0, this.labelCounts[oldVal] - 1);
    }
    if (newVal === 1 || newVal === 2 || newVal === 4) {
      this.labelCounts[newVal] += 1;
    }
  }

  /**
   * Bắt đầu một nét vẽ liên tục (pointerdown -> pointermove -> pointerup)
   * để gộp toàn bộ nét vẽ thành đúng một undo unit.
   */
  beginStroke(sliceIndex: number, newValue: BraTSLabelId): void {
    if (this.activeStroke !== null) {
      this.commitStroke();
    }
    this.activeStroke = {
      sliceIndex,
      newValue,
      seen: new Set<number>(),
      changedIndices: [],
      oldValues: [],
      newValues: [],
    };
  }

  extendStroke(flatIndices: readonly number[], sliceIndex?: number): boolean {
    if (!this.activeStroke || !this.isInitialized() || flatIndices.length === 0) {
      return false;
    }
    const stroke = this.activeStroke;
    if (sliceIndex !== undefined && sliceIndex !== stroke.sliceIndex) {
      return false;
    }
    let changed = false;
    for (const idx of flatIndices) {
      if (
        idx < 0 ||
        idx >= this.workingMaskBuffer.length ||
        stroke.seen.has(idx)
      ) {
        continue;
      }
      stroke.seen.add(idx);
      const oldVal = this.workingMaskBuffer[idx] ?? 0;
      if (oldVal !== stroke.newValue) {
        stroke.changedIndices.push(idx);
        stroke.oldValues.push(oldVal);
        stroke.newValues.push(stroke.newValue);
        this.adjustLabelCount(oldVal, stroke.newValue);
        this.workingMaskBuffer[idx] = stroke.newValue;
        changed = true;
      }
    }
    if (changed) {
      this.updateSliceFlags(stroke.sliceIndex);
    }
    return changed;
  }

  commitStroke(): boolean {
    const stroke = this.activeStroke;
    this.activeStroke = null;
    if (!stroke || stroke.changedIndices.length === 0) {
      return false;
    }
    return this.pushStrokeCommand(
      stroke.sliceIndex,
      stroke.changedIndices,
      stroke.oldValues,
      stroke.newValues,
    );
  }

  /**
   * Áp dụng một stroke hoàn chỉnh lên lát axial `sliceIndex` với tập chỉ số phẳng `flatIndices`.
   * Chỉ ghi nhận các voxel thực sự thay đổi giá trị. Trả về true nếu có ít nhất 1 voxel đổi.
   */
  applyStroke(
    sliceIndex: number,
    flatIndices: readonly number[],
    newValue: BraTSLabelId,
  ): boolean {
    if (!this.isInitialized() || flatIndices.length === 0) {
      return false;
    }
    if (this.activeStroke !== null) {
      this.commitStroke();
    }

    const seen = new Set<number>();
    const changedIndices: number[] = [];
    const oldValues: number[] = [];
    const newValues: number[] = [];

    for (const idx of flatIndices) {
      if (idx < 0 || idx >= this.workingMaskBuffer.length || seen.has(idx)) {
        continue;
      }
      seen.add(idx);
      const oldVal = this.workingMaskBuffer[idx] ?? 0;
      if (oldVal !== newValue) {
        changedIndices.push(idx);
        oldValues.push(oldVal);
        newValues.push(newValue);
        this.adjustLabelCount(oldVal, newValue);
        this.workingMaskBuffer[idx] = newValue;
      }
    }

    if (changedIndices.length === 0) {
      return false;
    }

    return this.pushStrokeCommand(
      sliceIndex,
      changedIndices,
      oldValues,
      newValues,
    );
  }

  private pushStrokeCommand(
    sliceIndex: number,
    changedIndices: number[],
    oldValues: number[],
    newValues: number[],
  ): boolean {

    const indicesArr = Uint32Array.from(changedIndices);
    const oldArr = Uint8Array.from(oldValues);
    const newArr = Uint8Array.from(newValues);
    const byteSize =
      indicesArr.byteLength + oldArr.byteLength + newArr.byteLength;

    const cmd: StrokeCommand = {
      seq: this.nextSeq++,
      sliceIndex,
      indices: indicesArr,
      oldValues: oldArr,
      newValues: newArr,
      byteSize,
    };

    // Thao tác mới xóa redo stack của riêng lát hiện tại
    const existingRedo = this.redoStacks.get(sliceIndex);
    if (existingRedo && existingRedo.length > 0) {
      for (const r of existingRedo) {
        this.totalHistoryBytes = Math.max(0, this.totalHistoryBytes - r.byteSize);
      }
      this.redoStacks.delete(sliceIndex);
    }

    let undoStack = this.undoStacks.get(sliceIndex);
    if (!undoStack) {
      undoStack = [];
      this.undoStacks.set(sliceIndex, undoStack);
    }
    undoStack.push(cmd);
    this.totalHistoryBytes += byteSize;

    this.enforceHistoryLimits(sliceIndex);
    this.updateSliceFlags(sliceIndex);
    return true;
  }

  undo(sliceIndex: number): boolean {
    const undoStack = this.undoStacks.get(sliceIndex);
    if (!undoStack || undoStack.length === 0) {
      return false;
    }
    const cmd = undoStack.pop()!;
    for (let i = 0; i < cmd.indices.length; i += 1) {
      const idx = cmd.indices[i]!;
      const prevVal = this.workingMaskBuffer[idx] ?? 0;
      const restoredVal = cmd.oldValues[i]!;
      this.adjustLabelCount(prevVal, restoredVal);
      this.workingMaskBuffer[idx] = restoredVal;
    }

    let redoStack = this.redoStacks.get(sliceIndex);
    if (!redoStack) {
      redoStack = [];
      this.redoStacks.set(sliceIndex, redoStack);
    }
    redoStack.push(cmd);

    this.updateSliceFlags(sliceIndex);
    return true;
  }

  redo(sliceIndex: number): boolean {
    const redoStack = this.redoStacks.get(sliceIndex);
    if (!redoStack || redoStack.length === 0) {
      return false;
    }
    const cmd = redoStack.pop()!;
    for (let i = 0; i < cmd.indices.length; i += 1) {
      const idx = cmd.indices[i]!;
      const prevVal = this.workingMaskBuffer[idx] ?? 0;
      const nextVal = cmd.newValues[i]!;
      this.adjustLabelCount(prevVal, nextVal);
      this.workingMaskBuffer[idx] = nextVal;
    }

    let undoStack = this.undoStacks.get(sliceIndex);
    if (!undoStack) {
      undoStack = [];
      this.undoStacks.set(sliceIndex, undoStack);
    }
    undoStack.push(cmd);

    this.updateSliceFlags(sliceIndex);
    return true;
  }

  /**
   * Cập nhật base mask sau khi lưu thành công mà vẫn giữ tính toàn vẹn
   * nếu working mask có phát sinh thêm chỉnh sửa.
   */
  markSaved(savedMaskSnapshot: Uint8Array): void {
    if (savedMaskSnapshot.length !== this.workingMaskBuffer.length) {
      return;
    }
    this.baseMaskBuffer = new Uint8Array(savedMaskSnapshot);
    this.recomputeAllDirtySlices();
  }

  /**
   * Thay thế base mask (và đồng bộ lại working mask về base mới khi đổi phiên bản cùng lưới),
   * đồng thời cập nhật bộ đếm labelCounts và lịch sử.
   */
  replaceBaseMask(nextBaseMask: Uint8Array): void {
    if (nextBaseMask.length !== this.workingMaskBuffer.length) {
      throw new Error(
        `Mask length (${nextBaseMask.length}) không khớp working buffer (${this.workingMaskBuffer.length}).`,
      );
    }
    this.activeStroke = null;
    for (let i = 0; i < nextBaseMask.length; i += 1) {
      const prevVal = this.workingMaskBuffer[i] ?? 0;
      const nextVal = nextBaseMask[i] ?? 0;
      this.adjustLabelCount(prevVal, nextVal);
    }
    this.baseMaskBuffer = new Uint8Array(nextBaseMask);
    this.workingMaskBuffer = new Uint8Array(nextBaseMask);
    this.undoStacks.clear();
    this.redoStacks.clear();
    this.dirtySlices.clear();
    this.totalHistoryBytes = 0;
    this.nextSeq = 1;
    this.historyLimitMessage = null;
    this.recomputeOccupiedSlices();
  }

  discardChanges(): void {
    this.activeStroke = null;
    this.workingMaskBuffer.set(this.baseMaskBuffer);
    this.undoStacks.clear();
    this.redoStacks.clear();
    this.dirtySlices.clear();
    this.totalHistoryBytes = 0;
    this.historyLimitMessage = null;
    this.recomputeOccupiedSlices();
  }

  dispose(): void {
    this.activeStroke = null;
    this.baseMaskBuffer = new Uint8Array(0);
    this.workingMaskBuffer = new Uint8Array(0);
    this.labelCounts = { 1: 0, 2: 0, 4: 0 };
    this.undoStacks.clear();
    this.redoStacks.clear();
    this.occupiedSlices.clear();
    this.dirtySlices.clear();
    this.totalHistoryBytes = 0;
    this.historyLimitMessage = null;
  }

  private enforceHistoryLimits(sliceIndex: number): void {
    const sliceStack = this.undoStacks.get(sliceIndex);
    if (sliceStack && sliceStack.length > this.maxStrokesPerSlice) {
      while (sliceStack.length > this.maxStrokesPerSlice) {
        const evicted = sliceStack.shift();
        if (evicted) {
          this.totalHistoryBytes = Math.max(
            0,
            this.totalHistoryBytes - evicted.byteSize,
          );
          this.historyLimitMessage = `Lịch sử hoàn tác trên lát này đã đạt giới hạn ${this.maxStrokesPerSlice} nét; các nét cũ nhất đã được giải phóng nhưng dữ liệu mask hiện tại vẫn được giữ nguyên.`;
        }
      }
    }

    while (this.totalHistoryBytes > this.maxHistoryBytes) {
      let oldestSlice: number | null = null;
      let oldestSeq = Number.POSITIVE_INFINITY;
      let fromRedo = false;

      for (const [s, stack] of this.undoStacks.entries()) {
        const head = stack[0];
        if (head && head.seq < oldestSeq) {
          oldestSeq = head.seq;
          oldestSlice = s;
          fromRedo = false;
        }
      }
      for (const [s, stack] of this.redoStacks.entries()) {
        const head = stack[0];
        if (head && head.seq < oldestSeq) {
          oldestSeq = head.seq;
          oldestSlice = s;
          fromRedo = true;
        }
      }

      if (oldestSlice === null) break;
      const targetMap = fromRedo ? this.redoStacks : this.undoStacks;
      const targetStack = targetMap.get(oldestSlice);
      const evicted = targetStack?.shift();
      if (!evicted) break;

      this.totalHistoryBytes = Math.max(
        0,
        this.totalHistoryBytes - evicted.byteSize,
      );
      this.historyLimitMessage =
        'Bộ nhớ lịch sử hoàn tác toàn phiên đã đạt ngưỡng 64 MiB; thao tác cũ nhất đã được dọn bớt mà không làm mất chỉnh sửa mask.';
    }
  }

  private updateSliceFlags(sliceIndex: number): void {
    const { axialAxis, rowAxis, colAxis, rowDim, colDim } = this.axesInfo;
    let hasMask = false;
    let isSliceDirty = false;
    const coord: [number, number, number] = [0, 0, 0];
    coord[axialAxis] = sliceIndex;

    for (let r = 0; r < rowDim; r += 1) {
      coord[rowAxis] = r;
      for (let c = 0; c < colDim; c += 1) {
        coord[colAxis] = c;
        const flat = voxelCoordToFlatIndex(
          coord[0],
          coord[1],
          coord[2],
          this.shape,
        );
        const w = this.workingMaskBuffer[flat] ?? 0;
        const b = this.baseMaskBuffer[flat] ?? 0;
        if (w !== 0) hasMask = true;
        if (w !== b) isSliceDirty = true;
        if (hasMask && isSliceDirty) break;
      }
      if (hasMask && isSliceDirty) break;
    }

    if (hasMask) {
      this.occupiedSlices.add(sliceIndex);
    } else {
      this.occupiedSlices.delete(sliceIndex);
    }

    if (isSliceDirty) {
      this.dirtySlices.add(sliceIndex);
    } else {
      this.dirtySlices.delete(sliceIndex);
    }
  }

  private recomputeOccupiedSlices(): void {
    this.occupiedSlices.clear();
    let count1 = 0;
    let count2 = 0;
    let count4 = 0;
    const { axialAxis } = this.axesInfo;
    const [nx, ny, nz] = this.shape;
    const sliceStride = nx * ny;
    for (let z = 0; z < nz; z += 1) {
      const zOff = z * sliceStride;
      for (let y = 0; y < ny; y += 1) {
        const yOff = zOff + y * nx;
        for (let x = 0; x < nx; x += 1) {
          const val = this.workingMaskBuffer[yOff + x];
          if (val !== 0) {
            if (val === 1) count1 += 1;
            else if (val === 2) count2 += 1;
            else if (val === 4) count4 += 1;
            const axialSlice = axialAxis === 0 ? x : axialAxis === 1 ? y : z;
            this.occupiedSlices.add(axialSlice);
          }
        }
      }
    }
    this.labelCounts = { 1: count1, 2: count2, 4: count4 };
  }

  private recomputeAllDirtySlices(): void {
    this.dirtySlices.clear();
    const { axialAxis } = this.axesInfo;
    const [nx, ny, nz] = this.shape;
    const sliceStride = nx * ny;
    for (let z = 0; z < nz; z += 1) {
      const zOff = z * sliceStride;
      for (let y = 0; y < ny; y += 1) {
        const yOff = zOff + y * nx;
        for (let x = 0; x < nx; x += 1) {
          const idx = yOff + x;
          if (this.workingMaskBuffer[idx] !== this.baseMaskBuffer[idx]) {
            const axialSlice = axialAxis === 0 ? x : axialAxis === 1 ? y : z;
            this.dirtySlices.add(axialSlice);
          }
        }
      }
    }
  }
}
