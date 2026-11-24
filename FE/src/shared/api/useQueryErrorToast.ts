import * as React from 'react';
import { shouldSuppressErrorToast } from '@/shared/api/errors';
import { useToast } from '@/shared/ui';

/**
 * Kích hoạt toast thông báo lỗi API từ query thất bại,
 * tự động bỏ qua `AbortError` khi người dùng chuyển trang hoặc hủy request.
 */
export function useQueryErrorToast(
  error: unknown,
  title = 'Không thể tải dữ liệu',
): void {
  const { toastError } = useToast();
  const lastReportedRef = React.useRef<unknown>(null);

  React.useEffect(() => {
    if (!error) {
      lastReportedRef.current = null;
      return;
    }
    if (shouldSuppressErrorToast(error)) {
      return;
    }
    if (lastReportedRef.current === error) {
      return;
    }
    lastReportedRef.current = error;
    toastError(error, title);
  }, [error, title, toastError]);
}
