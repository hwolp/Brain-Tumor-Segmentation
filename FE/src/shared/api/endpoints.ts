import { listAdminUsers } from './adminUsers';
import { apiRequest } from './client';
import { assertBinaryRequestCurrent, fetchProtectedBinary } from './maskVersions';
import type {
  AdminAuditEventListParams,
  AdminBenchmarksListParams,
  AdminJobsListParams,
  AdminUsersListParams,
  PatientsListParams,
} from './endpointParams';
import { ApiClientError } from './errors';
import {
  createFixtureAdminBenchmark,
  deleteFixtureAdminBenchmark,
  getFixtureAdminBenchmarkArtifactBuffer,
  getFixtureAdminBenchmarkDetail,
  getFixtureAdminBenchmarks,
  getFixtureAdminJobs,
  getFixtureAdminJobDetail,
  getFixtureAdminOverview,
  getFixtureAdminSettings,
  updateFixtureAdminSettings,
  getFixtureAuditEvents,
  getFixtureCaseDetail,
  getFixtureCases,
  getFixtureInferenceJob,
  getFixturePatientDetail,
  getFixturePatients,
  getFixtureSystemAvailability,
  createFixtureInferenceJob,
  cancelFixtureInferenceJob,
  retryFixtureAdminJob,
} from './fixtures';
import type {
  AdminBenchmarkDetailDto,
  AdminBenchmarkSummaryDto,
  AdminDoctorUserDto,
  AdminJobDto,
  AdminJobDetailDto,
  AdminModelDto,
  AdminOverviewDto,
  AdminSettingsDto,
  AdminWorkerDto,
  AuditEventDto,
  BenchmarkArtifactKind,
  BenchmarkDeletionDto,
  CaseDto,
  InferenceJobDto,
  MaskVersionDto,
  PaginatedResponse,
  PatientDto,
  SystemAvailabilityDto,
  VolumeDto,
} from './types';

function buildSearchParams(
  entries: Record<string, string | number | undefined>,
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(entries)) {
    if (v !== undefined && String(v).trim() !== '') {
      sp.set(k, String(v));
    }
  }
  const serialized = sp.toString();
  return serialized ? `?${serialized}` : '';
}

export async function fetchPatients(
  params: PatientsListParams,
  options: { signal?: AbortSignal; fixtureMode?: boolean },
): Promise<PaginatedResponse<PatientDto>> {
  if (options.fixtureMode) {
    return getFixturePatients(params);
  }
  const qs = buildSearchParams({
    q: params.q,
    page: params.page,
    page_size: params.pageSize,
  });
  return apiRequest<PaginatedResponse<PatientDto>>(`/patients${qs}`, {
    method: 'GET',
    signal: options.signal,
  });
}

export async function fetchPatientDetail(
  patientId: string,
  options: { signal?: AbortSignal; fixtureMode?: boolean },
): Promise<{ patient: PatientDto; cases: CaseDto[] }> {
  if (options.fixtureMode) {
    return getFixturePatientDetail(patientId);
  }
  const [patient, casesPage] = await Promise.all([
    apiRequest<PatientDto>(`/patients/${encodeURIComponent(patientId)}`, {
      method: 'GET',
      signal: options.signal,
    }),
    apiRequest<PaginatedResponse<CaseDto>>(
      `/patients/${encodeURIComponent(patientId)}/cases`,
      {
        method: 'GET',
        signal: options.signal,
      },
    ),
  ]);
  return { patient, cases: casesPage.items };
}

export async function fetchDoctorCasesOverview(options: {
  signal?: AbortSignal;
  fixtureMode?: boolean;
}): Promise<PaginatedResponse<CaseDto>> {
  if (options.fixtureMode) {
    return getFixtureCases();
  }
  return apiRequest<PaginatedResponse<CaseDto>>('/cases?page=1&page_size=20', {
    method: 'GET',
    signal: options.signal,
  });
}

export async function fetchCaseDetail(
  caseId: string,
  options: { signal?: AbortSignal; fixtureMode?: boolean },
): Promise<{
  caseData: CaseDto;
  volumes: VolumeDto[];
  jobs: InferenceJobDto[];
  maskVersions: MaskVersionDto[];
}> {
  if (options.fixtureMode) {
    return getFixtureCaseDetail(caseId);
  }
  const encodedId = encodeURIComponent(caseId);
  const [caseData, volumes, jobsPage, masksPage] = await Promise.all([
    apiRequest<CaseDto>(`/cases/${encodedId}`, {
      method: 'GET',
      signal: options.signal,
    }),
    apiRequest<VolumeDto[]>(`/cases/${encodedId}/volumes`, {
      method: 'GET',
      signal: options.signal,
    }),
    apiRequest<PaginatedResponse<InferenceJobDto>>(`/cases/${encodedId}/jobs`, {
      method: 'GET',
      signal: options.signal,
    }),
    apiRequest<PaginatedResponse<MaskVersionDto>>(
      `/cases/${encodedId}/mask-versions`,
      {
        method: 'GET',
        signal: options.signal,
      },
    ),
  ]);
  return {
    caseData,
    volumes,
    jobs: jobsPage.items,
    maskVersions: masksPage.items,
  };
}

export async function fetchSystemAvailability(
  options: { signal?: AbortSignal; fixtureMode?: boolean } = {},
): Promise<SystemAvailabilityDto | null> {
  if (options.fixtureMode) {
    return getFixtureSystemAvailability();
  }
  try {
    const raw = await apiRequest<Partial<SystemAvailabilityDto>>(
      '/system/availability',
      {
        method: 'GET',
        signal: options.signal,
      },
    );
    if (
      !raw ||
      typeof raw !== 'object' ||
      typeof raw.accepting_jobs !== 'boolean' ||
      typeof raw.worker_online !== 'boolean'
    ) {
      return null;
    }
    return {
      accepting_jobs: raw.accepting_jobs,
      worker_online: raw.worker_online,
      active_model_id:
        typeof raw.active_model_id === 'string' ? raw.active_model_id : null,
      updated_at:
        typeof raw.updated_at === 'string'
          ? raw.updated_at
          : new Date().toISOString(),
    };
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

export async function fetchInferenceJob(
  jobId: string,
  options: {
    caseId?: string;
    signal?: AbortSignal;
    fixtureMode?: boolean;
  } = {},
): Promise<InferenceJobDto> {
  if (options.fixtureMode) {
    return getFixtureInferenceJob(jobId);
  }
  const raw = await apiRequest<Partial<InferenceJobDto>>(
    `/jobs/${encodeURIComponent(jobId)}`,
    {
      method: 'GET',
      signal: options.signal,
    },
  );
  if (raw && typeof raw === 'object' && typeof raw.state === 'string' && raw.id) {
    return raw as InferenceJobDto;
  }
  if (options.caseId) {
    const page = await apiRequest<PaginatedResponse<InferenceJobDto>>(
      `/cases/${encodeURIComponent(options.caseId)}/jobs`,
      {
        method: 'GET',
        signal: options.signal,
      },
    );
    const matched = page.items.find((item) => item.id === jobId);
    if (matched) {
      return matched;
    }
  }
  throw new ApiClientError({ status: 404, code: 'job_not_found' });
}

export async function createInferenceJob(
  caseId: string,
  idempotencyKey: string,
  options: { fixtureMode?: boolean } = {},
): Promise<{ job: InferenceJobDto }> {
  if (options.fixtureMode) {
    return { job: createFixtureInferenceJob(caseId, idempotencyKey) };
  }
  return apiRequest<{ job: InferenceJobDto }>(
    `/cases/${encodeURIComponent(caseId)}/jobs`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: {},
    },
  );
}

export async function cancelInferenceJob(
  jobId: string,
  options: { fixtureMode?: boolean } = {},
): Promise<InferenceJobDto> {
  if (options.fixtureMode) return cancelFixtureInferenceJob(jobId);
  return apiRequest<InferenceJobDto>(`/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
  });
}

export async function fetchAdminOverview(options: {
  signal?: AbortSignal;
  fixtureMode?: boolean;
}): Promise<{
  overview: AdminOverviewDto;
  workers: AdminWorkerDto[];
  models: AdminModelDto[];
}> {
  if (options.fixtureMode) {
    return getFixtureAdminOverview();
  }
  const [overview, workers, models] = await Promise.all([
    apiRequest<AdminOverviewDto>('/admin/overview', {
      method: 'GET',
      signal: options.signal,
    }),
    apiRequest<AdminWorkerDto[]>('/admin/workers', {
      method: 'GET',
      signal: options.signal,
    }),
    apiRequest<AdminModelDto[]>('/admin/models', {
      method: 'GET',
      signal: options.signal,
    }),
  ]);
  return { overview, workers, models };
}

export async function fetchAdminUsers(
  params: AdminUsersListParams,
  options: { signal?: AbortSignal; fixtureMode?: boolean },
): Promise<PaginatedResponse<AdminDoctorUserDto>> {
  return listAdminUsers(params, options);
}

export async function fetchAdminJobs(
  params: AdminJobsListParams,
  options: { signal?: AbortSignal; fixtureMode?: boolean },
): Promise<PaginatedResponse<AdminJobDto>> {
  if (options.fixtureMode) {
    return getFixtureAdminJobs(params);
  }
  const qs = buildSearchParams({
    q: params.q,
    state: params.status === 'all' ? undefined : params.status,
    page: params.page,
    page_size: params.pageSize,
  });
  return apiRequest<PaginatedResponse<AdminJobDto>>(`/admin/jobs${qs}`, {
    method: 'GET',
    signal: options.signal,
  });
}

export async function retryAdminJob(
  jobId: string,
  options: { fixtureMode?: boolean } = {},
): Promise<AdminJobDto> {
  if (options.fixtureMode) return retryFixtureAdminJob(jobId);
  return apiRequest<AdminJobDto>(`/admin/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: 'POST',
    body: {},
  });
}

export async function fetchAdminJobDetail(
  jobId: string,
  options: { signal?: AbortSignal; fixtureMode?: boolean },
): Promise<AdminJobDetailDto> {
  if (options.fixtureMode) return getFixtureAdminJobDetail(jobId);
  return apiRequest<AdminJobDetailDto>(`/admin/jobs/${encodeURIComponent(jobId)}`, {
    method: 'GET',
    signal: options.signal,
  });
}

export async function fetchAdminSettings(options: {
  signal?: AbortSignal;
  fixtureMode?: boolean;
}): Promise<{ settings: AdminSettingsDto; models: AdminModelDto[] }> {
  if (options.fixtureMode) {
    return getFixtureAdminSettings();
  }
  const [settings, models] = await Promise.all([
    apiRequest<AdminSettingsDto>('/admin/settings', {
      method: 'GET',
      signal: options.signal,
    }),
    apiRequest<AdminModelDto[]>('/admin/models', {
      method: 'GET',
      signal: options.signal,
    }),
  ]);
  return { settings, models };
}

export async function updateAdminSettings(
  settings: AdminSettingsDto,
  options: { fixtureMode?: boolean } = {},
): Promise<AdminSettingsDto> {
  const payload = {
    version: settings.version,
    accepting_jobs: settings.accepting_jobs,
    max_upload_mib: settings.max_upload_mib,
    max_decompressed_mib: settings.max_decompressed_mib,
    default_doctor_quota_gib: settings.default_doctor_quota_gib,
    system_quota_gib: settings.system_quota_gib,
  };
  if (options.fixtureMode) return updateFixtureAdminSettings(payload);
  return apiRequest<AdminSettingsDto>('/admin/settings', {
    method: 'PATCH',
    body: payload,
  });
}

export async function fetchAdminAuditEvents(
  params: AdminAuditEventListParams,
  options: { signal?: AbortSignal; fixtureMode?: boolean },
): Promise<PaginatedResponse<AuditEventDto>> {
  if (options.fixtureMode) {
    return getFixtureAuditEvents(params);
  }
  const qs = buildSearchParams({
    q: params.q,
    page: params.page,
    page_size: params.pageSize,
  });
  return apiRequest<PaginatedResponse<AuditEventDto>>(
    `/admin/audit-events${qs}`,
    {
      method: 'GET',
      signal: options.signal,
    },
  );
}

export async function fetchAdminWorkers(options: {
  signal?: AbortSignal;
  fixtureMode?: boolean;
}): Promise<AdminWorkerDto[]> {
  if (options.fixtureMode) {
    return getFixtureAdminOverview().workers;
  }
  return apiRequest<AdminWorkerDto[]>('/admin/workers', {
    method: 'GET',
    signal: options.signal,
  });
}

export async function fetchAdminBenchmarks(
  params: AdminBenchmarksListParams,
  options: { signal?: AbortSignal; fixtureMode?: boolean },
): Promise<PaginatedResponse<AdminBenchmarkSummaryDto>> {
  if (options.fixtureMode) {
    return getFixtureAdminBenchmarks(params);
  }
  const qs = buildSearchParams({
    q: params.q,
    state: params.state === 'all' ? undefined : params.state,
    worker_id: params.workerId,
    page: params.page,
    page_size: params.pageSize,
  });
  return apiRequest<PaginatedResponse<AdminBenchmarkSummaryDto>>(
    `/admin/benchmarks${qs}`,
    {
      method: 'GET',
      signal: options.signal,
    },
  );
}

export async function fetchAdminBenchmarkDetail(
  benchmarkId: string,
  options: { signal?: AbortSignal; fixtureMode?: boolean },
): Promise<AdminBenchmarkDetailDto> {
  if (options.fixtureMode) {
    return getFixtureAdminBenchmarkDetail(benchmarkId);
  }
  return apiRequest<AdminBenchmarkDetailDto>(
    `/admin/benchmarks/${encodeURIComponent(benchmarkId)}`,
    {
      method: 'GET',
      signal: options.signal,
    },
  );
}

export async function createAdminBenchmark(
  payload: {
    title: string;
    targetWorkerId: string;
    notes?: string;
    flair: File;
    t1ce: File;
    gtMask: File;
  },
  options: { fixtureMode?: boolean } = {},
): Promise<AdminBenchmarkDetailDto> {
  if (options.fixtureMode) {
    return createFixtureAdminBenchmark(payload);
  }
  const form = new FormData();
  form.append('title', payload.title.trim());
  form.append('target_worker_id', payload.targetWorkerId);
  if (payload.notes?.trim()) {
    form.append('notes', payload.notes.trim());
  }
  form.append('flair', payload.flair);
  form.append('t1ce', payload.t1ce);
  form.append('gt_mask', payload.gtMask);

  return apiRequest<AdminBenchmarkDetailDto>('/admin/benchmarks', {
    method: 'POST',
    body: form,
  });
}

export async function deleteAdminBenchmark(
  benchmarkId: string,
  options: { fixtureMode?: boolean } = {},
): Promise<BenchmarkDeletionDto> {
  if (options.fixtureMode) {
    return deleteFixtureAdminBenchmark(benchmarkId);
  }
  return apiRequest<BenchmarkDeletionDto>(
    `/admin/benchmarks/${encodeURIComponent(benchmarkId)}`,
    {
      method: 'DELETE',
    },
  );
}

export async function downloadAdminBenchmarkArtifactBuffer(
  benchmarkId: string,
  artifact: BenchmarkArtifactKind,
  options: { signal?: AbortSignal; fixtureMode?: boolean } = {},
): Promise<ArrayBuffer> {
  if (options.fixtureMode) {
    return getFixtureAdminBenchmarkArtifactBuffer(benchmarkId, artifact);
  }
  const { response, requestEpoch } = await fetchProtectedBinary(
    `/admin/benchmarks/${encodeURIComponent(benchmarkId)}/files/${encodeURIComponent(artifact)}`,
    { signal: options.signal },
  );
  const bytes = await response.arrayBuffer();
  assertBinaryRequestCurrent(requestEpoch, options.signal);
  return bytes;
}
