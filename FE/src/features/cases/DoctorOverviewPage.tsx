import * as React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  Eye,
  FileStack,
  Search,
  X,
} from 'lucide-react';
import { useAuthStore } from '@/app/auth-store';
import { fetchDoctorCasesOverview } from '@/shared/api/endpoints';
import { useQueryErrorToast } from '@/shared/api/useQueryErrorToast';
import type { CaseDto } from '@/shared/api/types';
import { formatDateTimeVN, formatStudyDate } from '@/shared/lib/datetime';
import {
  Button,
  DataTable,
  type DataTableColumn,
  Input,
  Select,
  StatusBadge,
  buttonVariants,
} from '@/shared/ui';
import {
  getCaseReadinessMeta,
  getJobStateMeta,
} from '@/features/cases/statusMappings';

export function DoctorOverviewPage() {
  const user = useAuthStore((s) => s.user);
  const fixtureMode = useAuthStore((s) => s.fixtureMode);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState('all');

  const casesQuery = useQuery({
    queryKey: [
      'doctor',
      user?.id ?? 'anon',
      'cases-overview',
      { fixtureMode },
    ],
    queryFn: ({ signal }) =>
      fetchDoctorCasesOverview({ signal, fixtureMode }),
  });

  useQueryErrorToast(casesQuery.error, 'Không thể tải tổng quan ca chụp');

  const items = casesQuery.data?.items ?? [];
  const isStatsUnavailable = casesQuery.isPending || casesQuery.isError;
  const readyCount = items.filter((c) => c.readiness === 'ready').length;
  const missingCount = items.filter(
    (c) => c.readiness === 'missing_inputs',
  ).length;
  const activeJobsCount = items.filter(
    (c) =>
      c.latest_job_state === 'queued' || c.latest_job_state === 'running',
  ).length;

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const hasActiveFilters = Boolean(normalizedQuery || statusFilter !== 'all');
  const filteredItems = items.filter((row) => {
    if (normalizedQuery) {
      const code = (row.patient_code ?? row.patient_id).toLowerCase();
      const dateStr = formatStudyDate(row.study_date).toLowerCase();
      const rawDate = row.study_date.toLowerCase();
      const notes = (row.notes ?? '').toLowerCase();
      if (
        !code.includes(normalizedQuery) &&
        !dateStr.includes(normalizedQuery) &&
        !rawDate.includes(normalizedQuery) &&
        !notes.includes(normalizedQuery)
      ) {
        return false;
      }
    }
    if (statusFilter === 'ready') {
      return row.readiness === 'ready';
    }
    if (statusFilter === 'missing_inputs') {
      return row.readiness === 'missing_inputs';
    }
    if (statusFilter === 'active_job') {
      return (
        row.latest_job_state === 'queued' || row.latest_job_state === 'running'
      );
    }
    if (statusFilter === 'invalid') {
      return row.readiness === 'invalid';
    }
    return true;
  });

  const columns: DataTableColumn<CaseDto>[] = [
    {
      key: 'patient_code',
      header: 'Mã BN',
      cell: (row) => (
        <Link
          to={`/doctor/patients/${row.patient_id}`}
          className="font-mono text-sm font-semibold text-[var(--action-primary)] hover:underline"
        >
          {row.patient_code ?? row.patient_id.slice(0, 8)}
        </Link>
      ),
    },
    {
      key: 'study_date',
      header: 'Ngày chụp',
      cell: (row) => (
        <span className="tabular-nums">{formatStudyDate(row.study_date)}</span>
      ),
    },
    {
      key: 'readiness',
      header: 'Dữ liệu MRI',
      cell: (row) => {
        const meta = getCaseReadinessMeta(row.readiness);
        return <StatusBadge label={meta.label} tone={meta.tone} />;
      },
    },
    {
      key: 'job_state',
      header: 'Tác vụ AI',
      cell: (row) => {
        if (!row.latest_job_state) {
          return <StatusBadge label="Chưa chạy AI" tone="neutral" />;
        }
        const meta = getJobStateMeta(row.latest_job_state);
        return <StatusBadge label={meta.label} tone={meta.tone} />;
      },
    },
    {
      key: 'updated_at',
      header: 'Cập nhật',
      cell: (row) => formatDateTimeVN(row.updated_at),
    },
    {
      key: 'actions',
      header: 'Thao tác',
      align: 'right',
      cell: (row) => (
        <div className="flex flex-nowrap items-center justify-end gap-1.5 whitespace-nowrap">
          <Link
            to={`/doctor/cases/${row.id}/viewer`}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            <Eye className="size-4" aria-hidden="true" />
            Mở Viewer
          </Link>
          <Link
            to={`/doctor/cases/${row.id}`}
            className={buttonVariants({ variant: 'primary', size: 'sm' })}
          >
            Chi tiết
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">
          Tổng quan ca chụp của tôi
        </h1>

        <Link
          to="/doctor/patients"
          className={buttonVariants({
            variant: 'primary',
            className: 'w-full sm:w-auto',
          })}
        >
          Danh sách bệnh nhân
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </div>

      <section
        aria-label="Chỉ số tổng quan"
        className="grid grid-cols-1 gap-4 md:grid-cols-3"
      >
        <div className="flex items-center gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-[var(--status-info-bg)] text-[var(--status-info)]">
            <FileStack className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-[var(--text-secondary)]">
              Tổng số ca gần đây
            </p>
            <p className="text-2xl font-bold tabular-nums">
              {isStatsUnavailable ? '—' : items.length}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-[var(--status-success-bg)] text-[var(--status-success)]">
            <CheckCircle2 className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-[var(--text-secondary)]">
              Đủ FLAIR + T1ce (Sẵn sàng)
            </p>
            <p className="text-2xl font-bold tabular-nums">
              {isStatsUnavailable ? '—' : readyCount}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-[var(--status-warning-bg)] text-[var(--status-warning)]">
            <Clock className="size-5" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="text-xs font-medium text-[var(--text-secondary)]">
              Thiếu xung / Đang xử lý
            </p>
            <p className="text-2xl font-bold tabular-nums">
              {isStatsUnavailable ? '—' : missingCount + activeJobsCount}
            </p>
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">
            Ca chụp gần đây
          </h2>
        </div>

        <div className="flex flex-col items-stretch gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-3.5 sm:flex-row sm:flex-wrap sm:items-center sm:p-4">
          <div className="relative min-w-0 flex-1 sm:max-w-md sm:min-w-[240px]">
            <label htmlFor="overview-case-search" className="sr-only">
              Tìm theo mã bệnh nhân hoặc ngày chụp
            </label>
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--text-secondary)]"
              aria-hidden="true"
            />
            <Input
              id="overview-case-search"
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Tìm theo mã bệnh nhân, ngày chụp..."
              className="pl-9 pr-10"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Xóa từ khóa tìm kiếm"
                className="absolute top-1/2 right-2.5 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-[var(--text-secondary)] hover:bg-[var(--bg-muted)] hover:text-[var(--text-primary)]"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            )}
          </div>

          <div className="w-full sm:w-56">
            <label htmlFor="overview-status-filter" className="sr-only">
              Lọc trạng thái ca chụp
            </label>
            <Select
              id="overview-status-filter"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="all">Tất cả trạng thái</option>
              <option value="ready">Đủ FLAIR + T1ce (Sẵn sàng)</option>
              <option value="missing_inputs">Thiếu xung MRI</option>
              <option value="active_job">Đang xử lý AI</option>
              <option value="invalid">Lỗi dữ liệu MRI</option>
            </Select>
          </div>

          {hasActiveFilters && (
            <Button
              type="button"
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => {
                setSearchQuery('');
                setStatusFilter('all');
              }}
            >
              Xóa lọc
            </Button>
          )}
        </div>

        <DataTable
          caption="Danh sách các ca chụp gần đây thuộc quyền bác sĩ"
          columns={columns}
          data={filteredItems}
          rowKey={(row) => row.id}
          isLoading={casesQuery.isPending}
          error={casesQuery.error}
          onRetry={() => {
            void casesQuery.refetch();
          }}
          emptyTitle="Chưa có ca chụp nào"
          emptyDescription={
            hasActiveFilters
              ? 'Không có ca chụp nào khớp với bộ lọc hiện tại.'
              : 'Hãy vào danh sách bệnh nhân để tạo hồ sơ và lần chụp MRI đầu tiên.'
          }
          emptyAction={
            hasActiveFilters ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setSearchQuery('');
                  setStatusFilter('all');
                }}
              >
                Xóa lọc
              </Button>
            ) : (
              <Link
                to="/doctor/patients"
                className={buttonVariants({ variant: 'primary' })}
              >
                Mở danh sách bệnh nhân
              </Link>
            )
          }
        />
      </section>
    </div>
  );
}
