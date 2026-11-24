import * as React from 'react';
import { Check, Copy, Eye, EyeOff, KeyRound, Pencil, UserPlus } from 'lucide-react';
import {
  DISPLAY_NAME_MAX_LENGTH,
  DISPLAY_NAME_MIN_LENGTH,
  TEMP_PASSWORD_MAX_LENGTH,
  TEMP_PASSWORD_MIN_LENGTH,
  USERNAME_PATTERN,
} from '@/shared/api/adminUsers';
import {
  extractFieldErrors,
  normalizeApiError,
  normalizeErrorCode,
} from '@/shared/api/errors';
import type {
  AdminCreateDoctorRequestDto,
  AdminDoctorUserDto,
} from '@/shared/api/types';
import { Alert, Button, FormField, Input, Modal, useToast } from '@/shared/ui';

export interface OneTimeSecretInfo {
  mode: 'create' | 'reset';
  username: string;
  displayName: string;
  temporaryPassword: string;
}

export interface CreateDoctorModalProps {
  open: boolean;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (payload: AdminCreateDoctorRequestDto) => Promise<void>;
}

export function CreateDoctorModal({
  open,
  isSubmitting,
  onClose,
  onSubmit,
}: CreateDoctorModalProps) {
  const formId = React.useId();
  const usernameRef = React.useRef<HTMLInputElement | null>(null);

  const [username, setUsername] = React.useState('');
  const [displayName, setDisplayName] = React.useState('');
  const [temporaryPassword, setTemporaryPassword] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);

  const [fieldErrors, setFieldErrors] = React.useState<{
    username?: string;
    display_name?: string;
    temporary_password?: string;
  }>({});
  const [serverError, setServerError] = React.useState<{
    message: string;
    requestId: string | null;
  } | null>(null);

  React.useEffect(() => {
    setUsername('');
    setDisplayName('');
    setTemporaryPassword('');
    setShowPassword(false);
    setFieldErrors({});
    setServerError(null);
  }, [open]);

  const validate = (): boolean => {
    const nextErrors: {
      username?: string;
      display_name?: string;
      temporary_password?: string;
    } = {};

    const trimmedUsername = username.trim();
    if (!USERNAME_PATTERN.test(trimmedUsername)) {
      nextErrors.username =
        'Tên đăng nhập phải dài 3–64 ký tự, chỉ gồm chữ thường [a-z], số [0-9], dấu chấm (.), gạch dưới (_) hoặc gạch ngang (-).';
    }

    const trimmedDisplay = displayName.trim();
    if (
      trimmedDisplay.length < DISPLAY_NAME_MIN_LENGTH ||
      trimmedDisplay.length > DISPLAY_NAME_MAX_LENGTH
    ) {
      nextErrors.display_name = `Họ và tên hiển thị phải từ ${DISPLAY_NAME_MIN_LENGTH} đến ${DISPLAY_NAME_MAX_LENGTH} ký tự.`;
    }

    // Tuyệt đối không .trim() temporaryPassword
    if (
      temporaryPassword.length < TEMP_PASSWORD_MIN_LENGTH ||
      temporaryPassword.length > TEMP_PASSWORD_MAX_LENGTH
    ) {
      nextErrors.temporary_password = `Mật khẩu tạm phải từ ${TEMP_PASSWORD_MIN_LENGTH} đến ${TEMP_PASSWORD_MAX_LENGTH} ký tự (cho phép khoảng trắng).`;
    }

    setFieldErrors(nextErrors);
    return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setServerError(null);

    if (!validate()) {
      return;
    }

    try {
      await onSubmit({
        username: username.trim(),
        display_name: displayName.trim(),
        temporary_password: temporaryPassword,
      });
      setTemporaryPassword('');
    } catch (error) {
      const normalized = normalizeApiError(error);
      const mappedFields = extractFieldErrors(error);
      const code = normalizeErrorCode(normalized.code);

      if (code === 'username_conflict') {
        mappedFields.username = mappedFields.username ?? normalized.message;
      }

      setFieldErrors({
        username: mappedFields.username,
        display_name: mappedFields.display_name,
        temporary_password: mappedFields.temporary_password,
      });
      setServerError({
        message: normalized.message,
        requestId: normalized.requestId,
      });
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Tạo tài khoản bác sĩ"
      size="md"
      isSubmitting={isSubmitting}
      initialFocusRef={usernameRef}
      footer={
        <>
          <Button variant="outline" disabled={isSubmitting} onClick={onClose}>
            Hủy
          </Button>
          <Button
            type="submit"
            form={formId}
            isLoading={isSubmitting}
            loadingText="Đang tạo tài khoản..."
          >
            <UserPlus className="size-4" aria-hidden="true" />
            Tạo tài khoản
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {serverError && (
          <Alert
            variant="error"
            title="Không thể tạo tài khoản bác sĩ"
            description={
              Object.values(fieldErrors).some(
                (msg) => Boolean(msg && msg.trim() === serverError.message.trim()),
              )
                ? undefined
                : serverError.message
            }
          >
            {serverError.requestId && (
              <span className="sr-only">
                Mã yêu cầu: {serverError.requestId}
              </span>
            )}
          </Alert>
        )}

        <form id={formId} onSubmit={handleSubmit} className="flex flex-col gap-4" noValidate>
          <FormField
            id="create-doctor-username"
            label="Tên đăng nhập"
            required
            error={fieldErrors.username ?? null}
          >
            {(props) => (
              <Input
                {...props}
                ref={usernameRef}
                type="text"
                autoComplete="off"
                placeholder="nguyenthengoc"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={isSubmitting}
                hasError={Boolean(fieldErrors.username)}
              />
            )}
          </FormField>

          <FormField
            id="create-doctor-display-name"
            label="Họ và tên hiển thị"
            required
            error={fieldErrors.display_name ?? null}
          >
            {(props) => (
              <Input
                {...props}
                type="text"
                placeholder="BS. Nguyễn Hoàng Minh"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={isSubmitting}
                hasError={Boolean(fieldErrors.display_name)}
              />
            )}
          </FormField>

          <FormField
            id="create-doctor-temp-password"
            label="Mật khẩu tạm ban đầu"
            required
            error={fieldErrors.temporary_password ?? null}
          >
            {(props) => (
              <div className="relative flex items-center">
                <Input
                  {...props}
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="new-password"
                  placeholder="Tối thiểu 12 ký tự"
                  value={temporaryPassword}
                  onChange={(e) => setTemporaryPassword(e.target.value)}
                  disabled={isSubmitting}
                  hasError={Boolean(fieldErrors.temporary_password)}
                  className="pr-12"
                />
                <button
                  type="button"
                  aria-label={showPassword ? 'Ẩn mật khẩu tạm' : 'Hiện mật khẩu tạm'}
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute top-1/2 right-1 inline-flex min-h-[40px] min-w-[40px] -translate-y-1/2 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-muted)] hover:text-[var(--text-primary)] cursor-pointer"
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

export interface EditDoctorNameModalProps {
  targetUser: AdminDoctorUserDto | null;
  isSubmitting: boolean;
  onClose: () => void;
  onSubmit: (userId: string, displayName: string) => Promise<void>;
}

export function EditDoctorNameModal({
  targetUser,
  isSubmitting,
  onClose,
  onSubmit,
}: EditDoctorNameModalProps) {
  const formId = React.useId();
  const nameInputRef = React.useRef<HTMLInputElement | null>(null);

  const [displayName, setDisplayName] = React.useState('');
  const [fieldError, setFieldError] = React.useState<string | null>(null);
  const [serverError, setServerError] = React.useState<{
    message: string;
    requestId: string | null;
  } | null>(null);

  React.useEffect(() => {
    if (targetUser) {
      setDisplayName(targetUser.display_name);
      setFieldError(null);
      setServerError(null);
    }
  }, [targetUser]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetUser) return;

    setFieldError(null);
    setServerError(null);

    const trimmed = displayName.trim();
    if (
      trimmed.length < DISPLAY_NAME_MIN_LENGTH ||
      trimmed.length > DISPLAY_NAME_MAX_LENGTH
    ) {
      setFieldError(
        `Họ và tên hiển thị phải từ ${DISPLAY_NAME_MIN_LENGTH} đến ${DISPLAY_NAME_MAX_LENGTH} ký tự.`,
      );
      return;
    }

    try {
      await onSubmit(targetUser.id, trimmed);
    } catch (error) {
      const normalized = normalizeApiError(error);
      const mapped = extractFieldErrors(error);
      if (mapped.display_name) {
        setFieldError(mapped.display_name);
      }
      setServerError({
        message: normalized.message,
        requestId: normalized.requestId,
      });
    }
  };

  return (
    <Modal
      open={Boolean(targetUser)}
      onClose={onClose}
      title="Chỉnh sửa tên hiển thị bác sĩ"
      description={
        targetUser ? `@${targetUser.username}` : undefined
      }
      size="sm"
      isSubmitting={isSubmitting}
      initialFocusRef={nameInputRef}
      footer={
        <>
          <Button variant="outline" disabled={isSubmitting} onClick={onClose}>
            Hủy
          </Button>
          <Button
            type="submit"
            form={formId}
            isLoading={isSubmitting}
            loadingText="Đang lưu..."
          >
            <Pencil className="size-4" aria-hidden="true" />
            Lưu thay đổi
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {serverError && (
          <Alert
            variant="error"
            title="Không thể cập nhật tài khoản"
            description={
              fieldError && fieldError.trim() === serverError.message.trim()
                ? undefined
                : serverError.message
            }
          >
            {serverError.requestId && (
              <span className="sr-only">
                Mã yêu cầu: {serverError.requestId}
              </span>
            )}
          </Alert>
        )}

        <form id={formId} onSubmit={handleSubmit} className="flex flex-col gap-3" noValidate>
          <FormField
            id="edit-doctor-display-name"
            label="Họ và tên hiển thị"
            required
            error={fieldError}
          >
            {(props) => (
              <Input
                {...props}
                ref={nameInputRef}
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                disabled={isSubmitting}
                hasError={Boolean(fieldError)}
              />
            )}
          </FormField>
        </form>
      </div>
    </Modal>
  );
}

export interface OneTimePasswordModalProps {
  secret: OneTimeSecretInfo | null;
  onClose: () => void;
}

export function OneTimePasswordModal({
  secret,
  onClose,
}: OneTimePasswordModalProps) {
  const { pushToast } = useToast();
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    setCopied(false);
  }, [secret]);

  const handleCopy = async () => {
    if (!secret) return;
    if (
      !navigator.clipboard ||
      typeof navigator.clipboard.writeText !== 'function'
    ) {
      setCopied(false);
      pushToast({
        variant: 'warning',
        title: 'Trình duyệt không hỗ trợ tự động sao chép',
        description:
          'Vui lòng bôi đen và sao chép thủ công mật khẩu tạm hiển thị bên dưới.',
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(secret.temporaryPassword);
      setCopied(true);
      pushToast({
        variant: 'success',
        title: 'Đã sao chép mật khẩu tạm',
        description: `Đã sao chép mật khẩu tạm cho @${secret.username}.`,
      });
    } catch {
      setCopied(false);
      pushToast({
        variant: 'warning',
        title: 'Không thể tự động sao chép',
        description:
          'Vui lòng bôi đen và sao chép thủ công mật khẩu tạm hiển thị bên dưới.',
      });
    }
  };

  return (
    <Modal
      open={Boolean(secret)}
      onClose={onClose}
      title={
        secret?.mode === 'create'
          ? 'Đã tạo tài khoản bác sĩ — Mật khẩu tạm một lần'
          : 'Đã đặt lại mật khẩu tạm — Hiển thị một lần'
      }
      description={
        secret
          ? `Tài khoản bác sĩ: ${secret.displayName} (@${secret.username})`
          : undefined
      }
      size="md"
      footer={
        <Button variant="primary" onClick={onClose}>
          Đã ghi nhận, đóng hộp thoại
        </Button>
      }
    >
      {secret && (
        <div className="flex flex-col gap-4">
          <Alert
            variant="warning"
            title="Chỉ hiển thị duy nhất một lần"
            description="Mật khẩu tạm này không được lưu trong trình duyệt và không thể xem lại sau khi đóng hộp thoại. Bác sĩ sẽ buộc phải đổi mật khẩu mới ở lần đăng nhập kế tiếp."
          />

          <div className="flex flex-col gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-muted)] p-4">
            <div className="flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
              <KeyRound className="size-4" aria-hidden="true" />
              <span>Mật khẩu tạm cho @{secret.username}</span>
            </div>
            <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
              <code
                data-testid="one-time-temp-password"
                className="flex min-h-[40px] min-w-0 flex-1 items-center rounded-md border border-[var(--border-default)] bg-[var(--bg-surface)] px-3 py-2 font-mono text-sm font-semibold text-[var(--text-primary)] select-all break-all"
              >
                {secret.temporaryPassword}
              </code>
              <Button
                variant="outline"
                size="md"
                className="h-10 min-h-[40px] shrink-0"
                onClick={() => void handleCopy()}
              >
                {copied ? (
                  <>
                    <Check className="size-4" aria-hidden="true" />
                    Đã sao chép
                  </>
                ) : (
                  <>
                    <Copy className="size-4" aria-hidden="true" />
                    Sao chép mật khẩu tạm
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
