import * as React from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Info,
  X,
  AlertTriangle,
} from 'lucide-react';
import { normalizeApiError, shouldSuppressErrorToast } from '@/shared/api/errors';
import { registerSessionCleanupHook } from '@/shared/api/queryClient';
import { cn } from '@/shared/lib/cn';

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface ToastItem {
  id: string;
  variant: ToastVariant;
  title: string;
  description?: string;
  requestId?: string | null;
}

interface ToastContextValue {
  toasts: ToastItem[];
  pushToast: (toast: Omit<ToastItem, 'id'> & { durationMs?: number }) => string;
  toastError: (error: unknown, fallbackTitle?: string) => string | null;
  dismissToast: (id: string) => void;
  clearToasts: () => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

const VARIANT_STYLES: Readonly<Record<ToastVariant, string>> = {
  info: 'border-[var(--status-info-border)] bg-[var(--bg-surface)] text-[var(--text-primary)]',
  success: 'border-[var(--status-success-border)] bg-[var(--bg-surface)] text-[var(--text-primary)]',
  warning: 'border-[var(--status-warning-border)] bg-[var(--bg-surface)] text-[var(--text-primary)]',
  error: 'border-[var(--status-error-border)] bg-[var(--bg-surface)] text-[var(--text-primary)]',
};

const VARIANT_ICONS: Readonly<Record<ToastVariant, React.ComponentType<{ className?: string }>>> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertCircle,
};

const VARIANT_ICON_COLOR: Readonly<Record<ToastVariant, string>> = {
  info: 'text-[var(--status-info)]',
  success: 'text-[var(--status-success)]',
  warning: 'text-[var(--status-warning)]',
  error: 'text-[var(--status-error)]',
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);
  const timersRef = React.useRef<Map<string, number>>(new Map());
  const counterRef = React.useRef(0);

  const dismissToast = React.useCallback((id: string) => {
    const timer = timersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const clearToasts = React.useCallback(() => {
    for (const timer of timersRef.current.values()) {
      window.clearTimeout(timer);
    }
    timersRef.current.clear();
    setToasts([]);
  }, []);

  React.useEffect(() => {
    const unregisterCleanup = registerSessionCleanupHook(clearToasts);
    return () => {
      unregisterCleanup();
      for (const timer of timersRef.current.values()) {
        window.clearTimeout(timer);
      }
      timersRef.current.clear();
    };
  }, [clearToasts]);

  const pushToast = React.useCallback(
    ({
      durationMs = 4500,
      ...toast
    }: Omit<ToastItem, 'id'> & { durationMs?: number }) => {
      counterRef.current += 1;
      const id = `toast-${counterRef.current}`;
      setToasts((prev) => [...prev, { ...toast, id }]);

      if (durationMs > 0) {
        const timer = window.setTimeout(() => {
          dismissToast(id);
        }, durationMs);
        timersRef.current.set(id, timer);
      }
      return id;
    },
    [dismissToast],
  );

  /**
   * Hiển thị toast lỗi từ API. Tự động bỏ qua AbortError khi chuyển trang để không gây lỗi giả.
   */
  const toastError = React.useCallback(
    (error: unknown, fallbackTitle = 'Thao tác không thành công') => {
      if (shouldSuppressErrorToast(error)) {
        return null;
      }
      const normalized = normalizeApiError(error);
      return pushToast({
        variant: 'error',
        title: fallbackTitle,
        description: normalized.message,
        requestId: normalized.requestId,
      });
    },
    [pushToast],
  );

  const value = React.useMemo<ToastContextValue>(
    () => ({ toasts, pushToast, toastError, dismissToast, clearToasts }),
    [toasts, pushToast, toastError, dismissToast, clearToasts],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-relevant="additions text"
        className="pointer-events-none fixed right-3 bottom-3 left-3 z-50 flex flex-col gap-2 sm:right-4 sm:bottom-4 sm:left-auto sm:w-full sm:max-w-sm"
      >
        {toasts.map((item) => {
          const Icon = VARIANT_ICONS[item.variant];
          return (
            <div
              key={item.id}
              role="status"
              className={cn(
                'pointer-events-auto flex items-start gap-3 rounded-lg border p-3.5 shadow-md',
                VARIANT_STYLES[item.variant],
              )}
            >
              <Icon
                className={cn('mt-0.5 size-5 shrink-0', VARIANT_ICON_COLOR[item.variant])}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{item.title}</p>
                {item.description && (
                  <p className="mt-0.5 text-sm text-[var(--text-secondary)]">
                    {item.description}
                  </p>
                )}
                {item.requestId && (
                  <span className="sr-only">
                    Mã yêu cầu: {item.requestId}
                  </span>
                )}
              </div>
              <button
                type="button"
                aria-label="Đóng thông báo"
                onClick={() => dismissToast(item.id)}
                className="inline-flex size-7 -mt-0.5 -mr-1 shrink-0 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-muted)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return ctx;
}
