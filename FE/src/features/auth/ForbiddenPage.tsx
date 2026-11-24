import { Link } from 'react-router-dom';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import { getDefaultRouteForUser, useAuthStore } from '@/app/auth-store';
import { buttonVariants, RefractLightCanvas } from '@/shared/ui';

export function ForbiddenPage() {
  const user = useAuthStore((s) => s.user);
  const backPath = getDefaultRouteForUser(user);
  const backLabel =
    user?.role === 'admin'
      ? 'Quay lại khu vực Quản trị'
      : user?.role === 'doctor'
        ? 'Quay lại khu vực Bác sĩ'
        : 'Về trang đăng nhập';

  return (
    <main className="relative isolate flex min-h-dvh items-center justify-center overflow-x-clip bg-[var(--color-paper)] p-6">
      <RefractLightCanvas variant="glass" />
      <section
        role="alert"
        className="refract-panel-lead relative z-10 flex w-full max-w-lg flex-col items-start gap-4 p-6 sm:p-8"
      >
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-[var(--radius-pill)] border border-[var(--status-error-border)] bg-[var(--status-error-bg)] text-[var(--status-error)]">
            <ShieldAlert className="size-5" aria-hidden="true" />
          </div>
          <div>
            <p className="font-mono text-xs font-medium text-[var(--status-error)]">
              Mã lỗi 403
            </p>
            <h1 className="font-display text-2xl font-normal text-[var(--color-ink)]">
              Không có quyền truy cập
            </h1>
          </div>
        </div>

        <p className="text-sm text-[var(--text-secondary)]">
          Vai trò tài khoản hiện tại của bạn không được phép truy cập đường dẫn này. Nếu bạn cần hỗ trợ phân quyền, vui lòng liên hệ quản trị viên hệ thống.
        </p>

        <Link to={backPath} className={buttonVariants({ variant: 'primary' })}>
          <ArrowLeft className="size-4" aria-hidden="true" />
          {backLabel}
        </Link>
      </section>
    </main>
  );
}
