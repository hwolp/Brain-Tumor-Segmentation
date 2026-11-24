import * as React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Button } from '@/shared/ui';

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Global Error Boundary bảo vệ ứng dụng khỏi màn hình trắng và không lộ stack trace kỹ thuật.
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(_error: Error, _info: React.ErrorInfo): void {
    // Không đẩy stack trace hoặc dữ liệu nhạy cảm lên DOM hoặc storage
  }

  private handleReload = () => {
    this.setState({ hasError: false });
    window.location.assign('/');
  };

  render() {
    if (this.state.hasError) {
      return (
        <main className="flex min-h-dvh items-center justify-center bg-[var(--bg-canvas)] p-6">
          <section
            role="alert"
            className="flex w-full max-w-md flex-col gap-4 rounded-xl border border-[var(--status-error-border)] bg-[var(--bg-surface)] p-6 shadow-sm"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle
                className="size-6 shrink-0 text-[var(--status-error)]"
                aria-hidden="true"
              />
              <div className="flex flex-col items-start gap-1">
                <h1 className="text-lg font-semibold leading-6 text-[var(--text-primary)]">
                  Giao diện gặp sự cố ngoài dự kiến
                </h1>
                <p className="text-sm text-[var(--text-secondary)]">
                  Hệ thống đã dừng hiển thị thành phần bị lỗi để bảo vệ dữ liệu phiên làm việc. Vui lòng tải lại ứng dụng.
                </p>
                <Button onClick={this.handleReload} className="mt-3">
                  <RotateCcw className="size-4" aria-hidden="true" />
                  Quay về trang chính
                </Button>
              </div>
            </div>
          </section>
        </main>
      );
    }

    return this.props.children;
  }
}
