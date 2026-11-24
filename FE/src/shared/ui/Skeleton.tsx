import * as React from 'react';
import { cn } from '@/shared/lib/cn';

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string;
}

export function Skeleton({ className, ...props }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'animate-pulse rounded-[var(--radius-inner)] bg-[var(--color-paper-3)]',
        className,
      )}
      {...props}
    />
  );
}

export function TableSkeleton({
  rows = 5,
  columns = 4,
}: {
  rows?: number;
  columns?: number;
}) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Đang tải danh sách"
      className="refract-panel flex flex-col gap-3 p-5"
    >
      <span className="sr-only">Đang tải dữ liệu...</span>
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {Array.from({ length: columns }).map((_, idx) => (
          <Skeleton key={`head-${idx}`} className="h-5 w-3/4" />
        ))}
      </div>
      <div className="flex flex-col gap-3 pt-3">
        {Array.from({ length: rows }).map((_, rowIdx) => (
          <div
            key={`row-${rowIdx}`}
            className="grid gap-3 border-t border-[var(--border-default)] pt-3"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: columns }).map((__, colIdx) => (
              <Skeleton key={`cell-${rowIdx}-${colIdx}`} className="h-5 w-full" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Đang tải thông tin"
      className="refract-panel flex flex-col gap-3 p-5"
    >
      <span className="sr-only">Đang tải dữ liệu...</span>
      <Skeleton className="h-6 w-1/3" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-20 w-full" />
    </div>
  );
}
