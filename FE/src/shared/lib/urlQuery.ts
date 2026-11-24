import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export interface ListQueryState {
  q: string;
  page: number;
  pageSize: number;
  status: string;
}

function parsePositiveInt(
  raw: string | null,
  fallback: number,
  max?: number,
): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }
  if (max !== undefined && parsed > max) {
    return max;
  }
  return parsed;
}

/**
 * Đồng bộ trạng thái tìm kiếm, lọc và phân trang với URL query params
 * để Back/Forward hoạt động chính xác theo đặc tả FE.
 */
export function useUrlListParams(defaultStatus = 'all') {
  const [searchParams, setSearchParams] = useSearchParams();

  const q = searchParams.get('q') ?? '';
  const page = parsePositiveInt(searchParams.get('page'), 1);
  const pageSize = parsePositiveInt(
    searchParams.get('page_size'),
    DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
  );
  const status = searchParams.get('status') ?? defaultStatus;

  const [searchInput, setSearchInput] = useState(q);

  useEffect(() => {
    setSearchInput(q);
  }, [q]);

  const updateParams = useCallback(
    (patch: Partial<ListQueryState>, replace = false) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);

          if (patch.q !== undefined) {
            const trimmed = patch.q.trim();
            if (trimmed) {
              next.set('q', trimmed);
            } else {
              next.delete('q');
            }
          }

          if (patch.page !== undefined) {
            if (patch.page <= 1) {
              next.delete('page');
            } else {
              next.set('page', String(patch.page));
            }
          }

          if (patch.pageSize !== undefined) {
            if (patch.pageSize === DEFAULT_PAGE_SIZE) {
              next.delete('page_size');
            } else {
              next.set(
                'page_size',
                String(Math.min(MAX_PAGE_SIZE, Math.max(1, patch.pageSize))),
              );
            }
          }

          if (patch.status !== undefined) {
            if (!patch.status || patch.status === defaultStatus) {
              next.delete('status');
            } else {
              next.set('status', patch.status);
            }
          }

          return next;
        },
        { replace },
      );
    },
    [defaultStatus, setSearchParams],
  );

  // Debounce 300ms khi nhập ô tìm kiếm
  useEffect(() => {
    const trimmedInput = searchInput.trim();
    if (trimmedInput === q.trim()) {
      return;
    }
    const timer = window.setTimeout(() => {
      updateParams({ q: trimmedInput, page: 1 }, true);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [q, searchInput, updateParams]);

  return {
    q,
    page,
    pageSize,
    status,
    searchInput,
    setSearchInput,
    setPage: (nextPage: number) => updateParams({ page: nextPage }),
    setPageSize: (nextSize: number) =>
      updateParams({ pageSize: nextSize, page: 1 }),
    setStatus: (nextStatus: string) =>
      updateParams({ status: nextStatus, page: 1 }),
    resetFilters: () => {
      setSearchInput('');
      updateParams({ q: '', page: 1, status: defaultStatus });
    },
  };
}
