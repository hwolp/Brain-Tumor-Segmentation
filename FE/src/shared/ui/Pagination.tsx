import { ChevronLeft, ChevronRight } from 'lucide-react';
import { DEFAULT_PAGE_SIZE } from '@/shared/lib/urlQuery';
import { cn } from '@/shared/lib/cn';
import { IconButton } from './IconButton';

export interface PaginationProps {
  page: number;
  pageSize?: number;
  total: number;
  onPageChange: (nextPage: number) => void;
  className?: string;
}

/**
 * Điều khiển phân trang (mặc định 20 dòng/trang theo CONTRACTS.md).
 */
export function Pagination({
  page,
  pageSize = DEFAULT_PAGE_SIZE,
  total,
  onPageChange,
  className,
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const startItem = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const endItem = Math.min(safePage * pageSize, total);

  if (total === 0) {
    return null;
  }

  return (
    <nav
      aria-label="Phân trang"
      className={cn(
        'flex flex-col items-center justify-between gap-2.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2.5 text-sm sm:flex-row sm:px-4',
        className,
      )}
    >
      <p className="text-[var(--text-secondary)] tabular-nums">
        Hiển thị <strong className="text-[var(--text-primary)]">{startItem}</strong>–
        <strong className="text-[var(--text-primary)]">{endItem}</strong> trên tổng{' '}
        <strong className="text-[var(--text-primary)]">{total}</strong> kết quả
      </p>

      <div className="flex items-center gap-2">
        <IconButton
          aria-label="Trang trước"
          tooltip="Trang trước"
          size="md"
          disabled={page <= 1}
          onClick={() =>
            onPageChange(Math.max(1, Math.min(page - 1, totalPages)))
          }
          icon={<ChevronLeft className="size-4" />}
        />

        <span className="inline-flex h-9 items-center px-2.5 text-sm font-medium text-[var(--text-primary)] tabular-nums">
          Trang {safePage} / {totalPages}
        </span>

        <IconButton
          aria-label="Trang sau"
          tooltip="Trang sau"
          size="md"
          disabled={page >= totalPages}
          onClick={() =>
            onPageChange(Math.min(totalPages, Math.max(1, page) + 1))
          }
          icon={<ChevronRight className="size-4" />}
        />
      </div>
    </nav>
  );
}
