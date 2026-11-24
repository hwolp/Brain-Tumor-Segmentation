import * as React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Cpu,
  Eye,
  Layers,
  Pencil,
  Trash2,
} from 'lucide-react';
import { useAuthStore } from '@/app/auth-store';
import { getSessionEpoch } from '@/shared/api/client';
import {
  cancelInferenceJob,
  createInferenceJob,
  fetchCaseDetail,
  fetchInferenceJob,
  fetchSystemAvailability,
} from '@/shared/api/endpoints';
import {
  ApiClientError,
  isAbortError,
  normalizeApiError,
  normalizeErrorCode,
} from '@/shared/api/errors';
import {
  MAX_UPLOAD_BYTES,
  deleteCase,
  deleteCaseVolume,
  updateCase,
  uploadCaseVolume,
  generateIdempotencyKey,
} from '@/shared/api/patientsCases';
import type {
  CaseCreateRequest,
  VolumeDto,
  VolumeModality,
} from '@/shared/api/types';
import { useQueryErrorToast } from '@/shared/api/useQueryErrorToast';
import { formatDateTimeVN, formatStudyDate } from '@/shared/lib/datetime';
import { BRATS_LABELS, BRATS_TUMOR_LABEL_IDS } from '@/shared/lib/labels';
import { formatVolumeSummary } from '@/shared/lib/volume';
import {
  Alert,
  Button,
  CardSkeleton,
  ConfirmDialog,
  ErrorState,
  StatusBadge,
  buttonVariants,
  useToast,
} from '@/shared/ui';
import { CaseFormModal } from '@/features/patients/CaseFormModal';
import {
  formatJobErrorReason,
  formatJobStage,
  getCaseReadinessMeta,
  getJobStateMeta,
} from './statusMappings';
import { type SlotUploadState, VolumeUploadSlot } from './VolumeUploadSlot';

function hasValidNiftiExtension(filename: string): boolean {
  const lower = filename.trim().toLowerCase();
  return lower.endsWith('.nii') || lower.endsWith('.nii.gz');
}

function hasSegInFilename(filename: string): boolean {
  return filename.trim().toLowerCase().includes('_seg');
}

export function CaseDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const user = useAuthStore((s) => s.user);
  const fixtureMode = useAuthStore((s) => s.fixtureMode);

  const [slotStates, setSlotStates] = React.useState<
    Record<VolumeModality, SlotUploadState>
  >({
    flair: { status: 'idle' },
    t1ce: { status: 'idle' },
  });
  const abortControllerRef = React.useRef<AbortController | null>(null);
  const activeUploadModalityRef = React.useRef<VolumeModality | null>(null);
  const currentCaseIdRef = React.useRef(id);
  currentCaseIdRef.current = id;

  const [editCaseOpen, setEditCaseOpen] = React.useState(false);
  const [isUpdatingCase, setIsUpdatingCase] = React.useState(false);
  const [createJobOpen, setCreateJobOpen] = React.useState(false);
  const [jobRequestError, setJobRequestError] = React.useState<string | null>(null);
  const [jobRequestErrorId, setJobRequestErrorId] = React.useState<
    string | null
  >(null);
  const [hasUncertainJobAttempt, setHasUncertainJobAttempt] = React.useState(false);
  const [jobActionNotice, setJobActionNotice] = React.useState<{
    variant: 'info' | 'warning' | 'error';
    title: string;
    description: string;
  } | null>(null);
  const inferenceIdempotencyKeyRef = React.useRef<string | null>(null);
  const createJobInFlightRef = React.useRef(false);
  const syncedTerminalJobRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    inferenceIdempotencyKeyRef.current = null;
    createJobInFlightRef.current = false;
    syncedTerminalJobRef.current = null;
    setJobRequestError(null);
    setJobRequestErrorId(null);
    setHasUncertainJobAttempt(false);
    setJobActionNotice(null);
  }, [id, user?.id]);

  const [deleteCaseOpen, setDeleteCaseOpen] = React.useState(false);
  const [isDeletingCase, setIsDeletingCase] = React.useState(false);
  const [deleteCaseError, setDeleteCaseError] = React.useState<{
    message: string;
    requestId: string | null;
  } | null>(null);

  const [deletingVolume, setDeletingVolume] = React.useState<VolumeDto | null>(
    null,
  );
  const [isDeletingVolume, setIsDeletingVolume] = React.useState(false);
  const [deleteVolumeError, setDeleteVolumeError] = React.useState<{
    message: string;
    requestId: string | null;
  } | null>(null);

  const caseQueryKey = [
    'doctor',
    user?.id ?? 'anon',
    'case',
    id,
    { fixtureMode },
  ] as const;

  const caseQuery = useQuery({
    queryKey: caseQueryKey,
    queryFn: ({ signal }) => fetchCaseDetail(id, { signal, fixtureMode }),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d) return false;
      const hasJobRow = d.jobs.some(
        (job) => job.state === 'queued' || job.state === 'running',
      );
      if (hasJobRow) return false;
      return d.caseData.latest_job_state === 'queued' ||
        d.caseData.latest_job_state === 'running'
        ? 3000
        : false;
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });

  const availabilityQuery = useQuery({
    queryKey: [
      'doctor',
      user?.id ?? 'anon',
      'system-availability',
      { fixtureMode },
    ] as const,
    queryFn: ({ signal }) =>
      fetchSystemAvailability({ signal, fixtureMode }),
    enabled: Boolean(id),
    refetchInterval: 15000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const baseActiveJob = React.useMemo(
    () =>
      caseQuery.data?.jobs.find(
        (job) => job.state === 'queued' || job.state === 'running',
      ) ?? null,
    [caseQuery.data?.jobs],
  );

  const activeJobQuery = useQuery({
    queryKey: [
      'doctor',
      user?.id ?? 'anon',
      'job',
      baseActiveJob?.id ?? 'none',
      { fixtureMode },
    ] as const,
    queryFn: ({ signal }) =>
      fetchInferenceJob(baseActiveJob!.id, {
        caseId: id,
        signal,
        fixtureMode,
      }),
    enabled: Boolean(baseActiveJob?.id),
    refetchInterval: (query) => {
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'hidden'
      ) {
        return false;
      }
      const st = query.state.data?.state ?? baseActiveJob?.state;
      return st === 'queued' || st === 'running' ? 3000 : false;
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  });

  const invalidateCaseRelatedQueries = React.useCallback(
    async (explicitPatientId?: string | null) => {
      const uid = user?.id ?? 'anon';
      const targetPatientId =
        explicitPatientId ?? caseQuery.data?.caseData.patient_id ?? null;
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['doctor', uid, 'case', id],
        }),
        queryClient.invalidateQueries({
          queryKey: ['doctor', uid, 'cases-overview'],
        }),
        targetPatientId
          ? queryClient.invalidateQueries({
              queryKey: ['doctor', uid, 'patient', targetPatientId],
            })
          : queryClient.invalidateQueries({
              queryKey: ['doctor', uid, 'patient'],
            }),
      ]);
    },
    [caseQuery.data?.caseData.patient_id, id, queryClient, user?.id],
  );

  React.useEffect(() => {
    const polled = activeJobQuery.data;
    if (!polled) return;
    const isTerminal =
      polled.state === 'succeeded' ||
      polled.state === 'failed' ||
      polled.state === 'cancelled';
    if (!isTerminal) return;
    const terminalKey = `${polled.id}:${polled.state}`;
    if (syncedTerminalJobRef.current === terminalKey) return;
    syncedTerminalJobRef.current = terminalKey;
    void invalidateCaseRelatedQueries();
  }, [activeJobQuery.data, invalidateCaseRelatedQueries]);

  React.useEffect(() => {
    if (!baseActiveJob?.id) return;
    const refetchWhenActive = () => {
      if (
        typeof document === 'undefined' ||
        document.visibilityState === 'visible'
      ) {
        void activeJobQuery.refetch();
      }
    };
    window.addEventListener('online', refetchWhenActive);
    document.addEventListener('visibilitychange', refetchWhenActive);
    return () => {
      window.removeEventListener('online', refetchWhenActive);
      document.removeEventListener('visibilitychange', refetchWhenActive);
    };
  }, [baseActiveJob?.id, activeJobQuery]);

  const intakePaused = availabilityQuery.data?.accepting_jobs === false;
  const workerOffline =
    availabilityQuery.data?.accepting_jobs === true &&
    availabilityQuery.data?.worker_online === false;

  const createJobMutation = useMutation({
    mutationFn: (key: string) =>
      createInferenceJob(id, key, { fixtureMode }),
    onSuccess: async ({ job }) => {
      inferenceIdempotencyKeyRef.current = null;
      setHasUncertainJobAttempt(false);
      setCreateJobOpen(false);
      setJobRequestError(null);
      setJobRequestErrorId(null);
      setJobActionNotice(null);
      queryClient.setQueryData<typeof caseQuery.data>(caseQueryKey, (old) =>
        old
          ? {
              ...old,
              caseData: {
                ...old.caseData,
                latest_job_state: job.state,
                is_inputs_locked: true,
              },
              jobs: [job, ...old.jobs.filter((item) => item.id !== job.id)],
            }
          : old,
      );
      await invalidateCaseRelatedQueries();
      pushToast({
        variant: workerOffline ? 'info' : 'success',
        title: workerOffline
          ? 'Đã xếp hàng tác vụ AI (chờ worker)'
          : 'Đã gửi tác vụ phân đoạn AI',
        description: workerOffline
          ? 'Tác vụ phân đoạn đã vào hàng đợi và sẽ tự động chạy khi worker trực tuyến.'
          : 'Tác vụ phân đoạn đang chờ worker nhận xử lý.',
      });
    },
    onError: async (error) => {
      if (isAbortError(error)) {
        return;
      }
      const normalized = normalizeApiError(error);
      const code = normalizeErrorCode(normalized.code);

      if (
        normalized.status === 409 &&
        (code === 'active_job_conflict' || code === 'active_job_exists')
      ) {
        inferenceIdempotencyKeyRef.current = null;
        setHasUncertainJobAttempt(false);
        setCreateJobOpen(false);
        setJobRequestError(null);
        setJobRequestErrorId(null);
        setJobActionNotice({
          variant: 'info',
          title: 'Ca chụp đã có tác vụ AI đang hoạt động',
          description:
            'Hệ thống đã tải và hiển thị tác vụ đang hoạt động của ca này thay vì tạo tác vụ mới.',
        });
        await caseQuery.refetch();
        return;
      }

      const isAmbiguousFailure =
        code === 'network_error' ||
        normalized.status === 0 ||
        (normalized.status >= 500 && normalized.status !== 503);

      if (isAmbiguousFailure) {
        setHasUncertainJobAttempt(true);
        setJobRequestErrorId(normalized.requestId);
        setJobRequestError(
          'Chưa nhận được xác nhận từ máy chủ. Bấm gửi lại sẽ giữ nguyên khóa thao tác để tránh tạo hai job trùng.',
        );
        return;
      }

      // Lỗi xác định (4xx hoặc 503 tạm dừng nhận job): hủy key cũ để lần thử mới sinh key mới
      inferenceIdempotencyKeyRef.current = null;
      setHasUncertainJobAttempt(false);
      if (normalized.status === 503 || code === 'not_accepting_jobs') {
        void availabilityQuery.refetch();
      }
      setJobRequestErrorId(normalized.requestId);
      setJobRequestError(normalized.message);
    },
    onSettled: () => {
      createJobInFlightRef.current = false;
    },
  });

  const cancelJobMutation = useMutation({
    mutationFn: (jobId: string) =>
      cancelInferenceJob(jobId, { fixtureMode }),
    onSuccess: async (cancelledJob) => {
      setJobActionNotice(null);
      queryClient.setQueryData<typeof caseQuery.data>(caseQueryKey, (old) =>
        old
          ? {
              ...old,
              caseData: {
                ...old.caseData,
                latest_job_state: cancelledJob.state,
              },
              jobs: old.jobs.map((item) =>
                item.id === cancelledJob.id ? cancelledJob : item,
              ),
            }
          : old,
      );
      await invalidateCaseRelatedQueries();
      pushToast({
        variant: 'success',
        title: 'Đã hủy tác vụ đang chờ',
        description: 'Ca chụp đã sẵn sàng để gửi job mới.',
      });
    },
    onError: async (error) => {
      if (isAbortError(error)) {
        return;
      }
      const normalized = normalizeApiError(error);
      const code = normalizeErrorCode(normalized.code);
      if (code === 'job_not_cancellable' || normalized.status === 409) {
        setJobActionNotice({
          variant: 'warning',
          title: 'Không thể hủy tác vụ AI',
          description:
            'Tác vụ đã được worker nhận xử lý (đang chạy) hoặc đã kết thúc nên không thể hủy. Đã cập nhật lại trạng thái mới nhất.',
        });
        pushToast({
          variant: 'warning',
          title: 'Không thể hủy tác vụ AI',
          description:
            'Tác vụ đã chuyển sang trạng thái đang xử lý trên worker.',
          requestId: normalized.requestId,
        });
        await Promise.all([
          activeJobQuery.refetch(),
          caseQuery.refetch(),
        ]);
        return;
      }
      setJobActionNotice({
        variant: 'error',
        title: 'Không thể hủy tác vụ AI',
        description: normalized.message,
      });
      pushToast({
        variant: 'error',
        title: 'Không thể hủy tác vụ AI',
        description: normalized.message,
        requestId: normalized.requestId,
      });
    },
  });

  const openCreateJobDialogForNewAttempt = () => {
    if (!hasUncertainJobAttempt) {
      inferenceIdempotencyKeyRef.current = null;
      setJobRequestError(null);
      setJobRequestErrorId(null);
      createJobMutation.reset();
    }
    setCreateJobOpen(true);
  };

  const handleConfirmCreateJob = () => {
    if (createJobInFlightRef.current || createJobMutation.isPending) {
      return;
    }
    createJobInFlightRef.current = true;
    inferenceIdempotencyKeyRef.current ??= generateIdempotencyKey();
    createJobMutation.mutate(inferenceIdempotencyKeyRef.current);
  };

  const isAccessOrNotFoundError =
    caseQuery.error instanceof ApiClientError &&
    (caseQuery.error.status === 403 || caseQuery.error.status === 404);
  const data = isAccessOrNotFoundError ? undefined : caseQuery.data;

  useQueryErrorToast(
    data ? null : caseQuery.error,
    'Không thể tải thông tin ca chụp',
  );
  const flairVolume = data?.volumes.find((v) => v.modality === 'flair');
  const t1ceVolume = data?.volumes.find((v) => v.modality === 't1ce');
  const mergedJobs = React.useMemo(() => {
    const rawJobs = data?.jobs ?? [];
    const polled = activeJobQuery.data;
    if (!polled) return rawJobs;
    const exists = rawJobs.some((item) => item.id === polled.id);
    if (!exists) return [polled, ...rawJobs];
    return rawJobs.map((item) => (item.id === polled.id ? polled : item));
  }, [data?.jobs, activeJobQuery.data]);
  const latestJob = mergedJobs[0];
  const olderJobs = mergedJobs.slice(1);

  const hasActiveJob = Boolean(
    data &&
      mergedJobs.some((j) => j.state === 'queued' || j.state === 'running'),
  );

  const hasMaskVersions = Boolean(
    data &&
      (data.caseData.latest_mask_version_id !== null ||
        data.maskVersions.length > 0),
  );

  const isInputsLocked = Boolean(
    data?.caseData.is_inputs_locked ||
      data?.caseData.inputs_locked_at ||
      hasActiveJob ||
      hasMaskVersions,
  );

  const lockReason =
    !isInputsLocked || hasActiveJob
      ? null
      : 'Ca chụp đã có phiên bản mask; hãy tạo ca mới nếu muốn dùng bộ ảnh khác.';

  const validVolumes = (data?.volumes ?? []).filter(
    (v) => v.validation_status === 'valid',
  );
  const hasValidVolume = validVolumes.length > 0;
  const canRunInference = Boolean(
    data &&
      data.caseData.readiness === 'ready' &&
      data.caseData.can_run_inference !== false,
  );

  const blockingReasons = data?.caseData.blocking_reasons ?? [];

  const startUploadForSlot = React.useCallback(
    async (modality: VolumeModality, file: File) => {
      const uploadEpoch = getSessionEpoch();
      activeUploadModalityRef.current = modality;
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const releaseActiveUpload = () => {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        if (activeUploadModalityRef.current === modality) {
          activeUploadModalityRef.current = null;
        }
      };

      setSlotStates((prev) => ({
        ...prev,
        [modality]: {
          status: 'uploading',
          file,
          progressPercent: 0,
          loadedBytes: 0,
          totalBytes: file.size,
          phase: 'uploading',
        },
      }));

      try {
        await uploadCaseVolume(id, modality, file, {
          fixtureMode,
          signal: controller.signal,
          onProgress: (loaded, total) => {
            if (
              uploadEpoch !== getSessionEpoch() ||
              currentCaseIdRef.current !== id
            ) {
              return;
            }
            const pct =
              total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
            setSlotStates((prev) => {
              const curr = prev[modality];
              if (curr.status !== 'uploading') return prev;
              return {
                ...prev,
                [modality]: {
                  ...curr,
                  loadedBytes: loaded,
                  totalBytes: total,
                  progressPercent: pct,
                },
              };
            });
          },
          onValidatingPhase: () => {
            if (
              uploadEpoch !== getSessionEpoch() ||
              currentCaseIdRef.current !== id
            ) {
              return;
            }
            setSlotStates((prev) => {
              const curr = prev[modality];
              if (curr.status !== 'uploading') return prev;
              return {
                ...prev,
                [modality]: {
                  ...curr,
                  progressPercent: 100,
                  phase: 'validating',
                },
              };
            });
          },
        });

        releaseActiveUpload();
        if (
          uploadEpoch !== getSessionEpoch() ||
          currentCaseIdRef.current !== id
        ) {
          return;
        }
        setSlotStates((prev) => ({
          ...prev,
          [modality]: { status: 'idle' },
        }));
        await invalidateCaseRelatedQueries();
        pushToast({
          variant: 'success',
          title: `Đã tải lên xung ${modality.toUpperCase()}`,
          description: `${file.name} đã vượt qua kiểm tra NIfTI.`,
        });
      } catch (error) {
        releaseActiveUpload();
        if (
          uploadEpoch !== getSessionEpoch() ||
          currentCaseIdRef.current !== id
        ) {
          return;
        }
        if (isAbortError(error)) {
          setSlotStates((prev) => ({
            ...prev,
            [modality]: { status: 'idle' },
          }));
          await caseQuery.refetch();
        } else {
          const normalized = normalizeApiError(error);
          setSlotStates((prev) => ({
            ...prev,
            [modality]: {
              status: 'error',
              message: normalized.message,
              requestId: normalized.requestId,
              fileName: file.name,
            },
          }));
          await caseQuery.refetch();
        }
      } finally {
        releaseActiveUpload();
      }
    },
    [id, fixtureMode, invalidateCaseRelatedQueries, pushToast, caseQuery],
  );

  // Hàng đợi tuần tự: chỉ upload 1 xung tại một thời điểm
  React.useEffect(() => {
    if (activeUploadModalityRef.current !== null) {
      return;
    }
    const isAnyUploading =
      slotStates.flair.status === 'uploading' ||
      slotStates.t1ce.status === 'uploading';
    if (isAnyUploading) {
      return;
    }

    const nextModality: VolumeModality | null =
      slotStates.flair.status === 'queued'
        ? 'flair'
        : slotStates.t1ce.status === 'queued'
          ? 't1ce'
          : null;

    if (nextModality) {
      const queuedState = slotStates[nextModality];
      if (queuedState.status === 'queued') {
        void startUploadForSlot(nextModality, queuedState.file);
      }
    }
  }, [slotStates, startUploadForSlot]);

  React.useEffect(() => {
    setSlotStates({
      flair: { status: 'idle' },
      t1ce: { status: 'idle' },
    });
    return () => {
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      activeUploadModalityRef.current = null;
    };
  }, [id]);

  const handleSelectFile = (modality: VolumeModality, file: File) => {
    if (!hasValidNiftiExtension(file.name)) {
      setSlotStates((prev) => ({
        ...prev,
        [modality]: {
          status: 'error',
          message:
            'Định dạng tệp không hợp lệ. Chỉ chấp nhận tệp NIfTI (.nii hoặc .nii.gz).',
          requestId: null,
          fileName: file.name,
        },
      }));
      return;
    }

    if (file.size <= 0) {
      setSlotStates((prev) => ({
        ...prev,
        [modality]: {
          status: 'error',
          message: 'Tệp rỗng (0 bytes). Vui lòng chọn tệp NIfTI hợp lệ.',
          requestId: null,
          fileName: file.name,
        },
      }));
      return;
    }

    if (file.size > MAX_UPLOAD_BYTES) {
      setSlotStates((prev) => ({
        ...prev,
        [modality]: {
          status: 'error',
          message: `Dung lượng tệp (${(file.size / (1024 * 1024)).toFixed(1)} MiB) vượt quá giới hạn tối đa 100 MiB.`,
          requestId: null,
          fileName: file.name,
        },
      }));
      return;
    }

    if (hasSegInFilename(file.name)) {
      setSlotStates((prev) => ({
        ...prev,
        [modality]: {
          status: 'seg_warning',
          file,
        },
      }));
      return;
    }

    setSlotStates((prev) => ({
      ...prev,
      [modality]: {
        status: 'queued',
        file,
      },
    }));
  };

  const handleConfirmSegUpload = (modality: VolumeModality) => {
    setSlotStates((prev) => {
      const current = prev[modality];
      if (current.status !== 'seg_warning') return prev;
      return {
        ...prev,
        [modality]: {
          status: 'queued',
          file: current.file,
        },
      };
    });
  };

  const handleDismissSlotState = (modality: VolumeModality) => {
    setSlotStates((prev) => ({
      ...prev,
      [modality]: { status: 'idle' },
    }));
  };

  const handleCancelUpload = (modality: VolumeModality) => {
    const current = slotStates[modality];
    if (current.status === 'queued') {
      setSlotStates((prev) => ({
        ...prev,
        [modality]: { status: 'idle' },
      }));
      return;
    }
    if (
      current.status === 'uploading' &&
      activeUploadModalityRef.current === modality
    ) {
      abortControllerRef.current?.abort();
    }
  };

  const handleConfirmDeleteVolume = async () => {
    if (!deletingVolume) return;
    setIsDeletingVolume(true);
    setDeleteVolumeError(null);
    try {
      const deletion = await deleteCaseVolume(id, deletingVolume.id, {
        fixtureMode,
      });
      const mod = deletingVolume.modality.toUpperCase();
      setDeletingVolume(null);
      await invalidateCaseRelatedQueries(data?.caseData.patient_id);
      pushToast({
        variant: deletion.status === 'deleting' ? 'info' : 'success',
        title:
          deletion.status === 'deleting'
            ? `Đã thu hồi xung ${mod}`
            : `Đã xóa xung ${mod}`,
        description:
          deletion.status === 'deleting'
            ? 'Xung MRI đã được gỡ khỏi ca chụp; hệ thống đang tiếp tục dọn dẹp tệp lưu trữ nền.'
            : 'Bạn có thể tải lên lại xung MRI mới cho vị trí này.',
      });
    } catch (error) {
      const normalized = normalizeApiError(error);
      setDeleteVolumeError({
        message: normalized.message,
        requestId: normalized.requestId,
      });
    } finally {
      setIsDeletingVolume(false);
    }
  };

  const handleUpdateCase = async (payload: CaseCreateRequest) => {
    setIsUpdatingCase(true);
    try {
      await updateCase(id, payload, { fixtureMode });
      setEditCaseOpen(false);
      await invalidateCaseRelatedQueries(data?.caseData.patient_id);
      pushToast({
        variant: 'success',
        title: 'Đã cập nhật ca chụp',
      });
    } finally {
      setIsUpdatingCase(false);
    }
  };

  const handleConfirmDeleteCase = async () => {
    setIsDeletingCase(true);
    setDeleteCaseError(null);
    const parentPatientId = data?.caseData.patient_id;
    try {
      const deletion = await deleteCase(id, { fixtureMode });
      setDeleteCaseOpen(false);
      await queryClient.cancelQueries({
        queryKey: ['doctor', user?.id ?? 'anon', 'case', id],
      });
      await Promise.all([
        parentPatientId
          ? queryClient.invalidateQueries({
              queryKey: ['doctor', user?.id ?? 'anon', 'patient', parentPatientId],
            })
          : Promise.resolve(),
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
            ? 'Đã thu hồi truy cập ca chụp'
            : 'Đã xóa ca chụp',
        description:
          deletion.status === 'deleting'
            ? 'Quyền truy cập ca chụp đã bị thu hồi ngay; hệ thống đang tiếp tục dọn dẹp tệp lưu trữ nền.'
            : 'Ca chụp và toàn bộ tệp MRI/mask liên quan đã được xóa.',
      });
      navigate(
        parentPatientId
          ? `/doctor/patients/${parentPatientId}`
          : '/doctor/patients',
        { replace: true },
      );
      queryClient.removeQueries({
        queryKey: ['doctor', user?.id ?? 'anon', 'case', id],
      });
    } catch (error) {
      const normalized = normalizeApiError(error);
      setDeleteCaseError({
        message: normalized.message,
        requestId: normalized.requestId,
      });
    } finally {
      setIsDeletingCase(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          to={
            data?.caseData.patient_id
              ? `/doctor/patients/${data.caseData.patient_id}`
              : '/doctor/patients'
          }
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Quay lại hồ sơ bệnh nhân
        </Link>

        {data && (
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditCaseOpen(true)}
            >
              <Pencil className="size-4" aria-hidden="true" />
              Sửa ca chụp
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setDeleteCaseError(null);
                setDeleteCaseOpen(true);
              }}
            >
              <Trash2 className="size-4" aria-hidden="true" />
              Xóa ca chụp
            </Button>

            {hasValidVolume ? (
              <Link
                to={`/doctor/cases/${id}/viewer`}
                className={buttonVariants({ variant: 'primary', size: 'sm' })}
              >
                <Eye className="size-4" aria-hidden="true" />
                Mở Viewer / Chỉnh mask
              </Link>
            ) : (
              <Button
                variant="primary"
                size="sm"
                disabled
                title="Cần ít nhất 1 xung MRI hợp lệ (FLAIR hoặc T1ce) để mở Viewer"
              >
                <Eye className="size-4" aria-hidden="true" />
                Mở Viewer / Chỉnh mask
              </Button>
            )}
          </div>
        )}
      </div>

      {caseQuery.isPending && <CardSkeleton />}

      {caseQuery.isError && !data && (
        <ErrorState
          title="Không thể truy cập ca chụp"
          error={caseQuery.error}
          onRetry={() => {
            void caseQuery.refetch();
          }}
        />
      )}

      {caseQuery.isRefetchError && data && (
        <Alert
          variant="warning"
          title="Chưa cập nhật trạng thái ca chụp mới nhất"
          description="Mất kết nối tạm thời tới máy chủ API. Đang hiển thị dữ liệu gần nhất đã tải được."
        />
      )}

      {data && (
        <>
          <section className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex min-w-[240px] flex-1 flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  {data.caseData.patient_code && (
                    <span className="inline-flex items-center rounded-md border border-[var(--status-info-border)] bg-[var(--status-info-bg)] px-2 py-0.5 font-mono text-xs font-semibold text-[var(--action-primary)]">
                      Mã BN: {data.caseData.patient_code}
                    </span>
                  )}
                  <span className="break-all font-mono text-xs font-semibold text-[var(--action-primary)]">
                    Mã ca: {data.caseData.id}
                  </span>
                  <StatusBadge
                    label={getCaseReadinessMeta(data.caseData.readiness).label}
                    tone={getCaseReadinessMeta(data.caseData.readiness).tone}
                  />
                </div>
                <h1 className="text-2xl font-bold text-[var(--text-primary)]">
                  Ca chụp ngày {formatStudyDate(data.caseData.study_date)}
                </h1>
                <p className="text-sm text-[var(--text-secondary)]">
                  Cập nhật gần nhất: {formatDateTimeVN(data.caseData.updated_at)}
                </p>
              </div>

              <Button
                variant={
                  canRunInference && !hasActiveJob && !intakePaused
                    ? 'primary'
                    : 'outline'
                }
                className="w-full sm:w-auto"
                disabled={
                  !canRunInference ||
                  hasActiveJob ||
                  intakePaused ||
                  createJobMutation.isPending
                }
                onClick={openCreateJobDialogForNewAttempt}
                title={
                  intakePaused
                    ? 'Hệ thống hiện đang tạm dừng nhận tác vụ AI mới'
                    : canRunInference && !hasActiveJob
                      ? workerOffline
                        ? 'Worker đang ngoại tuyến — job sẽ xếp vào hàng đợi chờ worker'
                        : 'Gửi ca chụp tới worker để chạy TDA-SegUNet'
                      : blockingReasons[0] ??
                        (hasActiveJob
                          ? 'Ca chụp đã có một job đang hoạt động'
                          : 'Cần đủ 2 xung FLAIR + T1ce hợp lệ và khớp hình học để chạy AI')
                }
                isLoading={createJobMutation.isPending}
                loadingText="Đang gửi job..."
              >
                <Cpu className="size-4" aria-hidden="true" />
                {hasActiveJob
                  ? 'Job AI đang hoạt động'
                  : intakePaused
                    ? 'Tạm dừng nhận job AI'
                    : 'Chạy phân đoạn AI'}
              </Button>
            </div>

            {data.caseData.notes && (
              <p className="mt-4 rounded-md bg-[var(--bg-muted)] p-3 text-sm text-[var(--text-primary)]">
                {data.caseData.notes}
              </p>
            )}

            {intakePaused && (
              <div className="mt-4">
                <Alert
                  variant="warning"
                  title="Hệ thống tạm dừng nhận tác vụ phân đoạn mới"
                  description="Chế độ bảo trì / cấu hình vận hành đang tạm ngưng nhận job AI mới. Các job đã nhận trước đó vẫn tiếp tục xử lý và bạn vẫn có thể mở Viewer để chỉnh sửa mask thủ công."
                />
              </div>
            )}

            {!intakePaused && workerOffline && canRunInference && !hasActiveJob && (
              <div className="mt-4">
                <Alert
                  variant="warning"
                  title="Worker AI đang ngoại tuyến — tác vụ mới sẽ chờ worker"
                  description="Chưa ghi nhận heartbeat từ worker trong 90 giây qua. Bạn vẫn có thể gửi tác vụ vào hàng đợi; tác vụ sẽ chờ worker trực tuyến để bắt đầu chạy."
                />
              </div>
            )}

            {availabilityQuery.isError && (
              <div className="mt-4">
                <Alert
                  variant="warning"
                  title="Mất kết nối API kiểm tra hàng đợi"
                  description="Chưa kiểm tra được trạng thái hệ thống từ máy chủ API (khác với trạng thái worker ngoại tuyến)."
                />
              </div>
            )}

            {!canRunInference && (
              <div className="mt-4">
                <Alert
                  variant={
                    data.caseData.readiness === 'invalid' ? 'error' : 'info'
                  }
                  title="Trạng thái sẵn sàng AI"
                  description={
                    blockingReasons.length > 0
                      ? blockingReasons.join(' · ')
                      : !hasValidVolume
                        ? 'Chưa có xung MRI hợp lệ. Cần tải lên ít nhất 1 xung để mở Viewer, và đủ FLAIR + T1ce khớp hình học để chạy AI.'
                        : 'Đã có thể mở Viewer / chỉnh mask thủ công. Cần đủ cả FLAIR và T1ce hợp lệ, khớp hình học để chạy AI.'
                  }
                />
              </div>
            )}
          </section>

          <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <VolumeUploadSlot
              modality="flair"
              title="Xung FLAIR"
              volume={flairVolume}
              uploadState={slotStates.flair}
              isInputsLocked={isInputsLocked}
              lockReason={lockReason}
              onSelectFile={handleSelectFile}
              onConfirmSegUpload={handleConfirmSegUpload}
              onDismissSlotState={handleDismissSlotState}
              onCancelUpload={handleCancelUpload}
              onRequestDeleteVolume={(vol) => {
                setDeleteVolumeError(null);
                setDeletingVolume(vol);
              }}
            />
            <VolumeUploadSlot
              modality="t1ce"
              title="Xung T1ce"
              volume={t1ceVolume}
              uploadState={slotStates.t1ce}
              isInputsLocked={isInputsLocked}
              lockReason={lockReason}
              onSelectFile={handleSelectFile}
              onConfirmSegUpload={handleConfirmSegUpload}
              onDismissSlotState={handleDismissSlotState}
              onCancelUpload={handleCancelUpload}
              onRequestDeleteVolume={(vol) => {
                setDeleteVolumeError(null);
                setDeletingVolume(vol);
              }}
            />
          </section>

          <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="flex flex-col gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
              <h2 className="text-base font-semibold text-[var(--text-primary)]">
                Trạng thái tác vụ AI gần nhất
              </h2>

              {jobActionNotice && (
                <Alert
                  variant={jobActionNotice.variant}
                  title={jobActionNotice.title}
                  description={jobActionNotice.description}
                />
              )}

              {latestJob ? (
                <div className="flex flex-col gap-2 text-sm">
                  {activeJobQuery.isError &&
                    (latestJob.state === 'queued' ||
                      latestJob.state === 'running') && (
                      <Alert
                        variant="warning"
                        title="Chưa cập nhật trạng thái tác vụ"
                        description="Mất kết nối tạm thời tới máy chủ API nên chưa cập nhật trạng thái mới. Tác vụ không bị chuyển sang thất bại; hệ thống sẽ tự động cập nhật lại khi kết nối phục hồi."
                      />
                    )}

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="break-all font-mono text-xs text-[var(--text-secondary)]">
                      Job ID: {latestJob.id}
                    </span>
                    <StatusBadge
                      label={getJobStateMeta(latestJob.state).label}
                      tone={getJobStateMeta(latestJob.state).tone}
                    />
                  </div>
                  <p className="text-[var(--text-secondary)]">
                    Giai đoạn: <strong>{formatJobStage(latestJob.stage)}</strong>
                    {latestJob.completed_slices !== null &&
                      latestJob.total_slices !== null &&
                      latestJob.total_slices > 0 &&
                      ` (${latestJob.completed_slices}/${latestJob.total_slices} lát)`}
                  </p>
                  {latestJob.state === 'running' &&
                    latestJob.completed_slices !== null &&
                    latestJob.total_slices !== null &&
                    latestJob.total_slices > 0 && (
                      <div
                        role="progressbar"
                        aria-label="Tiến độ xử lý lát cắt AI"
                        aria-valuemin={0}
                        aria-valuemax={latestJob.total_slices}
                        aria-valuenow={Math.min(
                          latestJob.completed_slices,
                          latestJob.total_slices,
                        )}
                        className="h-2 w-full overflow-hidden rounded-full bg-[var(--bg-muted)]"
                      >
                        <div
                          className="h-full rounded-full bg-[var(--action-primary)] transition-all"
                          style={{
                            width: `${Math.min(
                              100,
                              Math.round(
                                (latestJob.completed_slices /
                                  latestJob.total_slices) *
                                  100,
                              ),
                            )}%`,
                          }}
                        />
                      </div>
                    )}
                  <p className="text-xs text-[var(--text-secondary)]">
                    Tạo lúc: {formatDateTimeVN(latestJob.created_at)} · Lượt thử:{' '}
                    {latestJob.attempt_count}
                    {latestJob.attempt_count > 1
                      ? ` (gồm ${latestJob.attempt_count - 1} lần tự động thử lại)`
                      : ''}
                  </p>
                  {latestJob.state === 'queued' && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="self-start"
                      disabled={cancelJobMutation.isPending}
                      isLoading={cancelJobMutation.isPending}
                      loadingText="Đang hủy..."
                      onClick={() => cancelJobMutation.mutate(latestJob.id)}
                    >
                      Hủy job đang chờ
                    </Button>
                  )}
                  {latestJob.result_mask_version_id && (
                    <Link
                      to={`/doctor/cases/${id}/viewer?version=${encodeURIComponent(latestJob.result_mask_version_id)}`}
                      className={buttonVariants({
                        variant: 'outline',
                        size: 'sm',
                        className: 'self-start',
                      })}
                    >
                      Xem kết quả AI
                    </Link>
                  )}
                  {latestJob.state === 'failed' && (
                    <>
                      <Alert
                        variant="error"
                        title="Tác vụ phân đoạn thất bại"
                        description={`${formatJobErrorReason(latestJob.error_code)} Các phiên bản mask đã lưu trước đó vẫn được giữ nguyên.`}
                      >
                        {latestJob.error_code && (
                          <code className="sr-only">
                            Mã lỗi kỹ thuật: {latestJob.error_code}
                          </code>
                        )}
                      </Alert>
                      {canRunInference && !hasActiveJob && !intakePaused && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="self-start"
                          onClick={() => {
                            inferenceIdempotencyKeyRef.current = null;
                            setHasUncertainJobAttempt(false);
                            setJobRequestError(null);
                            setJobRequestErrorId(null);
                            createJobMutation.reset();
                            setCreateJobOpen(true);
                          }}
                        >
                          Thử lại phân đoạn AI
                        </Button>
                      )}
                    </>
                  )}

                  {olderJobs.length > 0 && (
                    <div className="mt-2 border-t border-[var(--border-default)] pt-3">
                      <p className="mb-2 text-xs font-semibold text-[var(--text-secondary)]">
                        Lịch sử tác vụ trước đó ({olderJobs.length})
                      </p>
                      <ul className="flex flex-col gap-2">
                        {olderJobs.map((oldJob) => (
                          <li
                            key={oldJob.id}
                            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--border-default)] px-2.5 py-2 text-xs"
                          >
                            <div className="flex min-w-0 flex-col gap-0.5">
                              <span className="break-all font-mono text-[var(--text-secondary)]">
                                {oldJob.id}
                              </span>
                              <span className="text-[var(--text-secondary)]">
                                {formatDateTimeVN(oldJob.created_at)} · Lượt thử:{' '}
                                {oldJob.attempt_count}
                              </span>
                            </div>
                            <div className="flex items-center gap-2">
                              <StatusBadge
                                label={getJobStateMeta(oldJob.state).label}
                                tone={getJobStateMeta(oldJob.state).tone}
                              />
                              {oldJob.result_mask_version_id && (
                                <Link
                                  to={`/doctor/cases/${id}/viewer?version=${encodeURIComponent(oldJob.result_mask_version_id)}`}
                                  className={buttonVariants({
                                    variant: 'outline',
                                    size: 'sm',
                                  })}
                                >
                                  Xem kết quả AI
                                </Link>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-[var(--text-secondary)]">
                  Chưa có tác vụ phân đoạn nào được gửi cho ca này.
                </p>
              )}
            </div>

            <div className="flex flex-col gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-[var(--text-primary)]">
                  Phiên bản Mask ({data.maskVersions.length})
                </h2>
                <Layers
                  className="size-5 text-[var(--text-secondary)]"
                  aria-hidden="true"
                />
              </div>

              {data.maskVersions.length === 0 ? (
                <p className="text-sm text-[var(--text-secondary)]">
                  Chưa có phiên bản mask nào được lưu. Bạn có thể mở Viewer để tạo mask thủ công hoặc chạy AI khi đủ hai xung.
                </p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {data.maskVersions.map((ver) => (
                    <li
                      key={ver.id}
                      className="rounded-lg border border-[var(--border-default)] p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm">
                            Phiên bản v{ver.version_number}
                          </span>
                          <StatusBadge
                            label={ver.source === 'ai' ? 'AI gốc' : 'Chỉnh tay'}
                            tone={ver.source === 'ai' ? 'info' : 'neutral'}
                          />
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-[var(--text-secondary)]">
                            {formatDateTimeVN(ver.created_at)}
                          </span>
                          {hasValidVolume && (
                            <Link
                              to={`/doctor/cases/${id}/viewer?version=${encodeURIComponent(ver.id)}`}
                              className={buttonVariants({
                                variant: 'outline',
                                size: 'sm',
                              })}
                            >
                              Mở v{ver.version_number}
                            </Link>
                          )}
                        </div>
                      </div>
                      <p className="mt-1 text-xs text-[var(--text-secondary)]">
                        {ver.source === 'ai'
                          ? `Model: ${ver.model_version_id ?? 'TDA-SegUNet'}`
                          : `Người tạo: ${ver.created_by_name ?? 'Bác sĩ'}`}
                      </p>
                      {ver.note && (
                        <p className="mt-1 text-xs text-[var(--text-secondary)]">
                          {ver.note}
                        </p>
                      )}
                      <div className="mt-2.5 grid grid-cols-1 gap-1.5">
                        {BRATS_TUMOR_LABEL_IDS.map((lblId) => {
                          const spec = BRATS_LABELS[lblId];
                          const mm3 = ver.label_volumes_mm3[String(lblId)] ?? 0;
                          const volumeText = formatVolumeSummary(mm3);
                          return (
                            <div
                              key={lblId}
                              title={`${spec.shortName}: ${volumeText}`}
                              className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 rounded-md border border-[var(--border-default)] bg-[var(--bg-muted)] px-2.5 py-1.5 text-xs"
                            >
                              <span className="flex shrink-0 items-center gap-1.5 font-medium text-[var(--text-primary)]">
                                <span
                                  className="size-3 shrink-0 rounded-sm"
                                  style={{
                                    backgroundColor: spec.hexColor ?? undefined,
                                  }}
                                  aria-hidden="true"
                                />
                                {spec.shortName}:
                              </span>
                              <span className="whitespace-nowrap font-mono tabular-nums text-[var(--text-secondary)]">
                                {volumeText}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <CaseFormModal
            open={editCaseOpen}
            mode="edit"
            initialCase={data.caseData}
            isSubmitting={isUpdatingCase}
            onClose={() => setEditCaseOpen(false)}
            onEditSubmit={handleUpdateCase}
          />

          <ConfirmDialog
            open={createJobOpen}
            onClose={() => {
              if (!createJobMutation.isPending) setCreateJobOpen(false);
            }}
            onConfirm={handleConfirmCreateJob}
            title="Gửi ca chụp chạy phân đoạn AI?"
            description="Hệ thống sẽ khóa bộ xung MRI hiện tại, thêm một job vào hàng đợi và tạo phiên bản mask mới sau khi worker hoàn tất. Các phiên bản mask đang có sẽ được giữ nguyên."
            confirmLabel={
              hasUncertainJobAttempt
                ? 'Gửi lại (cùng khóa)'
                : 'Gửi vào hàng đợi'
            }
            isSubmitting={createJobMutation.isPending}
          >
            <div className="flex flex-col gap-3">
              {workerOffline && (
                <Alert
                  variant="warning"
                  title="Tác vụ sẽ chờ worker trực tuyến"
                  description="Worker hiện đang ngoại tuyến (quá 90 giây chưa có heartbeat). Tác vụ sẽ được xếp vào hàng đợi (Đang chờ) và tự động chạy khi worker kết nối lại."
                />
              )}
              {jobRequestError && (
                <Alert
                  variant="error"
                  title="Chưa xác nhận được yêu cầu"
                  description={jobRequestError}
                >
                  {jobRequestErrorId && (
                    <span className="sr-only">
                      Mã tham chiếu: {jobRequestErrorId}
                    </span>
                  )}
                </Alert>
              )}
            </div>
          </ConfirmDialog>

          <ConfirmDialog
            open={Boolean(deletingVolume)}
            onClose={() => {
              if (!isDeletingVolume) {
                setDeletingVolume(null);
                setDeleteVolumeError(null);
              }
            }}
            onConfirm={handleConfirmDeleteVolume}
            title="Xóa xung MRI khỏi ca chụp?"
            description={
              deletingVolume
                ? `Xóa xung ${deletingVolume.modality.toUpperCase()} (${deletingVolume.filename ?? deletingVolume.file_id}) khỏi ca chụp này. Bạn có thể tải lên lại tệp khác sau khi xóa.`
                : ''
            }
            confirmLabel="Xóa xung"
            variant="destructive"
            isSubmitting={isDeletingVolume}
          >
            {deleteVolumeError && (
              <Alert
                variant="error"
                title="Không thể xóa xung MRI"
                description={deleteVolumeError.message}
              >
                {deleteVolumeError.requestId && (
                  <span className="sr-only">
                    Mã tham chiếu: {deleteVolumeError.requestId}
                  </span>
                )}
              </Alert>
            )}
          </ConfirmDialog>

          <ConfirmDialog
            open={deleteCaseOpen}
            onClose={() => {
              if (!isDeletingCase) {
                setDeleteCaseOpen(false);
                setDeleteCaseError(null);
              }
            }}
            onConfirm={handleConfirmDeleteCase}
            title="Xóa ca chụp MRI?"
            description="Thao tác này sẽ xóa ca chụp, các tệp MRI và toàn bộ phiên bản mask liên quan. Không thể hoàn tác."
            confirmLabel="Xóa ca chụp"
            variant="destructive"
            isSubmitting={isDeletingCase}
          >
            {deleteCaseError && (
              <Alert
                variant="error"
                title="Không thể xóa ca chụp"
                description={deleteCaseError.message}
              >
                {deleteCaseError.requestId && (
                  <span className="sr-only">
                    Mã tham chiếu: {deleteCaseError.requestId}
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
