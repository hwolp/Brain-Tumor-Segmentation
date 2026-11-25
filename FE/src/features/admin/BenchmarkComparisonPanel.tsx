import * as React from 'react';
import { Eye, EyeOff, Layers, Loader2, SplitSquareHorizontal } from 'lucide-react';
import { downloadAdminBenchmarkArtifactBuffer } from '@/shared/api/endpoints';
import type {
  AdminBenchmarkDetailDto,
  BenchmarkRegionMetricsDto,
} from '@/shared/api/types';
import { formatDateTimeVN } from '@/shared/lib/datetime';
import {
  BRATS_LABELS,
  BRATS_TUMOR_LABEL_IDS,
  type BraTSEditableLabelId,
} from '@/shared/lib/labels';
import { Alert, Button, StatusBadge } from '@/shared/ui';
import {
  clampSliceIndex,
  parseNiftiVolume,
  planeDisplayPointToVoxelCoord,
  resolvePlaneAxes,
  voxelCoordToFlatIndex,
  type SlicePlaneType,
} from '@/viewer-adapter';
import { SliceCanvasPane } from '@/features/viewer/SliceCanvasPane';
import { formatJobErrorReason, formatJobStage, getJobStateMeta } from '@/features/cases/statusMappings';
import {
  computeAutoWindowLevel,
  computeErrorMapVolume,
  computeSliceErrorCounts,
  ERROR_CODE_FN,
  ERROR_CODE_FP,
  ERROR_CODE_TP,
  ERROR_MAP_COLORS,
  type ErrorMapScope,
} from './benchmarkErrorMap';

function formatMetric(value: number | null | undefined, digits = 4): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function toUint8Mask(data: Float32Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 1) {
    out[i] = Math.max(0, Math.min(255, Math.round(data[i] ?? 0)));
  }
  return out;
}

interface BenchmarkErrorMapCanvasProps {
  plane: SlicePlaneType;
  sliceIndex: number;
  shape: readonly [number, number, number];
  affine: number[][] | null | undefined;
  mriBuffer: Float32Array;
  errorMapBuffer: Uint8Array;
  opacityPercent: number;
  visibleClasses: { tp: boolean; fp: boolean; fn: boolean };
  onWheelSlice: (delta: number) => void;
}

function BenchmarkErrorMapCanvas({
  plane,
  sliceIndex,
  shape,
  affine,
  mriBuffer,
  errorMapBuffer,
  opacityPercent,
  visibleClasses,
  onWheelSlice,
}: BenchmarkErrorMapCanvasProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const axes = React.useMemo(
    () => resolvePlaneAxes(plane, affine, shape),
    [plane, affine, shape],
  );
  const windowLevel = React.useMemo(
    () => computeAutoWindowLevel(mriBuffer),
    [mriBuffer],
  );

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { colDim, rowDim } = axes;
    if (canvas.width !== colDim || canvas.height !== rowDim) {
      canvas.width = colDim;
      canvas.height = rowDim;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const imageData = ctx.createImageData(colDim, rowDim);
    const pixels = imageData.data;
    const clampedSlice = clampSliceIndex(sliceIndex, axes.totalSlices);
    const wlMin = windowLevel.center - windowLevel.width / 2;
    const wlInvWidth = windowLevel.width > 0 ? 255 / windowLevel.width : 1;
    const alpha = Math.min(1, Math.max(0, opacityPercent / 100));

    for (let dy = 0; dy < rowDim; dy += 1) {
      const rowBase = dy * colDim;
      for (let dx = 0; dx < colDim; dx += 1) {
        const coord = planeDisplayPointToVoxelCoord(
          plane,
          dx,
          dy,
          clampedSlice,
          affine,
          shape,
        );
        const flat = voxelCoordToFlatIndex(coord[0], coord[1], coord[2], shape);
        const rawVal = mriBuffer[flat] ?? 0;
        const gray = Math.min(
          255,
          Math.max(0, Math.round((rawVal - wlMin) * wlInvWidth)),
        );
        let r = gray;
        let g = gray;
        let b = gray;

        const errCode = errorMapBuffer[flat] ?? 0;
        const shouldDraw =
          (errCode === ERROR_CODE_TP && visibleClasses.tp) ||
          (errCode === ERROR_CODE_FP && visibleClasses.fp) ||
          (errCode === ERROR_CODE_FN && visibleClasses.fn);

        if (shouldDraw && alpha > 0 && (errCode === 1 || errCode === 2 || errCode === 3)) {
          const [cr, cg, cb] = ERROR_MAP_COLORS[errCode];
          r = Math.round(r * (1 - alpha) + cr * alpha);
          g = Math.round(g * (1 - alpha) + cg * alpha);
          b = Math.round(b * (1 - alpha) + cb * alpha);
        }

        const off = (rowBase + dx) * 4;
        pixels[off] = r;
        pixels[off + 1] = g;
        pixels[off + 2] = b;
        pixels[off + 3] = 255;
      }
    }
    ctx.putImageData(imageData, 0, 0);
  }, [
    axes,
    plane,
    sliceIndex,
    shape,
    affine,
    mriBuffer,
    errorMapBuffer,
    opacityPercent,
    visibleClasses,
    windowLevel,
  ]);

  return (
    <div
      className="flex flex-col overflow-hidden rounded-[var(--radius-inner)] border border-[var(--viewer-border)] bg-[var(--viewer-bg)]"
      onWheel={(e) => {
        onWheelSlice(e.deltaY > 0 ? 1 : -1);
      }}
    >
      <div className="flex items-center justify-between border-b border-[var(--viewer-border)] px-3 py-2 text-xs text-[var(--viewer-text)]">
        <span className="font-medium">Bản đồ sai khác (TP / FP / FN)</span>
        <span className="tabular-nums opacity-80">
          Lát {clampedDisplay(sliceIndex, axes.totalSlices)}/{axes.totalSlices}
        </span>
      </div>
      <div className="flex min-h-[340px] items-center justify-center p-3">
        <canvas
          ref={canvasRef}
          aria-label="Bản đồ sai khác AI so với nhãn bác sĩ"
          className="max-h-[420px] max-w-full object-contain"
          style={{ imageRendering: 'pixelated' }}
        />
      </div>
    </div>
  );
}

function clampedDisplay(sliceIndex: number, total: number): number {
  return clampSliceIndex(sliceIndex, total) + 1;
}

interface VolumeBuffersState {
  benchmarkId: string;
  shape: [number, number, number];
  affine: number[][];
  flair: Float32Array | null;
  t1ce: Float32Array | null;
  gtMask: Uint8Array;
  predMask: Uint8Array;
}

export interface BenchmarkComparisonPanelProps {
  detail: AdminBenchmarkDetailDto;
  fixtureMode: boolean;
}

export function BenchmarkComparisonPanel({
  detail,
  fixtureMode,
}: BenchmarkComparisonPanelProps) {
  const [viewMode, setViewMode] = React.useState<'side-by-side' | 'error-map'>(
    'side-by-side',
  );
  const [baseModality, setBaseModality] = React.useState<'flair' | 't1ce'>('flair');
  const [plane, setPlane] = React.useState<SlicePlaneType>('axial');
  const [sliceIndex, setSliceIndex] = React.useState<number>(
    detail.metrics?.best_slice_z ?? Math.floor((detail.shape?.[2] ?? 155) / 2),
  );
  const [opacityPercent, setOpacityPercent] = React.useState<number>(50);
  const [zoomLevel, setZoomLevel] = React.useState<number>(1);
  const [panOffset, setPanOffset] = React.useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });
  const [visibleLabels, setVisibleLabels] = React.useState<
    Record<BraTSEditableLabelId, boolean>
  >({ 1: true, 2: true, 4: true });
  const [errorScope, setErrorScope] = React.useState<ErrorMapScope>('WT');
  const [visibleErrorClasses, setVisibleErrorClasses] = React.useState({
    tp: true,
    fp: true,
    fn: true,
  });

  const [showVisual, setShowVisual] = React.useState<boolean>(false);
  const [buffers, setBuffers] = React.useState<VolumeBuffersState | null>(null);
  const [visualLoading, setVisualLoading] = React.useState<boolean>(false);
  const [visualError, setVisualError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setShowVisual(false);
    setBuffers(null);
    setVisualError(null);
    setPlane('axial');
    setSliceIndex(
      detail.metrics?.best_slice_z ?? Math.floor((detail.shape?.[2] ?? 155) / 2),
    );
    setZoomLevel(1);
    setPanOffset({ x: 0, y: 0 });
  }, [detail.id, detail.metrics?.best_slice_z, detail.shape]);

  const loadVisualBuffers = React.useCallback(
    async (modality: 'flair' | 't1ce') => {
      if (detail.state !== 'succeeded' || !detail.has_pred_mask) return;
      if (fixtureMode) {
        setVisualError(
          'Chế độ dữ liệu mẫu (fixture) không chứa tệp NIfTI 3D nhị phân để hiển thị lát cắt.',
        );
        return;
      }
      setVisualLoading(true);
      setVisualError(null);
      try {
        if (buffers && buffers.benchmarkId === detail.id) {
          if (modality === 't1ce' && !buffers.t1ce) {
            const t1ceRaw = await downloadAdminBenchmarkArtifactBuffer(
              detail.id,
              't1ce',
              { fixtureMode },
            );
            const parsedT1ce = await parseNiftiVolume(t1ceRaw);
            setBuffers((prev) =>
              prev && prev.benchmarkId === detail.id
                ? { ...prev, t1ce: parsedT1ce.data }
                : prev,
            );
          }
          if (modality === 'flair' && !buffers.flair) {
            const flairRaw = await downloadAdminBenchmarkArtifactBuffer(
              detail.id,
              'flair',
              { fixtureMode },
            );
            const parsedFlair = await parseNiftiVolume(flairRaw);
            setBuffers((prev) =>
              prev && prev.benchmarkId === detail.id
                ? { ...prev, flair: parsedFlair.data }
                : prev,
            );
          }
          setShowVisual(true);
          return;
        }

        const [mriRaw, gtRaw, predRaw] = await Promise.all([
          downloadAdminBenchmarkArtifactBuffer(detail.id, modality, { fixtureMode }),
          downloadAdminBenchmarkArtifactBuffer(detail.id, 'gt_mask', { fixtureMode }),
          downloadAdminBenchmarkArtifactBuffer(detail.id, 'pred_mask', { fixtureMode }),
        ]);

        const [mriParsed, gtParsed, predParsed] = await Promise.all([
          parseNiftiVolume(mriRaw),
          parseNiftiVolume(gtRaw),
          parseNiftiVolume(predRaw),
        ]);

        setBuffers({
          benchmarkId: detail.id,
          shape: mriParsed.shape,
          affine: mriParsed.affine,
          flair: modality === 'flair' ? mriParsed.data : null,
          t1ce: modality === 't1ce' ? mriParsed.data : null,
          gtMask: toUint8Mask(gtParsed.data),
          predMask: toUint8Mask(predParsed.data),
        });
        setShowVisual(true);
      } catch (err) {
        setVisualError(
          err instanceof Error
            ? err.message
            : 'Không thể tải dữ liệu ảnh NIfTI để hiển thị đối chiếu.',
        );
      } finally {
        setVisualLoading(false);
      }
    },
    [buffers, detail.has_pred_mask, detail.id, detail.state, fixtureMode],
  );

  const activeMriBuffer =
    buffers && buffers.benchmarkId === detail.id
      ? baseModality === 'flair'
        ? buffers.flair
        : buffers.t1ce
      : null;

  const autoWindowLevel = React.useMemo(
    () =>
      activeMriBuffer
        ? computeAutoWindowLevel(activeMriBuffer)
        : { center: 0.5, width: 1 },
    [activeMriBuffer],
  );

  const planeAxes = React.useMemo(() => {
    const shp = buffers?.shape ?? detail.shape ?? [240, 240, 155];
    const aff = buffers?.affine ?? detail.affine;
    return resolvePlaneAxes(plane, aff, shp);
  }, [buffers?.affine, buffers?.shape, detail.affine, detail.shape, plane]);

  React.useEffect(() => {
    setSliceIndex((prev) => clampSliceIndex(prev, planeAxes.totalSlices));
  }, [planeAxes.totalSlices]);

  const errorMapBuffer = React.useMemo(() => {
    if (!buffers || buffers.benchmarkId !== detail.id) return null;
    return computeErrorMapVolume(buffers.predMask, buffers.gtMask, errorScope);
  }, [buffers, detail.id, errorScope]);

  const sliceErrorCounts = React.useMemo(() => {
    if (!errorMapBuffer || !buffers) return null;
    return computeSliceErrorCounts(
      errorMapBuffer,
      plane,
      sliceIndex,
      buffers.shape,
      buffers.affine,
    );
  }, [buffers, errorMapBuffer, plane, sliceIndex]);

  const stateMeta = getJobStateMeta(detail.state);
  const metrics = detail.metrics;
  const metricRows: Array<{
    key: string;
    label: string;
    data: BenchmarkRegionMetricsDto;
  }> = metrics
    ? [
        { key: 'WT', label: 'WT — Toàn bộ khối u (1 + 2 + 4)', data: metrics.regions.WT },
        { key: 'TC', label: 'TC — Lõi khối u (1 + 4)', data: metrics.regions.TC },
        { key: 'ET', label: 'ET — U bắt thuốc (4)', data: metrics.regions.ET },
        { key: '1', label: 'Nhãn 1 — Lõi hoại tử (NCR/NET)', data: metrics.labels['1'] },
        { key: '2', label: 'Nhãn 2 — Phù quanh u (ED)', data: metrics.labels['2'] },
        { key: '4', label: 'Nhãn 4 — U ngấm thuốc (ET)', data: metrics.labels['4'] },
      ]
    : [];

  return (
    <section
      aria-label="Chi tiết kết quả kiểm định AI"
      className="refract-panel flex flex-col gap-5 p-5 sm:p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-rule)] pb-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h2 className="font-display text-xl font-normal text-[var(--color-ink)]">
              {detail.title}
            </h2>
            <StatusBadge label={stateMeta.label} tone={stateMeta.tone} />
          </div>
          <p className="text-xs text-[var(--text-secondary)]">
            Worker chỉ định:{' '}
            <span className="font-mono font-medium text-[var(--color-ink)]">
              {detail.target_worker_id}
            </span>
            {detail.executed_worker_id && (
              <>
                {' '}
                · Thực chạy:{' '}
                <span className="font-mono">{detail.executed_worker_id}</span>
                {detail.worker_device_type ? ` (${detail.worker_device_type})` : ''}
              </>
            )}
            {detail.model_version_id && (
              <>
                {' '}
                · Model: <span className="font-mono">{detail.model_version_id}</span>
              </>
            )}
            {' · '}Tạo lúc: {formatDateTimeVN(detail.created_at)}
          </p>
          {detail.notes && (
            <p className="text-sm text-[var(--color-ink-2)]">{detail.notes}</p>
          )}
        </div>

        {detail.state === 'succeeded' && detail.has_pred_mask && (
          <Button
            variant={showVisual ? 'secondary' : 'primary'}
            isLoading={visualLoading}
            loadingText="Đang tải ảnh NIfTI..."
            onClick={() => {
              if (showVisual) {
                setShowVisual(false);
              } else {
                void loadVisualBuffers(baseModality);
              }
            }}
          >
            {showVisual ? (
              <EyeOff className="size-4" aria-hidden="true" />
            ) : (
              <Eye className="size-4" aria-hidden="true" />
            )}
            {showVisual ? 'Ẩn trình xem lát cắt' : 'Xem lát cắt đối chiếu trực quan'}
          </Button>
        )}
      </div>

      {(detail.state === 'queued' || detail.state === 'running') && (
        <Alert
          variant="info"
          title={
            detail.state === 'queued'
              ? `Đang chờ worker "${detail.target_worker_id}" nhận bài kiểm định`
              : `Worker đang xử lý: ${formatJobStage(detail.stage)}`
          }
          description={
            detail.completed_slices !== null && detail.total_slices
              ? `Tiến độ lát cắt: ${detail.completed_slices}/${detail.total_slices} lát. Trang sẽ tự cập nhật mỗi 3 giây.`
              : 'AI Worker chỉ được nhận 2 xung FLAIR + T1ce; nhãn bác sĩ (seg) được giữ riêng ở máy chủ để chấm điểm.'
          }
        />
      )}

      {detail.state === 'failed' && (
        <Alert
          variant="error"
          title="Lượt kiểm định AI thất bại"
          description={formatJobErrorReason(detail.error_code)}
        />
      )}

      {metrics && (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <div className="rounded-[var(--radius-inner)] border border-[var(--color-rule)] bg-[var(--color-paper-2)]/60 p-3.5">
              <p className="text-xs text-[var(--color-muted)]">Mean Dice (BraTS)</p>
              <p className="mt-1 font-mono text-xl font-semibold text-[var(--color-ink)] tabular-nums">
                {formatMetric(metrics.mean_dice_brats)}
              </p>
            </div>
            <div className="rounded-[var(--radius-inner)] border border-[var(--color-rule)] bg-[var(--color-paper-2)]/60 p-3.5">
              <p className="text-xs text-[var(--color-muted)]">WT Dice</p>
              <p className="mt-1 font-mono text-xl font-semibold text-[var(--color-ink)] tabular-nums">
                {formatMetric(metrics.regions.WT.dice)}
              </p>
            </div>
            <div className="rounded-[var(--radius-inner)] border border-[var(--color-rule)] bg-[var(--color-paper-2)]/60 p-3.5">
              <p className="text-xs text-[var(--color-muted)]">TC Dice</p>
              <p className="mt-1 font-mono text-xl font-semibold text-[var(--color-ink)] tabular-nums">
                {formatMetric(metrics.regions.TC.dice)}
              </p>
            </div>
            <div className="rounded-[var(--radius-inner)] border border-[var(--color-rule)] bg-[var(--color-paper-2)]/60 p-3.5">
              <p className="text-xs text-[var(--color-muted)]">ET Dice</p>
              <p className="mt-1 font-mono text-xl font-semibold text-[var(--color-ink)] tabular-nums">
                {formatMetric(metrics.regions.ET.dice)}
              </p>
            </div>
            <div className="rounded-[var(--radius-inner)] border border-[var(--color-rule)] bg-[var(--color-paper-2)]/60 p-3.5">
              <p className="text-xs text-[var(--color-muted)]">Crop Capture</p>
              <p className="mt-1 font-mono text-xl font-semibold text-[var(--color-ink)] tabular-nums">
                {metrics.crop_capture
                  ? `${(metrics.crop_capture.capture_recall * 100).toFixed(1)}%`
                  : '—'}
              </p>
            </div>
            <div className="rounded-[var(--radius-inner)] border border-[var(--color-rule)] bg-[var(--color-paper-2)]/60 p-3.5">
              <p className="text-xs text-[var(--color-muted)]">Thời gian suy luận</p>
              <p className="mt-1 font-mono text-xl font-semibold text-[var(--color-ink)] tabular-nums">
                {formatDurationMs(detail.inference_duration_ms)}
              </p>
            </div>
          </div>

          <div className="overflow-x-auto rounded-[var(--radius-inner)] border border-[var(--color-rule)]">
            <table className="w-full min-w-[760px] border-collapse text-left text-sm">
              <thead className="border-b border-[var(--color-rule)] bg-[var(--color-paper-2)]/75">
                <tr>
                  <th className="px-3.5 py-2.5 text-xs font-medium text-[var(--color-ink-2)]">
                    Vùng / Nhãn đối chiếu
                  </th>
                  <th className="px-3.5 py-2.5 text-right text-xs font-medium text-[var(--color-ink-2)]">
                    Dice
                  </th>
                  <th className="px-3.5 py-2.5 text-right text-xs font-medium text-[var(--color-ink-2)]">
                    IoU
                  </th>
                  <th className="px-3.5 py-2.5 text-right text-xs font-medium text-[var(--color-ink-2)]">
                    Precision
                  </th>
                  <th className="px-3.5 py-2.5 text-right text-xs font-medium text-[var(--color-ink-2)]">
                    Recall
                  </th>
                  <th className="px-3.5 py-2.5 text-right text-xs font-medium text-[var(--color-ink-2)]">
                    GT (mL)
                  </th>
                  <th className="px-3.5 py-2.5 text-right text-xs font-medium text-[var(--color-ink-2)]">
                    AI (mL)
                  </th>
                  <th className="px-3.5 py-2.5 text-right text-xs font-medium text-[var(--color-ink-2)]">
                    Chênh lệch (mL)
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-rule-2)]">
                {metricRows.map(({ key, label, data }) => (
                  <tr key={key}>
                    <td className="px-3.5 py-2.5 font-medium text-[var(--color-ink)]">
                      <span>{label}</span>
                      {data.both_empty && (
                        <span className="ml-2 rounded bg-[var(--color-paper-2)] px-1.5 py-0.5 text-[11px] text-[var(--color-muted)]">
                          Cùng rỗng
                        </span>
                      )}
                    </td>
                    <td className="px-3.5 py-2.5 text-right font-mono tabular-nums">
                      {data.dice.toFixed(4)}
                    </td>
                    <td className="px-3.5 py-2.5 text-right font-mono tabular-nums">
                      {data.iou.toFixed(4)}
                    </td>
                    <td className="px-3.5 py-2.5 text-right font-mono tabular-nums">
                      {data.precision.toFixed(4)}
                    </td>
                    <td className="px-3.5 py-2.5 text-right font-mono tabular-nums">
                      {data.recall.toFixed(4)}
                    </td>
                    <td className="px-3.5 py-2.5 text-right font-mono tabular-nums">
                      {data.gt_volume_ml.toFixed(2)}
                    </td>
                    <td className="px-3.5 py-2.5 text-right font-mono tabular-nums">
                      {data.pred_volume_ml.toFixed(2)}
                    </td>
                    <td className="px-3.5 py-2.5 text-right font-mono tabular-nums">
                      {data.volume_diff_ml >= 0 ? `+${data.volume_diff_ml.toFixed(2)}` : data.volume_diff_ml.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {visualError && (
        <Alert
          variant="warning"
          title="Không thể mở trình xem đối chiếu"
          description={visualError}
        />
      )}

      {showVisual && buffers && activeMriBuffer && (
        <div className="flex flex-col gap-4 rounded-[var(--radius-inner)] border border-[var(--color-rule)] bg-[var(--color-paper-2)]/40 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant={viewMode === 'side-by-side' ? 'primary' : 'outline'}
                onClick={() => setViewMode('side-by-side')}
              >
                <SplitSquareHorizontal className="size-4" aria-hidden="true" />
                So sánh song song (GT vs AI)
              </Button>
              <Button
                size="sm"
                variant={viewMode === 'error-map' ? 'primary' : 'outline'}
                onClick={() => setViewMode('error-map')}
              >
                <Layers className="size-4" aria-hidden="true" />
                Bản đồ sai khác (TP / FP / FN)
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-[var(--color-muted)]">Ảnh nền:</span>
              {(['flair', 't1ce'] as const).map((mod) => (
                <Button
                  key={mod}
                  size="sm"
                  variant={baseModality === mod ? 'primary' : 'outline'}
                  disabled={visualLoading}
                  onClick={() => {
                    setBaseModality(mod);
                    void loadVisualBuffers(mod);
                  }}
                >
                  {mod === 'flair' ? 'FLAIR' : 'T1ce'}
                </Button>
              ))}
              {visualLoading && <Loader2 className="size-4 animate-spin" />}

              <span className="ml-2 text-[var(--color-muted)]">Mặt phẳng:</span>
              {(['axial', 'coronal', 'sagittal'] as const).map((p) => (
                <Button
                  key={p}
                  size="sm"
                  variant={plane === p ? 'primary' : 'outline'}
                  onClick={() => setPlane(p)}
                >
                  {p === 'axial' ? 'Axial' : p === 'coronal' ? 'Coronal' : 'Sagittal'}
                </Button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="flex items-center gap-3 text-xs text-[var(--color-ink-2)]">
              <span className="shrink-0 whitespace-nowrap tabular-nums">
                Lát cắt ({clampedDisplay(sliceIndex, planeAxes.totalSlices)}/{planeAxes.totalSlices}):
              </span>
              <input
                type="range"
                min={0}
                max={Math.max(0, planeAxes.totalSlices - 1)}
                value={sliceIndex}
                onChange={(e) => setSliceIndex(Number(e.target.value))}
                className="w-full"
              />
            </label>

            <label className="flex items-center gap-3 text-xs text-[var(--color-ink-2)]">
              <span className="shrink-0 whitespace-nowrap tabular-nums">
                Độ mờ mask ({opacityPercent}%):
              </span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={opacityPercent}
                onChange={(e) => setOpacityPercent(Number(e.target.value))}
                className="w-full"
              />
            </label>
          </div>

          {viewMode === 'side-by-side' ? (
            <>
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <span className="text-[var(--color-muted)]">Hiển thị nhãn:</span>
                {BRATS_TUMOR_LABEL_IDS.map((lbl) => (
                  <label key={lbl} className="flex cursor-pointer items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={visibleLabels[lbl]}
                      onChange={(e) =>
                        setVisibleLabels((prev) => ({
                          ...prev,
                          [lbl]: e.target.checked,
                        }))
                      }
                    />
                    <span>
                      Nhãn {lbl} ({BRATS_LABELS[lbl].shortName})
                    </span>
                  </label>
                ))}
              </div>

              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <SliceCanvasPane
                  title="Nhãn bác sĩ (Ground Truth)"
                  plane={plane}
                  sliceIndex={sliceIndex}
                  shape={buffers.shape}
                  affine={buffers.affine}
                  mriBuffer={activeMriBuffer}
                  maskBuffer={buffers.gtMask}
                  showMask
                  editable={false}
                  activeTool="view"
                  maskOpacityPercent={opacityPercent}
                  visibleLabels={visibleLabels}
                  windowLevel={autoWindowLevel}
                  zoomLevel={zoomLevel}
                  panOffset={panOffset}
                  crosshairVoxel={null}
                  renderRevision={0}
                  onWheelSlice={(delta) =>
                    setSliceIndex((prev) =>
                      clampSliceIndex(prev + delta, planeAxes.totalSlices),
                    )
                  }
                  onZoomDelta={(delta) =>
                    setZoomLevel((prev) => Math.min(4, Math.max(0.5, prev + delta)))
                  }
                  onPanDelta={(dx, dy) =>
                    setPanOffset((prev) => ({ x: prev.x + dx, y: prev.y + dy }))
                  }
                  onResetView={() => {
                    setZoomLevel(1);
                    setPanOffset({ x: 0, y: 0 });
                  }}
                />
                <SliceCanvasPane
                  title="AI dự đoán (Predicted)"
                  plane={plane}
                  sliceIndex={sliceIndex}
                  shape={buffers.shape}
                  affine={buffers.affine}
                  mriBuffer={activeMriBuffer}
                  maskBuffer={buffers.predMask}
                  showMask
                  editable={false}
                  activeTool="view"
                  maskOpacityPercent={opacityPercent}
                  visibleLabels={visibleLabels}
                  windowLevel={autoWindowLevel}
                  zoomLevel={zoomLevel}
                  panOffset={panOffset}
                  crosshairVoxel={null}
                  renderRevision={0}
                  onWheelSlice={(delta) =>
                    setSliceIndex((prev) =>
                      clampSliceIndex(prev + delta, planeAxes.totalSlices),
                    )
                  }
                  onZoomDelta={(delta) =>
                    setZoomLevel((prev) => Math.min(4, Math.max(0.5, prev + delta)))
                  }
                  onPanDelta={(dx, dy) =>
                    setPanOffset((prev) => ({ x: prev.x + dx, y: prev.y + dy }))
                  }
                  onResetView={() => {
                    setZoomLevel(1);
                    setPanOffset({ x: 0, y: 0 });
                  }}
                />
              </div>
            </>
          ) : (
            errorMapBuffer && (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[var(--color-muted)]">Phạm vi chấm:</span>
                    {(['WT', 'TC', 'ET', '1', '2', '4'] as ErrorMapScope[]).map((sc) => (
                      <Button
                        key={sc}
                        size="sm"
                        variant={errorScope === sc ? 'primary' : 'outline'}
                        onClick={() => setErrorScope(sc)}
                      >
                        {sc === '1' || sc === '2' || sc === '4' ? `Nhãn ${sc}` : sc}
                      </Button>
                    ))}
                  </div>

                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex cursor-pointer items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={visibleErrorClasses.tp}
                        onChange={(e) =>
                          setVisibleErrorClasses((p) => ({ ...p, tp: e.target.checked }))
                        }
                      />
                      <span className="inline-block size-2.5 rounded-full bg-emerald-500" />
                      <span>
                        TP trùng khớp ({sliceErrorCounts?.tp ?? 0})
                      </span>
                    </label>
                    <label className="flex cursor-pointer items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={visibleErrorClasses.fp}
                        onChange={(e) =>
                          setVisibleErrorClasses((p) => ({ ...p, fp: e.target.checked }))
                        }
                      />
                      <span className="inline-block size-2.5 rounded-full bg-red-500" />
                      <span>
                        FP đoán thừa ({sliceErrorCounts?.fp ?? 0})
                      </span>
                    </label>
                    <label className="flex cursor-pointer items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={visibleErrorClasses.fn}
                        onChange={(e) =>
                          setVisibleErrorClasses((p) => ({ ...p, fn: e.target.checked }))
                        }
                      />
                      <span className="inline-block size-2.5 rounded-full bg-amber-500" />
                      <span>
                        FN bỏ sót ({sliceErrorCounts?.fn ?? 0})
                      </span>
                    </label>
                  </div>
                </div>

                <BenchmarkErrorMapCanvas
                  plane={plane}
                  sliceIndex={sliceIndex}
                  shape={buffers.shape}
                  affine={buffers.affine}
                  mriBuffer={activeMriBuffer}
                  errorMapBuffer={errorMapBuffer}
                  opacityPercent={opacityPercent}
                  visibleClasses={visibleErrorClasses}
                  onWheelSlice={(delta) =>
                    setSliceIndex((prev) =>
                      clampSliceIndex(prev + delta, planeAxes.totalSlices),
                    )
                  }
                />
              </div>
            )
          )}
        </div>
      )}
    </section>
  );
}
