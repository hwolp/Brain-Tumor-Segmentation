import * as React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Eye,
  FolderPlus,
  Pencil,
  Trash2,
} from 'lucide-react';
import { useAuthStore } from '@/app/auth-store';
import { fetchPatientDetail } from '@/shared/api/endpoints';
import { normalizeApiError } from '@/shared/api/errors';
import {
  createCase,
  deletePatient,
  updatePatient,
} from '@/shared/api/patientsCases';
import type {
  CaseCreateRequest,
  CaseDto,
  PatientCreateRequest,
} from '@/shared/api/types';
import { useQueryErrorToast } from '@/shared/api/useQueryErrorToast';
import { formatDateTimeVN, formatStudyDate } from '@/shared/lib/datetime';
import {
  Alert,
  Button,
  CardSkeleton,
  ConfirmDialog,
  DataTable,
  type DataTableColumn,
  ErrorState,
  StatusBadge,
  buttonVariants,
  useToast,
} from '@/shared/ui';
import {
  formatPatientSex,
  getCaseReadinessMeta,
} from '@/features/cases/statusMappings';
import { CaseFormModal, type PendingCreateAttempt } from './CaseFormModal';
import { PatientFormModal } from './PatientFormModal';

export function PatientDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const user = useAuthStore((s) => s.user);
  const fixtureMode = useAuthStore((s) => s.fixtureMode);

  const [editOpen, setEditOpen] = React.useState(false);
  const [isUpdatingPatient, setIsUpdatingPatient] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [isDeletingPatient, setIsDeletingPatient] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<{
    message: string;
    requestId: string | null;
  } | null>(null);
  const [createCaseOpen, setCreateCaseOpen] = React.useState(false);
  const [isCreatingCase, setIsCreatingCase] = React.useState(false);
  const [pendingCreateAttempt, setPendingCreateAttempt] =
    React.useState<PendingCreateAttempt | null>(null);
  const [needsReconcileConfirm, setNeedsReconcileConfirm] =
    React.useState(false);

  React.useEffect(() => {
    setPendingCreateAttempt(null);
    setNeedsReconcileConfirm(false);
  }, [id]);

  const patientDetailKey = [
    'doctor',
    user?.id ?? 'anon',
    'patient',
    id,
    { fixtureMode },
  ] as const;

  const detailQuery = useQuery({
    queryKey: patientDetailKey,
    queryFn: ({ signal }) => fetchPatientDetail(id, { signal, fixtureMode }),
    enabled: Boolean(id),
  });

  useQueryErrorToast(detailQuery.error, 'Không thể tải hồ sơ bệnh nhân');

  const sortedCases = [...(detailQuery.data?.cases ?? [])].sort((a, b) =>
    b.study_date.localeCompare(a.study_date),
  );

  const handleUpdatePatient = async (payload: PatientCreateRequest) => {
    setIsUpdatingPatient(true);
    try {
      const updated = await updatePatient(id, payload, { fixtureMode });
      setEditOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['doctor', user?.id ?? 'anon', 'patient', id],
        }),
        queryClient.invalidateQueries({
          queryKey: ['doctor', user?.id ?? 'anon', 'patients'],
        }),
        queryClient.invalidateQueries({
          queryKey: ['doctor', user?.id ?? 'anon', 'cases-overview'],
        }),
      ]);
      pushToast({
        variant: 'success',
        title: 'Đã cập nhật hồ sơ bệnh nhân',
        description: `${updated.full_name} (${updated.patient_code})`,
      });
    } finally {
      setIsUpdatingPatient(false);
    }
  };

  const handleConfirmDeletePatient = async () => {
    setIsDeletingPatient(true);
    setDeleteError(null);
    try {
      const deletion = await deletePatient(id, { fixtureMode });
      setDeleteOpen(false);
      await queryClient.cancelQueries({
        queryKey: ['doctor', user?.id ?? 'anon', 'patient', id],
      });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['doctor', user?.id ?? 'anon', 'patients'],
        }),
        queryClient.invalidateQueries({
          queryKey: ['doctor', user?.id ?? 'anon', 'cases-overview'],
        }),
      ]);
      pushToast({
        variant: deletion.status === 'deleting' ? 'info' : 'success',
        title:
          deletion.status === 'deleting'
            ? 'Đã thu hồi truy cập hồ sơ bệnh nhân'
            : 'Đã xóa hồ sơ bệnh nhân',
        description:
          deletion.status === 'deleting'
            ? 'Quyền truy cập hồ sơ đã bị thu hồi ngay; hệ thống đang tiếp tục dọn dẹp tệp lưu trữ nền.'
            : 'Hồ sơ và toàn bộ ca chụp/tệp liên quan đã được xóa.',
      });
      navigate('/doctor/patients', { replace: true });
      queryClient.removeQueries({
        queryKey: ['doctor', user?.id ?? 'anon', 'patient', id],
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

  const handleCreateCase = async (
    payload: CaseCreateRequest,
    idempotencyKey: string,
  ) => {
    setIsCreatingCase(true);
    try {
      const created = await createCase(id, payload, idempotencyKey, {
        fixtureMode,
      });
      setCreateCaseOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['doctor', user?.id ?? 'anon', 'patient', id],
        }),
        queryClient.invalidateQueries({
          queryKey: ['doctor', user?.id ?? 'anon', 'patients'],
        }),
        queryClient.invalidateQueries({
          queryKey: ['doctor', user?.id ?? 'anon', 'cases-overview'],
        }),
      ]);
      pushToast({
        variant: 'success',
        title: 'Đã tạo ca chụp mới',
        description: `Ca chụp ngày ${formatStudyDate(created.study_date)} đã sẵn sàng tải lên ảnh MRI.`,
      });
      navigate(`/doctor/cases/${created.id}`);
    } finally {
      setIsCreatingCase(false);
    }
  };

  const caseColumns: DataTableColumn<CaseDto>[] = [
    {
      key: 'study_date',
      header: 'Ngày chụp',
      cellClassName: 'whitespace-nowrap',
      cell: (row) => (
        <span className="font-medium tabular-nums">
          {formatStudyDate(row.study_date)}
        </span>
      ),
    },
    {
      key: 'readiness',
      header: 'Trạng thái dữ liệu',
      cellClassName: 'whitespace-nowrap',
      cell: (row) => {
        const meta = getCaseReadinessMeta(row.readiness);
        return <StatusBadge label={meta.label} tone={meta.tone} />;
      },
    },
    {
      key: 'notes',
      header: 'Ghi chú ca chụp',
      cell: (row) => (
        <span
          title={row.notes || undefined}
          className="line-clamp-2 max-w-[260px] text-[var(--text-secondary)]"
        >
          {row.notes || 'Không có ghi chú'}
        </span>
      ),
    },
    {
      key: 'updated_at',
      header: 'Cập nhật',
      cellClassName: 'whitespace-nowrap text-xs tabular-nums',
      cell: (row) => formatDateTimeVN(row.updated_at),
    },
    {
      key: 'actions',
      header: 'Thao tác',
      align: 'right',
      cellClassName: 'whitespace-nowrap',
      cell: (row) => (
        <div className="flex flex-nowrap items-center justify-end gap-1.5 whitespace-nowrap">
          <Link
            to={`/doctor/cases/${row.id}/viewer`}
            className={buttonVariants({ variant: 'outline', size: 'xs' })}
          >
            <Eye className="size-3.5" aria-hidden="true" />
            Viewer
          </Link>
          <Link
            to={`/doctor/cases/${row.id}`}
            className={buttonVariants({ variant: 'primary', size: 'xs' })}
          >
            Chi tiết ca
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </Link>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          to="/doctor/patients"
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Danh sách bệnh nhân
        </Link>
      </div>

      {detailQuery.isPending && <CardSkeleton />}

      {detailQuery.isError && (
        <ErrorState
          title="Không thể truy cập hồ sơ bệnh nhân"
          error={detailQuery.error}
          onRetry={() => {
            void detailQuery.refetch();
          }}
        />
      )}

      {!detailQuery.isError && detailQuery.data?.patient && (
        <>
          <section className="refract-panel p-5 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-[240px] flex-1 flex-col gap-1">
                <span className="font-mono text-xs font-medium text-[var(--color-accent)]">
                  Mã BN: {detailQuery.data.patient.patient_code}
                </span>
                <h1 className="font-display text-[1.75rem] leading-[1.08] font-normal text-[var(--color-ink)]">
                  {detailQuery.data.patient.full_name}
                </h1>
                <p className="text-sm text-[var(--text-secondary)] tabular-nums">
                  Năm sinh: {detailQuery.data.patient.birth_year} · Giới tính:{' '}
                  {formatPatientSex(detailQuery.data.patient.sex)} · Tạo lúc:{' '}
                  {formatDateTimeVN(detailQuery.data.patient.created_at)}
                </p>
              </div>

              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditOpen(true)}
                >
                  <Pencil className="size-4" aria-hidden="true" />
                  Sửa hồ sơ
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setDeleteError(null);
                    setDeleteOpen(true);
                  }}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                  Xóa hồ sơ
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setCreateCaseOpen(true)}
                >
                  <FolderPlus className="size-4" aria-hidden="true" />
                  Tạo ca chụp mới
                </Button>
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="font-display text-lg font-normal text-[var(--color-ink)]">
              Các lần chụp MRI ({sortedCases.length})
            </h2>
            <DataTable
              caption="Danh sách các ca chụp của bệnh nhân"
              columns={caseColumns}
              data={sortedCases}
              rowKey={(row) => row.id}
              emptyTitle="Chưa có ca chụp nào"
              emptyDescription="Bệnh nhân này chưa có lần chụp MRI nào được ghi nhận."
            />
          </section>

          <PatientFormModal
            open={editOpen}
            mode="edit"
            initialPatient={detailQuery.data.patient}
            isSubmitting={isUpdatingPatient}
            onClose={() => setEditOpen(false)}
            onSubmit={handleUpdatePatient}
          />

          <CaseFormModal
            open={createCaseOpen}
            mode="create"
            isSubmitting={isCreatingCase}
            pendingAttempt={pendingCreateAttempt}
            onPendingAttemptChange={setPendingCreateAttempt}
            needsReconcileConfirm={needsReconcileConfirm}
            onNeedsReconcileChange={setNeedsReconcileConfirm}
            onClose={() => setCreateCaseOpen(false)}
            onCreateSubmit={handleCreateCase}
            onConflictRefreshCases={async () => {
              await detailQuery.refetch();
            }}
          />

          <ConfirmDialog
            open={deleteOpen}
            onClose={() => {
              if (!isDeletingPatient) {
                setDeleteOpen(false);
                setDeleteError(null);
              }
            }}
            onConfirm={handleConfirmDeletePatient}
            title="Xóa hồ sơ bệnh nhân?"
            description={`Thao tác này sẽ xóa hồ sơ ${detailQuery.data.patient.full_name} (${detailQuery.data.patient.patient_code}), các ca chụp và toàn bộ tệp MRI/mask liên quan. Không thể hoàn tác.`}
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
        </>
      )}
    </div>
  );
}
