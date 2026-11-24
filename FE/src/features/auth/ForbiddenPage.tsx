import { Link } from 'react-router-dom';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import { getDefaultRouteForUser, useAuthStore } from '@/app/auth-store';
import { buttonVariants } from '@/shared/ui';

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
    <main className="flex min-h-dvh items-center justify-center bg-[var(--bg-canvas)] p-6">
      <section
        role="alert"
        className="flex w-full max-w-lg flex-col items-start gap-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-6 shadow-sm sm:p-8"
      >
        <div className="flex items-center gap-3">
          <div className="flex size-12 items-center justify-center rounded-full bg-[var(--status-error-bg)] text-[var(--status-error)]">
            <ShieldAlert className="size-6" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--status-error)]">
              Mã lỗi 403
            </p>
            <h1 className="text-xl font-bold text-[var(--text-primary)]">
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
