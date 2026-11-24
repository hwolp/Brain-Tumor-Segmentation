import * as React from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
} from 'lucide-react';
import { cn } from '@/shared/lib/cn';

export type AlertVariant = 'info' | 'success' | 'warning' | 'error';

const ALERT_STYLES: Readonly<Record<AlertVariant, string>> = {
  info:
    'border-[var(--status-info-border)] bg-[var(--status-info-bg)] text-[var(--text-primary)]',
  success:
    'border-[var(--status-success-border)] bg-[var(--status-success-bg)] text-[var(--text-primary)]',
  warning:
    'border-[var(--status-warning-border)] bg-[var(--status-warning-bg)] text-[var(--text-primary)]',
  error:
    'border-[var(--status-error-border)] bg-[var(--status-error-bg)] text-[var(--text-primary)]',
};

const ALERT_ICON_COLOR: Readonly<Record<AlertVariant, string>> = {
  info: 'text-[var(--status-info)]',
  success: 'text-[var(--status-success)]',
  warning: 'text-[var(--status-warning)]',
  error: 'text-[var(--status-error)]',
};

const ALERT_ICONS: Readonly<Record<AlertVariant, React.ComponentType<{ className?: string }>>> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertCircle,
};

export interface AlertProps {
  variant?: AlertVariant;
  title?: string;
  description?: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export function Alert({
  variant = 'info',
  title,
  description,
  children,
  action,
  className,
}: AlertProps) {
  const Icon = ALERT_ICONS[variant];
  const role = variant === 'error' || variant === 'warning' ? 'alert' : 'status';

  return (
    <div
      role={role}
      className={cn(
        'flex items-start gap-3 rounded-lg border px-4 py-3 text-sm',
        ALERT_STYLES[variant],
        className,
      )}
    >
      <Icon
        className={cn('size-5 shrink-0', ALERT_ICON_COLOR[variant])}
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1 leading-5">
        {title && (
          <p className="font-semibold leading-5 text-[var(--text-primary)]">
            {title}
          </p>
        )}
        {description && (
          <p className="text-sm leading-5 text-[var(--text-secondary)]">
            {description}
          </p>
        )}
        {children}
        {action && (
          <div className="mt-1.5 flex flex-wrap items-center gap-2">{action}</div>
        )}
      </div>
    </div>
  );
}
