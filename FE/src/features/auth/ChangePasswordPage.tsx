import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Eye, EyeOff, KeyRound, LogOut } from 'lucide-react';
import { getDefaultRouteForUser, useAuthStore } from '@/app/auth-store';
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

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export function ChangePasswordPage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const status = useAuthStore((s) => s.status);
  const completePasswordChange = useAuthStore((s) => s.completePasswordChange);
  const logout = useAuthStore((s) => s.logout);

  const [currentPassword, setCurrentPassword] = React.useState('');
  const [newPassword, setNewPassword] = React.useState('');
  const [confirmPassword, setConfirmPassword] = React.useState('');
  const [showCurrentPassword, setShowCurrentPassword] = React.useState(false);
  const [showNewPassword, setShowNewPassword] = React.useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<{
    current_password?: string;
    new_password?: string;
    confirm_password?: string;
  }>({});
  const [errorInfo, setErrorInfo] = React.useState<{
    message: string;
    requestId: string | null;
  } | null>(null);

  const isForced = status === 'must_change_password';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorInfo(null);
    setFieldErrors({});

    // Tuyệt đối không .trim() currentPassword hay newPassword theo đặc tả BE-01
    if (!currentPassword || !newPassword || !confirmPassword) {
      setFieldErrors({
        current_password: !currentPassword
          ? 'Vui lòng nhập mật khẩu hiện tại.'
          : undefined,
        new_password: !newPassword ? 'Vui lòng nhập mật khẩu mới.' : undefined,
        confirm_password: !confirmPassword
          ? 'Vui lòng nhập lại mật khẩu mới.'
          : undefined,
      });
      setErrorInfo({
        message: 'Vui lòng điền đầy đủ mật khẩu hiện tại và mật khẩu mới.',
        requestId: null,
      });
      return;
    }
    if (
      newPassword.length < PASSWORD_MIN_LENGTH ||
      newPassword.length > PASSWORD_MAX_LENGTH
    ) {
      setFieldErrors({
        new_password: `Cần nhập từ ${PASSWORD_MIN_LENGTH} đến ${PASSWORD_MAX_LENGTH} ký tự.`,
      });
      setErrorInfo({
        message: `Mật khẩu mới phải có từ ${PASSWORD_MIN_LENGTH} đến ${PASSWORD_MAX_LENGTH} ký tự (cho phép khoảng trắng).`,
        requestId: null,
      });
      return;
    }
    if (newPassword !== confirmPassword) {
      setFieldErrors({
        confirm_password: 'Mật khẩu nhập lại chưa khớp.',
      });
      setErrorInfo({
        message: 'Xác nhận mật khẩu mới không khớp.',
        requestId: null,
      });
      return;
    }
    if (currentPassword === newPassword) {
      setFieldErrors({
        new_password: 'Không được trùng với mật khẩu hiện tại.',
      });
      setErrorInfo({
        message: 'Mật khẩu mới phải khác mật khẩu hiện tại.',
        requestId: null,
      });
      return;
    }

    setIsSubmitting(true);
    try {
      await completePasswordChange(currentPassword, newPassword);
      navigate('/login', {
        replace: true,
        state: {
          notice: {
            variant: 'success',
            title: 'Đổi mật khẩu thành công',
            message:
              'Đổi mật khẩu thành công. Vui lòng đăng nhập lại bằng mật khẩu mới.',
          },
        },
      });
    } catch (error) {
      const normalized = normalizeApiError(error);
      const code = normalizeErrorCode(normalized.code);
      const apiFieldErrors = extractFieldErrors(error);

      const nextFieldErrors: {
        current_password?: string;
        new_password?: string;
        confirm_password?: string;
      } = {
        current_password: apiFieldErrors.current_password,
        new_password: apiFieldErrors.new_password,
        confirm_password: apiFieldErrors.confirm_password,
      };

      if (
        (code === 'invalid_credentials' ||
          code === 'invalid_current_password' ||
          normalized.status === 400) &&
        !nextFieldErrors.current_password
      ) {
        nextFieldErrors.current_password =
          code === 'invalid_credentials' || code === 'invalid_current_password'
            ? 'Mật khẩu hiện tại không chính xác.'
            : normalized.message;
      }

      setFieldErrors(nextFieldErrors);
      setErrorInfo({
        message:
          code === 'invalid_credentials' || code === 'invalid_current_password'
            ? 'Mật khẩu hiện tại không chính xác.'
            : (nextFieldErrors.new_password ?? normalized.message),
        requestId: normalized.requestId,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="relative isolate flex min-h-dvh items-center justify-center overflow-x-clip bg-[var(--color-paper)] px-4 py-8 sm:px-6">
      <RefractLightCanvas variant="glass" />
      <section className="refract-panel-lead relative z-10 w-full max-w-[456px] p-6 sm:p-8">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-[var(--radius-pill)] border border-[var(--color-rule)] bg-[var(--color-light)] text-[var(--color-accent)]">
            <KeyRound className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h1 className="font-display text-2xl leading-[1.08] font-normal text-[var(--color-ink)]">
              Đổi mật khẩu tài khoản
            </h1>
            {user && (
              <p className="truncate font-mono text-xs text-[var(--text-secondary)]">
                @{user.username}
              </p>
            )}
          </div>
        </div>

          {isForced && (
            <Alert
              variant="warning"
              className="mb-4"
              title="Yêu cầu đổi mật khẩu tạm"
              description="Bạn cần đổi mật khẩu mới trước khi truy cập dữ liệu và chức năng của hệ thống."
            />
          )}

          {errorInfo && (
            <Alert
              variant="error"
              className="mb-4"
              title="Không thể đổi mật khẩu"
              description={errorInfo.message}
            >
              {errorInfo.requestId && (
                <span className="sr-only">
                  Mã yêu cầu: {errorInfo.requestId}
                </span>
              )}
            </Alert>
          )}

          <form onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
            <FormField
              id="cp-current"
              label="Mật khẩu hiện tại"
              required
              error={fieldErrors.current_password}
            >
              {(props) => (
                <div className="relative flex items-center">
                  <Input
                    {...props}
                    hasError={Boolean(fieldErrors.current_password)}
                    type={showCurrentPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={currentPassword}
                    onChange={(e) => {
                      setCurrentPassword(e.target.value);
                      if (fieldErrors.current_password) {
                        setFieldErrors((prev) => ({
                          ...prev,
                          current_password: undefined,
                        }));
                      }
                    }}
                    disabled={isSubmitting}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    aria-label={
                      showCurrentPassword
                        ? 'Ẩn mật khẩu hiện tại'
                        : 'Hiện mật khẩu hiện tại'
                    }
                    onClick={() => setShowCurrentPassword((v) => !v)}
                    className="absolute top-1/2 right-1.5 inline-flex size-8 min-h-[32px] min-w-[32px] -translate-y-1/2 items-center justify-center rounded-[var(--radius-pill)] text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--bg-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                  >
                    {showCurrentPassword ? (
                      <EyeOff className="size-4" aria-hidden="true" />
                    ) : (
                      <Eye className="size-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
              )}
            </FormField>

            <FormField
              id="cp-new"
              label="Mật khẩu mới"
              required
              error={fieldErrors.new_password}
            >
              {(props) => (
                <div className="relative flex items-center">
                  <Input
                    {...props}
                    hasError={Boolean(fieldErrors.new_password)}
                    type={showNewPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="Tối thiểu 12 ký tự"
                    value={newPassword}
                    onChange={(e) => {
                      setNewPassword(e.target.value);
                      if (fieldErrors.new_password) {
                        setFieldErrors((prev) => ({
                          ...prev,
                          new_password: undefined,
                        }));
                      }
                    }}
                    disabled={isSubmitting}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    aria-label={
                      showNewPassword ? 'Ẩn mật khẩu mới' : 'Hiện mật khẩu mới'
                    }
                    onClick={() => setShowNewPassword((v) => !v)}
                    className="absolute top-1/2 right-1.5 inline-flex size-8 min-h-[32px] min-w-[32px] -translate-y-1/2 items-center justify-center rounded-[var(--radius-pill)] text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--bg-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                  >
                    {showNewPassword ? (
                      <EyeOff className="size-4" aria-hidden="true" />
                    ) : (
                      <Eye className="size-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
              )}
            </FormField>

            <FormField
              id="cp-confirm"
              label="Nhập lại mật khẩu mới"
              required
              error={fieldErrors.confirm_password}
            >
              {(props) => (
                <div className="relative flex items-center">
                  <Input
                    {...props}
                    hasError={Boolean(fieldErrors.confirm_password)}
                    type={showConfirmPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => {
                      setConfirmPassword(e.target.value);
                      if (fieldErrors.confirm_password) {
                        setFieldErrors((prev) => ({
                          ...prev,
                          confirm_password: undefined,
                        }));
                      }
                    }}
                    disabled={isSubmitting}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    aria-label={
                      showConfirmPassword
                        ? 'Ẩn xác nhận mật khẩu mới'
                        : 'Hiện xác nhận mật khẩu mới'
                    }
                    onClick={() => setShowConfirmPassword((v) => !v)}
                    className="absolute top-1/2 right-1.5 inline-flex size-8 min-h-[32px] min-w-[32px] -translate-y-1/2 items-center justify-center rounded-[var(--radius-pill)] text-[var(--text-muted)] transition-colors duration-150 hover:bg-[var(--bg-muted)] hover:text-[var(--text-primary)] cursor-pointer"
                  >
                    {showConfirmPassword ? (
                      <EyeOff className="size-4" aria-hidden="true" />
                    ) : (
                      <Eye className="size-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
              )}
            </FormField>

            <div className="mt-2 flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between [&>*]:w-full sm:[&>*]:w-auto">
              {isForced ? (
                <Button
                  variant="outline"
                  disabled={isSubmitting}
                  onClick={() => {
                    void logout().then(() => navigate('/login', { replace: true }));
                  }}
                >
                  <LogOut className="size-4" aria-hidden="true" />
                  Đăng xuất
                </Button>
              ) : (
                <Button
                  variant="outline"
                  disabled={isSubmitting}
                  onClick={() => navigate(getDefaultRouteForUser(user))}
                >
                  <ArrowLeft className="size-4" aria-hidden="true" />
                  Quay lại
                </Button>
              )}

              <Button
                type="submit"
                isLoading={isSubmitting}
                loadingText="Đang cập nhật..."
              >
                Lưu mật khẩu mới
              </Button>
            </div>
          </form>
      </section>
    </main>
  );
}
