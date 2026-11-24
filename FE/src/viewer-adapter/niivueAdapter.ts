import { Niivue, SLICE_TYPE } from '@niivue/niivue';
import type { BraTSLabelId, BraTSEditableLabelId } from '@/shared/lib/labels';
import { buildBraTSColorMap, clampOpacityPercent } from './geometry';
import type {
  ViewerAdapterConfig,
  ViewerAdapterInstance,
  ViewerLayoutMode,
  ViewerVolumeInput,
} from './types';

function buildVisibleBraTSColorMap(
  visible: Record<BraTSEditableLabelId, boolean>,
) {
  const cmap = buildBraTSColorMap();
  cmap.A = cmap.I.map((labelId, idx) => {
    if (labelId === 1 || labelId === 2 || labelId === 4) {
      return visible[labelId] ? (cmap.A[idx] ?? 255) : 0;
    }
    return 0;
  });
  return cmap;
}

/**
 * Kiểm tra trình duyệt có hỗ trợ WebGL2 cho NiiVue hay không,
 * đồng thời giải phóng ngữ cảnh thăm dò qua WEBGL_lose_context.
 */
export function isWebGLAvailable(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  try {
    const canvas = document.createElement('canvas');
    const gl2 = canvas.getContext('webgl2');
    if (!gl2) {
      return false;
    }
    gl2.getExtension?.('WEBGL_lose_context')?.loseContext?.();
    return true;
  } catch {
    return false;
  }
}

function mapLayoutToSliceType(mode: ViewerLayoutMode): SLICE_TYPE {
  switch (mode) {
    case 'three-plane':
      return SLICE_TYPE.MULTIPLANAR;
    case 'adjacent':
    case 'comparison':
    default:
      return SLICE_TYPE.AXIAL;
  }
}

/**
 * Tạo adapter bọc kín `@niivue/niivue` để React component không phụ thuộc trực tiếp vào thư viện WebGL.
 */
export async function createNiivueAdapter(
  canvas: HTMLCanvasElement,
  config: ViewerAdapterConfig = {},
): Promise<ViewerAdapterInstance> {
  if (!isWebGLAvailable()) {
    throw new Error('Trình duyệt hoặc môi trường hiện tại không hỗ trợ WebGL2.');
  }

  const nv = new Niivue({
    backColor: config.backgroundColor ?? [0.043, 0.063, 0.125, 1],
    show3Dcrosshair: true,
    isResizeCanvas: true,
  });

  await nv.attachToCanvas(canvas);

  let disposed = false;
  let maskVolumeIndex = -1;
  let currentVisibleLabels: Record<BraTSEditableLabelId, boolean> = {
    1: true,
    2: true,
    4: true,
  };

  return {
    async loadVolumes(volumes: ViewerVolumeInput[]) {
      if (disposed || volumes.length === 0) {
        return;
      }

      await nv.loadVolumes(
        volumes.map((item) => ({
          url: item.url,
          name: item.name,
          colormap: 'gray',
          opacity: item.isMask
            ? clampOpacityPercent(config.maskOpacityPercent ?? 40) / 100
            : 1,
        })),
      );

      if (disposed) {
        return;
      }

      maskVolumeIndex = volumes.findIndex((v) => v.isMask);
      const maskVolume =
        maskVolumeIndex >= 0 ? nv.volumes[maskVolumeIndex] : undefined;
      if (maskVolume) {
        maskVolume.setColormapLabel(
          buildVisibleBraTSColorMap(currentVisibleLabels),
        );
      }
      nv.updateGLVolume();
    },

    setLayout(mode: ViewerLayoutMode) {
      if (disposed) return;
      nv.setSliceType(mapLayoutToSliceType(mode));
    },

    setMaskOpacity(opacityPercent: number) {
      if (
        disposed ||
        maskVolumeIndex < 0 ||
        maskVolumeIndex >= nv.volumes.length
      ) {
        return;
      }
      const clamped = clampOpacityPercent(opacityPercent) / 100;
      nv.setOpacity(maskVolumeIndex, clamped);
    },

    setVisibleLabels(visible: Record<BraTSEditableLabelId, boolean>) {
      if (disposed) return;
      currentVisibleLabels = { ...visible };
      const maskVolume =
        maskVolumeIndex >= 0 ? nv.volumes[maskVolumeIndex] : undefined;
      if (maskVolume) {
        maskVolume.setColormapLabel(
          buildVisibleBraTSColorMap(currentVisibleLabels),
        );
      }
      nv.updateGLVolume();
    },

    setActiveLabel(_label: BraTSLabelId) {
      // Sẽ gắn với penValue ở P4 khi kích hoạt tô trực tiếp trên buffer
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      maskVolumeIndex = -1;
      try {
        nv.volumes = [];
        nv.updateGLVolume();
      } catch {
        // Bỏ qua lỗi khi WebGL context đã bị thu hồi trước đó
      }
      try {
        const gl =
          (nv as unknown as { gl?: WebGL2RenderingContext | null }).gl ??
          canvas.getContext('webgl2');
        gl?.getExtension?.('WEBGL_lose_context')?.loseContext?.();
      } catch {
        // Bỏ qua lỗi khi giải phóng ngữ cảnh WebGL
      }
    },
  };
}
