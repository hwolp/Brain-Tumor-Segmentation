import { Link } from 'react-router-dom';
import { ArrowLeft, FileQuestion } from 'lucide-react';
import { getDefaultRouteForUser, useAuthStore } from '@/app/auth-store';
import { buttonVariants } from '@/shared/ui';

export function NotFoundPage() {
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
      <section className="flex w-full max-w-lg flex-col items-start gap-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-6 shadow-sm sm:p-8">
        <div className="flex items-center gap-3">
          <div className="flex size-12 items-center justify-center rounded-full bg-[var(--bg-muted)] text-[var(--text-secondary)]">
            <FileQuestion className="size-6" aria-hidden="true" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
              Mã lỗi 404
            </p>
            <h1 className="text-xl font-bold text-[var(--text-primary)]">
              Không tìm thấy trang yêu cầu
            </h1>
          </div>
        </div>

        <p className="text-sm text-[var(--text-secondary)]">
          Đường dẫn bạn vừa mở không tồn tại hoặc đã được di chuyển.
        </p>

        <Link to={backPath} className={buttonVariants({ variant: 'primary' })}>
          <ArrowLeft className="size-4" aria-hidden="true" />
          {backLabel}
        </Link>
      </section>
    </main>
  );
}
