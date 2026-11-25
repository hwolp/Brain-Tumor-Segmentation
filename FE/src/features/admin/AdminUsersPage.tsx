import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  KeyRound,
  Lock,
  Pencil,
  Search,
  Unlock,
  UserPlus,
} from 'lucide-react';
import { useAuthStore } from '@/app/auth-store';
import {
  createAdminDoctorUser,
  listAdminUsers,
  resetAdminDoctorPassword,
  updateAdminDoctorUser,
} from '@/shared/api/adminUsers';
import { normalizeApiError } from '@/shared/api/errors';
import type {
  AdminCreateDoctorRequestDto,
  AdminDoctorUserDto,
} from '@/shared/api/types';
import { useQueryErrorToast } from '@/shared/api/useQueryErrorToast';
import { formatDateTimeVN } from '@/shared/lib/datetime';
import { useUrlListParams } from '@/shared/lib/urlQuery';
import {
  Alert,
  Button,
  ConfirmDialog,
  DataTable,
  type DataTableColumn,
  Input,
  Pagination,
  Select,
  StatusBadge,
  useToast,
} from '@/shared/ui';
import {
  CreateDoctorModal,
  EditDoctorNameModal,
  OneTimePasswordModal,
  type OneTimeSecretInfo,
} from './AdminUserModals';

export function AdminUsersPage() {
  const queryClient = useQueryClient();
  const { pushToast, toastError } = useToast();
  const user = useAuthStore((s) => s.user);
  const fixtureMode = useAuthStore((s) => s.fixtureMode);
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

  const [createModalOpen, setCreateModalOpen] = React.useState(false);
  const [isCreating, setIsCreating] = React.useState(false);
  const [editingUser, setEditingUser] =
    React.useState<AdminDoctorUserDto | null>(null);
  const [toggleTargetUser, setToggleTargetUser] =
    React.useState<AdminDoctorUserDto | null>(null);
  const [resetTargetUser, setResetTargetUser] =
    React.useState<AdminDoctorUserDto | null>(null);
  const [isResettingPassword, setIsResettingPassword] = React.useState(false);
  const [confirmError, setConfirmError] = React.useState<{
    message: string;
    requestId: string | null;
  } | null>(null);

  // Chỉ giữ trong React UI state tạm thời; tuyệt đối không lưu localStorage, Query cache hay MutationCache
  const [oneTimeSecret, setOneTimeSecret] =
    React.useState<OneTimeSecretInfo | null>(null);

  const usersListScopeKey = ['admin', user?.id ?? 'anon', 'users'] as const;

  const usersQuery = useQuery({
    queryKey: [
      ...usersListScopeKey,
      { q, status, page, pageSize, fixtureMode },
    ],
    queryFn: ({ signal }) =>
      listAdminUsers({ q, status, page, pageSize }, { signal, fixtureMode }),
  });

  useQueryErrorToast(
    usersQuery.error,
    'Không thể tải danh sách tài khoản bác sĩ',
  );

  React.useEffect(() => {
    if (!usersQuery.data || usersQuery.isFetching) return;
    const { total, page_size } = usersQuery.data;
    const effectivePageSize = page_size > 0 ? page_size : pageSize;
    if (total > 0) {
      const maxPage = Math.ceil(total / effectivePageSize);
      if (page > maxPage) {
        setPage(maxPage);
      }
    }
  }, [usersQuery.data, usersQuery.isFetching, page, pageSize, setPage]);

  const refetchUsersList = async () => {
    const uid = user?.id ?? 'anon';
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: usersListScopeKey }),
      queryClient.invalidateQueries({ queryKey: ['admin', uid, 'overview'] }),
      queryClient.invalidateQueries({
        queryKey: ['admin', uid, 'audit-events'],
      }),
    ]);
  };

  // Gọi trực tiếp (không qua TanStack MutationCache) để tránh lưu temporary_password trong variables/data cache
  const handleCreateDoctor = async (payload: AdminCreateDoctorRequestDto) => {
    setIsCreating(true);
    try {
      const created = await createAdminDoctorUser(payload, { fixtureMode });
      setCreateModalOpen(false);
      await refetchUsersList();
      pushToast({
        variant: 'success',
        title: 'Đã tạo tài khoản bác sĩ',
        description: `Tài khoản @${created.username} đã sẵn sàng bàn giao mật khẩu tạm.`,
      });
      setOneTimeSecret({
        mode: 'create',
        username: created.username,
        displayName: created.display_name,
        temporaryPassword: payload.temporary_password,
      });
    } finally {
      setIsCreating(false);
    }
  };

  const editNameMutation = useMutation({
    mutationFn: ({ userId, displayName }: { userId: string; displayName: string }) =>
      updateAdminDoctorUser(
        userId,
        { display_name: displayName },
        { fixtureMode },
      ),
    onSuccess: async (updated) => {
      setEditingUser(null);
      await refetchUsersList();
      pushToast({
        variant: 'success',
        title: 'Đã cập nhật tên hiển thị',
        description: `Đã lưu tên mới cho @${updated.username}.`,
      });
    },
  });

  const toggleActiveMutation = useMutation({
    mutationFn: ({
      userId,
      nextActive,
    }: {
      userId: string;
      nextActive: boolean;
    }) =>
      updateAdminDoctorUser(
        userId,
        { is_active: nextActive },
        { fixtureMode },
      ),
    onSuccess: async (_updated, variables) => {
      const target = toggleTargetUser;
      setToggleTargetUser(null);
      setConfirmError(null);
      await refetchUsersList();
      pushToast({
        variant: 'success',
        title: variables.nextActive
          ? 'Đã mở khóa tài khoản bác sĩ'
          : 'Đã khóa tài khoản bác sĩ',
        description: target
          ? variables.nextActive
            ? `Bác sĩ @${target.username} có thể đăng nhập trở lại.`
            : `Đã khóa @${target.username} và thu hồi mọi phiên đăng nhập hiện có.`
          : undefined,
      });
    },
    onError: (error) => {
      const normalized = normalizeApiError(error);
      setConfirmError({
        message: normalized.message,
        requestId: normalized.requestId,
      });
      toastError(error, 'Không thể thay đổi trạng thái tài khoản');
    },
  });

  // Gọi trực tiếp (không qua TanStack MutationCache) để tránh lưu temporary_password trả về trong cache
  const handleResetPassword = async (target: AdminDoctorUserDto) => {
    setIsResettingPassword(true);
    try {
      const result = await resetAdminDoctorPassword(target.id, { fixtureMode });
      setResetTargetUser(null);
      setConfirmError(null);
      await refetchUsersList();
      pushToast({
        variant: 'success',
        title: 'Đã đặt lại mật khẩu tạm',
        description: `Mọi phiên đang mở của @${target.username} đã bị thu hồi.`,
      });
      setOneTimeSecret({
        mode: 'reset',
        username: target.username,
        displayName: target.display_name,
        temporaryPassword: result.temporary_password,
      });
    } catch (error) {
      const normalized = normalizeApiError(error);
      setConfirmError({
        message: normalized.message,
        requestId: normalized.requestId,
      });
      toastError(error, 'Không thể đặt lại mật khẩu tạm');
    } finally {
      setIsResettingPassword(false);
    }
  };

  const columns: DataTableColumn<AdminDoctorUserDto>[] = [
    {
      key: 'username',
      header: 'Tên đăng nhập',
      cellClassName: 'whitespace-nowrap',
      cell: (row) => (
        <span
          title={row.username}
          className="block max-w-[124px] truncate font-mono font-semibold"
        >
          {row.username}
        </span>
      ),
    },
    {
      key: 'display_name',
      header: 'Họ và tên',
      cell: (row) => (
        <span title={row.display_name} className="block max-w-[155px] truncate">
          {row.display_name}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Trạng thái',
      cell: (row) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge
            label={row.is_active ? 'Hoạt động' : 'Đã khóa'}
            tone={row.is_active ? 'success' : 'error'}
          />
          {row.must_change_password && (
            <StatusBadge label="Chờ đổi mật khẩu" tone="warning" />
          )}
        </div>
      ),
    },
    {
      key: 'created_at',
      header: 'Ngày tạo',
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
            onClick={() => setEditingUser(row)}
          >
            <Pencil className="size-3.5" aria-hidden="true" />
            Sửa tên
          </Button>
          <Button
            variant="outline"
            size="xs"
            className="min-w-[84px]"
            onClick={() => {
              setConfirmError(null);
              setToggleTargetUser(row);
            }}
          >
            {row.is_active ? (
              <>
                <Lock className="size-3.5" aria-hidden="true" />
                Khóa
              </>
            ) : (
              <>
                <Unlock className="size-3.5" aria-hidden="true" />
                Mở khóa
              </>
            )}
          </Button>
          <Button
            variant="outline"
            size="xs"
            onClick={() => {
              setConfirmError(null);
              setResetTargetUser(row);
            }}
          >
            <KeyRound className="size-3.5" aria-hidden="true" />
            Đặt lại mật khẩu
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-[1.75rem] leading-[1.08] font-normal text-[var(--color-ink)]">
          Quản lý tài khoản bác sĩ
        </h1>

        <Button
          variant="primary"
          className="w-full sm:w-auto"
          onClick={() => setCreateModalOpen(true)}
        >
          <UserPlus className="size-4" aria-hidden="true" />
          Tạo tài khoản bác sĩ
        </Button>
      </div>

      <div className="refract-panel flex flex-col items-stretch gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative min-w-0 flex-1 sm:min-w-[220px]">
          <label htmlFor="admin-user-search" className="sr-only">
            Tìm theo username hoặc tên hiển thị
          </label>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--text-muted)]"
            aria-hidden="true"
          />
          <Input
            id="admin-user-search"
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Tìm username hoặc họ tên bác sĩ"
            className="pl-9"
          />
        </div>

        <div className="w-full sm:w-48">
          <label htmlFor="admin-user-status" className="sr-only">
            Lọc trạng thái tài khoản
          </label>
          <Select
            id="admin-user-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="all">Tất cả trạng thái</option>
            <option value="active">Đang hoạt động</option>
            <option value="locked">Đã khóa</option>
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
        caption="Danh sách tài khoản bác sĩ trong hệ thống"
        columns={columns}
        data={usersQuery.data?.items ?? []}
        rowKey={(row) => row.id}
        isLoading={usersQuery.isPending}
        error={usersQuery.error}
        onRetry={() => {
          void usersQuery.refetch();
        }}
        emptyTitle="Chưa có tài khoản bác sĩ phù hợp"
        emptyDescription="Không tìm thấy tài khoản nào khớp bộ lọc hiện tại."
      />

      {usersQuery.data && (
        <Pagination
          page={page}
          pageSize={usersQuery.data.page_size}
          total={usersQuery.data.total}
          onPageChange={setPage}
        />
      )}

      <CreateDoctorModal
        open={createModalOpen}
        isSubmitting={isCreating}
        onClose={() => setCreateModalOpen(false)}
        onSubmit={handleCreateDoctor}
      />

      <EditDoctorNameModal
        targetUser={editingUser}
        isSubmitting={editNameMutation.isPending}
        onClose={() => setEditingUser(null)}
        onSubmit={async (userId, displayName) => {
          await editNameMutation.mutateAsync({ userId, displayName });
        }}
      />

      <ConfirmDialog
        open={Boolean(toggleTargetUser)}
        onClose={() => {
          setToggleTargetUser(null);
          setConfirmError(null);
        }}
        onConfirm={async () => {
          if (!toggleTargetUser) return;
          setConfirmError(null);
          try {
            await toggleActiveMutation.mutateAsync({
              userId: toggleTargetUser.id,
              nextActive: !toggleTargetUser.is_active,
            });
          } catch {
            // Lỗi đã được xử lý trong onError
          }
        }}
        title={
          toggleTargetUser?.is_active
            ? 'Xác nhận khóa tài khoản bác sĩ'
            : 'Xác nhận mở khóa tài khoản bác sĩ'
        }
        description={
          toggleTargetUser?.is_active
            ? `Khóa tài khoản @${toggleTargetUser.username} sẽ thu hồi ngay mọi phiên đăng nhập của bác sĩ. Toàn bộ hồ sơ bệnh nhân vẫn được giữ nguyên.`
            : `Mở khóa tài khoản @${toggleTargetUser?.username ?? ''} để bác sĩ có thể đăng nhập lại. Toàn bộ hồ sơ bệnh nhân vẫn được giữ nguyên.`
        }
        confirmLabel={
          toggleTargetUser?.is_active ? 'Khóa tài khoản' : 'Mở khóa tài khoản'
        }
        variant={toggleTargetUser?.is_active ? 'destructive' : 'primary'}
        isSubmitting={toggleActiveMutation.isPending}
      >
        {confirmError && toggleTargetUser && (
          <Alert
            variant="error"
            title="Thao tác thất bại"
            description={confirmError.message}
          >
            {confirmError.requestId && (
              <span className="sr-only">
                Mã yêu cầu: {confirmError.requestId}
              </span>
            )}
          </Alert>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(resetTargetUser)}
        onClose={() => {
          setResetTargetUser(null);
          setConfirmError(null);
        }}
        onConfirm={async () => {
          if (!resetTargetUser) return;
          setConfirmError(null);
          await handleResetPassword(resetTargetUser);
        }}
        title="Xác nhận đặt lại mật khẩu tạm"
        description={
          resetTargetUser
            ? `Mọi phiên đang mở của bác sĩ @${resetTargetUser.username} sẽ bị thu hồi ngay lập tức và bác sĩ phải đổi mật khẩu ở lần đăng nhập kế tiếp.`
            : ''
        }
        confirmLabel="Đặt lại mật khẩu"
        variant="destructive"
        isSubmitting={isResettingPassword}
      >
        {confirmError && resetTargetUser && (
          <Alert
            variant="error"
            title="Đặt lại mật khẩu thất bại"
            description={confirmError.message}
          >
            {confirmError.requestId && (
              <span className="sr-only">
                Mã yêu cầu: {confirmError.requestId}
              </span>
            )}
          </Alert>
        )}
      </ConfirmDialog>

      <OneTimePasswordModal
        secret={oneTimeSecret}
        onClose={() => setOneTimeSecret(null)}
      />
    </div>
  );
}
