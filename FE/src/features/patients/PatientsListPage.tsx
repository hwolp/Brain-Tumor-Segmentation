import * as React from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Pencil, Search, Trash2, UserPlus } from 'lucide-react';
import { useAuthStore } from '@/app/auth-store';
import { fetchPatients } from '@/shared/api/endpoints';
import { normalizeApiError } from '@/shared/api/errors';
import {
  createPatient,
  deletePatient,
  updatePatient,
} from '@/shared/api/patientsCases';
import type { PatientCreateRequest, PatientDto } from '@/shared/api/types';
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
  buttonVariants,
  useToast,
} from '@/shared/ui';
import { formatPatientSex } from '@/features/cases/statusMappings';
import { PatientFormModal } from './PatientFormModal';

export function PatientsListPage() {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const user = useAuthStore((s) => s.user);
  const fixtureMode = useAuthStore((s) => s.fixtureMode);
  const {
    q,
    page,
    pageSize,
    searchInput,
    setSearchInput,
    setPage,
    resetFilters,
  } = useUrlListParams();

  const [createOpen, setCreateOpen] = React.useState(false);
  const [editingPatient, setEditingPatient] = React.useState<PatientDto | null>(
    null,
  );
  const [deletingPatient, setDeletingPatient] =
    React.useState<PatientDto | null>(null);
  const [isSavingPatient, setIsSavingPatient] = React.useState(false);
  const [isDeletingPatient, setIsDeletingPatient] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<{
    message: string;
    requestId: string | null;
  } | null>(null);

  const patientsScopeKey = ['doctor', user?.id ?? 'anon', 'patients'] as const;

  const patientsQuery = useQuery({
    queryKey: [...patientsScopeKey, { q, page, pageSize, fixtureMode }],
    queryFn: ({ signal }) =>
      fetchPatients({ q, page, pageSize }, { signal, fixtureMode }),
  });

  useQueryErrorToast(
    patientsQuery.error,
    'Không thể tải danh sách bệnh nhân',
  );

  React.useEffect(() => {
    if (!patientsQuery.data || patientsQuery.isFetching) return;
    const { total, page_size } = patientsQuery.data;
    const effectivePageSize = page_size > 0 ? page_size : pageSize;
    if (total > 0) {
      const maxPage = Math.ceil(total / effectivePageSize);
      if (page > maxPage) {
        setPage(maxPage);
      }
    }
  }, [patientsQuery.data, patientsQuery.isFetching, page, pageSize, setPage]);

  const invalidatePatients = async (patientId?: string) => {
    const uid = user?.id ?? 'anon';
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: patientsScopeKey }),
      queryClient.invalidateQueries({
        queryKey: ['doctor', uid, 'cases-overview'],
      }),
      patientId
        ? queryClient.invalidateQueries({
            queryKey: ['doctor', uid, 'patient', patientId],
          })
        : Promise.resolve(),
    ]);
  };

  const handleCreatePatient = async (payload: PatientCreateRequest) => {
    setIsSavingPatient(true);
    try {
      const created = await createPatient(payload, { fixtureMode });
      setCreateOpen(false);
      await invalidatePatients();
      pushToast({
        variant: 'success',
        title: 'Đã tạo hồ sơ bệnh nhân',
        description: `${created.full_name} (${created.patient_code})`,
      });
    } finally {
      setIsSavingPatient(false);
    }
  };

  const handleEditPatient = async (payload: PatientCreateRequest) => {
    if (!editingPatient) return;
    setIsSavingPatient(true);
    try {
      const updated = await updatePatient(editingPatient.id, payload, {
        fixtureMode,
      });
      setEditingPatient(null);
      await invalidatePatients(updated.id);
      pushToast({
        variant: 'success',
        title: 'Đã cập nhật hồ sơ bệnh nhân',
        description: `${updated.full_name} (${updated.patient_code})`,
      });
    } finally {
      setIsSavingPatient(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deletingPatient) return;
    setIsDeletingPatient(true);
    setDeleteError(null);
    try {
      const deletion = await deletePatient(deletingPatient.id, {
        fixtureMode,
      });
      const deletedName = deletingPatient.full_name;
      const deletedId = deletingPatient.id;
      setDeletingPatient(null);
      await invalidatePatients(deletedId);
      pushToast({
        variant: deletion.status === 'deleting' ? 'info' : 'success',
        title:
          deletion.status === 'deleting'
            ? 'Đã thu hồi truy cập hồ sơ bệnh nhân'
            : 'Đã xóa hồ sơ bệnh nhân',
        description:
          deletion.status === 'deleting'
            ? `Quyền truy cập hồ sơ ${deletedName} đã bị thu hồi ngay; hệ thống đang tiếp tục dọn dẹp tệp lưu trữ nền.`
            : `Đã xóa hồ sơ ${deletedName} và toàn bộ dữ liệu liên quan.`,
      });
    } catch (error) {
      const normalized = normalizeApiError(error);
      setDeleteError({
        message: normalized.message,
        requestId: normalized.requestId,
      });
    } finally {
      setIsDeletingPatient(false);
    }
  };

  const columns: DataTableColumn<PatientDto>[] = [
    {
      key: 'patient_code',
      header: 'Mã bệnh nhân',
      cell: (row) => (
        <span className="font-mono text-sm font-semibold text-[var(--text-primary)]">
          {row.patient_code}
        </span>
      ),
    },
    {
      key: 'full_name',
      header: 'Họ và tên',
      cell: (row) => <span className="font-medium">{row.full_name}</span>,
    },
    {
      key: 'birth_year',
      header: 'Năm sinh',
      align: 'center',
      cell: (row) => <span className="tabular-nums">{row.birth_year}</span>,
    },
    {
      key: 'sex',
      header: 'Giới tính',
      align: 'center',
      cell: (row) => formatPatientSex(row.sex),
    },
    {
      key: 'case_count',
      header: 'Số ca chụp',
      align: 'center',
      cell: (row) => (
        <span className="font-mono text-sm font-medium tabular-nums text-[var(--text-primary)]">
          {row.case_count ?? 0}
        </span>
      ),
    },
    {
      key: 'updated_at',
      header: 'Cập nhật gần nhất',
      cell: (row) => formatDateTimeVN(row.updated_at),
    },
    {
      key: 'actions',
      header: 'Thao tác',
      align: 'right',
      cell: (row) => (
        <div className="flex flex-nowrap items-center justify-end gap-1.5 whitespace-nowrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEditingPatient(row)}
            aria-label={`Sửa hồ sơ ${row.patient_code}`}
          >
            <Pencil className="size-4" aria-hidden="true" />
            Sửa
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="hover:border-[var(--status-error-border)] hover:bg-[var(--status-error-bg)] hover:text-[var(--status-error)]"
            onClick={() => {
              setDeleteError(null);
              setDeletingPatient(row);
            }}
            aria-label={`Xóa hồ sơ ${row.patient_code}`}
          >
            <Trash2 className="size-4" aria-hidden="true" />
            Xóa
          </Button>
          <Link
            to={`/doctor/patients/${row.id}`}
            className={buttonVariants({ variant: 'primary', size: 'sm' })}
          >
            Xem hồ sơ
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-[1.75rem] leading-[1.08] font-normal text-[var(--color-ink)]">
          Danh sách bệnh nhân
        </h1>

        <Button
          variant="primary"
          className="w-full sm:w-auto"
          onClick={() => setCreateOpen(true)}
        >
          <UserPlus className="size-4" aria-hidden="true" />
          Thêm bệnh nhân
        </Button>
      </div>

      <div className="refract-panel flex flex-col items-stretch gap-3 p-4 sm:flex-row sm:flex-wrap sm:items-center">
        <div className="relative min-w-0 flex-1 sm:max-w-md sm:min-w-[240px]">
          <label htmlFor="patient-search" className="sr-only">
            Tìm theo mã hoặc họ tên bệnh nhân
          </label>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--text-muted)]"
            aria-hidden="true"
          />
          <Input
            id="patient-search"
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Tìm mã hoặc họ tên bệnh nhân"
            className="pl-9"
          />
        </div>

        {(Boolean(searchInput.trim()) || Boolean(q) || page > 1) && (
          <Button
            variant="outline"
            className="w-full sm:w-auto"
            onClick={resetFilters}
          >
            Xóa bộ lọc
          </Button>
        )}
      </div>

      <DataTable
        caption="Danh sách hồ sơ bệnh nhân của bác sĩ"
        columns={columns}
        data={patientsQuery.data?.items ?? []}
        rowKey={(row) => row.id}
        isLoading={patientsQuery.isPending}
        error={patientsQuery.error}
        onRetry={() => {
          void patientsQuery.refetch();
        }}
        emptyTitle="Chưa có hồ sơ bệnh nhân phù hợp"
        emptyDescription={
          q
            ? `Không tìm thấy bệnh nhân khớp từ khóa "${q}".`
            : 'Bạn chưa có hồ sơ bệnh nhân nào trong hệ thống.'
        }
        emptyAction={
          q ? (
            <Button variant="outline" onClick={resetFilters}>
              Đặt lại tìm kiếm
            </Button>
          ) : undefined
        }
      />

      {patientsQuery.data && (
        <Pagination
          page={page}
          pageSize={patientsQuery.data.page_size}
          total={patientsQuery.data.total}
          onPageChange={setPage}
        />
      )}

      <PatientFormModal
        open={createOpen}
        mode="create"
        isSubmitting={isSavingPatient}
        onClose={() => setCreateOpen(false)}
        onSubmit={handleCreatePatient}
      />

      <PatientFormModal
        open={Boolean(editingPatient)}
        mode="edit"
        initialPatient={editingPatient}
        isSubmitting={isSavingPatient}
        onClose={() => setEditingPatient(null)}
        onSubmit={handleEditPatient}
      />

      <ConfirmDialog
        open={Boolean(deletingPatient)}
        onClose={() => {
          if (!isDeletingPatient) {
            setDeletingPatient(null);
            setDeleteError(null);
          }
        }}
        onConfirm={handleConfirmDelete}
        title="Xóa hồ sơ bệnh nhân?"
        description={
          deletingPatient
            ? `Thao tác này sẽ xóa hồ sơ ${deletingPatient.full_name} (${deletingPatient.patient_code}), các ca chụp và toàn bộ tệp MRI/mask liên quan. Không thể hoàn tác.`
            : ''
        }
        confirmLabel="Xóa hồ sơ"
        variant="destructive"
        isSubmitting={isDeletingPatient}
      >
        {deleteError && (
          <Alert
            variant="error"
            title="Không thể xóa hồ sơ"
            description={deleteError.message}
          >
            {deleteError.requestId && (
              <span className="sr-only">
                Mã tham chiếu: {deleteError.requestId}
              </span>
            )}
          </Alert>
        )}
      </ConfirmDialog>
    </div>
  );
}
