import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, Stethoscope, UserCircle } from 'lucide-react';
import { useAuthStore } from '@/app/auth-store';
import { apiRequest } from '@/shared/api/client';
import type { UserDto } from '@/shared/api/types';
import { useQueryErrorToast } from '@/shared/api/useQueryErrorToast';
import { formatDateTimeVN } from '@/shared/lib/datetime';
import { StatusBadge, buttonVariants } from '@/shared/ui';

export function DoctorProfilePage() {
  const user = useAuthStore((s) => s.user);
  const status = useAuthStore((s) => s.status);
  const fixtureMode = useAuthStore((s) => s.fixtureMode);
  const reauthRequired = useAuthStore((s) => s.reauthRequired);

  const meQuery = useQuery({
    queryKey: ['auth', user?.id ?? 'anon', 'me', { fixtureMode }],
    queryFn: ({ signal }) =>
      apiRequest<UserDto>('/auth/me', {
        method: 'GET',
        signal,
      }),
    enabled:
      !fixtureMode &&
      status === 'authenticated' &&
      !reauthRequired &&
      Boolean(user),
  });

  useQueryErrorToast(meQuery.error, 'Không thể tải thông tin tài khoản');

  const profile =
    meQuery.data && typeof meQuery.data.username === 'string'
      ? meQuery.data
      : user;

  return (
    <div className="flex max-w-2xl flex-col gap-5">
      <h1 className="font-display text-[1.75rem] leading-[1.08] font-normal text-[var(--color-ink)]">
        Tài khoản cá nhân
      </h1>

      <section className="refract-panel flex flex-col gap-4 p-6">
        <div className="flex items-center gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-pill)] border border-[var(--color-rule)] bg-[var(--color-paper-2)] text-[var(--color-accent)]">
            <UserCircle className="size-6" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <h2 className="font-display truncate text-lg font-normal text-[var(--color-ink)]">
              {profile?.display_name ?? 'Bác sĩ'}
            </h2>
            <p className="truncate text-sm text-[var(--color-ink-2)]">
              Tên đăng nhập:{' '}
              <span className="font-mono">@{profile?.username ?? '—'}</span>
            </p>
          </div>
        </div>

        <dl className="grid grid-cols-1 gap-3 border-t border-[var(--color-rule)] pt-4 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-xs text-[var(--text-secondary)]">Vai trò</dt>
            <dd className="mt-1">
              <StatusBadge
                label="Bác sĩ chuyên khoa"
                tone="info"
                icon={<Stethoscope className="size-3.5 shrink-0" aria-hidden="true" />}
              />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-[var(--text-secondary)]">
              Trạng thái tài khoản
            </dt>
            <dd className="mt-1 flex flex-wrap gap-1.5">
              <StatusBadge
                label={profile?.is_active !== false ? 'Đang hoạt động' : 'Đã khóa'}
                tone={profile?.is_active !== false ? 'success' : 'error'}
              />
              {profile?.must_change_password && (
                <StatusBadge label="Cần đổi mật khẩu" tone="warning" />
              )}
            </dd>
          </div>
          {profile?.id && (
            <div>
              <dt className="text-xs text-[var(--text-secondary)]">
                Mã tài khoản kỹ thuật
              </dt>
              <dd className="mt-1 break-all font-mono text-xs text-[var(--text-secondary)]">
                {profile.id}
              </dd>
            </div>
          )}
          {profile?.created_at && (
            <div>
              <dt className="text-xs text-[var(--text-secondary)]">Ngày tạo</dt>
              <dd className="mt-1 text-sm text-[var(--text-primary)]">
                {formatDateTimeVN(profile.created_at)}
              </dd>
            </div>
          )}
        </dl>

        <div className="border-t border-[var(--border-default)] pt-4">
          <Link
            to="/change-password"
            className={buttonVariants({ variant: 'outline' })}
          >
            <KeyRound className="size-4" aria-hidden="true" />
            Đổi mật khẩu tài khoản
          </Link>
        </div>
      </section>
    </div>
  );
}
