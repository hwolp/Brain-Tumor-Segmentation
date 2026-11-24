import type { BraTSLabelId, BraTSEditableLabelId } from '@/shared/lib/labels';
import type { VolumeModality } from '@/shared/api/types';

export type ViewerLayoutMode = 'comparison' | 'adjacent' | 'three-plane';

export type ViewerTool = 'view' | 'brush' | 'erase';

export interface VolumeGeometry {
  shape: [number, number, number];
  spacingMm: [number, number, number];
  affine: number[][];
  orientationCode?: string;
  isOblique?: boolean;
}

export interface EditorCapability {
  canEdit: boolean;
  reason: string | null;
}

export interface BraTSColorMapDefinition {
  R: number[];
  G: number[];
  B: number[];
  A: number[];
  I: number[];
  labels: string[];
}

export interface ViewerAdapterConfig {
  backgroundColor?: [number, number, number, number];
  maskOpacityPercent?: number;
  onLocationChange?: (zeroBasedAxialSlice: number) => void;
  onError?: (message: string) => void;
}

export interface ViewerVolumeInput {
  url: string;
  name: string;
  modality: VolumeModality;
  isMask?: boolean;
}

export interface ViewerAdapterInstance {
  loadVolumes: (volumes: ViewerVolumeInput[]) => Promise<void>;
  setLayout: (mode: ViewerLayoutMode) => void;
  setMaskOpacity: (opacityPercent: number) => void;
  setVisibleLabels: (visible: Record<BraTSEditableLabelId, boolean>) => void;
  setActiveLabel: (label: BraTSLabelId) => void;
  dispose: () => void;
}
