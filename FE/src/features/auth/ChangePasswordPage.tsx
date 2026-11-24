import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, KeyRound, LogOut } from 'lucide-react';
import { getDefaultRouteForUser, useAuthStore } from '@/app/auth-store';
import { normalizeApiError } from '@/shared/api/errors';
import { Alert, Button, FormField, Input } from '@/shared/ui';

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
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [errorInfo, setErrorInfo] = React.useState<{
    message: string;
    requestId: string | null;
  } | null>(null);

  const isForced = status === 'must_change_password';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorInfo(null);

    // Tuyệt đối không .trim() currentPassword hay newPassword theo đặc tả BE-01
    if (!currentPassword || !newPassword || !confirmPassword) {
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
      setErrorInfo({
        message: `Mật khẩu mới phải có từ ${PASSWORD_MIN_LENGTH} đến ${PASSWORD_MAX_LENGTH} ký tự (cho phép khoảng trắng).`,
        requestId: null,
      });
      return;
    }
    if (newPassword !== confirmPassword) {
      setErrorInfo({
        message: 'Xác nhận mật khẩu mới không khớp.',
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
      setErrorInfo({
        message: normalized.message,
        requestId: normalized.requestId,
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

      <section className="relative z-10 w-full max-w-[440px] overflow-hidden rounded-2xl border border-slate-200/90 bg-[var(--bg-surface)] shadow-[0_16px_40px_-12px_rgba(15,23,42,0.12)]">
        <div
          aria-hidden="true"
          className="h-1.5 w-full bg-gradient-to-r from-[#0369A1] via-[#0284C7] to-[#38BDF8]"
        />

        <div className="p-6 sm:p-8">
          <div className="mb-6 flex items-center gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-[var(--status-info-border)] bg-[var(--status-info-bg)] text-[var(--action-primary)]">
              <KeyRound className="size-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">
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
            <FormField id="cp-current" label="Mật khẩu hiện tại" required>
              {(props) => (
                <Input
                  {...props}
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  disabled={isSubmitting}
                />
              )}
            </FormField>

            <FormField
              id="cp-new"
              label="Mật khẩu mới"
              required
            >
              {(props) => (
                <Input
                  {...props}
                  type="password"
                  autoComplete="new-password"
                  placeholder="Tối thiểu 12 ký tự"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  disabled={isSubmitting}
                />
              )}
            </FormField>

            <FormField id="cp-confirm" label="Nhập lại mật khẩu mới" required>
              {(props) => (
                <Input
                  {...props}
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  disabled={isSubmitting}
                />
              )}
            </FormField>

            <div className="mt-2 flex flex-col-reverse items-stretch gap-2.5 sm:flex-row sm:items-center sm:justify-between [&>*]:w-full sm:[&>*]:w-auto">
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
        </div>
      </section>
    </main>
  );
}
