import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical, Play, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useAuthStore } from '@/app/auth-store';
import {
  createAdminBenchmark,
  deleteAdminBenchmark,
  fetchAdminBenchmarkDetail,
  fetchAdminBenchmarks,
  fetchAdminWorkers,
} from '@/shared/api/endpoints';
import { normalizeApiError } from '@/shared/api/errors';
import { useQueryErrorToast } from '@/shared/api/useQueryErrorToast';
import type { AdminBenchmarkSummaryDto } from '@/shared/api/types';
import { formatDateTimeVN } from '@/shared/lib/datetime';
import { useUrlListParams } from '@/shared/lib/urlQuery';
import {
  Alert,
  Button,
  ConfirmDialog,
  DataTable,
  type DataTableColumn,
  FormField,
  Input,
  Pagination,
  Select,
  StatusBadge,
  Textarea,
  useToast,
} from '@/shared/ui';
import { formatJobStage, getJobStateMeta } from '@/features/cases/statusMappings';
import { BenchmarkComparisonPanel } from './BenchmarkComparisonPanel';

function formatDiceCell(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return value.toFixed(4);
}

function formatDurationCell(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export function AdminBenchmarksPage() {
  const user = useAuthStore((s) => s.user);
  const fixtureMode = useAuthStore((s) => s.fixtureMode);
  const queryClient = useQueryClient();
  const { pushToast } = useToast();

  const [title, setTitle] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [targetWorkerId, setTargetWorkerId] = React.useState('');
  const [flairFile, setFlairFile] = React.useState<File | null>(null);
  const [t1ceFile, setT1ceFile] = React.useState<File | null>(null);
  const [gtMaskFile, setGtMaskFile] = React.useState<File | null>(null);

  const flairInputRef = React.useRef<HTMLInputElement | null>(null);
  const t1ceInputRef = React.useRef<HTMLInputElement | null>(null);
  const gtMaskInputRef = React.useRef<HTMLInputElement | null>(null);

  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<AdminBenchmarkSummaryDto | null>(null);

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

  const workersQuery = useQuery({
    queryKey: ['admin', user?.id ?? 'anon', 'workers', { fixtureMode }],
    queryFn: ({ signal }) => fetchAdminWorkers({ signal, fixtureMode }),
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
  });

  React.useEffect(() => {
    const workers = workersQuery.data ?? [];
    if (workers.length > 0 && !targetWorkerId) {
      const online = workers.find((w) => w.online);
      setTargetWorkerId((online ?? workers[0]!).worker_id);
    }
  }, [workersQuery.data, targetWorkerId]);

  const benchmarksQuery = useQuery({
    queryKey: [
      'admin',
      user?.id ?? 'anon',
      'benchmarks',
      { q, status, page, pageSize, fixtureMode },
    ],
    queryFn: ({ signal }) =>
      fetchAdminBenchmarks({ q, state: status, page, pageSize }, { signal, fixtureMode }),
    refetchInterval: (query) =>
      query.state.data?.items.some(
        (item) => item.state === 'queued' || item.state === 'running',
      )
        ? 3000
        : false,
    refetchIntervalInBackground: false,
  });

  const detailQuery = useQuery({
    queryKey: [
      'admin',
      user?.id ?? 'anon',
      'benchmark-detail',
      selectedId,
      { fixtureMode },
    ],
    queryFn: ({ signal }) =>
      fetchAdminBenchmarkDetail(selectedId!, { signal, fixtureMode }),
    enabled: Boolean(selectedId),
    refetchInterval: (query) => {
      const st = query.state.data?.state;
      return st === 'queued' || st === 'running' ? 3000 : false;
    },
    refetchIntervalInBackground: false,
  });

  useQueryErrorToast(workersQuery.error, 'Không thể tải danh sách AI Worker');
  useQueryErrorToast(benchmarksQuery.error, 'Không thể tải lịch sử kiểm định AI');
  useQueryErrorToast(detailQuery.error, 'Không thể tải chi tiết lượt kiểm định');

  const createMutation = useMutation({
    mutationFn: () => {
      if (!flairFile || !t1ceFile || !gtMaskFile) {
        throw new Error('Vui lòng chọn đủ 3 tệp FLAIR, T1ce và Nhãn bác sĩ (seg).');
      }
      return createAdminBenchmark(
        {
          title,
          targetWorkerId,
          notes: notes.trim() || undefined,
          flair: flairFile,
          t1ce: t1ceFile,
          gtMask: gtMaskFile,
        },
        { fixtureMode },
      );
    },
    onSuccess: async (created) => {
      setTitle('');
      setNotes('');
      setFlairFile(null);
      setT1ceFile(null);
      setGtMaskFile(null);
      if (flairInputRef.current) flairInputRef.current.value = '';
      if (t1ceInputRef.current) t1ceInputRef.current.value = '';
      if (gtMaskInputRef.current) gtMaskInputRef.current.value = '';
      setSelectedId(created.id);
      await queryClient.invalidateQueries({
        queryKey: ['admin', user?.id ?? 'anon', 'benchmarks'],
      });
      pushToast({
        variant: 'success',
        title: 'Đã tạo lượt kiểm định AI',
        description: `Đã xếp hàng cho worker "${created.target_worker_id}".`,
      });
    },
    onError: (err) => {
      const normalized = normalizeApiError(err);
      pushToast({
        variant: 'error',
        title: 'Không thể tạo lượt kiểm định AI',
        description: normalized.message,
        requestId: normalized.requestId,
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteAdminBenchmark(id, { fixtureMode }),
    onSuccess: async (res) => {
      const removedId = deleteTarget?.id;
      setDeleteTarget(null);
      if (removedId && selectedId === removedId) {
        setSelectedId(null);
      }
      await queryClient.invalidateQueries({
        queryKey: ['admin', user?.id ?? 'anon', 'benchmarks'],
      });
      pushToast({
        variant: 'success',
        title: 'Đã xóa lượt kiểm định',
        description: `${res.message} (đã dọn ${res.files_cleaned} tệp).`,
      });
    },
    onError: (err) => {
      setDeleteTarget(null);
      const normalized = normalizeApiError(err);
      pushToast({
        variant: 'error',
        title: 'Không thể xóa lượt kiểm định',
        description: normalized.message,
        requestId: normalized.requestId,
      });
    },
  });

  const selectedWorker = (workersQuery.data ?? []).find(
    (w) => w.worker_id === targetWorkerId,
  );
  const canSubmit =
    title.trim().length > 0 &&
    targetWorkerId.trim().length > 0 &&
    Boolean(flairFile && t1ceFile && gtMaskFile) &&
    !createMutation.isPending;

  const columns: DataTableColumn<AdminBenchmarkSummaryDto>[] = [
    {
      key: 'title',
      header: 'Tên bài kiểm định',
      cell: (row) => (
        <div className="min-w-[180px]">
          <p className="font-medium text-[var(--color-ink)]">{row.title}</p>
          <p className="font-mono text-[11px] text-[var(--color-muted)]">{row.id}</p>
        </div>
      ),
    },
    {
      key: 'worker',
      header: 'AI Worker',
      cellClassName: 'whitespace-nowrap',
      cell: (row) => (
        <div className="text-xs">
          <p className="font-mono font-medium">{row.target_worker_id}</p>
          <p className="text-[var(--text-secondary)]">
            {row.worker_device_type ?? '—'}
            {row.model_version_id ? ` · ${row.model_version_id}` : ''}
          </p>
        </div>
      ),
    },
    {
      key: 'state',
      header: 'Trạng thái',
      cellClassName: 'whitespace-nowrap',
      cell: (row) => {
        const meta = getJobStateMeta(row.state);
        return (
          <div className="flex flex-col gap-1">
            <StatusBadge label={meta.label} tone={meta.tone} />
            {(row.state === 'queued' || row.state === 'running') && (
              <span className="text-[11px] text-[var(--text-secondary)] tabular-nums">
                {formatJobStage(row.stage)}
                {row.completed_slices !== null && row.total_slices
                  ? ` (${row.completed_slices}/${row.total_slices})`
                  : ''}
              </span>
            )}
          </div>
        );
      },
    },
    {
      key: 'mean_dice',
      header: 'Mean Dice',
      align: 'right',
      cellClassName: 'whitespace-nowrap font-mono tabular-nums',
      cell: (row) => formatDiceCell(row.mean_dice_brats),
    },
    {
      key: 'regions',
      header: 'WT / TC / ET',
      align: 'right',
      cellClassName: 'whitespace-nowrap font-mono text-xs tabular-nums',
      cell: (row) =>
        row.wt_dice !== null
          ? `${formatDiceCell(row.wt_dice)} / ${formatDiceCell(row.tc_dice)} / ${formatDiceCell(row.et_dice)}`
          : '—',
    },
    {
      key: 'duration',
      header: 'Thời gian',
      align: 'right',
      cellClassName: 'whitespace-nowrap font-mono text-xs tabular-nums',
      cell: (row) => formatDurationCell(row.inference_duration_ms),
    },
    {
      key: 'created_at',
      header: 'Ngày tạo',
      cellClassName: 'whitespace-nowrap text-xs tabular-nums',
      cell: (row) => formatDateTimeVN(row.created_at),
    },
    {
      key: 'actions',
      header: 'Thao tác',
      align: 'right',
      cellClassName: 'whitespace-nowrap',
      cell: (row) => (
        <div className="flex items-center justify-end gap-1.5">
          <Button
            size="sm"
            variant={selectedId === row.id ? 'primary' : 'outline'}
            onClick={() => setSelectedId(row.id)}
          >
            Xem kết quả
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={row.state === 'running'}
            aria-label={`Xóa ${row.title}`}
            onClick={() => setDeleteTarget(row)}
          >
            <Trash2 className="size-4" aria-hidden="true" />
            Xóa
          </Button>
        </div>
      ),
    },
  ];

  const items = benchmarksQuery.data?.items ?? [];
  const total = benchmarksQuery.data?.total ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-[1.75rem] leading-[1.08] font-normal text-[var(--color-ink)]">
            Kiểm định &amp; So sánh AI với Nhãn Bác sĩ
          </h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            Tải lên 2 xung FLAIR + T1ce và tệp nhãn chuẩn (seg.nii) để chấm điểm trực tiếp từng AI Worker. Dữ liệu tách biệt hoàn toàn khỏi hồ sơ bệnh nhân.
          </p>
        </div>

        <Button
          variant="outline"
          isLoading={workersQuery.isFetching || benchmarksQuery.isFetching}
          loadingText="Đang tải..."
          onClick={() => {
            void Promise.all([workersQuery.refetch(), benchmarksQuery.refetch()]);
          }}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          Làm mới
        </Button>
      </div>

      <section
        aria-label="Tạo lượt kiểm định mới"
        className="refract-panel flex flex-col gap-4 p-5 sm:p-6"
      >
        <div className="flex items-center gap-2 border-b border-[var(--color-rule)] pb-3">
          <FlaskConical className="size-4 text-[var(--color-accent)]" aria-hidden="true" />
          <h2 className="font-display text-lg font-normal text-[var(--color-ink)]">
            Tạo lượt so sánh mới
          </h2>
        </div>

        <form
          className="grid grid-cols-1 gap-4 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) {
              createMutation.mutate();
            }
          }}
        >
          <FormField id="bench-title" label="Tên bài kiểm định" required>
            {(controlProps) => (
              <Input
                {...controlProps}
                placeholder="Ví dụ: BraTS20_Training_001 - Worker GPU Colab"
                value={title}
                maxLength={160}
                onChange={(e) => setTitle(e.target.value)}
              />
            )}
          </FormField>

          <FormField id="bench-worker" label="Chọn AI Worker thực thi" required>
            {(controlProps) => (
              <Select
                {...controlProps}
                value={targetWorkerId}
                onChange={(e) => setTargetWorkerId(e.target.value)}
              >
                {(workersQuery.data ?? []).length === 0 ? (
                  <option value="">Chưa có AI Worker nào từng heartbeat</option>
                ) : (
                  (workersQuery.data ?? []).map((w) => (
                    <option key={w.worker_id} value={w.worker_id}>
                      {w.worker_id} · {w.device_type} · {w.model_version} ·{' '}
                      {w.online ? 'Trực tuyến' : 'Ngoại tuyến'}
                    </option>
                  ))
                )}
              </Select>
            )}
          </FormField>

          <div className="md:col-span-2">
            {selectedWorker && !selectedWorker.online && (
              <Alert
                variant="warning"
                title={`Worker "${selectedWorker.worker_id}" hiện đang ngoại tuyến`}
                description="Bạn vẫn có thể tạo lượt kiểm định; tác vụ sẽ chờ trong hàng đợi và tự động chạy ngay khi worker này kết nối lại."
              />
            )}
          </div>

          <FormField id="bench-flair" label="Xung FLAIR (.nii / .nii.gz)" required>
            {(controlProps) => (
              <input
                {...controlProps}
                ref={flairInputRef}
                type="file"
                accept=".nii,.nii.gz,.gz"
                onChange={(e) => setFlairFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm file:mr-3 file:rounded-[var(--radius-inner)] file:border file:border-[var(--color-rule)] file:bg-[var(--color-paper-2)] file:px-3 file:py-1.5 file:text-xs file:font-medium"
              />
            )}
          </FormField>

          <FormField id="bench-t1ce" label="Xung T1ce (.nii / .nii.gz)" required>
            {(controlProps) => (
              <input
                {...controlProps}
                ref={t1ceInputRef}
                type="file"
                accept=".nii,.nii.gz,.gz"
                onChange={(e) => setT1ceFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm file:mr-3 file:rounded-[var(--radius-inner)] file:border file:border-[var(--color-rule)] file:bg-[var(--color-paper-2)] file:px-3 file:py-1.5 file:text-xs file:font-medium"
              />
            )}
          </FormField>

          <FormField
            id="bench-gt"
            label="Nhãn chuẩn bác sĩ seg (.nii / .nii.gz — nhãn BraTS {0, 1, 2, 4})"
            required
          >
            {(controlProps) => (
              <input
                {...controlProps}
                ref={gtMaskInputRef}
                type="file"
                accept=".nii,.nii.gz,.gz"
                onChange={(e) => setGtMaskFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm file:mr-3 file:rounded-[var(--radius-inner)] file:border file:border-[var(--color-rule)] file:bg-[var(--color-paper-2)] file:px-3 file:py-1.5 file:text-xs file:font-medium"
              />
            )}
          </FormField>

          <FormField id="bench-notes" label="Ghi chú kỹ thuật (tùy chọn)">
            {(controlProps) => (
              <Textarea
                {...controlProps}
                rows={2}
                placeholder="Ví dụ: Đánh giá checkpoint ep136 trên ca BraTS 001..."
                value={notes}
                maxLength={2000}
                onChange={(e) => setNotes(e.target.value)}
              />
            )}
          </FormField>

          <div className="flex items-center justify-end gap-3 md:col-span-2">
            <Button
              type="submit"
              disabled={!canSubmit}
              isLoading={createMutation.isPending}
              loadingText="Đang tải tệp & kiểm tra hình học..."
            >
              <Play className="size-4" aria-hidden="true" />
              Chạy kiểm định AI
            </Button>
          </div>
        </form>
      </section>

      <section aria-label="Lịch sử kiểm định AI" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-64">
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--color-muted)]"
                aria-hidden="true"
              />
              <Input
                aria-label="Tìm kiếm bài kiểm định"
                placeholder="Tìm theo tên hoặc worker..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                className="pl-9"
              />
            </div>

            <Select
              aria-label="Lọc trạng thái kiểm định"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="w-44"
            >
              <option value="all">Tất cả trạng thái</option>
              <option value="queued">Đang chờ</option>
              <option value="running">Đang xử lý</option>
              <option value="succeeded">Hoàn tất</option>
              <option value="failed">Thất bại</option>
            </Select>

            {(q || status !== 'all') && (
              <Button variant="ghost" size="sm" onClick={resetFilters}>
                Xóa bộ lọc
              </Button>
            )}
          </div>
        </div>

        <DataTable
          columns={columns}
          data={items}
          rowKey={(row) => row.id}
          isLoading={benchmarksQuery.isPending}
          error={benchmarksQuery.error}
          onRetry={() => void benchmarksQuery.refetch()}
          emptyTitle="Chưa có lượt kiểm định AI nào"
          emptyDescription="Hãy tải lên bộ FLAIR + T1ce + seg.nii và chọn AI Worker ở phía trên để bắt đầu."
        />

        {total > pageSize && (
          <Pagination
            page={page}
            pageSize={pageSize}
            total={total}
            onPageChange={setPage}
          />
        )}
      </section>

      {selectedId && detailQuery.data && (
        <BenchmarkComparisonPanel
          detail={detailQuery.data}
          fixtureMode={fixtureMode}
        />
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Xóa lượt kiểm định AI?"
        description={
          deleteTarget
            ? `Thao tác này sẽ xóa vĩnh viễn "${deleteTarget.title}" và dọn sạch các tệp FLAIR, T1ce, nhãn bác sĩ và mask AI khỏi lưu trữ.`
            : ''
        }
        confirmLabel="Xóa và dọn tệp"
        variant="destructive"
        isSubmitting={deleteMutation.isPending}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) {
            deleteMutation.mutate(deleteTarget.id);
          }
        }}
      />
    </div>
  );
}
