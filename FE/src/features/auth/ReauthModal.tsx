import * as React from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, EyeOff, KeyRound, Lock, LogOut, User } from 'lucide-react';
import { getDefaultRouteForUser, useAuthStore } from '@/app/auth-store';
import { normalizeApiError } from '@/shared/api/errors';
import { Alert, Button, FormField, Input, Modal, useToast } from '@/shared/ui';

export function ReauthModal() {
  const navigate = useNavigate();
  const { pushToast } = useToast();

  const reauthRequired = useAuthStore((s) => s.reauthRequired);
  const reauthUsername = useAuthStore((s) => s.reauthUsername);
  const reauthReason = useAuthStore((s) => s.reauthReason);
  const reauthenticate = useAuthStore((s) => s.reauthenticate);
  const logout = useAuthStore((s) => s.logout);

  const formId = React.useId();
  const passwordInputRef = React.useRef<HTMLInputElement | null>(null);

  const [usernameInput, setUsernameInput] = React.useState(reauthUsername ?? '');
  const [allowSwitchAccount, setAllowSwitchAccount] = React.useState(false);
  const [password, setPassword] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [errorInfo, setErrorInfo] = React.useState<{
    message: string;
    requestId: string | null;
    retryAfterSeconds: number | null;
  } | null>(null);

  React.useEffect(() => {
    if (reauthRequired) {
      setUsernameInput(reauthUsername ?? '');
      setAllowSwitchAccount(false);
      setPassword('');
      setShowPassword(false);
      setErrorInfo(null);
    }
  }, [reauthRequired, reauthUsername]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorInfo(null);

    const targetUsername = (
      allowSwitchAccount ? usernameInput : (reauthUsername ?? usernameInput)
    ).trim();

    if (!targetUsername || !password) {
      setErrorInfo({
        message: 'Vui lòng nhập đầy đủ tên đăng nhập và mật khẩu.',
        requestId: null,
        retryAfterSeconds: null,
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await reauthenticate(
        password,
        allowSwitchAccount ? targetUsername : undefined,
      );
      setPassword('');

      if (result.switchedAccount) {
        pushToast({
          variant: 'info',
          title: 'Đã chuyển tài khoản',
          description:
            'Bản nháp cũ đã được xóa để bảo vệ dữ liệu bệnh nhân giữa các tài khoản.',
        });
        navigate(getDefaultRouteForUser(result.user), { replace: true });
      } else {
        pushToast({
          variant: 'success',
          title: 'Đã xác thực lại phiên',
          description: 'Bản nháp chỉnh sửa mask vẫn được giữ nguyên.',
        });
        if (result.user.must_change_password) {
          navigate('/change-password', { replace: true });
        }
      }
    } catch (error) {
      const normalized = normalizeApiError(error);
      setErrorInfo({
        message: normalized.message,
        requestId: normalized.requestId,
        retryAfterSeconds: normalized.retryAfterSeconds,
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDiscardAndLogout = async () => {
    setIsSubmitting(true);
    try {
      await logout();
      navigate('/login', { replace: true });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      open={reauthRequired}
      onClose={() => {
        // Không đóng tùy ý khi chưa xác thực lại hoặc chưa hủy bản nháp
      }}
      title="Xác thực lại phiên làm việc"
      description={
        reauthReason ??
        'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại để tiếp tục và giữ bản nháp mask chưa lưu.'
      }
      role="alertdialog"
      size="md"
      showCloseButton={false}
      closeOnEscape={false}
      closeOnBackdrop={false}
      isSubmitting={isSubmitting}
      initialFocusRef={passwordInputRef}
      footer={
        <>
          <Button
            variant="outline"
            disabled={isSubmitting}
            onClick={() => {
              void handleDiscardAndLogout();
            }}
          >
            <LogOut className="size-4" aria-hidden="true" />
            Hủy bản nháp &amp; đăng xuất
          </Button>
          <Button
            type="submit"
            form={formId}
            isLoading={isSubmitting}
            loadingText="Đang xác thực..."
          >
            <KeyRound className="size-4" aria-hidden="true" />
            Đăng nhập lại
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Alert
          variant="warning"
          title="Đang giữ bản nháp mask chưa lưu trong bộ nhớ"
          description="Đăng nhập lại đúng tài khoản bác sĩ hiện tại để giữ nguyên bản nháp. Nếu chuyển sang tài khoản khác hoặc đăng xuất, bản nháp sẽ bị xóa sạch."
        />

        {errorInfo && (
          <Alert
            variant="error"
            title="Xác thực lại không thành công"
            description={
              errorInfo.retryAfterSeconds
                ? `${errorInfo.message} Vui lòng đợi khoảng ${errorInfo.retryAfterSeconds} giây.`
                : errorInfo.message
            }
          >
            {errorInfo.requestId && (
              <span className="sr-only">
                Mã yêu cầu: {errorInfo.requestId}
              </span>
            )}
          </Alert>
        )}

        <form id={formId} onSubmit={handleSubmit} className="flex flex-col gap-3" noValidate>
          <FormField
            id="reauth-username"
            label="Tên đăng nhập"
            required
            helperText={
              allowSwitchAccount
                ? 'Đăng nhập tài khoản khác sẽ xóa bản nháp mask hiện tại.'
                : undefined
            }
          >
            {(fieldProps) => (
              <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
                <div className="relative flex min-w-0 flex-1 items-center">
                  <User
                    className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-slate-400"
                    aria-hidden="true"
                  />
                  <Input
                    {...fieldProps}
                    type="text"
                    autoComplete="username"
                    readOnly={!allowSwitchAccount}
                    value={usernameInput}
                    onChange={(e) => setUsernameInput(e.target.value)}
                    disabled={isSubmitting}
                    className={
                      !allowSwitchAccount
                        ? 'min-w-0 flex-1 bg-[var(--bg-muted)] pl-10 font-mono'
                        : 'min-w-0 flex-1 pl-10 font-mono'
                    }
                  />
                </div>
                <Button
                  variant="outline"
                  size="md"
                  className="shrink-0"
                  disabled={isSubmitting}
                  onClick={() => {
                    const next = !allowSwitchAccount;
                    setAllowSwitchAccount(next);
                    if (!next) {
                      setUsernameInput(reauthUsername ?? '');
                    }
                  }}
                >
                  {allowSwitchAccount ? 'Dùng lại tài khoản cũ' : 'Đổi tài khoản khác'}
                </Button>
              </div>
            )}
          </FormField>

          <FormField id="reauth-password" label="Mật khẩu" required>
            {(fieldProps) => (
              <div className="relative flex items-center">
                <Lock
                  className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-slate-400"
                  aria-hidden="true"
                />
                <Input
                  {...fieldProps}
                  ref={passwordInputRef}
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={isSubmitting}
                  className="pl-10 pr-10"
                />
                <button
                  type="button"
                  aria-label={showPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute top-1/2 right-1.5 inline-flex size-8 min-h-[32px] min-w-[32px] -translate-y-1/2 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-muted)] hover:text-[var(--text-primary)] cursor-pointer"
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
        </form>
      </div>
    </Modal>
  );
}
