import * as React from 'react';
import { Inbox } from 'lucide-react';
import { cn } from '@/shared/lib/cn';

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'refract-panel flex flex-col items-center justify-center gap-3 border-dashed border-[var(--color-rule)] px-6 py-10 text-center',
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="flex size-11 items-center justify-center rounded-[var(--radius-pill)] border border-[var(--color-rule)] bg-[var(--color-paper-2)] text-[var(--color-muted)]"
      >
        {icon ?? <Inbox className="size-5" />}
      </div>
      <div className="flex max-w-md flex-col gap-1">
        <h3 className="text-base font-medium text-[var(--text-primary)]">
          {title}
        </h3>
        {description && (
          <p className="text-sm text-[var(--text-secondary)]">{description}</p>
        )}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
