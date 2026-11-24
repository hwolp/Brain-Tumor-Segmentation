import { QueryClient } from '@tanstack/react-query';
import { ApiClientError, isAbortError } from './errors';

type CleanupHook = () => void;

const sessionCleanupHooks = new Set<CleanupHook>();

/**
 * Đăng ký hàm dọn dẹp bộ nhớ cục bộ (object URLs, viewer voxel buffers, Zustand draft)
 * sẽ được gọi khi logout hoặc chuyển tài khoản.
 */
export function registerSessionCleanupHook(hook: CleanupHook): () => void {
  sessionCleanupHooks.add(hook);
  return () => {
    sessionCleanupHooks.delete(hook);
  };
}

/**
 * Quy tắc retry cho TanStack Query theo đặc tả FE-01:
 * - Không retry khi AbortError
 * - Không retry các lỗi 4xx (đặc biệt 401/403/404/422)
 * - GET tối đa 2 lần retry với backoff cho lỗi mạng hoặc 5xx
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (isAbortError(error)) {
    return false;
  }
  if (error instanceof ApiClientError) {
    if (error.status >= 400 && error.status < 500) {
      return false;
    }
    if (error.isNetworkError || error.status >= 500 || error.status === 0) {
      return failureCount < 2;
    }
    return false;
  }
  return failureCount < 2;
}

export function queryRetryDelay(attemptIndex: number): number {
  return Math.min(1000 * 2 ** attemptIndex, 4000);
}

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetryQuery,
        retryDelay: queryRetryDelay,
        staleTime: 30_000,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

export const queryClient = createAppQueryClient();

/**
 * Hủy toàn bộ request đang chạy, xóa Query cache và kích hoạt dọn dẹp buffer/object URLs.
 */
export async function clearSessionCache(
  client: QueryClient = queryClient,
): Promise<void> {
  await client.cancelQueries();
  client.clear();
  for (const hook of sessionCleanupHooks) {
    try {
      hook();
    } catch {
      // Đảm bảo một cleanup hook lỗi không ngăn phần còn lại dọn dẹp
    }
  }
}
