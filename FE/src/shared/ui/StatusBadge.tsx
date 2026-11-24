import * as React from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Info,
  XCircle,
} from 'lucide-react';
import { cn } from '@/shared/lib/cn';

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

const TONE_STYLES: Readonly<Record<StatusTone, string>> = {
  neutral:
    'border-[var(--border-default)] bg-[var(--bg-muted)] text-[var(--text-primary)]',
  info:
    'border-[var(--status-info-border)] bg-[var(--status-info-bg)] text-[var(--status-info)]',
  success:
    'border-[var(--status-success-border)] bg-[var(--status-success-bg)] text-[var(--status-success)]',
  warning:
    'border-[var(--status-warning-border)] bg-[var(--status-warning-bg)] text-[var(--status-warning)]',
  error:
    'border-[var(--status-error-border)] bg-[var(--status-error-bg)] text-[var(--status-error)]',
};

const TONE_ICONS: Readonly<Record<StatusTone, React.ComponentType<{ className?: string }>>> = {
  neutral: Clock,
  info: Info,
  success: CheckCircle2,
  warning: AlertCircle,
  error: XCircle,
};

export interface StatusBadgeProps {
  label: string;
  tone?: StatusTone;
  showIcon?: boolean;
  icon?: React.ReactNode;
  title?: string;
  className?: string;
}

/**
 * Nhãn trạng thái luôn hiển thị văn bản rõ ràng (không chỉ dùng màu sắc).
 */
export function StatusBadge({
  label,
  tone = 'neutral',
  showIcon = true,
  icon,
  title,
  className,
}: StatusBadgeProps) {
  const Icon = TONE_ICONS[tone];
  return (
    <span
      title={title}
      className={cn(
        'inline-flex min-h-[24px] items-center gap-1.5 whitespace-nowrap rounded-[var(--radius-pill)] border px-2.5 py-1 text-xs font-medium leading-none tracking-[0.005em]',
        TONE_STYLES[tone],
        className,
      )}
    >
      {showIcon && (icon ?? <Icon className="size-3.5 shrink-0" aria-hidden="true" />)}
      <span>{label}</span>
    </span>
  );
}
