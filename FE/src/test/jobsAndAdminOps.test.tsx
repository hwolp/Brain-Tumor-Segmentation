import { QueryClient } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/app/auth-store';
import { AppProviders } from '@/app/providers';
import { AppRoutes } from '@/app/router';
import { FIXTURE_USERS } from '@/shared/api/fixtures';
import { createAppQueryClient } from '@/shared/api/queryClient';
import type {
  AdminJobDetailDto,
  AdminJobDto,
  AdminModelDto,
  AdminOverviewDto,
  AdminSettingsDto,
  AdminWorkerDto,
  CaseDto,
  InferenceJobDto,
  MaskVersionDto,
  SystemAvailabilityDto,
  VolumeDto,
} from '@/shared/api/types';
import {
  computeSliceBrushIndices,
  createEmptyMaskBuffer,
  displayPointToVoxelCoord,
  parseNiftiVolume,
  parsedVolumeToUint8Mask,
  serializeNiftiMask,
  useViewerStore,
  voxelCoordToFlatIndex,
  type VolumeGeometry,
} from '@/viewer-adapter';

function createTestQueryClient(): QueryClient {
  const client = createAppQueryClient();
  client.setDefaultOptions({
    queries: {
      retry: false,
      gcTime: 0,
    },
    mutations: {
      retry: false,
    },
  });
  return client;
}

function renderAppAt(
  initialEntries: string[],
  client = createTestQueryClient(),
) {
  return {
    client,
    ...render(
      <AppProviders client={client} autoBootstrap={false}>
        <MemoryRouter initialEntries={initialEntries}>
          <AppRoutes />
        </MemoryRouter>
      </AppProviders>,
    ),
  };
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(
  code: string,
  requestId: string,
  status: number,
  message = 'Server error',
): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message,
        details: null,
        request_id: requestId,
      },
    }),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': requestId,
      },
    },
  );
}

function createHealthResponse(url: string): Response | null {
  if (url.includes('/health/live')) {
    return jsonResponse({
      status: 'ok',
      service: 'brain-tumor-api',
      environment: 'local',
    });
  }
  if (url.includes('/health/ready')) {
    return jsonResponse({
      status: 'ready',
      checks: { database: 'ok', storage: 'ok' },
    });
  }
  return null;
}

function buildReadyVolumes(caseId: string): VolumeDto[] {
  const affine = [
    [1, 0, 0, -120],
    [0, 1, 0, -120],
    [0, 0, 1, -78],
    [0, 0, 0, 1],
  ];
  return [
    {
      id: 'vol-flair',
      case_id: caseId,
      modality: 'flair',
      file_id: 'file-flair',
      filename: 'flair.nii.gz',
      validation_status: 'valid',
      shape: [240, 240, 155],
      spacing_mm: [1, 1, 1],
      affine,
      orientation: 'RAS',
      size_bytes: 10_000_000,
      sha256: 'sha-flair',
    },
    {
      id: 'vol-t1ce',
      case_id: caseId,
      modality: 't1ce',
      file_id: 'file-t1ce',
      filename: 't1ce.nii.gz',
      validation_status: 'valid',
      shape: [240, 240, 155],
      spacing_mm: [1, 1, 1],
      affine,
      orientation: 'RAS',
      size_bytes: 10_000_000,
      sha256: 'sha-t1ce',
    },
  ];
}

let restoreObjectUrlMock: (() => void) | null = null;

function captureDownloadBlobs(): Blob[] {
  const original = URL.createObjectURL;
  const blobs: Blob[] = [];
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob) => {
      blobs.push(blob);
      return `blob:p56-test-${blobs.length}`;
    },
  });
  restoreObjectUrlMock = () => {
    if (original) {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: original,
      });
    } else {
      delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    }
    restoreObjectUrlMock = null;
  };
  return blobs;
}

async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () =>
      reject(reader.error ?? new Error('Failed to read blob'));
    reader.readAsArrayBuffer(blob);
  });
}

describe('P5-FE AI Jobs, Polling, Availability & Cancellation (QA-JOB-01)', () => {
  beforeEach(() => {
    if (typeof window.PointerEvent === 'undefined') {
      class MockPointerEvent extends MouseEvent {
        readonly pointerId: number;
        constructor(type: string, params: PointerEventInit = {}) {
          super(type, params);
          this.pointerId = params.pointerId ?? 1;
        }
      }
      Object.defineProperty(window, 'PointerEvent', {
        configurable: true,
        writable: true,
        value: MockPointerEvent,
      });
    }
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 1280,
    });
    useViewerStore.getState().resetViewerState();
    useAuthStore.setState({
      status: 'authenticated',
      user: FIXTURE_USERS.doctor,
      accessToken: 'doc-access-token',
      bootstrapError: null,
      fixtureMode: false,
      reauthRequired: false,
    });
  });

  afterEach(() => {
    restoreObjectUrlMock?.();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('QA-JOB-01: enforces single pending request + Idempotency-Key reuse on retry, shows worker-offline queueing notice, and blocks intake when accepting_jobs=false', async () => {
    const user = userEvent.setup();
    const caseId = 'case-job-idem-1';
    const volumes = buildReadyVolumes(caseId);
    let availability: SystemAvailabilityDto = {
      accepting_jobs: false,
      worker_online: true,
      active_model_id: 'tda-segunet-v1.0',
      updated_at: '2026-05-20T08:00:00Z',
    };
    let caseData: CaseDto = {
      id: caseId,
      patient_id: 'pat-1',
      study_date: '2026-05-20',
      notes: 'Ca kiểm thử hàng đợi AI',
      reference_volume_id: 'vol-flair',
      readiness: 'ready',
      is_inputs_locked: false,
      can_run_inference: true,
      blocking_reasons: [],
      latest_mask_version_id: null,
      latest_job_state: null,
      created_at: '2026-05-20T07:00:00Z',
      updated_at: '2026-05-20T07:30:00Z',
    };
    const jobs: InferenceJobDto[] = [];
    const sentIdempotencyKeys: string[] = [];
    const firstPostDeferred: { resolve?: (res: Response) => void } = {};
    let postCallNumber = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = createHealthResponse(url);
      if (health) return Promise.resolve(health);
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/api/v1/system/availability') && method === 'GET') {
        return Promise.resolve(jsonResponse(availability));
      }
      if (url.endsWith(`/api/v1/cases/${caseId}`) && method === 'GET') {
        return Promise.resolve(jsonResponse(caseData));
      }
      if (url.endsWith(`/api/v1/cases/${caseId}/volumes`) && method === 'GET') {
        return Promise.resolve(jsonResponse(volumes));
      }
      if (url.endsWith(`/api/v1/cases/${caseId}/jobs`) && method === 'GET') {
        return Promise.resolve(
          jsonResponse({ items: jobs, total: jobs.length, page: 1, page_size: 20 }),
        );
      }
      if (
        url.endsWith(`/api/v1/cases/${caseId}/mask-versions`) &&
        method === 'GET'
      ) {
        return Promise.resolve(
          jsonResponse({ items: [], total: 0, page: 1, page_size: 20 }),
        );
      }
      if (url.endsWith(`/api/v1/cases/${caseId}/jobs`) && method === 'POST') {
        postCallNumber += 1;
        const headers = new Headers(init?.headers);
        sentIdempotencyKeys.push(headers.get('Idempotency-Key') ?? '');
        if (postCallNumber === 1) {
          return new Promise<Response>((resolve) => {
            firstPostDeferred.resolve = resolve;
          });
        }
        const created: InferenceJobDto = {
          id: 'job-created-1',
          case_id: caseId,
          model_version_id: 'tda-segunet-v1.0',
          state: 'queued',
          stage: 'queued',
          completed_slices: 0,
          total_slices: 155,
          attempt_count: 0,
          max_auto_retries: 1,
          error_code: null,
          created_at: '2026-05-20T08:05:00Z',
          started_at: null,
          finished_at: null,
          result_mask_version_id: null,
        };
        jobs.unshift(created);
        caseData = {
          ...caseData,
          is_inputs_locked: true,
          latest_job_state: 'queued',
        };
        return Promise.resolve(jsonResponse({ job: created }, 202));
      }
      if (url.endsWith('/api/v1/jobs/job-created-1') && method === 'GET') {
        return Promise.resolve(jsonResponse(jobs[0]));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const { client } = renderAppAt([`/doctor/cases/${caseId}`]);

    // 1. Khi accepting_jobs = false -> nút bị khóa và hiển thị cảnh báo tạm dừng nhận job
    expect(
      await screen.findByText(/Hệ thống tạm dừng nhận tác vụ phân đoạn mới/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Tạm dừng nhận job AI/i }),
    ).toBeDisabled();

    // 2. Chuyển sang accepting_jobs = true, worker_online = false -> cho phép gửi vào hàng đợi kèm thông báo chờ worker
    availability = {
      ...availability,
      accepting_jobs: true,
      worker_online: false,
    };
    await act(async () => {
      await client.invalidateQueries();
    });

    expect(
      await screen.findByText(/Worker AI đang ngoại tuyến — tác vụ mới sẽ chờ worker/i),
    ).toBeInTheDocument();
    const runBtn = screen.getByRole('button', { name: /Chạy phân đoạn AI/i });
    expect(runBtn).toBeEnabled();

    await user.click(runBtn);
    const dialog = screen.getByRole('alertdialog');
    expect(
      within(dialog).getByText(/Tác vụ sẽ chờ worker trực tuyến/i),
    ).toBeInTheDocument();

    // 3. Double-click thật lúc request đang chờ -> chỉ tạo duy nhất 1 request POST
    const confirmBtn = within(dialog).getByRole('button', {
      name: 'Gửi vào hàng đợi',
    });
    fireEvent.click(confirmBtn);
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(sentIdempotencyKeys).toHaveLength(1);
      expect(firstPostDeferred.resolve).toBeDefined();
    });
    expect(sentIdempotencyKeys[0]).toMatch(/^[0-9a-f-]{36}$/i);

    // Lần 1 gặp lỗi mạng / 500 bất định -> giữ nguyên Idempotency-Key khi bấm gửi lại
    await act(async () => {
      firstPostDeferred.resolve?.(
        errorResponse('internal_error', 'req-job-500', 500),
      );
    });

    const retrySameKeyBtn = await within(dialog).findByRole('button', {
      name: 'Gửi lại (cùng khóa)',
    });
    await user.click(retrySameKeyBtn);

    await waitFor(() => {
      expect(sentIdempotencyKeys).toHaveLength(2);
    });
    expect(sentIdempotencyKeys[1]).toBe(sentIdempotencyKeys[0]);

    expect(await screen.findByText(/Job ID: job-created-1/i)).toBeInTheDocument();
    expect(screen.getByText('Đang chờ')).toBeInTheDocument();
  });

  it('polls active job every 3s (queued -> running x/N slices -> transient network error -> succeeded), stops polling at terminal state, and links exact ?version=<result_mask_version_id>', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const caseId = 'case-job-poll-1';
    const volumes = buildReadyVolumes(caseId);

    const olderMaskVersion: MaskVersionDto = {
      id: 'mv-ai-old-v1',
      case_id: caseId,
      version_number: 1,
      source: 'ai',
      base_version_id: null,
      reference_volume_id: 'vol-flair',
      file_id: 'file-mv-1',
      created_by: null,
      created_by_name: 'TDA-SegUNet v1.0',
      model_version_id: 'tda-segunet-v1.0',
      job_id: 'job-older-v1',
      created_at: '2026-05-18T10:00:00Z',
      note: 'Kết quả AI cũ v1',
      label_voxel_counts: { '1': 1000, '2': 2000, '4': 500 },
      label_volumes_mm3: { '1': 1000, '2': 2000, '4': 500 },
      sha256: 'sha-mv-1',
    };

    const olderJob: InferenceJobDto = {
      id: 'job-older-v1',
      case_id: caseId,
      model_version_id: 'tda-segunet-v1.0',
      state: 'succeeded',
      stage: 'done',
      completed_slices: 155,
      total_slices: 155,
      attempt_count: 1,
      max_auto_retries: 1,
      error_code: null,
      created_at: '2026-05-18T09:58:00Z',
      started_at: '2026-05-18T09:58:05Z',
      finished_at: '2026-05-18T10:00:00Z',
      result_mask_version_id: 'mv-ai-old-v1',
    };

    let activeJobState: InferenceJobDto = {
      id: 'job-live-2',
      case_id: caseId,
      model_version_id: 'tda-segunet-v1.0',
      state: 'queued',
      stage: 'queued',
      completed_slices: null,
      total_slices: null,
      attempt_count: 0,
      max_auto_retries: 1,
      error_code: null,
      created_at: '2026-05-20T09:00:00Z',
      started_at: null,
      finished_at: null,
      result_mask_version_id: null,
    };

    const maskVersions: MaskVersionDto[] = [olderMaskVersion];
    let jobPollCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = createHealthResponse(url);
      if (health) return health;
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/api/v1/system/availability')) {
        return jsonResponse({
          accepting_jobs: true,
          worker_online: true,
          active_model_id: 'tda-segunet-v1.0',
          updated_at: '2026-05-20T09:00:00Z',
        });
      }
      if (url.endsWith(`/api/v1/cases/${caseId}`) && method === 'GET') {
        return jsonResponse({
          id: caseId,
          patient_id: 'pat-1',
          study_date: '2026-05-20',
          notes: null,
          reference_volume_id: 'vol-flair',
          readiness: 'ready',
          is_inputs_locked: true,
          can_run_inference: true,
          blocking_reasons: [],
          latest_mask_version_id: maskVersions[0]?.id ?? null,
          latest_job_state: activeJobState.state,
          created_at: '2026-05-20T08:00:00Z',
          updated_at: '2026-05-20T09:00:00Z',
        });
      }
      if (url.endsWith(`/api/v1/cases/${caseId}/volumes`)) {
        return jsonResponse(volumes);
      }
      if (url.endsWith(`/api/v1/cases/${caseId}/jobs`) && method === 'GET') {
        return jsonResponse({
          items: [activeJobState, olderJob],
          total: 2,
          page: 1,
          page_size: 20,
        });
      }
      if (url.endsWith(`/api/v1/cases/${caseId}/mask-versions`)) {
        return jsonResponse({
          items: maskVersions,
          total: maskVersions.length,
          page: 1,
          page_size: 20,
        });
      }
      if (url.endsWith('/api/v1/jobs/job-live-2') && method === 'GET') {
        jobPollCalls += 1;
        if (jobPollCalls === 1) {
          return jsonResponse(activeJobState);
        }
        if (jobPollCalls === 2) {
          activeJobState = {
            ...activeJobState,
            state: 'running',
            stage: 'inference',
            completed_slices: 64,
            total_slices: 155,
            attempt_count: 1,
            started_at: '2026-05-20T09:00:03Z',
          };
          return jsonResponse(activeJobState);
        }
        if (jobPollCalls === 3) {
          throw new TypeError('Failed to fetch');
        }
        activeJobState = {
          ...activeJobState,
          state: 'succeeded',
          stage: 'done',
          completed_slices: 155,
          total_slices: 155,
          finished_at: '2026-05-20T09:00:09Z',
          result_mask_version_id: 'mv-ai-new-v2',
        };
        if (!maskVersions.some((m) => m.id === 'mv-ai-new-v2')) {
          maskVersions.unshift({
            id: 'mv-ai-new-v2',
            case_id: caseId,
            version_number: 2,
            source: 'ai',
            base_version_id: 'mv-ai-old-v1',
            reference_volume_id: 'vol-flair',
            file_id: 'file-mv-2',
            created_by: null,
            created_by_name: 'TDA-SegUNet v1.0',
            model_version_id: 'tda-segunet-v1.0',
            job_id: 'job-live-2',
            created_at: '2026-05-20T09:00:09Z',
            note: 'Kết quả AI mới v2',
            label_voxel_counts: { '1': 3000, '2': 6000, '4': 1200 },
            label_volumes_mm3: { '1': 3000, '2': 6000, '4': 1200 },
            sha256: 'sha-mv-2',
          });
        }
        return jsonResponse(activeJobState);
      }
      return jsonResponse({});
    });

    renderAppAt([`/doctor/cases/${caseId}`]);

    expect(await screen.findByText(/Job ID: job-live-2/i)).toBeInTheDocument();
    expect(screen.getByText('Đang chờ')).toBeInTheDocument();

    // Poll 2 (sau 3s): chuyển sang running + hiển thị (64/155 lát)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(await screen.findByText('Đang xử lý')).toBeInTheDocument();
    expect(screen.getByText(/\(64\/155 lát\)/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Hủy job đang chờ/i }),
    ).not.toBeInTheDocument();

    // Poll 3 (sau 3s): mất mạng -> hiện "Chưa cập nhật trạng thái tác vụ" nhưng KHÔNG đổi job sang Thất bại
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(
      await screen.findByText(/Chưa cập nhật trạng thái tác vụ/i),
    ).toBeInTheDocument();
    expect(screen.getByText('Đang xử lý')).toBeInTheDocument();
    expect(screen.queryByText('Thất bại')).not.toBeInTheDocument();

    // Poll 4 (sau 3s): hồi phục -> succeeded, cập nhật Phiên bản Mask và dừng polling
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    await waitFor(() => {
      expect(screen.getByText(/Phiên bản Mask \(2\)/)).toBeInTheDocument();
    });

    const resultLinks = screen.getAllByRole('link', { name: 'Xem kết quả AI' });
    expect(resultLinks).toHaveLength(2);
    // Job mới liên kết đúng mv-ai-new-v2; job cũ liên kết đúng mv-ai-old-v1 (không chọn mù bản mới nhất!)
    expect(resultLinks[0]).toHaveAttribute(
      'href',
      `/doctor/cases/${caseId}/viewer?version=mv-ai-new-v2`,
    );
    expect(resultLinks[1]).toHaveAttribute(
      'href',
      `/doctor/cases/${caseId}/viewer?version=mv-ai-old-v1`,
    );

    const callsAfterSucceeded = jobPollCalls;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9500);
    });
    expect(jobPollCalls).toBe(callsAfterSucceeded);
  });

  it('supports cancelling a queued job, handles 409 job_not_cancellable by refetching running state, and handles 409 active_job_conflict on enqueue', async () => {
    const user = userEvent.setup();
    const caseId = 'case-job-cancel-1';
    const volumes = buildReadyVolumes(caseId);

    let currentJob: InferenceJobDto | null = {
      id: 'job-cancel-target',
      case_id: caseId,
      model_version_id: 'tda-segunet-v1.0',
      state: 'queued',
      stage: 'queued',
      completed_slices: 0,
      total_slices: 155,
      attempt_count: 0,
      max_auto_retries: 1,
      error_code: null,
      created_at: '2026-05-20T10:00:00Z',
      started_at: null,
      finished_at: null,
      result_mask_version_id: null,
    };

    let cancelShouldConflict409 = true;
    let createShouldConflict409 = false;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = createHealthResponse(url);
      if (health) return health;
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/api/v1/system/availability')) {
        return jsonResponse({
          accepting_jobs: true,
          worker_online: true,
          active_model_id: 'tda-segunet-v1.0',
          updated_at: '2026-05-20T10:00:00Z',
        });
      }
      if (url.endsWith(`/api/v1/cases/${caseId}`) && method === 'GET') {
        return jsonResponse({
          id: caseId,
          patient_id: 'pat-1',
          study_date: '2026-05-20',
          notes: null,
          reference_volume_id: 'vol-flair',
          readiness: 'ready',
          is_inputs_locked: Boolean(
            currentJob &&
              (currentJob.state === 'queued' || currentJob.state === 'running'),
          ),
          can_run_inference: true,
          blocking_reasons: [],
          latest_mask_version_id: null,
          latest_job_state: currentJob?.state ?? null,
          created_at: '2026-05-20T09:00:00Z',
          updated_at: '2026-05-20T10:00:00Z',
        });
      }
      if (url.endsWith(`/api/v1/cases/${caseId}/volumes`)) {
        return jsonResponse(volumes);
      }
      if (url.endsWith(`/api/v1/cases/${caseId}/jobs`) && method === 'GET') {
        return jsonResponse({
          items: currentJob ? [currentJob] : [],
          total: currentJob ? 1 : 0,
          page: 1,
          page_size: 20,
        });
      }
      if (url.endsWith(`/api/v1/cases/${caseId}/mask-versions`)) {
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
      }
      if (url.endsWith('/api/v1/jobs/job-cancel-target') && method === 'GET') {
        return jsonResponse(currentJob);
      }
      if (
        url.endsWith('/api/v1/jobs/job-cancel-target/cancel') &&
        method === 'POST'
      ) {
        if (cancelShouldConflict409) {
          currentJob = {
            ...currentJob!,
            state: 'running',
            stage: 'preprocessing',
            attempt_count: 1,
          };
          return errorResponse('job_not_cancellable', 'req-cancel-409', 409);
        }
        currentJob = {
          ...currentJob!,
          state: 'cancelled',
          finished_at: '2026-05-20T10:02:00Z',
        };
        return jsonResponse(currentJob);
      }
      if (url.endsWith(`/api/v1/cases/${caseId}/jobs`) && method === 'POST') {
        if (createShouldConflict409) {
          currentJob = {
            id: 'job-already-active',
            case_id: caseId,
            model_version_id: 'tda-segunet-v1.0',
            state: 'running',
            stage: 'loading',
            completed_slices: null,
            total_slices: null,
            attempt_count: 1,
            max_auto_retries: 1,
            error_code: null,
            created_at: '2026-05-20T10:03:00Z',
            started_at: '2026-05-20T10:03:01Z',
            finished_at: null,
            result_mask_version_id: null,
          };
          return errorResponse('active_job_conflict', 'req-active-409', 409);
        }
        return jsonResponse({ job: currentJob }, 202);
      }
      if (url.endsWith('/api/v1/jobs/job-already-active') && method === 'GET') {
        return jsonResponse(currentJob);
      }
      return jsonResponse({});
    });

    const { client } = renderAppAt([`/doctor/cases/${caseId}`]);

    // 1. Khi worker vừa nhận job trước lúc bấm Hủy -> 409 job_not_cancellable -> giải thích rõ và cập nhật sang Đang xử lý
    const cancelBtn = await screen.findByRole('button', {
      name: /Hủy job đang chờ/i,
    });
    await user.click(cancelBtn);

    expect(
      await screen.findByText(/Tác vụ đã được worker nhận xử lý/i),
    ).toBeInTheDocument();
    expect(await screen.findByText('Đang xử lý')).toBeInTheDocument();
    expect(screen.getByText('Tiền xử lý / TDA')).toBeInTheDocument();

    // 2. Đặt lại 1 job queued khác để kiểm tra hủy thành công (200 -> Đã hủy)
    cancelShouldConflict409 = false;
    currentJob = {
      ...currentJob!,
      state: 'queued',
      stage: 'queued',
    };
    await act(async () => {
      await client.invalidateQueries();
    });

    const cancelBtn2 = await screen.findByRole('button', {
      name: /Hủy job đang chờ/i,
    });
    await user.click(cancelBtn2);
    expect(await screen.findByText('Đã hủy')).toBeInTheDocument();

    // 3. Khi tạo job mới nhưng backend báo 409 active_job_conflict -> đóng hộp thoại và hiển thị job đang chạy
    createShouldConflict409 = true;
    await user.click(screen.getByRole('button', { name: /Chạy phân đoạn AI/i }));
    const dialog = screen.getByRole('alertdialog');
    await user.click(
      within(dialog).getByRole('button', { name: 'Gửi vào hàng đợi' }),
    );

    expect(
      await screen.findByText(/Job ID: job-already-active/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Ca chụp đã có tác vụ AI đang hoạt động/i),
    ).toBeInTheDocument();
  });
});

describe('P5/P6 Viewer Mask Preservation & Print Summary (QA-MASK-06 & QA-OPS-03)', () => {
  beforeEach(() => {
    if (typeof window.PointerEvent === 'undefined') {
      class MockPointerEvent extends MouseEvent {
        readonly pointerId: number;
        constructor(type: string, params: PointerEventInit = {}) {
          super(type, params);
          this.pointerId = params.pointerId ?? 1;
        }
      }
      Object.defineProperty(window, 'PointerEvent', {
        configurable: true,
        writable: true,
        value: MockPointerEvent,
      });
    }
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 1280,
    });
    restoreObjectUrlMock?.();
    useViewerStore.getState().resetViewerState();
    useAuthStore.setState({
      status: 'authenticated',
      user: FIXTURE_USERS.doctor,
      accessToken: 'doc-access-token',
      bootstrapError: null,
      fixtureMode: false,
      reauthRequired: false,
    });
  });

  afterEach(() => {
    restoreObjectUrlMock?.();
    useViewerStore.getState().resetViewerState();
    vi.restoreAllMocks();
  });

  it('QA-MASK-06: preserves dirty manual draft and shows "Có kết quả AI mới" without overwriting when a new AI MaskVersion arrives', async () => {
    const user = userEvent.setup();
    const blobs = captureDownloadBlobs();
    const caseId = 'case-qa-mask-06';
    const geometry: VolumeGeometry = {
      shape: [8, 8, 4],
      spacingMm: [1, 1, 1],
      affine: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
    };

    const mriBytes = await serializeNiftiMask(
      createEmptyMaskBuffer(geometry.shape),
      geometry,
      { gzip: true },
    );

    const v1Mask = createEmptyMaskBuffer(geometry.shape);
    const v1Bytes = await serializeNiftiMask(v1Mask, geometry, { gzip: true });

    const v2AiMask = createEmptyMaskBuffer(geometry.shape);
    // V2 AI tô toàn bộ lát 2 bằng nhãn 4 (ET) để chứng minh không bị ghi đè vào workingMaskBuffer!
    const aiVoxelIdx = voxelCoordToFlatIndex(6, 6, 2, geometry.shape);
    v2AiMask[aiVoxelIdx] = 4;
    const v2AiBytes = await serializeNiftiMask(v2AiMask, geometry, {
      gzip: true,
    });

    const versions: MaskVersionDto[] = [
      {
        id: 'mv-manual-v1',
        case_id: caseId,
        version_number: 1,
        source: 'manual',
        base_version_id: null,
        reference_volume_id: 'vol-flair',
        file_id: 'file-v1',
        created_by: FIXTURE_USERS.doctor.id,
        created_by_name: FIXTURE_USERS.doctor.display_name,
        model_version_id: null,
        job_id: null,
        created_at: '2026-05-20T08:00:00Z',
        note: 'Bản gốc thủ công v1',
        label_voxel_counts: { '1': 0, '2': 0, '4': 0 },
        label_volumes_mm3: { '1': 0, '2': 0, '4': 0 },
        sha256: 'sha-v1',
      },
    ];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = createHealthResponse(url);
      if (health) return health;

      if (url.endsWith(`/api/v1/cases/${caseId}`)) {
        return jsonResponse({
          id: caseId,
          patient_id: 'pat-1',
          study_date: '2026-05-20',
          notes: null,
          reference_volume_id: 'vol-flair',
          readiness: 'ready',
          is_inputs_locked: true,
          can_run_inference: true,
          latest_mask_version_id: versions[0]!.id,
          created_at: '2026-05-20T07:00:00Z',
          updated_at: '2026-05-20T08:00:00Z',
        });
      }
      if (url.endsWith(`/api/v1/cases/${caseId}/volumes`)) {
        return jsonResponse([
          {
            id: 'vol-flair',
            case_id: caseId,
            modality: 'flair',
            file_id: 'file-mri',
            filename: 'flair.nii.gz',
            validation_status: 'valid',
            shape: geometry.shape,
            spacing_mm: geometry.spacingMm,
            affine: geometry.affine,
            orientation: 'RAS',
            size_bytes: mriBytes.byteLength,
            sha256: 'sha-mri',
          },
        ]);
      }
      if (url.endsWith(`/api/v1/cases/${caseId}/jobs`)) {
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
      }
      if (url.includes(`/api/v1/cases/${caseId}/mask-versions`)) {
        return jsonResponse({
          items: versions,
          total: versions.length,
          page: 1,
          page_size: 100,
        });
      }
      if (url.endsWith('/api/v1/files/file-mri/content')) {
        return new Response(vriCopy(mriBytes), { status: 200 });
      }
      if (url.endsWith('/api/v1/files/file-v1/content')) {
        return new Response(vriCopy(v1Bytes), { status: 200 });
      }
      if (url.endsWith('/api/v1/files/file-v2-ai/content')) {
        return new Response(vriCopy(v2AiBytes), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    function vriCopy(arr: Uint8Array): ArrayBuffer {
      const c = new Uint8Array(arr.byteLength);
      c.set(arr);
      return c.buffer;
    }

    useViewerStore.getState().setBrushRadius(1);
    const { client } = renderAppAt([`/doctor/cases/${caseId}/viewer`]);

    await waitFor(
      () => {
        expect(screen.getByTestId('mri-viewer-workspace')).toHaveAttribute(
          'data-volume-status',
          'ready',
        );
      },
      { timeout: 5000 },
    );

    const versionSelect = screen.getByRole('combobox', {
      name: 'Chọn phiên bản mask',
    });
    expect(versionSelect).toHaveValue('mv-manual-v1');

    // Bác sĩ tô nhãn 1 trên lát 0 -> tạo dirty draft
    await user.click(screen.getByRole('button', { name: 'Tô mask' }));
    const editCanvas = screen
      .getByTestId('pane-axial-editable')
      .querySelector('canvas')!;
    vi.spyOn(editCanvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 80,
      height: 80,
      right: 80,
      bottom: 80,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(editCanvas, { button: 0, clientX: 25, clientY: 25 });
    fireEvent.pointerUp(editCanvas, { button: 0, clientX: 25, clientY: 25 });
    expect(useViewerStore.getState().isDirty).toBe(true);

    // Job AI hoàn tất ở nền -> xuất hiện phiên bản v2 AI mới
    versions.unshift({
      id: 'mv-ai-v2',
      case_id: caseId,
      version_number: 2,
      source: 'ai',
      base_version_id: 'mv-manual-v1',
      reference_volume_id: 'vol-flair',
      file_id: 'file-v2-ai',
      created_by: null,
      created_by_name: 'TDA-SegUNet v1.0',
      model_version_id: 'tda-segunet-v1.0',
      job_id: 'job-99',
      created_at: '2026-05-20T08:10:00Z',
      note: 'Kết quả AI tự động v2',
      label_voxel_counts: { '1': 0, '2': 0, '4': 1 },
      label_volumes_mm3: { '1': 0, '2': 0, '4': 1 },
      sha256: 'sha-v2-ai',
    });

    await act(async () => {
      await client.invalidateQueries();
    });

    // Hiển thị thông báo "Có kết quả AI mới", giữ nguyên phiên bản đang chọn & bản nháp chưa lưu!
    expect(await screen.findByText('Có kết quả AI mới')).toBeInTheDocument();
    expect(versionSelect).toHaveValue('mv-manual-v1');
    expect(useViewerStore.getState().isDirty).toBe(true);

    // Xuất bản nháp để kiểm chứng voxel của bác sĩ còn nguyên vẹn và KHÔNG bị v2 AI ghi đè
    await user.click(screen.getByRole('button', { name: 'Xuất (.nii.gz)' }));
    await user.click(
      screen.getByRole('button', { name: 'Xuất bản nháp cục bộ (.nii.gz)' }),
    );
    await waitFor(() => expect(blobs).toHaveLength(1));

    const exportedParsed = await parseNiftiVolume(
      await blobToArrayBuffer(blobs[0]!),
    );
    const exportedMask = parsedVolumeToUint8Mask(exportedParsed);
    const expectedCenter = displayPointToVoxelCoord(
      2,
      2,
      0,
      geometry.affine,
      geometry.shape,
    );
    const expectedDisk = computeSliceBrushIndices(
      expectedCenter,
      1,
      0,
      geometry.affine,
      geometry.shape,
    );
    expect(expectedDisk.every((idx) => exportedMask[idx] === 1)).toBe(true);
    expect(exportedMask[aiVoxelIdx]).toBe(0);
  });

  it('QA-OPS-03: opening ?version=v1 (non-latest) selects v1, renders strictly v1 statistics/labels in print summary (never v2), and invokes window.print()', async () => {
    const user = userEvent.setup();
    const printSpy = vi.spyOn(window, 'print').mockImplementation(() => {});
    const caseId = 'case-qa-ops-03';
    const geometry: VolumeGeometry = {
      shape: [8, 8, 4],
      spacingMm: [1, 1, 1],
      affine: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
    };

    const emptyBytes = await serializeNiftiMask(
      createEmptyMaskBuffer(geometry.shape),
      geometry,
      { gzip: true },
    );

    const v2Latest: MaskVersionDto = {
      id: 'v2',
      case_id: caseId,
      version_number: 2,
      source: 'ai',
      base_version_id: 'v1',
      reference_volume_id: 'vol-flair',
      file_id: 'file-empty',
      created_by: null,
      created_by_name: 'TDA-SegUNet v2.0',
      model_version_id: 'tda-segunet-v2.0',
      job_id: 'job-v2',
      created_at: '2026-05-21T10:00:00Z',
      note: 'Ghi chú riêng của phiên bản mới nhất v2',
      label_voxel_counts: { '1': 9000, '2': 25000, '4': 6000 },
      label_volumes_mm3: { '1': 9000, '2': 25000, '4': 6000 },
      sha256: 'sha256-of-v2-latest',
    };

    const v1Older: MaskVersionDto = {
      id: 'v1',
      case_id: caseId,
      version_number: 1,
      source: 'manual',
      base_version_id: null,
      reference_volume_id: 'vol-flair',
      file_id: 'file-empty',
      created_by: FIXTURE_USERS.doctor.id,
      created_by_name: 'BS. Nguyễn Hoàng Minh',
      model_version_id: null,
      job_id: null,
      created_at: '2026-05-19T14:30:00Z',
      note: 'Ghi chú thẩm định của phiên bản v1',
      label_voxel_counts: { '1': 1500, '2': 3500, '4': 500 },
      label_volumes_mm3: { '1': 1500, '2': 3500, '4': 500 },
      sha256: 'sha256-of-v1-older',
    };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = createHealthResponse(url);
      if (health) return health;

      if (url.endsWith(`/api/v1/cases/${caseId}`)) {
        return jsonResponse({
          id: caseId,
          patient_id: 'pat-1',
          patient_code: 'BN-PRINT-01',
          study_date: '2026-05-19',
          notes: null,
          reference_volume_id: 'vol-flair',
          readiness: 'ready',
          is_inputs_locked: true,
          can_run_inference: true,
          latest_mask_version_id: 'v2',
          created_at: '2026-05-19T10:00:00Z',
          updated_at: '2026-05-21T10:00:00Z',
        });
      }
      if (url.endsWith(`/api/v1/cases/${caseId}/volumes`)) {
        return jsonResponse([
          {
            id: 'vol-flair',
            case_id: caseId,
            modality: 'flair',
            file_id: 'file-empty',
            filename: 'flair.nii.gz',
            validation_status: 'valid',
            shape: geometry.shape,
            spacing_mm: geometry.spacingMm,
            affine: geometry.affine,
            orientation: 'RAS',
            size_bytes: emptyBytes.byteLength,
            sha256: 'sha-mri',
          },
        ]);
      }
      if (url.endsWith(`/api/v1/cases/${caseId}/jobs`)) {
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
      }
      if (url.includes(`/api/v1/cases/${caseId}/mask-versions`)) {
        return jsonResponse({
          items: [v2Latest, v1Older],
          total: 2,
          page: 1,
          page_size: 100,
        });
      }
      if (url.endsWith('/api/v1/files/file-empty/content')) {
        const copy = new Uint8Array(emptyBytes.byteLength);
        copy.set(emptyBytes);
        return new Response(copy.buffer, { status: 200 });
      }
      if (url.endsWith('/api/v1/mask-versions/v1/metadata')) {
        return jsonResponse({
          version_id: 'v1',
          case_id: caseId,
          study_date: '2026-05-19',
          version_number: 1,
          source: 'manual',
          base_version_id: null,
          reference_volume_id: 'vol-flair',
          model_version_id: null,
          job_id: null,
          created_at: '2026-05-19T14:30:00Z',
          created_by_name: 'BS. Nguyễn Hoàng Minh',
          sha256: 'sha256-of-v1-older',
          labels: {
            '0': 'Nền',
            '1': '1: NCR/NET',
            '2': '2: Edema',
            '4': '4: ET',
          },
          coverage: {
            status: 'manual',
            coverage_file_id: null,
            note: 'Phạm vi coverage kiểm chứng cho bản v1.',
          },
          geometry: {
            shape: geometry.shape,
            spacing_mm: geometry.spacingMm,
            affine: geometry.affine,
            orientation: 'RAS',
            units: 'mm',
          },
          statistics: {
            voxel_volume_mm3: 1,
            per_label: [
              {
                label: 1,
                name: '1: NCR/NET',
                voxel_count: 1500,
                volume_mm3: 1500,
                volume_ml: 1.5,
              },
              {
                label: 2,
                name: '2: Edema',
                voxel_count: 3500,
                volume_mm3: 3500,
                volume_ml: 3.5,
              },
              {
                label: 4,
                name: '4: ET',
                voxel_count: 500,
                volume_mm3: 500,
                volume_ml: 0.5,
              },
            ],
            composite_groups: [
              { group: 'WT', labels: [1, 2, 4], volume_mm3: 5500, volume_ml: 5.5 },
              { group: 'TC', labels: [1, 4], volume_mm3: 2000, volume_ml: 2.0 },
              { group: 'ET', labels: [4], volume_mm3: 500, volume_ml: 0.5 },
            ],
            total_foreground_voxels: 5500,
            total_foreground_volume_mm3: 5500,
            total_foreground_volume_ml: 5.5,
          },
        });
      }
      return new Response(null, { status: 404 });
    });

    renderAppAt([`/doctor/cases/${caseId}/viewer?version=v1`]);

    await waitFor(
      () => {
        expect(screen.getByTestId('mri-viewer-workspace')).toHaveAttribute(
          'data-volume-status',
          'ready',
        );
      },
      { timeout: 5000 },
    );

    // Mở ?version=v1 phải chọn đúng v1 thay vì chọn mù bản v2 mới nhất
    const selector = screen.getByRole('combobox', {
      name: 'Chọn phiên bản mask',
    });
    expect(selector).toHaveValue('v1');

    const report = screen.getByTestId('print-summary-report');
    expect(report).toHaveTextContent(caseId);
    expect(report).toHaveTextContent('19/05/2026');
    expect(report).toHaveTextContent('v1 · Chỉnh sửa thủ công');
    expect(report).toHaveTextContent('BS. Nguyễn Hoàng Minh');
    expect(report).toHaveTextContent('Ghi chú thẩm định của phiên bản v1');
    expect(report).toHaveTextContent('Phạm vi coverage kiểm chứng cho bản v1.');
    expect(report).toHaveTextContent('1: NCR/NET');
    expect(report).toHaveTextContent('1500.00 mm³');
    expect(report).toHaveTextContent('1.500 mL');
    expect(report).toHaveTextContent('2: Edema');
    expect(report).toHaveTextContent('3500.00 mm³');
    expect(report).toHaveTextContent('3.500 mL');
    expect(report).toHaveTextContent('4: ET');
    expect(report).toHaveTextContent('500.00 mm³');
    expect(report).toHaveTextContent('0.500 mL');
    expect(report).toHaveTextContent('5500.00 mm³');
    expect(report).toHaveTextContent('5.500 mL');
    expect(report).toHaveTextContent('sha256-of-v1-older');

    // Tuyệt đối không lẫn dữ liệu của v2
    expect(report).not.toHaveTextContent('9000.00 mm³');
    expect(report).not.toHaveTextContent('25000.00 mm³');
    expect(report).not.toHaveTextContent('Ghi chú riêng của phiên bản mới nhất v2');
    expect(report).not.toHaveTextContent('tda-segunet-v2.0');
    expect(report).not.toHaveTextContent('sha256-of-v2-latest');

    // Bấm "In / Lưu PDF" gọi window.print()
    await user.click(screen.getByRole('button', { name: /In \/ Lưu PDF/i }));
    expect(printSpy).toHaveBeenCalledTimes(1);

    // Khi đang có chỉnh sửa chưa lưu (isDirty), bấm "In / Lưu PDF" cảnh báo rõ và cho phép in bản đã lưu v1 mà không trộn nét nháp
    await user.click(screen.getByRole('button', { name: 'Tô mask' }));
    const editCanvas = screen
      .getByTestId('pane-axial-editable')
      .querySelector('canvas')!;
    vi.spyOn(editCanvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 80,
      height: 80,
      right: 80,
      bottom: 80,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(editCanvas, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerUp(editCanvas, { button: 0, clientX: 20, clientY: 20 });
    expect(useViewerStore.getState().isDirty).toBe(true);

    await user.click(screen.getByRole('button', { name: /In \/ Lưu PDF/i }));
    const dirtyPrintModal = await screen.findByRole('dialog');
    expect(
      within(dirtyPrintModal).getByText(/không trộn các chỉnh sửa chưa lưu/i),
    ).toBeInTheDocument();
    await user.click(
      within(dirtyPrintModal).getByRole('button', {
        name: 'In bản đã lưu (v1)',
      }),
    );
    expect(printSpy).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('print-summary-report')).toHaveTextContent(
      '5500.00 mm³',
    );
  });
});

describe('P6-FE Admin Operations: Overview, Technical Jobs & Optimistic Settings', () => {
  beforeEach(() => {
    useAuthStore.setState({
      status: 'authenticated',
      user: FIXTURE_USERS.admin,
      accessToken: 'admin-access-token',
      bootstrapError: null,
      fixtureMode: false,
      reauthRequired: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('displays AdminOverviewPage (metrics, workers, models) and AdminJobsPage (detail attempts without PII, retry failed job + 409 retry_owner_inactive)', async () => {
    const user = userEvent.setup();

    const overview: AdminOverviewDto = {
      active_doctors: 4,
      locked_doctors: 1,
      queued_jobs: 2,
      running_jobs: 1,
      failed_jobs: 1,
      storage_used_bytes: 5 * 1024 * 1024 * 1024,
      storage_quota_bytes: 20 * 1024 * 1024 * 1024,
      worker_online: true,
      updated_at: '2026-05-21T09:00:00Z',
    };
    const workers: AdminWorkerDto[] = [
      {
        worker_id: 'worker-gpu-node-01',
        online: true,
        device_type: 'GPU',
        active_jobs: 1,
        last_heartbeat_at: '2026-05-21T08:59:50Z',
        model_version: 'tda-segunet-v1.0',
      },
    ];
    const models: AdminModelDto[] = [
      {
        id: 'tda-segunet-v1.0',
        name: 'TDA-SegUNet',
        version: '1.0.0',
        checkpoint_sha256: 'deadbeefcafe1234567890abcdef1234',
        expected_shape: [240, 240, 155],
        expected_spacing_mm: [1, 1, 1],
        is_active: true,
        verified: true,
      },
    ];

    const adminJobs: AdminJobDto[] = [
      {
        id: 'job-failed-ops-1',
        case_id: '20000000-0000-4000-8000-000000000777',
        doctor_username: 'bs.minh',
        model_version: 'tda-segunet-v1.0',
        state: 'failed',
        stage: 'inference',
        attempt_count: 2,
        error_code: 'worker_lost',
        created_at: '2026-05-21T08:00:00Z',
        started_at: '2026-05-21T08:00:05Z',
        finished_at: '2026-05-21T08:04:00Z',
      },
    ];

    const detailMap: Record<string, AdminJobDetailDto> = {
      'job-failed-ops-1': {
        ...adminJobs[0]!,
        attempts: [
          {
            id: 'att-1',
            attempt_number: 1,
            worker_id: 'worker-gpu-node-01',
            state: 'expired',
            stage: 'preprocessing',
            error_code: 'lease_expired',
            started_at: '2026-05-21T08:00:05Z',
            finished_at: '2026-05-21T08:02:00Z',
          },
          {
            id: 'att-2',
            attempt_number: 2,
            worker_id: 'worker-gpu-node-01',
            state: 'failed',
            stage: 'inference',
            error_code: 'worker_lost',
            started_at: '2026-05-21T08:02:05Z',
            finished_at: '2026-05-21T08:04:00Z',
          },
        ],
      },
    };

    let retryAttemptCount = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = createHealthResponse(url);
      if (health) return health;
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/api/v1/admin/overview')) {
        return jsonResponse(overview);
      }
      if (url.endsWith('/api/v1/admin/workers')) {
        return jsonResponse(workers);
      }
      if (url.endsWith('/api/v1/admin/models')) {
        return jsonResponse(models);
      }
      if (url.includes('/api/v1/admin/jobs') && method === 'GET') {
        const detailMatch = url.match(/\/api\/v1\/admin\/jobs\/([^/?]+)$/);
        if (detailMatch) {
          const found = detailMap[decodeURIComponent(detailMatch[1]!)];
          return found
            ? jsonResponse(found)
            : errorResponse('job_not_found', 'req-404', 404);
        }
        return jsonResponse({
          items: adminJobs,
          total: adminJobs.length,
          page: 1,
          page_size: 20,
        });
      }
      if (
        url.endsWith('/api/v1/admin/jobs/job-failed-ops-1/retry') &&
        method === 'POST'
      ) {
        retryAttemptCount += 1;
        if (retryAttemptCount === 1) {
          return errorResponse(
            'retry_owner_inactive',
            'req-owner-locked-409',
            409,
          );
        }
        if (retryAttemptCount === 2) {
          return errorResponse(
            'not_accepting_jobs',
            'req-paused-503',
            503,
          );
        }
        const retried: AdminJobDto = {
          id: 'job-retried-ops-2',
          case_id: adminJobs[0]!.case_id,
          doctor_username: 'bs.minh',
          model_version: 'tda-segunet-v1.0',
          state: 'queued',
          stage: 'queued',
          attempt_count: 0,
          error_code: null,
          created_at: '2026-05-21T09:05:00Z',
          started_at: null,
          finished_at: null,
        };
        adminJobs.unshift(retried);
        detailMap['job-retried-ops-2'] = { ...retried, attempts: [] };
        return jsonResponse(retried, 202);
      }
      return jsonResponse({});
    });

    const view = renderAppAt(['/admin']);

    // 1. AdminOverviewPage hiển thị số liệu vận hành, workers & models đã xác minh
    expect(await screen.findByText('4 hoạt động')).toBeInTheDocument();
    expect(screen.getByText('3 đang xử lý')).toBeInTheDocument();
    expect(screen.getByText('5.00 GiB')).toBeInTheDocument();
    expect(screen.getByText('worker-gpu-node-01')).toBeInTheDocument();
    expect(screen.getByText(/TDA-SegUNet v1\.0\.0/)).toBeInTheDocument();

    // 2. Chuyển sang AdminJobsPage -> xem chi tiết attempt kỹ thuật không chứa PII
    await user.click(screen.getByRole('link', { name: 'Quản lý tác vụ AI' }));
    expect(
      await screen.findByRole('heading', {
        name: 'Quản lý tác vụ AI',
      }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Chi tiết' }));
    const detailModal = await screen.findByRole('dialog');
    expect(
      within(detailModal).getByText(/Lịch sử attempt \(2\)/i),
    ).toBeInTheDocument();
    expect(
      within(detailModal).getByText(/Attempt 1 · worker-gpu-node-01/),
    ).toBeInTheDocument();
    expect(
      within(detailModal).getByText(/Attempt 2 · worker-gpu-node-01/),
    ).toBeInTheDocument();
    // Không chứa PII bệnh nhân hay đường dẫn nội bộ
    expect(detailModal.textContent).not.toContain('Trần Văn An');
    expect(detailModal.textContent).not.toContain('/storage/');

    await user.click(within(detailModal).getByRole('button', { name: /Đóng/i }));

    // 3. Thử gửi lại lần 1 gặp 409 retry_owner_inactive -> hiện cảnh báo tiếng Việt + request_id
    await user.click(screen.getByRole('button', { name: /Gửi lại/i }));
    const confirmRetry1 = screen.getByRole('alertdialog');
    await user.click(
      within(confirmRetry1).getByRole('button', { name: 'Tạo job mới' }),
    );

    await waitFor(() => {
      expect(screen.getAllByText(/req-owner-locked-409/i).length).toBeGreaterThan(
        0,
      );
    });
    expect(
      screen.getAllByText(/tài khoản bác sĩ sở hữu ca chụp đang bị khóa/i)
        .length,
    ).toBeGreaterThan(0);

    // 4. Lần 2 hệ thống tạm dừng nhận job (503 not_accepting_jobs) -> hiện cảnh báo 503 + request_id
    await user.click(screen.getByRole('button', { name: /Gửi lại/i }));
    const confirmRetry503 = screen.getByRole('alertdialog');
    await user.click(
      within(confirmRetry503).getByRole('button', { name: 'Tạo job mới' }),
    );
    await waitFor(() => {
      expect(screen.getAllByText(/req-paused-503/i).length).toBeGreaterThan(0);
    });
    expect(
      screen.getAllByText(/tạm ngừng nhận tác vụ phân đoạn mới/i).length,
    ).toBeGreaterThan(0);

    // 5. Sau khi hệ thống sẵn sàng, gửi lại lần 3 thành công -> tạo job-retried-ops-2 mới
    await user.click(screen.getByRole('button', { name: /Gửi lại/i }));
    const confirmRetry2 = screen.getByRole('alertdialog');
    await user.click(
      within(confirmRetry2).getByRole('button', { name: 'Tạo job mới' }),
    );

    expect(
      await screen.findByText('Worker chưa nhận job.'),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText('job-retried-ops-2').length,
    ).toBeGreaterThan(0);
    view.unmount();
  });

  it('saves AdminSettingsPage incrementing optimistic version and refetches latest version on 409 settings_version_conflict', async () => {
    const user = userEvent.setup();

    let serverSettings: AdminSettingsDto = {
      version: 1,
      accepting_jobs: true,
      max_upload_mib: 100,
      max_decompressed_mib: 256,
      default_doctor_quota_gib: 2,
      system_quota_gib: 20,
      updated_at: '2026-05-21T08:00:00Z',
    };

    const models: AdminModelDto[] = [
      {
        id: 'tda-segunet-v1.0',
        name: 'TDA-SegUNet',
        version: '1.0.0',
        checkpoint_sha256: 'abcdef1234567890abcdef1234567890',
        expected_shape: [240, 240, 155],
        expected_spacing_mm: [1, 1, 1],
        is_active: true,
        verified: true,
      },
    ];

    const sentPatchBodies: Array<Record<string, unknown>> = [];
    let simulateConflictNextPatch = false;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = createHealthResponse(url);
      if (health) return health;
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/api/v1/admin/settings') && method === 'GET') {
        return jsonResponse(serverSettings);
      }
      if (url.endsWith('/api/v1/admin/models') && method === 'GET') {
        return jsonResponse(models);
      }
      if (url.endsWith('/api/v1/admin/settings') && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<
          string,
          unknown
        >;
        sentPatchBodies.push(body);
        if (simulateConflictNextPatch) {
          simulateConflictNextPatch = false;
          // Phiên khác đã nâng lên version 5 trên máy chủ
          serverSettings = {
            ...serverSettings,
            version: 5,
            accepting_jobs: false,
            max_upload_mib: 64,
            updated_at: '2026-05-21T09:30:00Z',
          };
          return errorResponse(
            'settings_version_conflict',
            'req-settings-409',
            409,
          );
        }
        serverSettings = {
          ...serverSettings,
          ...(body as Omit<AdminSettingsDto, 'updated_at'>),
          version: Number(body.version) + 1,
          updated_at: '2026-05-21T09:10:00Z',
        };
        return jsonResponse(serverSettings);
      }
      return jsonResponse({});
    });

    renderAppAt(['/admin/settings']);

    expect(await screen.findByText(/Phiên bản 1/i)).toBeInTheDocument();
    expect(screen.getByText(/TDA-SegUNet · 1\.0\.0/)).toBeInTheDocument();

    // 1. Đổi giới hạn upload từ 100 -> xóa trống tạm thời không bị ép thành 0 -> gõ 80 MiB và lưu -> gửi version=1 và tăng lên Phiên bản 2
    const maxUploadInput = screen.getByLabelText(
      /Dung lượng tối đa mỗi tệp \(MiB\)/i,
    );
    await user.clear(maxUploadInput);
    expect(maxUploadInput).toHaveValue(null);
    expect(screen.getByRole('button', { name: 'Lưu cấu hình' })).toBeDisabled();
    await user.type(maxUploadInput, '80');
    await user.click(screen.getByRole('button', { name: 'Lưu cấu hình' }));

    expect(await screen.findByText(/Phiên bản 2/i)).toBeInTheDocument();
    expect(sentPatchBodies).toHaveLength(1);
    expect(sentPatchBodies[0]).toMatchObject({
      version: 1,
      max_upload_mib: 80,
    });
    expect(sentPatchBodies[0]).not.toHaveProperty('updated_at');

    // 2. Chỉnh tiếp nhưng gặp 409 settings_version_conflict -> hiển thị cảnh báo và tự động refetch Phiên bản 5
    simulateConflictNextPatch = true;
    const doctorQuotaInput = screen.getByLabelText(/Mặc định mỗi bác sĩ \(GiB\)/i);
    await user.clear(doctorQuotaInput);
    await user.type(doctorQuotaInput, '4');
    await user.click(screen.getByRole('button', { name: 'Lưu cấu hình' }));

    await waitFor(() => {
      expect(screen.getAllByText(/req-settings-409/i).length).toBeGreaterThan(0);
    });
    expect(
      screen.getAllByText(/Cấu hình đã được cập nhật ở một phiên khác/i).length,
    ).toBeGreaterThan(0);

    // Dữ liệu mới nhất từ máy chủ (Phiên bản 5, max_upload_mib = 64) đã được tải lại tự động
    expect(await screen.findByText(/Phiên bản 5/i)).toBeInTheDocument();
    expect(maxUploadInput).toHaveValue(64);
  });
});
