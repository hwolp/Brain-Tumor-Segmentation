import * as React from 'react';
import {
  AlertTriangle,
  FileUp,
  Trash2,
  Upload,
  XCircle,
} from 'lucide-react';
import type { VolumeDto, VolumeModality } from '@/shared/api/types';
import { cn } from '@/shared/lib/cn';
import { Alert, Button, StatusBadge } from '@/shared/ui';
import { getVolumeValidationMeta } from './statusMappings';

export type SlotUploadState =
  | { status: 'idle' }
  | { status: 'seg_warning'; file: File }
  | { status: 'queued'; file: File }
  | {
      status: 'uploading';
      file: File;
      progressPercent: number;
      loadedBytes: number;
      totalBytes: number;
      phase: 'uploading' | 'validating';
    }
  | {
      status: 'error';
      message: string;
      requestId: string | null;
      fileName?: string;
    };

export interface VolumeUploadSlotProps {
  modality: VolumeModality;
  title: string;
  volume?: VolumeDto;
  uploadState: SlotUploadState;
  isInputsLocked: boolean;
  lockReason: string | null;
  onSelectFile: (modality: VolumeModality, file: File) => void;
  onConfirmSegUpload: (modality: VolumeModality) => void;
  onDismissSlotState: (modality: VolumeModality) => void;
  onCancelUpload: (modality: VolumeModality) => void;
  onRequestDeleteVolume: (volume: VolumeDto) => void;
}

export function VolumeUploadSlot({
  modality,
  title,
  volume,
  uploadState,
  isInputsLocked,
  lockReason,
  onSelectFile,
  onConfirmSegUpload,
  onDismissSlotState,
  onCancelUpload,
  onRequestDeleteVolume,
}: VolumeUploadSlotProps) {
  const inputId = React.useId();
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [isDragOver, setIsDragOver] = React.useState(false);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) {
      onSelectFile(modality, file);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);
    if (
      isInputsLocked ||
      Boolean(volume) ||
      uploadState.status === 'uploading' ||
      uploadState.status === 'queued'
    ) {
      return;
    }
    const file = event.dataTransfer.files?.[0];
    if (file) {
      onSelectFile(modality, file);
    }
  };

  const validationErrors =
    volume?.validation_errors && volume.validation_errors.length > 0
      ? volume.validation_errors
      : volume?.validation_error
        ? [volume.validation_error]
        : [];

  return (
    <div
      data-testid={`volume-slot-${modality}`}
      className="flex flex-col gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4 sm:p-5"
    >
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-base font-semibold text-[var(--text-primary)]">
          {title}
        </h2>
        {volume ? (
          <StatusBadge
            label={getVolumeValidationMeta(volume.validation_status).label}
            tone={getVolumeValidationMeta(volume.validation_status).tone}
          />
        ) : uploadState.status === 'uploading' ? (
          <StatusBadge
            label={
              uploadState.phase === 'validating'
                ? 'Đang kiểm tra ảnh...'
                : 'Đang tải lên'
            }
            tone="info"
          />
        ) : uploadState.status === 'queued' ? (
          <StatusBadge label="Đang chờ hàng đợi" tone="neutral" />
        ) : (
          <StatusBadge label="Chưa tải lên" tone="warning" />
        )}
      </div>

      {volume ? (
        <div className="flex flex-col gap-3">
          <dl className="grid grid-cols-1 gap-2 rounded-md bg-[var(--bg-muted)] p-3 text-xs sm:grid-cols-2">
            <div className="min-w-0 sm:col-span-2">
              <dt className="text-[var(--text-secondary)]">Tệp</dt>
              <dd
                className="truncate font-mono font-medium"
                title={volume.filename ?? volume.file_id}
              >
                {volume.filename ?? volume.file_id}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[var(--text-secondary)]">Hướng / Lưới</dt>
              <dd className="font-mono font-medium">
                {volume.shape
                  ? `${volume.shape.join('×')} (${volume.orientation ?? 'N/A'})`
                  : 'Đang đọc'}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[var(--text-secondary)]">Spacing (mm)</dt>
              <dd className="font-mono font-medium">
                {volume.spacing_mm
                  ? volume.spacing_mm
                      .map((n) => Number(n.toFixed(4)))
                      .join(' × ')
                  : '—'}
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[var(--text-secondary)]">Dung lượng</dt>
              <dd className="font-mono font-medium">
                {(volume.size_bytes / (1024 * 1024)).toFixed(2)} MiB
              </dd>
            </div>
          </dl>

          {validationErrors.length > 0 && (
            <Alert
              variant="error"
              title="Lỗi kiểm tra khối ảnh"
              description={validationErrors.join(' ')}
            />
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isInputsLocked}
              title={lockReason ?? undefined}
              onClick={() => onRequestDeleteVolume(volume)}
              aria-label={`Xóa xung ${modality.toUpperCase()}`}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              Xóa xung
            </Button>
            {isInputsLocked && lockReason && (
              <span className="text-xs text-[var(--text-secondary)]">
                {lockReason}
              </span>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {uploadState.status === 'seg_warning' && (
            <Alert
              variant="warning"
              title="Cảnh báo tệp có chứa '_seg'"
              description={`Tệp "${uploadState.file.name}" có chứa "_seg" trong tên (thường là tệp mask phân đoạn, không phải ảnh MRI ${modality.toUpperCase()}). Không tự động gán tệp này.`}
              action={
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    onClick={() => onConfirmSegUpload(modality)}
                  >
                    Vẫn tải lên để máy chủ kiểm tra
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => onDismissSlotState(modality)}
                  >
                    Chọn tệp khác
                  </Button>
                </div>
              }
            />
          )}

          {uploadState.status === 'error' && (
            <Alert
              variant="error"
              title={`Không thể tải lên xung ${modality.toUpperCase()}`}
              description={uploadState.message}
            >
              {uploadState.requestId && (
                <span className="sr-only">
                  Mã tham chiếu: {uploadState.requestId}
                </span>
              )}
            </Alert>
          )}

          {uploadState.status === 'queued' && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-muted)] p-3 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium text-[var(--text-primary)]">
                  {uploadState.file.name}
                </p>
                <p className="text-xs text-[var(--text-secondary)]">
                  Đang chờ xung còn lại hoàn tất tải lên...
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onCancelUpload(modality)}
              >
                <XCircle className="size-4" aria-hidden="true" />
                Hủy chờ
              </Button>
            </div>
          )}

          {uploadState.status === 'uploading' && (
            <div className="flex flex-col gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-muted)] p-3">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate font-medium text-[var(--text-primary)]">
                  {uploadState.file.name}
                </span>
                <span className="shrink-0 font-mono font-semibold text-[var(--action-primary)]">
                  {uploadState.phase === 'validating'
                    ? 'Đang kiểm tra ảnh...'
                    : `${uploadState.progressPercent}%`}
                </span>
              </div>
              <div
                role="progressbar"
                aria-label={`Tiến độ tải lên ${title}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={
                  uploadState.phase === 'validating'
                    ? 100
                    : uploadState.progressPercent
                }
                className="h-2.5 w-full overflow-hidden rounded-full bg-[var(--bg-surface)]"
              >
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    uploadState.phase === 'validating'
                      ? 'w-full animate-pulse bg-[var(--status-info)]'
                      : 'bg-[var(--action-primary)]',
                  )}
                  style={{
                    width:
                      uploadState.phase === 'validating'
                        ? '100%'
                        : `${uploadState.progressPercent}%`,
                  }}
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-[var(--text-secondary)]">
                  {uploadState.phase === 'validating'
                    ? 'Đang kiểm tra ảnh NIfTI trên máy chủ...'
                    : `${(uploadState.loadedBytes / (1024 * 1024)).toFixed(2)} / ${(uploadState.totalBytes / (1024 * 1024)).toFixed(2)} MiB`}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => onCancelUpload(modality)}
                >
                  <XCircle className="size-4" aria-hidden="true" />
                  Hủy tải lên
                </Button>
              </div>
            </div>
          )}

          {uploadState.status !== 'uploading' &&
            uploadState.status !== 'queued' && (
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  if (!isInputsLocked) {
                    setIsDragOver(true);
                  }
                }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={handleDrop}
                className={cn(
                  'flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-4 text-center transition-colors',
                  isDragOver
                    ? 'border-[var(--action-primary)] bg-[var(--bg-muted)]'
                    : 'border-[var(--border-default)] bg-[var(--bg-surface)]',
                  isInputsLocked && 'opacity-60',
                )}
              >
                <FileUp
                  className="size-6 text-[var(--text-secondary)]"
                  aria-hidden="true"
                />
                <p className="text-xs text-[var(--text-secondary)]">
                  Kéo thả tệp <span className="font-mono">.nii</span> hoặc{' '}
                  <span className="font-mono">.nii.gz</span> vào đây, hoặc chọn tệp từ máy.
                </p>
                <input
                  ref={fileInputRef}
                  id={inputId}
                  type="file"
                  accept=".nii,.nii.gz"
                  className="sr-only"
                  disabled={isInputsLocked}
                  aria-label={`Chọn tệp ${title}`}
                  onChange={handleFileChange}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isInputsLocked}
                  title={lockReason ?? undefined}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload className="size-4" aria-hidden="true" />
                  Chọn tệp {modality.toUpperCase()}
                </Button>
                {isInputsLocked && lockReason && (
                  <p className="flex items-center gap-1 text-xs text-[var(--status-warning)]">
                    <AlertTriangle className="size-3.5" aria-hidden="true" />
                    {lockReason}
                  </p>
                )}
              </div>
            )}
        </div>
      )}
    </div>
  );
}
