import * as React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Brain, Eye, EyeOff, Lock, LogIn, User } from 'lucide-react';
import {
  type AuthNotice,
  getDefaultRouteForUser,
  isAllowedReturnPath,
  useAuthStore,
} from '@/app/auth-store';
import { normalizeApiError, normalizeErrorCode } from '@/shared/api/errors';
import { Alert, Button, FormField, Input } from '@/shared/ui';

interface LoginLocationState {
  from?: { pathname?: string; search?: string };
  notice?: AuthNotice;
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const login = useAuthStore((s) => s.login);
  const loginWithFixture = useAuthStore((s) => s.loginWithFixture);
  const fixtureMode = useAuthStore((s) => s.fixtureMode);
  const storeNotice = useAuthStore((s) => s.authNotice);
  const logoutSyncPending = useAuthStore((s) => s.logoutSyncPending);
  const retryServerLogout = useAuthStore((s) => s.retryServerLogout);
  const clearAuthNotice = useAuthStore((s) => s.clearAuthNotice);

  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [isRetryingLogout, setIsRetryingLogout] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<{
    message: string;
    requestId: string | null;
    isRateLimited: boolean;
    retryAfterSeconds: number | null;
  } | null>(null);

  const locationState = (location.state as LoginLocationState | null) ?? null;
  const searchParams = new URLSearchParams(location.search);
  const returnToParam = searchParams.get('returnTo');
  const fromPath = locationState?.from?.pathname
    ? `${locationState.from.pathname}${locationState.from.search ?? ''}`
    : returnToParam;

  const activeNotice = locationState?.notice ?? storeNotice;

  const navigateAfterLogin = (role: 'doctor' | 'admin', mustChange: boolean) => {
    if (mustChange) {
      navigate('/change-password', { replace: true });
      return;
    }
    if (fromPath && isAllowedReturnPath(fromPath, role)) {
      navigate(fromPath, { replace: true });
      return;
    }
    navigate(role === 'admin' ? '/admin' : '/doctor', { replace: true });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);

    const normalizedUsername = username.trim();
    if (!normalizedUsername || !password) {
      setSubmitError({
        message: 'Vui lòng nhập đầy đủ tên đăng nhập và mật khẩu.',
        requestId: null,
        isRateLimited: false,
        retryAfterSeconds: null,
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const user = await login(normalizedUsername, password);
      clearAuthNotice();
      navigateAfterLogin(user.role, user.must_change_password);
    } catch (error) {
      const normalized = normalizeApiError(error);
      const code = normalizeErrorCode(normalized.code);
      const isRateLimited =
        normalized.status === 429 ||
        code === 'rate_limit_exceeded' ||
        code === 'rate_limited';

      setSubmitError({
        message: normalized.message,
        requestId: normalized.requestId,
        isRateLimited,
        retryAfterSeconds: normalized.retryAfterSeconds,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFixtureLogin = async (role: 'doctor' | 'admin') => {
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const user = await loginWithFixture(role);
      clearAuthNotice();
      navigate(getDefaultRouteForUser(user), { replace: true });
    } catch (error) {
      const normalized = normalizeApiError(error);
      setSubmitError({
        message: normalized.message,
        requestId: normalized.requestId,
        isRateLimited: normalized.status === 429,
        retryAfterSeconds: normalized.retryAfterSeconds,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-slate-50 px-4 py-8 sm:px-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(3,105,161,0.09),_transparent_55%)]"
      />

      <section className="relative z-10 w-full max-w-[420px] overflow-hidden rounded-2xl border border-slate-200/90 bg-[var(--bg-surface)] shadow-[0_16px_40px_-12px_rgba(15,23,42,0.12)]">
        <div
          aria-hidden="true"
          className="h-1.5 w-full bg-gradient-to-r from-[#0369A1] via-[#0284C7] to-[#38BDF8]"
        />

        <div className="p-6 sm:p-8">
          <div className="mb-7 flex flex-col items-center text-center">
            <div className="mb-3 flex size-12 items-center justify-center rounded-xl border border-[var(--status-info-border)] bg-[var(--status-info-bg)] text-[var(--action-primary)] shadow-xs">
              <Brain className="size-6" aria-hidden="true" />
            </div>
            <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--action-primary)]">
              TDA-SegUNet
            </span>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-[var(--text-primary)]">
              Đăng nhập hệ thống
            </h1>
          </div>

          {fixtureMode && (
            <Alert
              variant="warning"
              className="mb-4"
              title="Chế độ dữ liệu mẫu (Fixture Mode)"
              description="Ứng dụng đang chạy độc lập không cần backend thật để phục vụ phát triển P1."
            />
          )}

          {activeNotice && !submitError && (
            <Alert
              variant={activeNotice.variant}
              className="mb-4"
              title={activeNotice.title}
              description={activeNotice.message}
            >
              {logoutSyncPending && (
                <div className="mt-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    isLoading={isRetryingLogout}
                    loadingText="Đang thu hồi phiên..."
                    onClick={() => {
                      setIsRetryingLogout(true);
                      void retryServerLogout().finally(() => {
                        setIsRetryingLogout(false);
                      });
                    }}
                  >
                    Thử thu hồi phiên trên máy chủ
                  </Button>
                </div>
              )}
            </Alert>
          )}

          {submitError && (
            <Alert
              variant="error"
              className="mb-4"
              title={
                submitError.isRateLimited
                  ? 'Tạm giới hạn đăng nhập'
                  : 'Đăng nhập không thành công'
              }
              description={submitError.message}
            >
              {submitError.isRateLimited && (
                <p className="text-xs text-[var(--text-secondary)]">
                  {submitError.retryAfterSeconds
                    ? `Vui lòng đợi khoảng ${submitError.retryAfterSeconds} giây trước khi thử đăng nhập lại.`
                    : 'Hệ thống đang tạm khóa thao tác thử lại để bảo vệ tài khoản. Vui lòng chờ vài phút rồi thử lại.'}
                </p>
              )}
              {submitError.requestId && (
                <span className="sr-only">
                  Mã yêu cầu: {submitError.requestId}
                </span>
              )}
            </Alert>
          )}

          <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
            <FormField id="login-username" label="Tên đăng nhập" required>
              {(fieldProps) => (
                <div className="relative flex items-center">
                  <User
                    className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-slate-400"
                    aria-hidden="true"
                  />
                  <Input
                    {...fieldProps}
                    type="text"
                    autoComplete="username"
                    placeholder="Nhập tên đăng nhập"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    disabled={isSubmitting}
                    className="pl-10"
                  />
                </div>
              )}
            </FormField>

            <FormField id="login-password" label="Mật khẩu" required>
              {(fieldProps) => (
                <div className="relative flex items-center">
                  <Lock
                    className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-slate-400"
                    aria-hidden="true"
                  />
                  <Input
                    {...fieldProps}
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    placeholder="Nhập mật khẩu"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    disabled={isSubmitting}
                    className="pl-10 pr-10"
                  />
                  <button
                    type="button"
                    aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute top-1/2 right-1.5 inline-flex size-8 min-h-[32px] min-w-[32px] -translate-y-1/2 items-center justify-center rounded-md text-slate-400 hover:bg-[var(--bg-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                  >
                    {showPassword ? (
                      <EyeOff className="size-4" aria-hidden="true" />
                    ) : (
                      <Eye className="size-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
              )}
            </FormField>

            <Button
              type="submit"
              size="lg"
              isLoading={isSubmitting}
              loadingText="Đang xác thực..."
              className="mt-2 w-full rounded-lg font-semibold shadow-xs"
            >
              <LogIn className="size-4" aria-hidden="true" />
              Đăng nhập
            </Button>
          </form>

          {fixtureMode && (
            <div className="mt-6 border-t border-[var(--border-default)] pt-4">
              <p className="mb-2 text-xs font-medium text-[var(--text-secondary)]">
                Đăng nhập nhanh (chỉ dùng trong Fixture Mode):
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  disabled={isSubmitting}
                  onClick={() => void handleFixtureLogin('doctor')}
                >
                  Vào vai Bác sĩ (Mẫu)
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  disabled={isSubmitting}
                  onClick={() => void handleFixtureLogin('admin')}
                >
                  Vào vai Admin (Mẫu)
                </Button>
              </div>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
