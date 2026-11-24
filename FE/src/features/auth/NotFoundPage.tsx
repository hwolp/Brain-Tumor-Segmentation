import { Link } from 'react-router-dom';
import { ArrowLeft, FileQuestion } from 'lucide-react';
import { getDefaultRouteForUser, useAuthStore } from '@/app/auth-store';
import { buttonVariants, RefractLightCanvas } from '@/shared/ui';

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
    <main className="relative isolate flex min-h-dvh items-center justify-center overflow-x-clip bg-[var(--color-paper)] p-6">
      <RefractLightCanvas variant="glass" />
      <section className="refract-panel-lead relative z-10 flex w-full max-w-lg flex-col items-start gap-4 p-6 sm:p-8">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-[var(--radius-pill)] border border-[var(--color-rule)] bg-[var(--color-paper-2)] text-[var(--color-ink-2)]">
            <FileQuestion className="size-5" aria-hidden="true" />
          </div>
          <div>
            <p className="font-mono text-xs font-medium text-[var(--color-muted)]">
              Mã lỗi 404
            </p>
            <h1 className="font-display text-2xl font-normal text-[var(--color-ink)]">
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
