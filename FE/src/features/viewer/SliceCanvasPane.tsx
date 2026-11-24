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
  const lastPanClientRef = React.useRef<{ x: number; y: number } | null>(null);
  const handledWheelEventsRef = React.useRef<WeakSet<Event>>(new WeakSet());
  const onStrokeEndRef = React.useRef(onStrokeEnd);
  onStrokeEndRef.current = onStrokeEnd;

  const [hoverPoint, setHoverPoint] = React.useState<{
    displayX: number;
    displayY: number;
  } | null>(null);

  const axes = React.useMemo(
    () => resolvePlaneAxes(plane, affine, shape),
    [plane, affine, shape],
  );

  const cancelActivePointerInteraction = React.useCallback(() => {
    const ptrId = activePointerIdRef.current;
    activePointerIdRef.current = null;
    if (isPanningRef.current) {
      isPanningRef.current = false;
      lastPanClientRef.current = null;
    }
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
  }, []);

  React.useEffect(() => {
    window.addEventListener('blur', cancelActivePointerInteraction);
    return () => {
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
    if (isDrawingRef.current || isPanningRef.current) {
      return;
    }

    const button = typeof e.button === 'number' ? e.button : 0;

    // Middle-click hoặc giữ Shift khi kéo để pan
    if (button === 1 || (e.shiftKey && button === 0)) {
      activePointerIdRef.current = pointerId;
      isPanningRef.current = true;
      lastPanClientRef.current = { x: e.clientX, y: e.clientY };
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
      onSelectCrosshair?.(displayX, displayY);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
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

    if (isPanningRef.current && lastPanClientRef.current) {
      const dx = e.clientX - lastPanClientRef.current.x;
      const dy = e.clientY - lastPanClientRef.current.y;
      lastPanClientRef.current = { x: e.clientX, y: e.clientY };
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

  const finishPointerAction = (e?: React.PointerEvent<HTMLCanvasElement>) => {
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

    if (isPanningRef.current) {
      isPanningRef.current = false;
      lastPanClientRef.current = null;
    }
    if (isDrawingRef.current) {
      isDrawingRef.current = false;
      onStrokeEndRef.current?.();
    }
    const targetCanvas = e?.currentTarget ?? canvasRef.current;
    if (
      targetCanvas &&
      endedPointerId !== null &&
      targetCanvas.hasPointerCapture?.(endedPointerId)
    ) {
      try {
        targetCanvas.releasePointerCapture(endedPointerId);
      } catch {
        // Ignore if pointer capture already released
      }
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    processWheelAction(e);
  };

  const isPaintToolActive =
    editable && (activeTool === 'brush' || activeTool === 'erase');

  const cursorClass = isPaintToolActive ? 'cursor-crosshair' : 'cursor-default';

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
        'relative flex min-w-0 flex-col overflow-hidden rounded-lg border bg-black transition-colors',
        isPaintToolActive
          ? 'border-sky-500/70 shadow-[0_0_0_1px_rgba(56,189,248,0.2)]'
          : editable
            ? 'border-slate-700'
            : 'border-[var(--viewer-border)]',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-[var(--viewer-border)] bg-[var(--viewer-surface)] px-2.5 py-1.5 text-xs sm:px-3">
        <span className="truncate font-semibold text-[var(--viewer-text)]">
          {title}
        </span>

        <div className="flex shrink-0 items-center gap-1.5">
          {sliceIndex === null ? (
            <span className="font-mono text-[11px] text-[var(--viewer-text-muted)]">
              Không có lát
            </span>
          ) : (
            <>
              <span className="font-mono text-[11px] text-slate-300 tabular-nums">
                Lát {sliceIndex + 1}/{axes.totalSlices}
              </span>
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold',
                  editable
                    ? 'border-sky-500/50 bg-sky-950/80 text-sky-300'
                    : 'border-slate-700 bg-slate-800/80 text-slate-400',
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
              className="inline-flex size-6 items-center justify-center rounded border border-slate-700 bg-slate-900/90 text-slate-300 hover:border-sky-400 hover:bg-slate-800 hover:text-white cursor-pointer"
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
          className="flex min-h-[260px] flex-1 items-center justify-center p-2 text-center text-sm font-medium text-[var(--viewer-text-muted)] sm:min-h-[340px] sm:p-4"
        >
          Không có lát
        </div>
      ) : (
        <div
          ref={viewportRef}
          className={cn(
            'relative flex flex-1 items-center justify-center overflow-hidden bg-black p-2 sm:p-3',
            isMaximized
              ? 'min-h-[360px] sm:min-h-[460px]'
              : isFullscreen
                ? 'min-h-[280px] sm:min-h-[370px]'
                : 'min-h-[250px] sm:min-h-[340px]',
          )}
        >
          {/* Nhãn định hướng giải phẫu theo affine */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1.5 left-1/2 z-10 -translate-x-1/2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] font-bold text-sky-300"
          >
            {axes.topBottomAnnotation.top}
          </span>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-1.5 left-1/2 z-10 -translate-x-1/2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] font-bold text-sky-300"
          >
            {axes.topBottomAnnotation.bottom}
          </span>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-1.5 z-10 -translate-y-1/2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] font-bold text-sky-300"
          >
            {axes.leftRightAnnotation.left}
          </span>
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 right-1.5 z-10 -translate-y-1/2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] font-bold text-sky-300"
          >
            {axes.leftRightAnnotation.right}
          </span>

          <div className="relative inline-flex max-h-full max-w-full items-center justify-center">
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
                canvasSizeClass,
                'touch-none select-none object-contain',
                cursorClass,
              )}
            />

            {isPaintToolActive && hoverPoint !== null && (
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
            className="pointer-events-none absolute bottom-1.5 left-1.5 z-10 hidden max-w-[68%] truncate rounded border border-slate-800/90 bg-slate-950/80 px-2 py-0.5 font-mono text-[10px] text-slate-300 backdrop-blur-xs sm:block"
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
              'Lăn chuột: ±Lát · Ctrl+Lăn: Zoom'
            )}
          </div>

          {/* Cụm nút Zoom nổi góc dưới phải */}
          {(onZoomDelta || onResetView) && (
            <div className="absolute right-1.5 bottom-1.5 z-10 flex items-center gap-0.5 rounded border border-slate-700/80 bg-slate-950/85 p-0.5 text-[10px] text-slate-200 backdrop-blur-xs">
              {onZoomDelta && (
                <button
                  type="button"
                  aria-label={`Thu nhỏ ${title}`}
                  title="Thu nhỏ (Ctrl + Lăn xuống)"
                  onClick={() => onZoomDelta(-0.15)}
                  className="inline-flex h-5 w-5 items-center justify-center rounded text-slate-300 hover:bg-slate-800 hover:text-white cursor-pointer"
                >
                  -
                </button>
              )}
              <span className="px-1 font-mono tabular-nums text-sky-300">
                {zoomLevel.toFixed(1)}x
              </span>
              {onZoomDelta && (
                <button
                  type="button"
                  aria-label={`Phóng to ${title}`}
                  title="Phóng to (Ctrl + Lăn lên)"
                  onClick={() => onZoomDelta(0.15)}
                  className="inline-flex h-5 w-5 items-center justify-center rounded text-slate-300 hover:bg-slate-800 hover:text-white cursor-pointer"
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
                  className="inline-flex h-5 items-center justify-center rounded px-1 font-mono text-[10px] text-slate-300 hover:bg-slate-800 hover:text-white cursor-pointer"
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
