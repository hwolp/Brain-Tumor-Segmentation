import * as React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Brain, Eye, EyeOff, Lock, LogIn, User } from 'lucide-react';
import {
  type AuthNotice,
  getDefaultRouteForUser,
  isAllowedReturnPath,
  useAuthStore,
} from '@/app/auth-store';
import {
  extractFieldErrors,
  normalizeApiError,
  normalizeErrorCode,
} from '@/shared/api/errors';
import {
  Alert,
  Button,
  FormField,
  Input,
  RefractLightCanvas,
} from '@/shared/ui';

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
    highlightCredentials: boolean;
  } | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<{
    username?: string;
    password?: string;
  }>({});

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
    setFieldErrors({});

    const normalizedUsername = username.trim();
    if (!normalizedUsername || !password) {
      setFieldErrors({
        username: !normalizedUsername ? 'Vui lòng nhập tên đăng nhập.' : undefined,
        password: !password ? 'Vui lòng nhập mật khẩu.' : undefined,
      });
      setSubmitError({
        message: 'Vui lòng nhập đầy đủ tên đăng nhập và mật khẩu.',
        requestId: null,
        isRateLimited: false,
        retryAfterSeconds: null,
        highlightCredentials: false,
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
      const apiFieldErrors = extractFieldErrors(error);
      const isRateLimited =
        normalized.status === 429 ||
        code === 'rate_limit_exceeded' ||
        code === 'rate_limited';
      const isCredentialError =
        normalized.status === 401 ||
        code === 'login_failed' ||
        code === 'invalid_credentials';

      if (Object.keys(apiFieldErrors).length > 0) {
        setFieldErrors({
          username: apiFieldErrors.username,
          password: apiFieldErrors.password,
        });
      }

      setSubmitError({
        message: normalized.message,
        requestId: normalized.requestId,
        isRateLimited,
        retryAfterSeconds: normalized.retryAfterSeconds,
        highlightCredentials: isCredentialError,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFixtureLogin = async (role: 'doctor' | 'admin') => {
    setIsSubmitting(true);
    setSubmitError(null);
    setFieldErrors({});
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
        highlightCredentials: false,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="relative isolate flex min-h-dvh items-center justify-center overflow-x-clip bg-[var(--color-paper)] px-4 py-8 sm:px-6">
      <RefractLightCanvas variant="glass" />
      <section className="refract-panel-lead relative z-10 w-full max-w-[432px] p-6 sm:p-8">
        <div className="mb-6 flex flex-col items-start">
          <div className="inline-flex items-center gap-2 rounded-[var(--radius-pill)] border border-[var(--color-rule)] bg-[var(--color-light)] px-3 py-1">
            <Brain
              className="size-4 shrink-0 text-[var(--color-accent)]"
              aria-hidden="true"
            />
            <span className="text-xs font-medium text-[var(--color-ink-2)]">
              TDA-SegUNet
            </span>
          </div>
          <h1 className="font-display mt-3 text-[1.75rem] leading-[1.08] font-normal text-[var(--color-ink)]">
            Đăng nhập hệ thống
          </h1>
          <p className="mt-1.5 text-sm text-[var(--color-muted)]">
            Trạm làm việc phân đoạn u não MRI đa xung
          </p>
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
            <FormField
              id="login-username"
              label="Tên đăng nhập"
              required
              error={fieldErrors.username}
            >
              {(fieldProps) => (
                <div className="relative flex items-center">
                  <User
                    className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-[var(--text-muted)]"
                    aria-hidden="true"
                  />
                  <Input
                    {...fieldProps}
                    hasError={Boolean(
                      fieldErrors.username || submitError?.highlightCredentials,
                    )}
                    type="text"
                    autoComplete="username"
                    placeholder="Nhập tên đăng nhập"
                    value={username}
                    onChange={(e) => {
                      setUsername(e.target.value);
                      if (fieldErrors.username) {
                        setFieldErrors((prev) => ({ ...prev, username: undefined }));
                      }
                      if (submitError?.highlightCredentials) {
                        setSubmitError((prev) =>
                          prev ? { ...prev, highlightCredentials: false } : prev,
                        );
                      }
                    }}
                    disabled={isSubmitting}
                    className="pl-10"
                  />
                </div>
              )}
            </FormField>

            <FormField
              id="login-password"
              label="Mật khẩu"
              required
              error={fieldErrors.password}
            >
              {(fieldProps) => (
                <div className="relative flex items-center">
                  <Lock
                    className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-[var(--text-muted)]"
                    aria-hidden="true"
                  />
                  <Input
                    {...fieldProps}
                    hasError={Boolean(
                      fieldErrors.password || submitError?.highlightCredentials,
                    )}
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    placeholder="Nhập mật khẩu"
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (fieldErrors.password) {
                        setFieldErrors((prev) => ({ ...prev, password: undefined }));
                      }
                      if (submitError?.highlightCredentials) {
                        setSubmitError((prev) =>
                          prev ? { ...prev, highlightCredentials: false } : prev,
                        );
                      }
                    }}
                    disabled={isSubmitting}
                    className="pl-10 pr-10"
                  />
                  <button
                    type="button"
                    aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute top-1/2 right-1.5 inline-flex size-8 min-h-[32px] min-w-[32px] -translate-y-1/2 items-center justify-center rounded-[var(--radius-pill)] text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--bg-muted)] hover:text-[var(--text-primary)] cursor-pointer"
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
              className="mt-2 w-full"
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
      </section>
    </main>
  );
}
