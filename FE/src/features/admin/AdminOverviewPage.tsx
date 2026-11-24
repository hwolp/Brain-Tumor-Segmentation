import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  Cpu,
  HardDrive,
  RefreshCw,
  Server,
  Users,
} from 'lucide-react';
import { useAuthStore } from '@/app/auth-store';
import { fetchAdminOverview } from '@/shared/api/endpoints';
import { useQueryErrorToast } from '@/shared/api/useQueryErrorToast';
import { formatDateTimeVN } from '@/shared/lib/datetime';
import {
  Alert,
  Button,
  CardSkeleton,
  ErrorState,
  StatusBadge,
} from '@/shared/ui';

function formatGiB(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export function AdminOverviewPage() {
  const user = useAuthStore((s) => s.user);
  const fixtureMode = useAuthStore((s) => s.fixtureMode);

  const overviewQuery = useQuery({
    queryKey: ['admin', user?.id ?? 'anon', 'overview', { fixtureMode }],
    queryFn: ({ signal }) => fetchAdminOverview({ signal, fixtureMode }),
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  useQueryErrorToast(
    overviewQuery.error,
    'Không thể tải tổng quan vận hành hệ thống',
  );

  const data = overviewQuery.data;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[1.75rem] leading-[1.08] font-normal text-[var(--color-ink)]">
            Tổng quan vận hành hệ thống
          </h1>
          {data && (
            <p className="mt-1 text-xs text-[var(--text-secondary)] tabular-nums">
              Cập nhật lúc: <strong className="font-medium">{formatDateTimeVN(data.overview.updated_at)}</strong>
            </p>
          )}
        </div>

        <Button
          variant="outline"
          isLoading={overviewQuery.isFetching}
          loadingText="Đang cập nhật..."
          onClick={() => {
            void overviewQuery.refetch();
          }}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          Làm mới số liệu
        </Button>
      </div>

      {overviewQuery.isPending && <CardSkeleton />}

      {overviewQuery.isError && !data && (
        <ErrorState
          title="Không thể tải thông số vận hành"
          error={overviewQuery.error}
          onRetry={() => {
            void overviewQuery.refetch();
          }}
        />
      )}

      {overviewQuery.isRefetchError && data && (
        <Alert
          variant="warning"
          title="Chưa làm mới được số liệu gần nhất"
          description="Đang hiển thị số liệu gần nhất đã tải được; hệ thống sẽ tự động thử lại."
        />
      )}

      {data && (
        <>
          <section
            aria-label="Chỉ số hệ thống"
            className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4"
          >
            <div className="refract-panel refract-panel-lift flex h-full flex-col justify-between gap-2 p-5">
              <div className="flex items-center justify-between text-xs font-medium text-[var(--color-muted)]">
                <span>Tài khoản bác sĩ</span>
                <Users className="size-4 text-[var(--color-muted)]" aria-hidden="true" />
              </div>
              <p className="refract-figure text-3xl text-[var(--color-ink)]">
                {`${data.overview.active_doctors} hoạt động`}
              </p>
              <p className="mt-auto text-xs text-[var(--color-ink-2)] tabular-nums">
                Đang khóa: {data.overview.locked_doctors}
              </p>
            </div>

            <div className="refract-panel refract-panel-lift flex h-full flex-col justify-between gap-2 p-5">
              <div className="flex items-center justify-between text-xs font-medium text-[var(--color-muted)]">
                <span>Tác vụ AI</span>
                <Cpu className="size-4 text-[var(--color-muted)]" aria-hidden="true" />
              </div>
              <p className="refract-figure text-3xl text-[var(--color-ink)]">
                {`${data.overview.queued_jobs + data.overview.running_jobs} đang xử lý`}
              </p>
              <p className="mt-auto text-xs text-[var(--color-ink-2)] tabular-nums">
                Chờ: {data.overview.queued_jobs} · Lỗi: {data.overview.failed_jobs}
              </p>
            </div>

            {(() => {
              const storagePercent =
                data.overview.storage_quota_bytes > 0
                  ? Math.min(
                      100,
                      Math.max(
                        0,
                        Math.round(
                          (data.overview.storage_used_bytes /
                            data.overview.storage_quota_bytes) *
                            100,
                        ),
                      ),
                    )
                  : 0;
              return (
                <div className="refract-panel refract-panel-lift flex h-full flex-col justify-between gap-2 p-5">
                  <div className="flex items-center justify-between text-xs font-medium text-[var(--color-muted)]">
                    <span>Dung lượng cục bộ</span>
                    <HardDrive className="size-4 text-[var(--color-muted)]" aria-hidden="true" />
                  </div>
                  <p className="refract-figure text-3xl text-[var(--color-ink)]">
                    {formatGiB(data.overview.storage_used_bytes)}
                  </p>
                  <div className="mt-auto flex flex-col gap-2">
                    <div
                      role="progressbar"
                      aria-label="Mức sử dụng dung lượng cục bộ"
                      aria-valuenow={storagePercent}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      className="h-2 w-full overflow-hidden rounded-[var(--radius-pill)] bg-[var(--color-paper-2)]"
                    >
                      <div
                        className="h-full w-full origin-left rounded-[var(--radius-pill)] bg-[var(--color-accent)] transition-transform duration-300 ease-[var(--ease-out)]"
                        style={{ transform: `scaleX(${storagePercent / 100})` }}
                      />
                    </div>
                    <p className="text-xs text-[var(--color-ink-2)] tabular-nums">
                      Hạn mức: {formatGiB(data.overview.storage_quota_bytes)} ({storagePercent}%)
                    </p>
                  </div>
                </div>
              );
            })()}

            <div className="refract-panel refract-panel-lift flex h-full flex-col justify-between gap-2 p-5">
              <div className="flex items-center justify-between text-xs font-medium text-[var(--color-muted)]">
                <span>Trạng thái Worker</span>
                <Activity className="size-4 text-[var(--color-muted)]" aria-hidden="true" />
              </div>
              <div className="pt-1">
                <StatusBadge
                  label={
                    data.overview.worker_online
                      ? 'Worker trực tuyến'
                      : 'Worker ngoại tuyến'
                  }
                  tone={data.overview.worker_online ? 'success' : 'warning'}
                />
              </div>
              <p className="mt-auto text-xs text-[var(--color-ink-2)] tabular-nums">
                Ngưỡng heartbeat: 90 giây
              </p>
            </div>
          </section>

          <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="refract-panel p-5 sm:p-6">
              <div className="mb-4 flex items-center gap-2 border-b border-[var(--color-rule)] pb-3">
                <Server className="size-4 text-[var(--color-muted)]" aria-hidden="true" />
                <h2 className="font-display text-lg font-normal text-[var(--color-ink)]">Danh sách Worker</h2>
              </div>
              {data.workers.length === 0 ? (
                <p className="text-sm text-[var(--color-ink-2)]">
                  Chưa ghi nhận worker nào đăng ký heartbeat.
                </p>
              ) : (
                <ul className="divide-y divide-[var(--color-rule)] text-sm">
                  {data.workers.map((w) => (
                    <li
                      key={w.worker_id}
                      className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0"
                    >
                      <div>
                        <p className="font-mono font-medium text-[var(--color-ink)]">{w.worker_id}</p>
                        <p className="text-xs text-[var(--color-ink-2)] tabular-nums">
                          Thiết bị: {w.device_type} · Model: {w.model_version} · Đang chạy: {w.active_jobs} · Heartbeat:{' '}
                          {formatDateTimeVN(w.last_heartbeat_at)}
                        </p>
                      </div>
                      <StatusBadge
                        label={w.online ? 'Trực tuyến' : 'Ngoại tuyến'}
                        tone={w.online ? 'success' : 'warning'}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="refract-panel p-5 sm:p-6">
              <div className="mb-4 flex items-center gap-2 border-b border-[var(--color-rule)] pb-3">
                <Cpu className="size-4 text-[var(--color-muted)]" aria-hidden="true" />
                <h2 className="font-display text-lg font-normal text-[var(--color-ink)]">
                  Mô hình AI
                </h2>
              </div>
              {data.models.length === 0 ? (
                <p className="text-sm text-[var(--color-ink-2)]">
                  Chưa có model manifest nào được đăng ký.
                </p>
              ) : (
                <ul className="divide-y divide-[var(--color-rule)] text-sm">
                  {data.models.map((m) => (
                    <li
                      key={m.id}
                      className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">
                          {m.name} {/^\d/.test(m.version) ? `v${m.version}` : `· ${m.version}`}
                        </span>
                        <StatusBadge
                          label={m.is_active ? 'Đang kích hoạt' : 'Chưa kích hoạt'}
                          tone={m.is_active ? 'success' : 'neutral'}
                        />
                      </div>
                      <p className="font-mono text-xs text-[var(--text-secondary)] tabular-nums">
                        Input: {m.expected_shape.join('×')} · Spacing:{' '}
                        {m.expected_spacing_mm.join('×')} mm
                      </p>
                      <p className="truncate font-mono text-xs text-[var(--text-secondary)]">
                        SHA-256: {m.checkpoint_sha256}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
