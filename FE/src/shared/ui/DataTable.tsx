import * as React from 'react';
import { cn } from '@/shared/lib/cn';
import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { TableSkeleton } from './Skeleton';

export interface DataTableColumn<T> {
  key: string;
  header: string;
  cell: (row: T) => React.ReactNode;
  headerClassName?: string;
  cellClassName?: string;
  align?: 'left' | 'right' | 'center';
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  data: T[];
  rowKey: (row: T) => string;
  caption?: string;
  isLoading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: React.ReactNode;
  onRowClick?: (row: T) => void;
  className?: string;
}

/**
 * Bảng dữ liệu chuẩn semantic HTML + cuộn ngang cục bộ (không làm tràn trang).
 * Tích hợp đầy đủ trạng thái loading, error (kèm request_id) và empty.
 */
export function DataTable<T>({
  columns,
  data,
  rowKey,
  caption,
  isLoading = false,
  error,
  onRetry,
  emptyTitle = 'Chưa có dữ liệu',
  emptyDescription = 'Không có bản ghi nào phù hợp với điều kiện hiện tại.',
  emptyAction,
  onRowClick,
  className,
}: DataTableProps<T>) {
  if (isLoading) {
    return <TableSkeleton rows={5} columns={Math.max(columns.length, 3)} />;
  }

  if (error) {
    return <ErrorState error={error} onRetry={onRetry} />;
  }

  if (data.length === 0) {
    return (
      <EmptyState
        title={emptyTitle}
        description={emptyDescription}
        action={emptyAction}
      />
    );
  }

  return (
    <div
      className={cn(
        'refract-panel w-full overflow-x-auto',
        className,
      )}
    >
      <table className="w-full border-collapse text-left text-[13px]">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="border-b border-[var(--color-rule)] bg-[var(--color-paper-2)]/75">
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={cn(
                  'whitespace-nowrap px-2.5 py-2.5 sm:px-3 text-xs font-medium text-[var(--color-ink-2)]',
                  col.align === 'right' && 'text-right',
                  col.align === 'center' && 'text-center',
                  col.headerClassName,
                )}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-rule-2)]">
          {data.map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn(
                'transition-colors duration-150',
                onRowClick && 'cursor-pointer hover:bg-[var(--color-accent-soft)]/50',
              )}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={cn(
                    'px-2.5 py-2.5 sm:px-3 align-middle text-[var(--text-primary)]',
                    col.align === 'right' && 'text-right tabular-nums',
                    col.align === 'center' && 'text-center',
                    col.cellClassName,
                  )}
                >
                  {col.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
