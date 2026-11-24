import { AlertTriangle, RotateCcw } from 'lucide-react';
import { normalizeApiError } from '@/shared/api/errors';
import { cn } from '@/shared/lib/cn';
import { Button } from './Button';

export interface ErrorStateProps {
  title?: string;
  message?: string;
  requestId?: string | null;
  error?: unknown;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}

/**
 * Hiển thị lỗi thân thiện bằng tiếng Việt kèm `request_id` để hỗ trợ kỹ thuật.
 * Không bao giờ hiển thị stack trace, đường dẫn storage hoặc dữ liệu nhạy cảm.
 */
export function ErrorState({
  title = 'Không thể tải dữ liệu',
  message,
  requestId,
  error,
  onRetry,
  retryLabel = 'Thử lại',
  className,
}: ErrorStateProps) {
  const normalized = error !== undefined ? normalizeApiError(error) : null;
  const resolvedMessage =
    message ?? normalized?.message ?? 'Đã xảy ra sự cố khi xử lý yêu cầu.';
  const resolvedRequestId = requestId ?? normalized?.requestId ?? null;

  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-start gap-3 rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-bg)] p-5',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <AlertTriangle
          className="size-5 shrink-0 text-[var(--status-error)]"
          aria-hidden="true"
        />
        <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
          <h3 className="text-base font-semibold leading-5 text-[var(--text-primary)]">
            {title}
          </h3>
          <p className="text-sm text-[var(--text-primary)]">{resolvedMessage}</p>
          {resolvedRequestId && (
            <p className="mt-0.5 text-[11px] text-[var(--text-secondary)]">
              Mã yêu cầu:{' '}
              <code className="font-mono text-[11px] text-[var(--text-secondary)] select-all">
                {resolvedRequestId}
              </code>
            </p>
          )}
          {onRetry && (
            <Button
              variant="outline"
              size="sm"
              onClick={onRetry}
              className="mt-2"
            >
              <RotateCcw className="size-4" aria-hidden="true" />
              {retryLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
