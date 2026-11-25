import * as React from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { cn } from '@/shared/lib/cn';
import {
  BRATS_LABELS,
  type BraTSLabelId,
  type BraTSEditableLabelId,
} from '@/shared/lib/labels';
import {
  planeDisplayPointToVoxelCoord,
  resolvePlaneAxes,
  voxelCoordToDisplayPoint,
  voxelCoordToFlatIndex,
  type SlicePlaneType,
  type ViewerPanOffset,
  type ViewerTool,
  type ViewerWindowLevel,
} from '@/viewer-adapter';

export interface SliceCanvasPaneProps {
  title: string;
  testId?: string;
  plane: SlicePlaneType;
  sliceIndex: number | null;
  shape: readonly [number, number, number];
  affine: number[][] | null | undefined;
  mriBuffer: Float32Array | null;
  maskBuffer: Uint8Array | null;
  showMask: boolean;
  editable: boolean;
  activeTool: ViewerTool;
  activeLabel?: BraTSEditableLabelId;
  brushRadius?: number;
  maskOpacityPercent: number;
  visibleLabels: Record<BraTSEditableLabelId, boolean>;
  windowLevel: ViewerWindowLevel;
  zoomLevel: number;
  panOffset: ViewerPanOffset;
  crosshairVoxel: [number, number, number] | null;
  renderRevision: number;
  isMaximized?: boolean;
  isFullscreen?: boolean;
  fillContainer?: boolean;
  onToggleMaximize?: () => void;
  onResetView?: () => void;
  onStrokeStart?: (displayX: number, displayY: number) => void;
  onStrokeMove?: (displayX: number, displayY: number) => void;
  onStrokeEnd?: () => void;
  onSelectCrosshair?: (displayX: number, displayY: number) => void;
  onWheelSlice?: (delta: number) => void;
  onZoomDelta?: (delta: number) => void;
  onPanDelta?: (dx: number, dy: number) => void;
  onBrushRadiusDelta?: (delta: number) => void;
}

function getDisplayCoordsFromPointer(
  e: React.PointerEvent<HTMLCanvasElement>,
  colDim: number,
  rowDim: number,
): { displayX: number; displayY: number } {
  const clientX =
    typeof e.clientX === 'number' && Number.isFinite(e.clientX) ? e.clientX : 0;
  const clientY =
    typeof e.clientY === 'number' && Number.isFinite(e.clientY) ? e.clientY : 0;
  const canvas = e.currentTarget;
  const rect = canvas.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    const displayX = ((clientX - rect.left) / rect.width) * colDim;
    const displayY = ((clientY - rect.top) / rect.height) * rowDim;
    return {
      displayX: Math.min(colDim - 1, Math.max(0, Math.floor(displayX))),
      displayY: Math.min(rowDim - 1, Math.max(0, Math.floor(displayY))),
    };
  }
  const offsetX =
    typeof e.nativeEvent.offsetX === 'number' &&
    Number.isFinite(e.nativeEvent.offsetX)
      ? e.nativeEvent.offsetX
      : clientX;
  const offsetY =
    typeof e.nativeEvent.offsetY === 'number' &&
    Number.isFinite(e.nativeEvent.offsetY)
      ? e.nativeEvent.offsetY
      : clientY;
  return {
    displayX: Math.min(colDim - 1, Math.max(0, Math.floor(offsetX))),
    displayY: Math.min(rowDim - 1, Math.max(0, Math.floor(offsetY))),
  };
}

function isSpacePanBlockedTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName.toLowerCase();
  if (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    tag === 'button' ||
    tag === 'a'
  ) {
    return true;
  }
  if (target.isContentEditable) return true;
  const role = target.getAttribute('role');
  if (role === 'combobox' || role === 'dialog' || role === 'button') return true;
  return Boolean(target.closest('[role="dialog"]'));
}

const PAN_DRAG_THRESHOLD_PX = 3;

interface PendingViewPress {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  displayX: number;
  displayY: number;
  hasDragged: boolean;
}

export function SliceCanvasPane({
  title,
  testId,
  plane,
  sliceIndex,
  shape,
  affine,
  mriBuffer,
  maskBuffer,
  showMask,
  editable,
  activeTool,
  activeLabel = 1,
  brushRadius = 3,
  maskOpacityPercent,
  visibleLabels,
  windowLevel,
  zoomLevel,
  panOffset,
  crosshairVoxel,
  renderRevision,
  isMaximized = false,
  isFullscreen = false,
  fillContainer = false,
  onToggleMaximize,
  onResetView,
  onStrokeStart,
  onStrokeMove,
  onStrokeEnd,
  onSelectCrosshair,
  onWheelSlice,
  onZoomDelta,
  onPanDelta,
  onBrushRadiusDelta,
}: SliceCanvasPaneProps) {
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const activePointerIdRef = React.useRef<number | null>(null);
  const isDrawingRef = React.useRef(false);
  const isPanningRef = React.useRef(false);
  const pendingViewPressRef = React.useRef<PendingViewPress | null>(null);
  const lastPanClientRef = React.useRef<{ x: number; y: number } | null>(null);
  const isSpacePanHeldRef = React.useRef(false);
  const handledWheelEventsRef = React.useRef<WeakSet<Event>>(new WeakSet());
  const onStrokeEndRef = React.useRef(onStrokeEnd);
  onStrokeEndRef.current = onStrokeEnd;

  const [isDraggingPan, setIsDraggingPan] = React.useState(false);
  const [isSpacePanHeld, setIsSpacePanHeld] = React.useState(false);
  const [viewportSize, setViewportSize] = React.useState<{
    width: number;
    height: number;
  } | null>(null);
  const [hoverPoint, setHoverPoint] = React.useState<{
    displayX: number;
    displayY: number;
  } | null>(null);

  const axes = React.useMemo(
    () => resolvePlaneAxes(plane, affine, shape),
    [plane, affine, shape],
  );

  React.useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || sliceIndex === null) {
      setViewportSize(null);
      return;
    }

    const updateSize = (width: number, height: number) => {
      if (!(width > 0 && height > 0)) return;
      const roundedW = Math.floor(width);
      const roundedH = Math.floor(height);
      setViewportSize((prev) =>
        prev && prev.width === roundedW && prev.height === roundedH
          ? prev
          : { width: roundedW, height: roundedH },
      );
    };

    const rect = viewport.getBoundingClientRect();
    updateSize(rect.width, rect.height);

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      updateSize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(viewport);

    return () => {
      observer.disconnect();
    };
  }, [sliceIndex]);

  const cancelActivePointerInteraction = React.useCallback(() => {
    const ptrId = activePointerIdRef.current;
    activePointerIdRef.current = null;
    pendingViewPressRef.current = null;
    if (isPanningRef.current) {
      isPanningRef.current = false;
      lastPanClientRef.current = null;
    }
    setIsDraggingPan(false);
    isSpacePanHeldRef.current = false;
    setIsSpacePanHeld(false);
    if (isDrawingRef.current) {
      isDrawingRef.current = false;
      onStrokeEndRef.current?.();
    }
    const canvas = canvasRef.current;
    if (canvas && ptrId !== null && canvas.hasPointerCapture?.(ptrId)) {
      try {
        canvas.releasePointerCapture(ptrId);
      } catch {
        // Ignore if pointer capture already released
      }
    }
    const viewport = viewportRef.current;
    if (viewport && ptrId !== null && viewport.hasPointerCapture?.(ptrId)) {
      try {
        viewport.releasePointerCapture(ptrId);
      } catch {
        // Ignore if pointer capture already released
      }
    }
  }, []);

  React.useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (isSpacePanBlockedTarget(e.target)) return;
      e.preventDefault();
      if (!isSpacePanHeldRef.current) {
        isSpacePanHeldRef.current = true;
        setIsSpacePanHeld(true);
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (isSpacePanHeldRef.current) {
        isSpacePanHeldRef.current = false;
        setIsSpacePanHeld(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', cancelActivePointerInteraction);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', cancelActivePointerInteraction);
      cancelActivePointerInteraction();
    };
  }, [cancelActivePointerInteraction]);

  React.useEffect(() => {
    if ((!editable || sliceIndex === null) && (isDrawingRef.current || isPanningRef.current)) {
      cancelActivePointerInteraction();
    }
    if (sliceIndex === null) {
      setHoverPoint(null);
    }
  }, [editable, sliceIndex, cancelActivePointerInteraction]);

  const processWheelAction = React.useCallback(
    (e: WheelEvent | React.WheelEvent<HTMLCanvasElement>) => {
      const nativeEvent = 'nativeEvent' in e ? e.nativeEvent : e;
      if (e.cancelable !== false) {
        e.preventDefault();
      }
      if (handledWheelEventsRef.current.has(nativeEvent)) {
        return;
      }
      handledWheelEventsRef.current.add(nativeEvent);

      if (e.ctrlKey || e.metaKey) {
        onZoomDelta?.(e.deltaY < 0 ? 0.15 : -0.15);
        return;
      }
      if (e.altKey) {
        onBrushRadiusDelta?.(e.deltaY < 0 ? 1 : -1);
        return;
      }
      if (isDrawingRef.current) {
        return;
      }
      if (onWheelSlice) {
        const step = e.shiftKey ? 5 : 1;
        onWheelSlice(e.deltaY > 0 ? step : -step);
      }
    },
    [onZoomDelta, onBrushRadiusDelta, onWheelSlice],
  );

  const processWheelActionRef = React.useRef(processWheelAction);
  processWheelActionRef.current = processWheelAction;

  React.useEffect(() => {
    const viewportEl = viewportRef.current;
    if (!viewportEl) return;
    const handleNativeWheel = (e: WheelEvent) => {
      processWheelActionRef.current(e);
    };
    viewportEl.addEventListener('wheel', handleNativeWheel, { passive: false });
    return () => {
      viewportEl.removeEventListener('wheel', handleNativeWheel);
    };
  }, [sliceIndex]);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || sliceIndex === null || !mriBuffer) return;

    const ctx = canvas.getContext('2d');
    if (!ctx || typeof ctx.createImageData !== 'function') return;

    const {
      colDim,
      rowDim,
      colAxis,
      rowAxis,
      sliceAxis,
      flipHorizontal,
      flipVertical,
    } = axes;
    const imageData = ctx.createImageData(colDim, rowDim);
    const pixels = imageData.data;

    const wlMin = windowLevel.center - windowLevel.width / 2;
    const wlInvWidth = 255 / Math.max(1, windowLevel.width);
    const maskAlpha = Math.min(1, Math.max(0, maskOpacityPercent / 100));

    const coord: [number, number, number] = [0, 0, 0];
    coord[sliceAxis] = Math.min(
      axes.totalSlices - 1,
      Math.max(0, sliceIndex),
    );

    for (let dy = 0; dy < rowDim; dy += 1) {
      const rowCoord = flipVertical ? rowDim - 1 - dy : dy;
      coord[rowAxis] = rowCoord;
      const rowOutBase = dy * colDim;

      for (let dx = 0; dx < colDim; dx += 1) {
        const colCoord = flipHorizontal ? colDim - 1 - dx : dx;
        coord[colAxis] = colCoord;

        const flatIdx = voxelCoordToFlatIndex(
          coord[0],
          coord[1],
          coord[2],
          shape,
        );
        const rawVal = mriBuffer[flatIdx] ?? 0;
        const gray = Math.min(
          255,
          Math.max(0, Math.round((rawVal - wlMin) * wlInvWidth)),
        );

        let r = gray;
        let g = gray;
        let b = gray;

        if (showMask && maskBuffer && maskAlpha > 0) {
          const labelVal = (maskBuffer[flatIdx] ?? 0) as BraTSLabelId;
          if (
            labelVal !== 0 &&
            (labelVal === 1 || labelVal === 2 || labelVal === 4) &&
            visibleLabels[labelVal]
          ) {
            const rgba = BRATS_LABELS[labelVal].rgba;
            r = Math.round(r * (1 - maskAlpha) + rgba[0] * maskAlpha);
            g = Math.round(g * (1 - maskAlpha) + rgba[1] * maskAlpha);
            b = Math.round(b * (1 - maskAlpha) + rgba[2] * maskAlpha);
          }
        }

        const pxOffset = (rowOutBase + dx) * 4;
        pixels[pxOffset] = r;
        pixels[pxOffset + 1] = g;
        pixels[pxOffset + 2] = b;
        pixels[pxOffset + 3] = 255;
      }
    }

    ctx.putImageData(imageData, 0, 0);

    // Vẽ crosshair đồng bộ nếu có
    if (crosshairVoxel) {
      const ch = voxelCoordToDisplayPoint(crosshairVoxel, plane, affine, shape);
      ctx.save();
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.75)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ch.displayX + 0.5, 0);
      ctx.lineTo(ch.displayX + 0.5, rowDim);
      ctx.moveTo(0, ch.displayY + 0.5);
      ctx.lineTo(colDim, ch.displayY + 0.5);
      ctx.stroke();
      ctx.restore();
    }
  }, [
    axes,
    sliceIndex,
    shape,
    affine,
    plane,
    mriBuffer,
    maskBuffer,
    showMask,
    maskOpacityPercent,
    visibleLabels,
    windowLevel,
    crosshairVoxel,
    renderRevision,
  ]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    if (sliceIndex === null || !mriBuffer) return;

    const coords = getDisplayCoordsFromPointer(e, axes.colDim, axes.rowDim);
    setHoverPoint(coords);

    const pointerId = typeof e.pointerId === 'number' ? e.pointerId : 1;
    // Bỏ qua đa điểm chạm thứ 2 khi đang có một pointer vẽ/pan dở
    if (
      activePointerIdRef.current !== null &&
      activePointerIdRef.current !== pointerId
    ) {
      return;
    }
    if (
      isDrawingRef.current ||
      isPanningRef.current ||
      pendingViewPressRef.current !== null
    ) {
      return;
    }

    const button = typeof e.button === 'number' ? e.button : 0;
    const clientX =
      typeof e.clientX === 'number' && Number.isFinite(e.clientX) ? e.clientX : 0;
    const clientY =
      typeof e.clientY === 'number' && Number.isFinite(e.clientY) ? e.clientY : 0;

    // Middle-click, hoặc giữ Shift / Space khi kéo để pan ngay
    if (button === 1 || (button === 0 && (e.shiftKey || isSpacePanHeldRef.current))) {
      activePointerIdRef.current = pointerId;
      isPanningRef.current = true;
      setIsDraggingPan(true);
      lastPanClientRef.current = { x: clientX, y: clientY };
      try {
        e.currentTarget.setPointerCapture?.(pointerId);
      } catch {
        // Ignore if unsupported
      }
      return;
    }

    if (button !== 0) return;

    const { displayX, displayY } = coords;

    if (editable && (activeTool === 'brush' || activeTool === 'erase')) {
      activePointerIdRef.current = pointerId;
      isDrawingRef.current = true;
      try {
        e.currentTarget.setPointerCapture?.(pointerId);
      } catch {
        // Ignore if unsupported
      }
      onStrokeStart?.(displayX, displayY);
    } else {
      // Chế độ Xem lát / chỉ đọc: nhấn-thả tại chỗ (< 3px) để đặt crosshair, nhấn-giữ kéo để pan ảnh
      activePointerIdRef.current = pointerId;
      pendingViewPressRef.current = {
        pointerId,
        startX: clientX,
        startY: clientY,
        lastX: clientX,
        lastY: clientY,
        displayX,
        displayY,
        hasDragged: false,
      };
      try {
        e.currentTarget.setPointerCapture?.(pointerId);
      } catch {
        // Ignore if unsupported
      }
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.stopPropagation();
    if (sliceIndex !== null && mriBuffer) {
      const hoverCoords = getDisplayCoordsFromPointer(
        e,
        axes.colDim,
        axes.rowDim,
      );
      setHoverPoint((prev) =>
        prev &&
        prev.displayX === hoverCoords.displayX &&
        prev.displayY === hoverCoords.displayY
          ? prev
          : hoverCoords,
      );
    }

    const pointerId = typeof e.pointerId === 'number' ? e.pointerId : 1;
    if (
      activePointerIdRef.current !== null &&
      pointerId !== activePointerIdRef.current
    ) {
      return;
    }

    const clientX =
      typeof e.clientX === 'number' && Number.isFinite(e.clientX) ? e.clientX : 0;
    const clientY =
      typeof e.clientY === 'number' && Number.isFinite(e.clientY) ? e.clientY : 0;

    const pendingPress = pendingViewPressRef.current;
    if (pendingPress && pendingPress.pointerId === pointerId) {
      if (!pendingPress.hasDragged) {
        if (
          Math.hypot(clientX - pendingPress.startX, clientY - pendingPress.startY) <
          PAN_DRAG_THRESHOLD_PX
        ) {
          return;
        }
        pendingPress.hasDragged = true;
        isPanningRef.current = true;
        setIsDraggingPan(true);
        const dx = clientX - pendingPress.startX;
        const dy = clientY - pendingPress.startY;
        pendingPress.lastX = clientX;
        pendingPress.lastY = clientY;
        onPanDelta?.(dx, dy);
        return;
      }
      const dx = clientX - pendingPress.lastX;
      const dy = clientY - pendingPress.lastY;
      pendingPress.lastX = clientX;
      pendingPress.lastY = clientY;
      onPanDelta?.(dx, dy);
      return;
    }

    if (isPanningRef.current && lastPanClientRef.current) {
      const dx = clientX - lastPanClientRef.current.x;
      const dy = clientY - lastPanClientRef.current.y;
      lastPanClientRef.current = { x: clientX, y: clientY };
      onPanDelta?.(dx, dy);
      return;
    }

    if (!isDrawingRef.current || !editable) return;
    const { displayX, displayY } = getDisplayCoordsFromPointer(
      e,
      axes.colDim,
      axes.rowDim,
    );
    onStrokeMove?.(displayX, displayY);
  };

  const handlePointerLeave = () => {
    if (!isDrawingRef.current) {
      setHoverPoint(null);
    }
  };

  const finishPointerAction = (
    e?: React.PointerEvent<HTMLCanvasElement | HTMLDivElement>,
  ) => {
    if (e && e.currentTarget === canvasRef.current) {
      e.stopPropagation();
    }
    if (e) {
      const pointerId = typeof e.pointerId === 'number' ? e.pointerId : 1;
      if (
        activePointerIdRef.current !== null &&
        pointerId !== activePointerIdRef.current
      ) {
        return;
      }
    }
    const endedPointerId =
      e && typeof e.pointerId === 'number'
        ? e.pointerId
        : activePointerIdRef.current;
    activePointerIdRef.current = null;

    const pendingPress = pendingViewPressRef.current;
    pendingViewPressRef.current = null;

    if (isPanningRef.current) {
      isPanningRef.current = false;
      lastPanClientRef.current = null;
    }
    setIsDraggingPan(false);

    if (isDrawingRef.current) {
      isDrawingRef.current = false;
      onStrokeEndRef.current?.();
    }

    if (pendingPress && !pendingPress.hasDragged && e?.type === 'pointerup') {
      onSelectCrosshair?.(pendingPress.displayX, pendingPress.displayY);
    }

    const targetEl = e?.currentTarget ?? canvasRef.current;
    if (
      targetEl &&
      endedPointerId !== null &&
      targetEl.hasPointerCapture?.(endedPointerId)
    ) {
      try {
        targetEl.releasePointerCapture(endedPointerId);
      } catch {
        // Ignore if pointer capture already released
      }
    }
  };

  const handleViewportPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (sliceIndex === null || !mriBuffer) return;
    if (e.target === canvasRef.current) return;
    if (e.target instanceof Element && e.target.closest('button')) return;

    const button = typeof e.button === 'number' ? e.button : 0;
    if (button !== 0 && button !== 1) return;

    const pointerId = typeof e.pointerId === 'number' ? e.pointerId : 1;
    if (
      activePointerIdRef.current !== null &&
      activePointerIdRef.current !== pointerId
    ) {
      return;
    }

    const clientX =
      typeof e.clientX === 'number' && Number.isFinite(e.clientX) ? e.clientX : 0;
    const clientY =
      typeof e.clientY === 'number' && Number.isFinite(e.clientY) ? e.clientY : 0;

    activePointerIdRef.current = pointerId;
    isPanningRef.current = true;
    setIsDraggingPan(true);
    lastPanClientRef.current = { x: clientX, y: clientY };
    try {
      e.currentTarget.setPointerCapture?.(pointerId);
    } catch {
      // Ignore if unsupported
    }
  };

  const handleViewportPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.target === canvasRef.current) return;
    const pointerId = typeof e.pointerId === 'number' ? e.pointerId : 1;
    if (
      activePointerIdRef.current !== null &&
      pointerId !== activePointerIdRef.current
    ) {
      return;
    }
    if (isPanningRef.current && lastPanClientRef.current) {
      const clientX =
        typeof e.clientX === 'number' && Number.isFinite(e.clientX) ? e.clientX : 0;
      const clientY =
        typeof e.clientY === 'number' && Number.isFinite(e.clientY) ? e.clientY : 0;
      const dx = clientX - lastPanClientRef.current.x;
      const dy = clientY - lastPanClientRef.current.y;
      lastPanClientRef.current = { x: clientX, y: clientY };
      onPanDelta?.(dx, dy);
    }
  };

  const finishViewportPointerAction = (
    e: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (e.target === canvasRef.current) return;
    finishPointerAction(e);
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    processWheelAction(e);
  };

  const isPaintToolActive =
    editable && (activeTool === 'brush' || activeTool === 'erase');

  const isSpaceOrViewPan = isSpacePanHeld || !isPaintToolActive;
  const cursorClass = isDraggingPan
    ? 'cursor-grabbing'
    : isSpaceOrViewPan
      ? 'cursor-grab'
      : 'cursor-crosshair';

  const inspectedVoxel = React.useMemo(() => {
    if (sliceIndex === null) return null;
    if (hoverPoint) {
      return planeDisplayPointToVoxelCoord(
        plane,
        hoverPoint.displayX,
        hoverPoint.displayY,
        sliceIndex,
        affine,
        shape,
      );
    }
    return crosshairVoxel;
  }, [sliceIndex, hoverPoint, plane, affine, shape, crosshairVoxel]);

  const inspectedHudInfo = React.useMemo(() => {
    if (!inspectedVoxel || !mriBuffer) return null;
    const [vx, vy, vz] = inspectedVoxel;
    const flatIdx = voxelCoordToFlatIndex(vx, vy, vz, shape);
    const intensity = Math.round(mriBuffer[flatIdx] ?? 0);
    const maskVal = maskBuffer ? ((maskBuffer[flatIdx] ?? 0) as BraTSLabelId) : 0;
    const labelText =
      maskVal === 1 || maskVal === 2 || maskVal === 4
        ? BRATS_LABELS[maskVal].shortName
        : null;
    return { vx, vy, vz, intensity, labelText };
  }, [inspectedVoxel, mriBuffer, maskBuffer, shape, renderRevision]);

  const brushHexColor =
    activeTool === 'erase'
      ? '#F87171'
      : (BRATS_LABELS[activeLabel]?.hexColor ?? '#F59E0B');

  const fittedCanvasSize = React.useMemo(() => {
    if (!viewportSize || viewportSize.width <= 0 || viewportSize.height <= 0) {
      return null;
    }
    const pad = 12;
    const availW = Math.max(1, viewportSize.width - pad);
    const availH = Math.max(1, viewportSize.height - pad);
    const scale = Math.min(availW / axes.colDim, availH / axes.rowDim);
    return {
      width: Math.max(1, Math.floor(axes.colDim * scale)),
      height: Math.max(1, Math.floor(axes.rowDim * scale)),
    };
  }, [viewportSize, axes.colDim, axes.rowDim]);

  const canvasTransformStyle = {
    transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomLevel})`,
    imageRendering: 'pixelated' as const,
  };

  const canvasSizeClass = isMaximized
    ? 'max-h-[calc(100dvh-230px)] max-w-full'
    : isFullscreen
      ? 'max-h-[calc(100dvh-280px)] max-w-full'
      : 'max-h-[420px] max-w-full';

  return (
    <div
      data-testid={testId}
      className={cn(
        'relative flex min-w-0 flex-col overflow-hidden rounded-[var(--radius-inner)] border bg-black transition-colors duration-150 ease-[var(--ease-out)]',
        fillContainer && 'h-full min-h-0',
        isPaintToolActive
          ? 'border-sky-500/60'
          : editable
            ? 'border-[var(--viewer-border-strong)]'
            : 'border-[var(--viewer-border)]',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--viewer-border)] bg-[var(--viewer-surface)] px-2.5 py-1 text-xs">
        <span className="truncate font-medium text-[var(--viewer-text)]">
          {title}
        </span>

        <div className="flex shrink-0 items-center gap-2">
          {sliceIndex === null ? (
            <span className="font-mono text-[11px] text-[var(--viewer-text-muted)]">
              Không có lát
            </span>
          ) : (
            <>
              <span className="font-mono text-[11px] text-[var(--viewer-text-secondary)] tabular-nums">
                Lát {sliceIndex + 1}/{axes.totalSlices}
              </span>
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px] font-medium',
                  editable
                    ? 'border border-sky-500/40 bg-sky-950/70 text-sky-300'
                    : 'border border-[var(--viewer-border)] bg-[var(--viewer-raised)] text-[var(--viewer-text-muted)]',
                )}
              >
                {editable && (
                  <span
                    className="size-1.5 rounded-full bg-sky-400"
                    aria-hidden="true"
                  />
                )}
                {editable ? ' · Có thể tô' : ' · Chỉ đọc'}
              </span>
            </>
          )}

          {onToggleMaximize && (
            <button
              type="button"
              aria-label={
                isMaximized ? `Thu nhỏ khung ${title}` : `Phóng đại khung ${title}`
              }
              title={
                isMaximized
                  ? 'Khôi phục bố cục nhiều khung'
                  : 'Phóng đại riêng khung ảnh này'
              }
              onClick={onToggleMaximize}
              className="inline-flex size-6 items-center justify-center rounded border border-[var(--viewer-border)] bg-[var(--viewer-raised)] text-[var(--viewer-text-secondary)] transition-colors duration-150 hover:border-[var(--viewer-border-strong)] hover:text-[var(--viewer-text)] cursor-pointer"
            >
              {isMaximized ? (
                <Minimize2 className="size-3.5" aria-hidden="true" />
              ) : (
                <Maximize2 className="size-3.5" aria-hidden="true" />
              )}
            </button>
          )}
        </div>
      </div>

      {sliceIndex === null ? (
        <div
          ref={viewportRef}
          className={cn(
            'flex items-center justify-center p-2 text-center text-sm font-medium text-[var(--viewer-text-muted)]',
            fillContainer
              ? 'min-h-[300px] flex-1 sm:min-h-[360px] lg:min-h-0'
              : 'h-[380px] sm:h-[460px]',
          )}
        >
          Không có lát
        </div>
      ) : (
        <div
          ref={viewportRef}
          onPointerDown={handleViewportPointerDown}
          onPointerMove={handleViewportPointerMove}
          onPointerUp={finishViewportPointerAction}
          onPointerCancel={finishViewportPointerAction}
          onLostPointerCapture={finishViewportPointerAction}
          className={cn(
            'relative flex touch-none select-none items-center justify-center overflow-hidden bg-black p-1.5',
            isDraggingPan ? 'cursor-grabbing' : 'cursor-grab',
            fillContainer
              ? 'min-h-[300px] flex-1 sm:min-h-[360px] lg:min-h-0'
              : 'h-[380px] sm:h-[460px]',
          )}
        >
          {/* Nhãn định hướng giải phẫu theo affine */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1 left-1/2 z-10 -translate-x-1/2 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[11px] font-medium text-[var(--viewer-text-secondary)]"
          >
            {axes.topBottomAnnotation.top}
          </span>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-1 left-1/2 z-10 -translate-x-1/2 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[11px] font-medium text-[var(--viewer-text-secondary)]"
          >
            {axes.topBottomAnnotation.bottom}
          </span>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-1 z-10 -translate-y-1/2 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[11px] font-medium text-[var(--viewer-text-secondary)]"
          >
            {axes.leftRightAnnotation.left}
          </span>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 right-1 z-10 -translate-y-1/2 rounded bg-black/75 px-1.5 py-0.5 font-mono text-[11px] font-medium text-[var(--viewer-text-secondary)]"
          >
            {axes.leftRightAnnotation.right}
          </span>

          <div
            style={
              fittedCanvasSize
                ? {
                    width: `${fittedCanvasSize.width}px`,
                    height: `${fittedCanvasSize.height}px`,
                  }
                : undefined
            }
            className={cn(
              'relative inline-flex items-center justify-center',
              !fittedCanvasSize && 'max-h-full max-w-full',
            )}
          >
            <canvas
              ref={canvasRef}
              width={axes.colDim}
              height={axes.rowDim}
              aria-label={title}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerLeave={handlePointerLeave}
              onPointerUp={finishPointerAction}
              onPointerCancel={finishPointerAction}
              onLostPointerCapture={finishPointerAction}
              onWheel={handleWheel}
              style={canvasTransformStyle}
              className={cn(
                fittedCanvasSize
                  ? 'block h-full w-full'
                  : cn(canvasSizeClass, 'object-contain'),
                'touch-none select-none',
                cursorClass,
              )}
            />

            {isPaintToolActive && !isSpacePanHeld && !isDraggingPan && hoverPoint !== null && (
              <svg
                data-testid="brush-cursor-preview"
                aria-hidden="true"
                viewBox={`0 0 ${axes.colDim} ${axes.rowDim}`}
                style={{
                  transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoomLevel})`,
                }}
                className="pointer-events-none absolute inset-0 h-full w-full"
              >
                <circle
                  cx={hoverPoint.displayX + 0.5}
                  cy={hoverPoint.displayY + 0.5}
                  r={brushRadius + 0.4}
                  stroke={brushHexColor}
                  strokeWidth={0.75}
                  strokeDasharray={activeTool === 'erase' ? '1.6 1.2' : undefined}
                  fill={brushHexColor}
                  fillOpacity={activeTool === 'erase' ? 0.15 : 0.18}
                />
                {activeTool === 'brush' && (
                  <>
                    <line
                      x1={hoverPoint.displayX + 0.5 - 1.2}
                      y1={hoverPoint.displayY + 0.5}
                      x2={hoverPoint.displayX + 0.5 + 1.2}
                      y2={hoverPoint.displayY + 0.5}
                      stroke={brushHexColor}
                      strokeWidth={0.6}
                    />
                    <line
                      x1={hoverPoint.displayX + 0.5}
                      y1={hoverPoint.displayY + 0.5 - 1.2}
                      x2={hoverPoint.displayX + 0.5}
                      y2={hoverPoint.displayY + 0.5 + 1.2}
                      stroke={brushHexColor}
                      strokeWidth={0.6}
                    />
                  </>
                )}
              </svg>
            )}
          </div>

          {/* Voxel HUD góc dưới trái */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute bottom-1.5 left-1.5 z-10 hidden max-w-[68%] truncate rounded border border-[var(--viewer-border)] bg-[var(--viewer-bg)]/90 px-2 py-0.5 font-mono text-[11px] text-[var(--viewer-text-secondary)] tabular-nums sm:block"
          >
            {inspectedHudInfo ? (
              <>
                Voxel ({inspectedHudInfo.vx},{inspectedHudInfo.vy},
                {inspectedHudInfo.vz}) · I:{inspectedHudInfo.intensity}
                {inspectedHudInfo.labelText
                  ? ` · ${inspectedHudInfo.labelText}`
                  : ' · Lăn chuột: ±Lát'}
              </>
            ) : (
              'Kéo ảnh: Di chuyển · Lăn: ±Lát · Ctrl+Lăn: Zoom'
            )}
          </div>

          {/* Cụm nút Zoom nổi góc dưới phải */}
          {(onZoomDelta || onResetView) && (
            <div className="absolute right-1.5 bottom-1.5 z-10 flex items-center gap-0.5 rounded border border-[var(--viewer-border)] bg-[var(--viewer-bg)]/90 p-0.5 text-[11px] text-[var(--viewer-text)]">
              {onZoomDelta && (
                <button
                  type="button"
                  aria-label={`Thu nhỏ ${title}`}
                  title="Thu nhỏ (Ctrl + Lăn xuống)"
                  onClick={() => onZoomDelta(-0.15)}
                  className="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--viewer-text-secondary)] transition-colors duration-150 hover:bg-[var(--viewer-raised)] hover:text-[var(--viewer-text)] cursor-pointer"
                >
                  -
                </button>
              )}
              <span className="px-1 font-mono tabular-nums text-[var(--viewer-text)]">
                {zoomLevel.toFixed(1)}x
              </span>
              {onZoomDelta && (
                <button
                  type="button"
                  aria-label={`Phóng to ${title}`}
                  title="Phóng to (Ctrl + Lăn lên)"
                  onClick={() => onZoomDelta(0.15)}
                  className="inline-flex h-5 w-5 items-center justify-center rounded text-[var(--viewer-text-secondary)] transition-colors duration-150 hover:bg-[var(--viewer-raised)] hover:text-[var(--viewer-text)] cursor-pointer"
                >
                  +
                </button>
              )}
              {onResetView && (
                <button
                  type="button"
                  aria-label={`Đặt lại góc nhìn ${title}`}
                  title="Đặt lại tỷ lệ 1:1"
                  onClick={onResetView}
                  className="inline-flex h-5 items-center justify-center rounded px-1 font-mono text-[11px] text-[var(--viewer-text-secondary)] transition-colors duration-150 hover:bg-[var(--viewer-raised)] hover:text-[var(--viewer-text)] cursor-pointer"
                >
                  1:1
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
