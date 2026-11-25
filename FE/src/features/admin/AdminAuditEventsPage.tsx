import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, Search } from 'lucide-react';
import { useAuthStore } from '@/app/auth-store';
import { fetchAdminAuditEvents } from '@/shared/api/endpoints';
import { useQueryErrorToast } from '@/shared/api/useQueryErrorToast';
import type { AuditEventDto } from '@/shared/api/types';
import { formatDateTimeVN } from '@/shared/lib/datetime';
import { useUrlListParams } from '@/shared/lib/urlQuery';
import {
  Button,
  DataTable,
  type DataTableColumn,
  Input,
  Pagination,
  StatusBadge,
} from '@/shared/ui';

const AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = {
  'admin.user.create': 'Tạo tài khoản bác sĩ',
  'admin.user_create': 'Tạo tài khoản bác sĩ',
  'admin.user.update': 'Cập nhật tài khoản bác sĩ',
  'admin.user_update': 'Cập nhật tài khoản bác sĩ',
  'admin.user.enable': 'Mở khóa tài khoản bác sĩ',
  'admin.user_enable': 'Mở khóa tài khoản bác sĩ',
  'admin.user.unlock': 'Mở khóa tài khoản bác sĩ',
  'admin.user_unlock': 'Mở khóa tài khoản bác sĩ',
  'admin.user.disable': 'Khóa tài khoản bác sĩ',
  'admin.user_disable': 'Khóa tài khoản bác sĩ',
  'admin.user.lock': 'Khóa tài khoản bác sĩ',
  'admin.user_lock': 'Khóa tài khoản bác sĩ',
  'admin.user.reset_password': 'Đặt lại mật khẩu tạm',
  'admin.user_reset_password': 'Đặt lại mật khẩu tạm',
  'admin.settings.update': 'Cập nhật cấu hình vận hành',
  'admin.settings_update': 'Cập nhật cấu hình vận hành',
  'admin.job.retry': 'Gửi lại tác vụ AI',
  'admin.job_retry': 'Gửi lại tác vụ AI',
  'job.retry': 'Gửi lại tác vụ AI',
  'job.create': 'Tạo tác vụ phân đoạn AI',
  'job.cancel': 'Hủy tác vụ phân đoạn AI',
  'job.complete': 'Hoàn tất tác vụ phân đoạn AI',
  'job.fail': 'Tác vụ phân đoạn AI thất bại',
  'auth.login': 'Đăng nhập hệ thống',
  'auth.login_rate_limited': 'Giới hạn tần suất đăng nhập',
  'auth.logout': 'Đăng xuất hệ thống',
  'auth.refresh': 'Làm mới phiên đăng nhập',
  'auth.refresh_reused': 'Thu hồi phiên do dùng lại token',
  'auth.change_password': 'Đổi mật khẩu tài khoản',
  'patient.create': 'Tạo hồ sơ bệnh nhân',
  'patient.update': 'Cập nhật hồ sơ bệnh nhân',
  'patient.delete': 'Xóa hồ sơ bệnh nhân',
  'case.create': 'Tạo ca chụp MRI',
  'case.update': 'Cập nhật ca chụp MRI',
  'case.delete': 'Xóa ca chụp MRI',
  'volume.upload': 'Tải lên khối ảnh NIfTI',
  'volume.delete': 'Xóa khối ảnh NIfTI',
  'mask_version.create': 'Lưu phiên bản mask chỉnh sửa',
  'mask.save': 'Lưu phiên bản mask chỉnh sửa',
};

function formatAuditActionLabel(action: string): string {
  const normalized = action.trim().toLowerCase();
  return AUDIT_ACTION_LABELS[normalized] ?? 'Thao tác quản trị hệ thống';
}

export function AdminAuditEventsPage() {
  const user = useAuthStore((s) => s.user);
  const fixtureMode = useAuthStore((s) => s.fixtureMode);
  const { q, page, pageSize, searchInput, setSearchInput, setPage, resetFilters } =
    useUrlListParams();

  const auditQuery = useQuery({
    queryKey: [
      'admin',
      user?.id ?? 'anon',
      'audit-events',
      { q, page, pageSize, fixtureMode },
    ],
    queryFn: ({ signal }) =>
      fetchAdminAuditEvents({ q, page, pageSize }, { signal, fixtureMode }),
  });

  useQueryErrorToast(auditQuery.error, 'Không thể tải nhật ký quản trị');

  React.useEffect(() => {
    if (!auditQuery.data || auditQuery.isFetching) return;
    const { total, page_size } = auditQuery.data;
    const effectivePageSize = page_size > 0 ? page_size : pageSize;
    if (total > 0) {
      const maxPage = Math.ceil(total / effectivePageSize);
      if (page > maxPage) {
        setPage(maxPage);
      }
    }
  }, [auditQuery.data, auditQuery.isFetching, page, pageSize, setPage]);

  const columns: DataTableColumn<AuditEventDto>[] = [
    {
      key: 'created_at',
      header: 'Thời gian',
      cellClassName: 'whitespace-nowrap',
      cell: (row) => (
        <span className="text-xs tabular-nums">{formatDateTimeVN(row.created_at)}</span>
      ),
    },
    {
      key: 'actor_username',
      header: 'Người thực hiện',
      cellClassName: 'whitespace-nowrap',
      cell: (row) => (
        <span
          title={`@${row.actor_username}`}
          className="block max-w-[116px] truncate font-mono text-xs"
        >
          @{row.actor_username}
        </span>
      ),
    },
    {
      key: 'action',
      header: 'Hành động',
      cell: (row) => (
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium text-[var(--text-primary)]">
            {formatAuditActionLabel(row.action)}
          </span>
          <span
            title={row.action}
            className="block max-w-[180px] truncate font-mono text-xs text-[var(--text-secondary)]"
          >
            {row.action}
          </span>
        </div>
      ),
    },
    {
      key: 'target_id',
      header: 'Đối tượng',
      cellClassName: 'whitespace-nowrap',
      cell: (row) => (
        <span title={row.target_id} className="block max-w-[104px] truncate font-mono text-xs">
          {row.target_id}
        </span>
      ),
    },
    {
      key: 'outcome',
      header: 'Kết quả',
      cellClassName: 'whitespace-nowrap',
      cell: (row) => (
        <StatusBadge
          label={row.outcome === 'success' ? 'Thành công' : 'Thất bại'}
          tone={row.outcome === 'success' ? 'success' : 'error'}
        />
      ),
    },
    {
      key: 'request_id',
      header: 'Request ID',
      cellClassName: 'whitespace-nowrap',
      cell: (row) => (
        <span
          title={row.request_id}
          className="block max-w-[104px] truncate font-mono text-xs text-[var(--text-secondary)]"
        >
          {row.request_id}
        </span>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-[1.75rem] leading-[1.08] font-normal text-[var(--color-ink)]">
          Nhật ký sự kiện quản trị
        </h1>

        <Button
          variant="outline"
          isLoading={auditQuery.isFetching}
          loadingText="Đang làm mới..."
          onClick={() => {
            void auditQuery.refetch();
          }}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          Làm mới
        </Button>
      </div>

      <div className="refract-panel flex flex-col items-stretch gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative min-w-0 flex-1 sm:min-w-[240px]">
          <label htmlFor="audit-search" className="sr-only">
            Tìm theo người thực hiện, hành động hoặc Request ID
          </label>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--text-muted)]"
            aria-hidden="true"
          />
          <Input
            id="audit-search"
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Tìm tài khoản, hành động hoặc Request ID"
            className="pl-9"
          />
        </div>
        {(q || page > 1) && (
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
        caption="Nhật ký thao tác quản trị hệ thống"
        columns={columns}
        data={auditQuery.data?.items ?? []}
        rowKey={(row) => row.id}
        isLoading={auditQuery.isPending}
        error={auditQuery.error}
        onRetry={() => {
          void auditQuery.refetch();
        }}
        emptyTitle="Chưa có sự kiện nào"
        emptyDescription="Không có nhật ký nào phù hợp với điều kiện tìm kiếm."
      />

      {auditQuery.data && (
        <Pagination
          page={page}
          pageSize={auditQuery.data.page_size}
          total={auditQuery.data.total}
          onPageChange={setPage}
        />
      )}
    </div>
  );
}
