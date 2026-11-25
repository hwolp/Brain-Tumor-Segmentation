import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, RotateCcw, Search } from 'lucide-react';
import { useAuthStore } from '@/app/auth-store';
import {
  fetchAdminJobDetail,
  fetchAdminJobs,
  retryAdminJob,
} from '@/shared/api/endpoints';
import { normalizeApiError, normalizeErrorCode } from '@/shared/api/errors';
import { useQueryErrorToast } from '@/shared/api/useQueryErrorToast';
import type { AdminJobAttemptDto, AdminJobDto } from '@/shared/api/types';
import { formatDateTimeVN } from '@/shared/lib/datetime';
import { useUrlListParams } from '@/shared/lib/urlQuery';
import {
  Alert,
  Button,
  ConfirmDialog,
  DataTable,
  type DataTableColumn,
  Input,
  Modal,
  Pagination,
  Select,
  StatusBadge,
  type StatusTone,
  useToast,
} from '@/shared/ui';
import {
  formatJobErrorReason,
  formatJobStage,
  getJobStateMeta,
} from '@/features/cases/statusMappings';

function getAttemptStateMeta(state: AdminJobAttemptDto['state']): {
  label: string;
  tone: StatusTone;
} {
  switch (state) {
    case 'running':
      return { label: 'Đang xử lý', tone: 'info' };
    case 'succeeded':
      return { label: 'Hoàn tất', tone: 'success' };
    case 'expired':
      return { label: 'Hết hạn phiên', tone: 'warning' };
    case 'failed':
    default:
      return { label: 'Thất bại', tone: 'error' };
  }
}

function describeJobErrorCode(errorCode: string): string {
  const mappedCode =
    errorCode.trim().toLowerCase() === 'lease_expired'
      ? 'worker_lease_expired'
      : errorCode;
  return formatJobErrorReason(mappedCode);
}

export function AdminJobsPage() {
  const user = useAuthStore((s) => s.user);
  const fixtureMode = useAuthStore((s) => s.fixtureMode);
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [detailJobId, setDetailJobId] = React.useState<string | null>(null);
  const [retryTarget, setRetryTarget] = React.useState<AdminJobDto | null>(null);
  const {
    q,
    page,
    pageSize,
    status,
    searchInput,
    setSearchInput,
    setPage,
    setStatus,
    resetFilters,
  } = useUrlListParams('all');

  const jobsQuery = useQuery({
    queryKey: [
      'admin',
      user?.id ?? 'anon',
      'jobs',
      { q, status, page, pageSize, fixtureMode },
    ],
    queryFn: ({ signal }) =>
      fetchAdminJobs({ q, status, page, pageSize }, { signal, fixtureMode }),
    refetchInterval: (query) =>
      query.state.data?.items.some(
        (job) => job.state === 'queued' || job.state === 'running',
      )
        ? 15000
        : false,
    refetchIntervalInBackground: false,
  });

  const detailQuery = useQuery({
    queryKey: [
      'admin',
      user?.id ?? 'anon',
      'job-detail',
      detailJobId,
      { fixtureMode },
    ],
    queryFn: ({ signal }) =>
      fetchAdminJobDetail(detailJobId!, { signal, fixtureMode }),
    enabled: Boolean(detailJobId),
  });

  const retryMutation = useMutation({
    mutationFn: (jobId: string) => retryAdminJob(jobId, { fixtureMode }),
    onSuccess: async (job) => {
      setRetryTarget(null);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['admin', user?.id ?? 'anon', 'jobs'],
        }),
        queryClient.invalidateQueries({
          queryKey: ['admin', user?.id ?? 'anon', 'overview'],
        }),
        queryClient.invalidateQueries({
          queryKey: ['admin', user?.id ?? 'anon', 'audit-events'],
        }),
      ]);
      pushToast({
        variant: 'success',
        title: 'Đã tạo job thử lại',
        description: `Job mới ${job.id} đã được đưa vào hàng đợi kỹ thuật.`,
      });
      setDetailJobId(job.id);
    },
    onError: (error) => {
      setRetryTarget(null);
      const normalized = normalizeApiError(error);
      const code = normalizeErrorCode(normalized.code);
      pushToast({
        variant: 'error',
        title: 'Không thể gửi lại job',
        description: normalized.message,
        requestId: normalized.requestId,
      });
      if (code === 'job_not_retryable' || code === 'active_job_conflict') {
        void jobsQuery.refetch();
      }
    },
  });

  useQueryErrorToast(
    jobsQuery.error,
    'Không thể tải danh sách tác vụ kỹ thuật',
  );
  useQueryErrorToast(detailQuery.error, 'Không thể tải chi tiết job');

  React.useEffect(() => {
    if (!jobsQuery.data || jobsQuery.isFetching) return;
    const { total, page_size } = jobsQuery.data;
    const effectivePageSize = page_size > 0 ? page_size : pageSize;
    if (total > 0) {
      const maxPage = Math.ceil(total / effectivePageSize);
      if (page > maxPage) {
        setPage(maxPage);
      }
    }
  }, [jobsQuery.data, jobsQuery.isFetching, page, pageSize, setPage]);

  const columns: DataTableColumn<AdminJobDto>[] = [
    {
      key: 'id',
      header: 'Job ID',
      cellClassName: 'whitespace-nowrap',
      cell: (row) => (
        <span title={row.id} className="block max-w-[96px] truncate font-mono text-xs">
          {row.id}
        </span>
      ),
    },
    {
      key: 'doctor_username',
      header: 'Tài khoản gửi',
      cellClassName: 'whitespace-nowrap',
      cell: (row) => (
        <span
          title={`@${row.doctor_username}`}
          className="block max-w-[116px] truncate font-mono text-xs"
        >
          @{row.doctor_username}
        </span>
      ),
    },
    {
      key: 'model_version',
      header: 'Model',
      cellClassName: 'whitespace-nowrap',
      cell: (row) => (
        <span
          title={row.model_version}
          className="block max-w-[110px] truncate font-mono text-xs"
        >
          {row.model_version}
        </span>
      ),
    },
    {
      key: 'state',
      header: 'Trạng thái',
      cell: (row) => {
        const meta = getJobStateMeta(row.state);
        return (
          <div className="flex flex-col items-start gap-0.5">
            <StatusBadge label={meta.label} tone={meta.tone} />
            <span className="text-[11px] text-[var(--text-secondary)]">
              {formatJobStage(row.stage)}
            </span>
            {row.error_code && (
              <span
                title={row.error_code}
                className="block max-w-[160px] truncate font-mono text-[11px] text-[var(--status-error)]"
              >
                {row.error_code}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: 'attempt_count',
      header: 'Lượt thử',
      align: 'right',
      cellClassName: 'whitespace-nowrap',
      cell: (row) => <span className="tabular-nums">{row.attempt_count}</span>,
    },
    {
      key: 'created_at',
      header: 'Thời gian tạo',
      cellClassName: 'whitespace-nowrap',
      cell: (row) => (
        <span className="text-xs tabular-nums">{formatDateTimeVN(row.created_at)}</span>
      ),
    },
    {
      key: 'actions',
      header: 'Thao tác',
      align: 'right',
      cellClassName: 'whitespace-nowrap',
      cell: (row) => (
        <div className="flex flex-nowrap items-center justify-end gap-1.5 whitespace-nowrap">
          <Button
            variant="outline"
            size="xs"
            onClick={() => setDetailJobId(row.id)}
          >
            Chi tiết
          </Button>
          {row.state === 'failed' && (
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                retryMutation.reset();
                setRetryTarget(row);
              }}
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
              Gửi lại
            </Button>
          )}
        </div>
      ),
    },
  ];

  const retryNormalizedError = retryMutation.error
    ? normalizeApiError(retryMutation.error)
    : null;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-[1.75rem] leading-[1.08] font-normal text-[var(--color-ink)]">
          Quản lý tác vụ AI
        </h1>

        <Button
          variant="outline"
          isLoading={jobsQuery.isFetching}
          loadingText="Đang làm mới..."
          onClick={() => {
            void jobsQuery.refetch();
          }}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          Làm mới
        </Button>
      </div>

      {retryNormalizedError && (
        <Alert
          variant="error"
          title="Không thể gửi lại job"
          description={retryNormalizedError.message}
        >
          {retryNormalizedError.requestId && (
            <span className="sr-only">
              Mã yêu cầu: {retryNormalizedError.requestId}
            </span>
          )}
        </Alert>
      )}

      <div className="refract-panel flex flex-col items-stretch gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative min-w-0 flex-1 sm:min-w-[220px]">
          <label htmlFor="admin-job-search" className="sr-only">
            Tìm theo Job ID hoặc username bác sĩ
          </label>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--text-muted)]"
            aria-hidden="true"
          />
          <Input
            id="admin-job-search"
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Tìm mã tác vụ hoặc username bác sĩ"
            className="pl-9"
          />
        </div>

        <div className="w-full sm:w-48">
          <label htmlFor="admin-job-state" className="sr-only">
            Lọc trạng thái job
          </label>
          <Select
            id="admin-job-state"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="all">Tất cả trạng thái</option>
            <option value="queued">Đang chờ</option>
            <option value="running">Đang xử lý</option>
            <option value="succeeded">Hoàn tất</option>
            <option value="failed">Thất bại</option>
            <option value="cancelled">Đã hủy</option>
          </Select>
        </div>

        {(q || status !== 'all' || page > 1) && (
          <Button
            variant="outline"
            size="md"
            className="h-10 min-h-[40px] w-full sm:w-auto"
            onClick={resetFilters}
          >
            Xóa bộ lọc
          </Button>
        )}
      </div>

      <DataTable
        caption="Danh sách metadata tác vụ kỹ thuật"
        columns={columns}
        data={jobsQuery.data?.items ?? []}
        rowKey={(row) => row.id}
        isLoading={jobsQuery.isPending}
        error={jobsQuery.error}
        onRetry={() => void jobsQuery.refetch()}
        emptyTitle="Chưa có tác vụ nào"
        emptyDescription="Không có job kỹ thuật nào khớp điều kiện lọc."
      />

      {jobsQuery.data && (
        <Pagination
          page={page}
          pageSize={jobsQuery.data.page_size}
          total={jobsQuery.data.total}
          onPageChange={setPage}
        />
      )}

      <ConfirmDialog
        open={Boolean(retryTarget)}
        onClose={() => {
          if (!retryMutation.isPending) setRetryTarget(null);
        }}
        onConfirm={() => {
          if (retryTarget) retryMutation.mutate(retryTarget.id);
        }}
        title="Gửi lại tác vụ thất bại?"
        description={
          retryTarget
            ? `Tạo một job mới cho ca ${retryTarget.case_id}. Hệ thống kiểm tra lại tài khoản bác sĩ và các xung đầu vào trước khi đưa vào hàng đợi.`
            : ''
        }
        confirmLabel="Tạo job mới"
        isSubmitting={retryMutation.isPending}
      />

      <Modal
        open={Boolean(detailJobId)}
        onClose={() => setDetailJobId(null)}
        title="Chi tiết tác vụ kỹ thuật"
        size="lg"
      >
        {detailQuery.isPending && <p className="text-sm">Đang tải chi tiết...</p>}
        {detailQuery.isError && (
          <Alert
            variant="error"
            title="Không thể tải chi tiết"
            description={normalizeApiError(detailQuery.error).message}
          />
        )}
        {detailQuery.data && (
          <div className="flex flex-col gap-4 text-sm">
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div><dt className="text-xs text-[var(--text-secondary)]">Job ID</dt><dd className="break-all font-mono">{detailQuery.data.id}</dd></div>
              <div><dt className="text-xs text-[var(--text-secondary)]">Tài khoản bác sĩ</dt><dd className="font-mono">@{detailQuery.data.doctor_username}</dd></div>
              <div><dt className="text-xs text-[var(--text-secondary)]">Case ID</dt><dd className="break-all font-mono">{detailQuery.data.case_id}</dd></div>
              <div><dt className="text-xs text-[var(--text-secondary)]">Model</dt><dd className="font-mono">{detailQuery.data.model_version}</dd></div>
              <div>
                <dt className="text-xs text-[var(--text-secondary)]">Trạng thái</dt>
                <dd className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  {(() => {
                    const meta = getJobStateMeta(detailQuery.data.state);
                    return <StatusBadge label={meta.label} tone={meta.tone} />;
                  })()}
                  <span className="text-[var(--text-secondary)]">
                    · {formatJobStage(detailQuery.data.stage)}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-xs text-[var(--text-secondary)]">Mã lỗi</dt>
                <dd>
                  {detailQuery.data.error_code ? (
                    <div className="flex flex-col gap-0.5">
                      <span className="font-mono">{detailQuery.data.error_code}</span>
                      <span className="text-xs text-[var(--text-secondary)]">
                        {describeJobErrorCode(detailQuery.data.error_code)}
                      </span>
                    </div>
                  ) : (
                    <span className="font-mono">—</span>
                  )}
                </dd>
              </div>
            </dl>
            <section>
              <h2 className="mb-2 font-semibold">Lịch sử attempt ({detailQuery.data.attempts.length})</h2>
              {detailQuery.data.attempts.length === 0 ? (
                <p className="text-[var(--text-secondary)]">Worker chưa nhận job.</p>
              ) : (
                <ol className="flex flex-col gap-2">
                  {detailQuery.data.attempts.map((attempt) => {
                    const attemptMeta = getAttemptStateMeta(attempt.state);
                    return (
                      <li key={attempt.id} className="rounded-md border border-[var(--border-default)] p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-mono">Attempt {attempt.attempt_number} · {attempt.worker_id}</p>
                          <StatusBadge label={attemptMeta.label} tone={attemptMeta.tone} />
                        </div>
                        <p className="mt-1 text-xs text-[var(--text-secondary)]">
                          {attemptMeta.label} · {formatJobStage(attempt.stage)} · {formatDateTimeVN(attempt.started_at)}
                        </p>
                        {attempt.error_code && (
                          <p className="mt-1 text-xs text-[var(--text-secondary)]">
                            <span className="font-mono text-[var(--text-primary)]">
                              Lỗi: {attempt.error_code}
                            </span>
                            {' — '}
                            <span>{describeJobErrorCode(attempt.error_code)}</span>
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
          </div>
        )}
      </Modal>
    </div>
  );
}
