import { create } from 'zustand';
import { registerSessionCleanupHook } from '@/shared/api/queryClient';
import type { VolumeModality } from '@/shared/api/types';
import type { BraTSEditableLabelId } from '@/shared/lib/labels';
import {
  clampBrushRadius,
  clampOpacityPercent,
  clampSliceIndex,
  DEFAULT_BRUSH_RADIUS_VOXEL,
  DEFAULT_MASK_OPACITY_PERCENT,
} from './geometry';
import type { ViewerLayoutMode, ViewerTool } from './types';

export interface ViewerWindowLevel {
  center: number;
  width: number;
}

export interface ViewerPanOffset {
  x: number;
  y: number;
}

export interface ViewerState {
  caseId: string | null;
  activeVersionId: string | null;
  layoutMode: ViewerLayoutMode;
  activeTool: ViewerTool;
  activeLabel: BraTSEditableLabelId;
  brushRadius: number;
  maskOpacityPercent: number;
  visibleLabels: Record<BraTSEditableLabelId, boolean>;
  modality: VolumeModality;
  currentSliceZeroBased: number;
  totalSlices: number;
  isDirty: boolean;
  dirtySlices: number[];
  occupiedSlices: number[];
  canUndoCurrentSlice: boolean;
  canRedoCurrentSlice: boolean;
  historyLimitMessage: string | null;
  zoomLevel: number;
  panOffset: ViewerPanOffset;
  windowLevel: ViewerWindowLevel;
  crosshairVoxel: [number, number, number] | null;
  setCaseContext: (caseId: string | null, activeVersionId?: string | null) => void;
  setActiveVersionId: (versionId: string | null) => void;
  setLayoutMode: (mode: ViewerLayoutMode) => void;
  setActiveTool: (tool: ViewerTool) => void;
  setActiveLabel: (label: BraTSEditableLabelId) => void;
  setBrushRadius: (radius: number) => void;
  setMaskOpacityPercent: (opacity: number) => void;
  toggleLabelVisibility: (label: BraTSEditableLabelId) => void;
  setModality: (modality: VolumeModality) => void;
  setSliceIndex: (zeroBasedIndex: number) => void;
  setTotalSlices: (totalSlices: number) => void;
  setDirty: (dirty: boolean) => void;
  syncEngineState: (payload: {
    isDirty: boolean;
    dirtySlices: number[];
    occupiedSlices: number[];
    canUndoCurrentSlice: boolean;
    canRedoCurrentSlice: boolean;
    historyLimitMessage: string | null;
  }) => void;
  setZoomLevel: (zoom: number) => void;
  setPanOffset: (pan: ViewerPanOffset) => void;
  setWindowLevel: (wl: ViewerWindowLevel) => void;
  setCrosshairVoxel: (voxel: [number, number, number] | null) => void;
  resetViewportTransform: () => void;
  resetViewerState: () => void;
}

const INITIAL_VIEWER_DATA = {
  caseId: null as string | null,
  activeVersionId: null as string | null,
  layoutMode: 'comparison' as ViewerLayoutMode,
  activeTool: 'view' as ViewerTool,
  activeLabel: 1 as BraTSEditableLabelId,
  brushRadius: DEFAULT_BRUSH_RADIUS_VOXEL,
  maskOpacityPercent: DEFAULT_MASK_OPACITY_PERCENT,
  visibleLabels: { 1: true, 2: true, 4: true },
  modality: 'flair' as VolumeModality,
  currentSliceZeroBased: 0,
  totalSlices: 155,
  isDirty: false,
  dirtySlices: [] as number[],
  occupiedSlices: [] as number[],
  canUndoCurrentSlice: false,
  canRedoCurrentSlice: false,
  historyLimitMessage: null as string | null,
  zoomLevel: 1,
  panOffset: { x: 0, y: 0 },
  windowLevel: { center: 500, width: 1000 },
  crosshairVoxel: null as [number, number, number] | null,
};

export const useViewerStore = create<ViewerState>((set) => ({
  ...INITIAL_VIEWER_DATA,
  setCaseContext: (caseId, activeVersionId = null) =>
    set({ caseId, activeVersionId }),
  setActiveVersionId: (activeVersionId) => set({ activeVersionId }),
  setLayoutMode: (layoutMode) => set({ layoutMode }),
  setActiveTool: (activeTool) => set({ activeTool }),
  setActiveLabel: (activeLabel) => set({ activeLabel }),
  setBrushRadius: (radius) => set({ brushRadius: clampBrushRadius(radius) }),
  setMaskOpacityPercent: (opacity) =>
    set({ maskOpacityPercent: clampOpacityPercent(opacity) }),
  toggleLabelVisibility: (label) =>
    set((state) => ({
      visibleLabels: {
        ...state.visibleLabels,
        [label]: !state.visibleLabels[label],
      },
    })),
  setModality: (modality) => set({ modality }),
  setSliceIndex: (zeroBasedIndex) =>
    set((state) => ({
      currentSliceZeroBased: clampSliceIndex(zeroBasedIndex, state.totalSlices),
    })),
  setTotalSlices: (totalSlices) =>
    set((state) => ({
      totalSlices: Math.max(0, Math.floor(totalSlices)),
      currentSliceZeroBased: clampSliceIndex(
        state.currentSliceZeroBased,
        totalSlices,
      ),
    })),
  setDirty: (isDirty) => set({ isDirty }),
  syncEngineState: (payload) => set(payload),
  setZoomLevel: (zoom) =>
    set({
      zoomLevel: Number.isFinite(zoom)
        ? Math.min(8, Math.max(0.5, zoom))
        : 1,
    }),
  setPanOffset: (panOffset) => set({ panOffset }),
  setWindowLevel: (windowLevel) =>
    set({
      windowLevel: {
        center: Number.isFinite(windowLevel.center) ? windowLevel.center : 500,
        width:
          Number.isFinite(windowLevel.width) && windowLevel.width > 1
            ? windowLevel.width
            : 1,
      },
    }),
  setCrosshairVoxel: (crosshairVoxel) => set({ crosshairVoxel }),
  resetViewportTransform: () =>
    set({
      zoomLevel: 1,
      panOffset: { x: 0, y: 0 },
      windowLevel: { center: 500, width: 1000 },
    }),
  resetViewerState: () =>
    set({
      ...INITIAL_VIEWER_DATA,
      visibleLabels: { 1: true, 2: true, 4: true },
      dirtySlices: [],
      occupiedSlices: [],
      panOffset: { x: 0, y: 0 },
      windowLevel: { center: 500, width: 1000 },
    }),
}));

// Đăng ký dọn dẹp trạng thái viewer khi logout / chuyển tài khoản
registerSessionCleanupHook(() => {
  useViewerStore.getState().resetViewerState();
});
