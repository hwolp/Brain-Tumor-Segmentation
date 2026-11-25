import type {
  AdminAuditEventListParams,
  AdminBenchmarksListParams,
  AdminJobsListParams,
  AdminUsersListParams,
  PatientsListParams,
} from './endpointParams';
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
  CaseCreateRequest,
  CaseDto,
  CaseUpdateRequest,
  DeletionStatusOut,
  InferenceJobDto,
  LivenessResponse,
  MaskMetadataExportOut,
  MaskVersionDto,
  PaginatedResponse,
  PatientCreateRequest,
  PatientDto,
  PatientUpdateRequest,
  ReadinessResponse,
  SystemAvailabilityDto,
  UserDto,
  VolumeDto,
  VolumeModality,
} from './types';
import { BRATS_COMPOSITE_GROUPS, BRATS_LABELS, BRATS_TUMOR_LABEL_IDS } from '@/shared/lib/labels';
import { ApiClientError } from './errors';

export const FIXTURE_USERS: Record<'doctor' | 'admin', UserDto> = {
  doctor: {
    id: '00000000-0000-4000-8000-000000000101',
    username: 'nguyenthengoc',
    display_name: 'BS. Nguyễn Thế Ngọc',
    role: 'doctor',
    is_active: true,
    must_change_password: false,
    created_at: '2026-01-10T03:00:00Z',
  },
  admin: {
    id: '00000000-0000-4000-8000-000000000001',
    username: 'adminops',
    display_name: 'Quản trị vận hành',
    role: 'admin',
    is_active: true,
    must_change_password: false,
    created_at: '2026-01-01T01:00:00Z',
  },
};

export const FIXTURE_HEALTH_LIVE: LivenessResponse = {
  status: 'ok',
  service: 'brain-tumor-api',
  environment: 'local',
};

export const FIXTURE_HEALTH_READY: ReadinessResponse = {
  status: 'ready',
  checks: {
    database: 'ok',
    storage: 'ok',
  },
};

const FIXTURE_PATIENTS: PatientDto[] = [
  {
    id: '10000000-0000-4000-8000-000000000001',
    patient_code: 'BN-BRATS-001',
    full_name: 'Trần Văn An (Mẫu)',
    birth_year: 1968,
    sex: 'male',
    owner_id: FIXTURE_USERS.doctor.id,
    case_count: 2,
    created_at: '2026-05-01T02:15:00Z',
    updated_at: '2026-05-15T09:30:00Z',
  },
  {
    id: '10000000-0000-4000-8000-000000000002',
    patient_code: 'BN-BRATS-002',
    full_name: 'Lê Thị Bình (Mẫu)',
    birth_year: 1974,
    sex: 'female',
    owner_id: FIXTURE_USERS.doctor.id,
    case_count: 1,
    created_at: '2026-05-04T06:20:00Z',
    updated_at: '2026-05-14T16:45:00Z',
  },
];

const FIXTURE_CASES: CaseDto[] = [
  {
    id: '20000000-0000-4000-8000-000000000001',
    patient_id: FIXTURE_PATIENTS[0]!.id,
    patient_code: FIXTURE_PATIENTS[0]!.patient_code,
    study_date: '2026-05-15',
    notes: 'Ca dữ liệu BraTS mẫu dùng kiểm thử giao diện P1 (FLAIR + T1ce đồng nhất lưới 240×240×155).',
    reference_volume_id: '30000000-0000-4000-8000-000000000001',
    readiness: 'ready',
    is_inputs_locked: true,
    inputs_locked_at: '2026-05-15T09:10:00Z',
    can_run_inference: true,
    latest_mask_version_id: '50000000-0000-4000-8000-000000000001',
    latest_job_state: 'succeeded',
    created_at: '2026-05-15T02:00:00Z',
    updated_at: '2026-05-15T09:30:00Z',
  },
  {
    id: '20000000-0000-4000-8000-000000000002',
    patient_id: FIXTURE_PATIENTS[0]!.id,
    patient_code: FIXTURE_PATIENTS[0]!.patient_code,
    study_date: '2026-04-20',
    notes: 'Ca mới tạo thiếu xung T1ce.',
    reference_volume_id: '30000000-0000-4000-8000-000000000003',
    readiness: 'missing_inputs',
    is_inputs_locked: false,
    latest_mask_version_id: null,
    latest_job_state: null,
    created_at: '2026-04-20T04:00:00Z',
    updated_at: '2026-04-20T04:10:00Z',
  },
  {
    id: '20000000-0000-4000-8000-000000000003',
    patient_id: FIXTURE_PATIENTS[1]!.id,
    patient_code: FIXTURE_PATIENTS[1]!.patient_code,
    study_date: '2026-05-14',
    notes: 'Đang kiểm tra đồng bộ không gian.',
    reference_volume_id: null,
    readiness: 'missing_inputs',
    is_inputs_locked: false,
    latest_mask_version_id: null,
    latest_job_state: null,
    created_at: '2026-05-14T10:00:00Z',
    updated_at: '2026-05-14T10:00:00Z',
  },
];

const FIXTURE_VOLUMES: VolumeDto[] = [
  {
    id: '30000000-0000-4000-8000-000000000001',
    case_id: FIXTURE_CASES[0]!.id,
    modality: 'flair',
    file_id: '40000000-0000-4000-8000-000000000001',
    filename: 'brats_sample_flair.nii.gz',
    validation_status: 'valid',
    validation_error: null,
    shape: [240, 240, 155],
    spacing_mm: [1, 1, 1],
    affine: [
      [1, 0, 0, -120],
      [0, 1, 0, -120],
      [0, 0, 1, -78],
      [0, 0, 0, 1],
    ],
    orientation: 'RAS',
    size_bytes: 18_432_000,
    sha256: 'e3b0c44298fc1c149afbf4c8996fb924',
  },
  {
    id: '30000000-0000-4000-8000-000000000002',
    case_id: FIXTURE_CASES[0]!.id,
    modality: 't1ce',
    file_id: '40000000-0000-4000-8000-000000000002',
    filename: 'brats_sample_t1ce.nii.gz',
    validation_status: 'valid',
    validation_error: null,
    shape: [240, 240, 155],
    spacing_mm: [1, 1, 1],
    affine: [
      [1, 0, 0, -120],
      [0, 1, 0, -120],
      [0, 0, 1, -78],
      [0, 0, 0, 1],
    ],
    orientation: 'RAS',
    size_bytes: 17_910_000,
    sha256: '9f86d081884c7d659a2feaa0c55ad015',
  },
];

const FIXTURE_JOBS: InferenceJobDto[] = [
  {
    id: '60000000-0000-4000-8000-000000000001',
    case_id: FIXTURE_CASES[0]!.id,
    model_version_id: 'tda-segunet-v1.0',
    state: 'succeeded',
    stage: 'done',
    completed_slices: 155,
    total_slices: 155,
    attempt_count: 1,
    max_auto_retries: 1,
    error_code: null,
    created_at: '2026-05-15T09:10:00Z',
    started_at: '2026-05-15T09:10:05Z',
    finished_at: '2026-05-15T09:11:02Z',
    result_mask_version_id: '50000000-0000-4000-8000-000000000001',
  },
];

const fixtureJobRequestKeys = new Map<string, string>();
const FIXTURE_ADMIN_SETTINGS: AdminSettingsDto = {
  version: 1,
  accepting_jobs: true,
  max_upload_mib: 100,
  max_decompressed_mib: 256,
  default_doctor_quota_gib: 2,
  system_quota_gib: 20,
  updated_at: '2026-05-15T08:12:00Z',
};

const FIXTURE_MASK_VERSIONS: MaskVersionDto[] = [
  {
    id: '50000000-0000-4000-8000-000000000001',
    case_id: FIXTURE_CASES[0]!.id,
    version_number: 1,
    source: 'ai',
    base_version_id: null,
    reference_volume_id: FIXTURE_VOLUMES[0]!.id,
    file_id: '40000000-0000-4000-8000-000000000099',
    created_by: FIXTURE_USERS.doctor.id,
    created_by_name: 'TDA-SegUNet v1.0 (AI)',
    created_at: '2026-05-15T09:11:02Z',
    note: 'Phân đoạn tự động từ mô hình TDA-SegUNet (dữ liệu mẫu)',
    model_version_id: 'tda-segunet-v1.0',
    job_id: FIXTURE_JOBS[0]!.id,
    label_voxel_counts: { '1': 12450, '2': 38900, '4': 9650 },
    label_volumes_mm3: { '1': 12450, '2': 38900, '4': 9650 },
    sha256: '4a7d1ed414474e4033ac29ccb8653d9b',
  },
];

const FIXTURE_ADMIN_USERS: AdminDoctorUserDto[] = [
  {
    id: FIXTURE_USERS.doctor.id,
    username: 'nguyenthengoc',
    display_name: 'BS. Nguyễn Thế Ngọc',
    role: 'doctor',
    is_active: true,
    must_change_password: false,
    created_at: '2026-01-10T03:00:00Z',
    updated_at: '2026-01-10T03:00:00Z',
  },
  {
    id: '00000000-0000-4000-8000-000000000102',
    username: 'phamthilan',
    display_name: 'BS. Phạm Thị Lan',
    role: 'doctor',
    is_active: false,
    must_change_password: true,
    created_at: '2026-02-14T08:00:00Z',
    updated_at: '2026-02-14T08:00:00Z',
  },
];

const FIXTURE_ADMIN_JOBS: AdminJobDto[] = [
  {
    id: '60000000-0000-4000-8000-000000000001',
    case_id: '20000000-0000-4000-8000-000000000001',
    doctor_username: 'nguyenthengoc',
    model_version: 'tda-segunet-v1.0',
    state: 'succeeded',
    stage: 'done',
    attempt_count: 1,
    error_code: null,
    created_at: '2026-05-15T09:10:00Z',
    started_at: '2026-05-15T09:10:05Z',
    finished_at: '2026-05-15T09:11:02Z',
  },
  {
    id: '60000000-0000-4000-8000-000000000002',
    case_id: '20000000-0000-4000-8000-000000000009',
    doctor_username: 'nguyenthengoc',
    model_version: 'tda-segunet-v1.0',
    state: 'failed',
    stage: 'inference',
    attempt_count: 2,
    error_code: 'worker_lease_expired',
    created_at: '2026-05-14T15:00:00Z',
    started_at: '2026-05-14T15:00:08Z',
    finished_at: '2026-05-14T15:02:10Z',
  },
];

const FIXTURE_AUDIT_EVENTS: AuditEventDto[] = [
  {
    id: '70000000-0000-4000-8000-000000000001',
    created_at: '2026-05-15T07:45:00Z',
    actor_username: 'adminops',
    action: 'admin.user.create',
    target_id: FIXTURE_USERS.doctor.id,
    outcome: 'success',
    request_id: 'req-fixture-001',
  },
  {
    id: '70000000-0000-4000-8000-000000000002',
    created_at: '2026-05-15T08:12:00Z',
    actor_username: 'adminops',
    action: 'admin.settings.update',
    target_id: 'system-settings',
    outcome: 'success',
    request_id: 'req-fixture-002',
  },
];

export function getFixturePatients(
  params: PatientsListParams,
): PaginatedResponse<PatientDto> {
  const query = (params.q ?? '').trim().toLowerCase();
  const filtered = query
    ? FIXTURE_PATIENTS.filter(
        (p) =>
          p.patient_code.toLowerCase().includes(query) ||
          p.full_name.toLowerCase().includes(query),
      )
    : FIXTURE_PATIENTS;

  const start = (params.page - 1) * params.pageSize;
  return {
    items: filtered.slice(start, start + params.pageSize),
    total: filtered.length,
    page: params.page,
    page_size: params.pageSize,
  };
}

export function getFixturePatientDetail(id: string): {
  patient: PatientDto;
  cases: CaseDto[];
} {
  const patient =
    FIXTURE_PATIENTS.find((p) => p.id === id) ?? FIXTURE_PATIENTS[0]!;
  const cases = FIXTURE_CASES.filter((c) => c.patient_id === patient.id);
  return { patient, cases };
}

export function getFixtureCases(): PaginatedResponse<CaseDto> {
  return {
    items: FIXTURE_CASES,
    total: FIXTURE_CASES.length,
    page: 1,
    page_size: 20,
  };
}

export function getFixtureCaseDetail(id: string): {
  caseData: CaseDto;
  volumes: VolumeDto[];
  jobs: InferenceJobDto[];
  maskVersions: MaskVersionDto[];
} {
  const caseData = FIXTURE_CASES.find((c) => c.id === id) ?? FIXTURE_CASES[0]!;
  return {
    caseData,
    volumes: FIXTURE_VOLUMES.filter((v) => v.case_id === caseData.id),
    jobs: FIXTURE_JOBS.filter((j) => j.case_id === caseData.id),
    maskVersions: FIXTURE_MASK_VERSIONS.filter((m) => m.case_id === caseData.id),
  };
}

export function getFixtureSystemAvailability(): SystemAvailabilityDto {
  const overview = getFixtureAdminOverview();
  const activeModel = overview.models.find((m) => m.is_active) ?? null;
  return {
    accepting_jobs: FIXTURE_ADMIN_SETTINGS.accepting_jobs,
    worker_online: overview.overview.worker_online,
    active_model_id: activeModel?.id ?? null,
    updated_at: new Date().toISOString(),
  };
}

export function getFixtureInferenceJob(jobId: string): InferenceJobDto {
  const job = FIXTURE_JOBS.find((item) => item.id === jobId);
  if (!job) {
    throw new ApiClientError({ status: 404, code: 'job_not_found' });
  }
  return { ...job };
}

export function createFixtureInferenceJob(
  caseId: string,
  idempotencyKey: string,
): InferenceJobDto {
  const requestScope = `${caseId}:${idempotencyKey}`;
  const existingId = fixtureJobRequestKeys.get(requestScope);
  if (existingId) {
    const existing = FIXTURE_JOBS.find((job) => job.id === existingId);
    if (existing) return existing;
  }
  if (!FIXTURE_ADMIN_SETTINGS.accepting_jobs) {
    throw new ApiClientError({ status: 503, code: 'not_accepting_jobs' });
  }
  const caseData = FIXTURE_CASES.find((item) => item.id === caseId);
  if (!caseData || (!caseData.can_run_inference && caseData.readiness !== 'ready')) {
    throw new ApiClientError({ status: 422, code: 'case_not_ready' });
  }
  if (FIXTURE_JOBS.some((job) => job.case_id === caseId && ['queued', 'running'].includes(job.state))) {
    throw new ApiClientError({ status: 409, code: 'active_job_conflict' });
  }
  const now = new Date().toISOString();
  const job: InferenceJobDto = {
    id: nextFixtureUuid('60000000'),
    case_id: caseId,
    model_version_id: 'tda-segunet-v1.0',
    state: 'queued',
    stage: 'queued',
    completed_slices: 0,
    total_slices: 155,
    attempt_count: 0,
    max_auto_retries: 1,
    error_code: null,
    created_at: now,
    started_at: null,
    finished_at: null,
    result_mask_version_id: null,
  };
  FIXTURE_JOBS.unshift(job);
  fixtureJobRequestKeys.set(requestScope, job.id);
  caseData.latest_job_state = 'queued';
  caseData.is_inputs_locked = true;
  caseData.inputs_locked_at = now;
  return job;
}

export function cancelFixtureInferenceJob(jobId: string): InferenceJobDto {
  const job = FIXTURE_JOBS.find((item) => item.id === jobId);
  if (!job) throw new ApiClientError({ status: 404, code: 'job_not_found' });
  if (job.state !== 'queued') throw new ApiClientError({ status: 409, code: 'job_not_cancellable' });
  job.state = 'cancelled';
  job.finished_at = new Date().toISOString();
  const caseData = FIXTURE_CASES.find((item) => item.id === job.case_id);
  if (caseData) {
    caseData.latest_job_state = 'cancelled';
    const hasOtherActiveJob = FIXTURE_JOBS.some(
      (item) =>
        item.case_id === caseData.id &&
        item.id !== job.id &&
        (item.state === 'queued' || item.state === 'running'),
    );
    if (!caseData.latest_mask_version_id && !hasOtherActiveJob) {
      caseData.is_inputs_locked = false;
      caseData.inputs_locked_at = null;
    }
  }
  return job;
}

export function getFixtureAdminOverview(): {
  overview: AdminOverviewDto;
  workers: AdminWorkerDto[];
  models: AdminModelDto[];
} {
  return {
    overview: {
      active_doctors: 1,
      locked_doctors: 1,
      queued_jobs: FIXTURE_ADMIN_JOBS.filter((job) => job.state === 'queued').length,
      running_jobs: FIXTURE_ADMIN_JOBS.filter((job) => job.state === 'running').length,
      failed_jobs: FIXTURE_ADMIN_JOBS.filter((job) => job.state === 'failed').length,
      storage_used_bytes: 36_342_000,
      storage_quota_bytes: 21_474_836_480,
      worker_online: true,
      updated_at: '2026-05-15T09:30:00Z',
    },
    workers: [
      {
        worker_id: 'worker-local-01',
        online: true,
        device_type: 'GPU',
        active_jobs: 0,
        last_heartbeat_at: '2026-05-15T09:29:50Z',
        model_version: 'tda-segunet-v1.0',
      },
    ],
    models: [
      {
        id: 'tda-segunet-v1.0',
        name: 'TDA-SegUNet',
        version: '1.0.0',
        checkpoint_sha256: 'a1b2c3d4e5f67890123456789abcdef0',
        expected_shape: [240, 240, 155],
        expected_spacing_mm: [1, 1, 1],
        is_active: true,
        verified: true,
      },
    ],
  };
}

export function getFixtureAdminUsers(
  params: AdminUsersListParams,
): PaginatedResponse<AdminDoctorUserDto> {
  const query = (params.q ?? '').trim().toLowerCase();
  const filtered = FIXTURE_ADMIN_USERS.filter((u) => {
    const matchesSearch =
      !query ||
      u.username.toLowerCase().includes(query) ||
      u.display_name.toLowerCase().includes(query);
    const matchesStatus =
      params.status === 'all' ||
      (params.status === 'active' && u.is_active) ||
      (params.status === 'locked' && !u.is_active);
    return matchesSearch && matchesStatus;
  });

  const start = (params.page - 1) * params.pageSize;
  return {
    items: filtered.slice(start, start + params.pageSize),
    total: filtered.length,
    page: params.page,
    page_size: params.pageSize,
  };
}

export function getFixtureAdminJobs(
  params: AdminJobsListParams,
): PaginatedResponse<AdminJobDto> {
  const query = (params.q ?? '').trim().toLowerCase();
  const filtered = FIXTURE_ADMIN_JOBS.filter((j) => {
    const matchesSearch =
      !query ||
      j.id.toLowerCase().includes(query) ||
      j.doctor_username.toLowerCase().includes(query);
    const matchesStatus = params.status === 'all' || j.state === params.status;
    return matchesSearch && matchesStatus;
  });

  const start = (params.page - 1) * params.pageSize;
  return {
    items: filtered.slice(start, start + params.pageSize),
    total: filtered.length,
    page: params.page,
    page_size: params.pageSize,
  };
}

export function getFixtureAdminJobDetail(jobId: string): AdminJobDetailDto {
  const job = FIXTURE_ADMIN_JOBS.find((item) => item.id === jobId);
  if (!job) throw new ApiClientError({ status: 404, code: 'job_not_found' });
  return {
    ...job,
    attempts: job.attempt_count > 0
      ? [{
          id: `${job.id.slice(0, 8)}-0000-4000-8000-000000000001`,
          attempt_number: job.attempt_count,
          worker_id: 'worker-local-01',
          state: job.state === 'succeeded' ? 'succeeded' : job.state === 'failed' ? 'failed' : 'running',
          stage: job.stage,
          error_code: job.error_code,
          started_at: job.started_at ?? job.created_at,
          finished_at: job.finished_at,
        }]
      : [],
  };
}

export function getFixtureAdminSettings(): {
  settings: AdminSettingsDto;
  models: AdminModelDto[];
} {
  return {
    settings: { ...FIXTURE_ADMIN_SETTINGS },
    models: getFixtureAdminOverview().models,
  };
}

export function updateFixtureAdminSettings(
  payload: Omit<AdminSettingsDto, 'updated_at'>,
): AdminSettingsDto {
  if (payload.version !== FIXTURE_ADMIN_SETTINGS.version) {
    throw new ApiClientError({ status: 409, code: 'settings_version_conflict' });
  }
  Object.assign(FIXTURE_ADMIN_SETTINGS, payload, {
    version: payload.version + 1,
    updated_at: new Date().toISOString(),
  });
  return { ...FIXTURE_ADMIN_SETTINGS };
}

export function retryFixtureAdminJob(jobId: string): AdminJobDto {
  const previous = FIXTURE_ADMIN_JOBS.find((item) => item.id === jobId);
  if (!previous) throw new ApiClientError({ status: 404, code: 'job_not_found' });
  if (previous.state !== 'failed') {
    throw new ApiClientError({ status: 409, code: 'job_not_retryable' });
  }
  const retry: AdminJobDto = {
    ...previous,
    id: nextFixtureUuid('60000000'),
    state: 'queued',
    stage: 'queued',
    attempt_count: 0,
    error_code: null,
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
  };
  FIXTURE_ADMIN_JOBS.unshift(retry);
  return retry;
}

export function getFixtureAuditEvents(
  params: AdminAuditEventListParams,
): PaginatedResponse<AuditEventDto> {
  const query = (params.q ?? '').trim().toLowerCase();
  const filtered = FIXTURE_AUDIT_EVENTS.filter((e) => {
    return (
      !query ||
      e.actor_username.toLowerCase().includes(query) ||
      e.action.toLowerCase().includes(query) ||
      e.request_id.toLowerCase().includes(query)
    );
  });
  const start = (params.page - 1) * params.pageSize;
  return {
    items: filtered.slice(start, start + params.pageSize),
    total: filtered.length,
    page: params.page,
    page_size: params.pageSize,
  };
}

function nextFixtureUuid(prefix: string): string {
  const tail = Math.floor(Math.random() * 0xffffffffffff)
    .toString(16)
    .padStart(12, '0');
  return `${prefix}-0000-4000-8000-${tail}`;
}

const fixtureIdempotencyMap = new Map<
  string,
  { digest: string; caseId: string }
>();

export function fixtureCreatePatient(
  payload: PatientCreateRequest,
): PatientDto {
  const normalizedCode = payload.patient_code.trim().toLowerCase();
  if (
    FIXTURE_PATIENTS.some(
      (p) => p.patient_code.trim().toLowerCase() === normalizedCode,
    )
  ) {
    throw new ApiClientError({
      status: 409,
      code: 'patient_code_exists',
      requestId: 'req-fixture-patient-409',
    });
  }
  const now = new Date().toISOString();
  const created: PatientDto = {
    id: nextFixtureUuid('10000000'),
    patient_code: payload.patient_code.trim(),
    full_name: payload.full_name.trim(),
    birth_year: payload.birth_year,
    sex: payload.sex,
    owner_id: FIXTURE_USERS.doctor.id,
    case_count: 0,
    created_at: now,
    updated_at: now,
  };
  FIXTURE_PATIENTS.unshift(created);
  return created;
}

export function fixtureUpdatePatient(
  patientId: string,
  payload: PatientUpdateRequest,
): PatientDto {
  const idx = FIXTURE_PATIENTS.findIndex((p) => p.id === patientId);
  if (idx === -1) {
    throw new ApiClientError({
      status: 404,
      code: 'patient_not_found',
      requestId: 'req-fixture-patient-404',
    });
  }
  const existing = FIXTURE_PATIENTS[idx]!;
  if (payload.patient_code !== undefined && payload.patient_code !== null) {
    const normalizedCode = payload.patient_code.trim().toLowerCase();
    if (
      FIXTURE_PATIENTS.some(
        (p) =>
          p.id !== patientId &&
          p.patient_code.trim().toLowerCase() === normalizedCode,
      )
    ) {
      throw new ApiClientError({
        status: 409,
        code: 'patient_code_exists',
        requestId: 'req-fixture-patient-409',
      });
    }
  }
  const updated: PatientDto = {
    ...existing,
    patient_code: payload.patient_code?.trim() ?? existing.patient_code,
    full_name: payload.full_name?.trim() ?? existing.full_name,
    birth_year: payload.birth_year ?? existing.birth_year,
    sex: payload.sex ?? existing.sex,
    updated_at: new Date().toISOString(),
  };
  FIXTURE_PATIENTS[idx] = updated;
  return updated;
}

export function fixtureDeletePatient(patientId: string): DeletionStatusOut {
  const idx = FIXTURE_PATIENTS.findIndex((p) => p.id === patientId);
  if (idx === -1) {
    throw new ApiClientError({
      status: 404,
      code: 'patient_not_found',
      requestId: 'req-fixture-patient-404',
    });
  }
  const patientCases = FIXTURE_CASES.filter((c) => c.patient_id === patientId);
  const hasActiveJob = patientCases.some((c) =>
    FIXTURE_JOBS.some(
      (j) =>
        j.case_id === c.id && (j.state === 'queued' || j.state === 'running'),
    ),
  );
  if (hasActiveJob) {
    throw new ApiClientError({
      status: 409,
      code: 'active_job_conflict',
      requestId: 'req-fixture-patient-job-409',
    });
  }
  FIXTURE_PATIENTS.splice(idx, 1);
  for (let i = FIXTURE_CASES.length - 1; i >= 0; i -= 1) {
    if (FIXTURE_CASES[i]!.patient_id === patientId) {
      const removedCaseId = FIXTURE_CASES[i]!.id;
      FIXTURE_CASES.splice(i, 1);
      for (let v = FIXTURE_VOLUMES.length - 1; v >= 0; v -= 1) {
        if (FIXTURE_VOLUMES[v]!.case_id === removedCaseId) {
          FIXTURE_VOLUMES.splice(v, 1);
        }
      }
    }
  }
  return {
    resource_type: 'patient',
    resource_id: patientId,
    status: 'deleted',
    files_cleaned: 0,
    message: 'Đã xóa hồ sơ bệnh nhân.',
  };
}

export function fixtureCreateCase(
  patientId: string,
  payload: CaseCreateRequest,
  idempotencyKey: string,
): CaseDto {
  const patient = FIXTURE_PATIENTS.find((p) => p.id === patientId);
  if (!patient) {
    throw new ApiClientError({
      status: 404,
      code: 'patient_not_found',
      requestId: 'req-fixture-case-pat-404',
    });
  }
  const scopeKey = `${patientId}:${idempotencyKey}`;
  const digest = JSON.stringify({
    study_date: payload.study_date,
    notes: payload.notes ?? null,
  });
  const existingReceipt = fixtureIdempotencyMap.get(scopeKey);
  if (existingReceipt) {
    if (existingReceipt.digest !== digest) {
      throw new ApiClientError({
        status: 409,
        code: 'idempotency_conflict',
        requestId: 'req-fixture-idem-409',
      });
    }
    const found = FIXTURE_CASES.find((c) => c.id === existingReceipt.caseId);
    if (!found) {
      throw new ApiClientError({
        status: 409,
        code: 'case_deleted',
        requestId: 'req-fixture-case-deleted-409',
      });
    }
    return found;
  }

  const now = new Date().toISOString();
  const created: CaseDto = {
    id: nextFixtureUuid('20000000'),
    patient_id: patientId,
    patient_code: patient.patient_code,
    study_date: payload.study_date,
    notes: payload.notes ?? null,
    reference_volume_id: null,
    readiness: 'missing_inputs',
    input_revision: 0,
    is_inputs_locked: false,
    can_run_inference: false,
    blocking_reasons: ['Thiếu xung FLAIR', 'Thiếu xung T1ce'],
    latest_mask_version_id: null,
    latest_job_state: null,
    created_at: now,
    updated_at: now,
  };
  FIXTURE_CASES.unshift(created);
  patient.case_count = (patient.case_count ?? 0) + 1;
  fixtureIdempotencyMap.set(scopeKey, { digest, caseId: created.id });
  return created;
}

export function fixtureUpdateCase(
  caseId: string,
  payload: CaseUpdateRequest,
): CaseDto {
  const idx = FIXTURE_CASES.findIndex((c) => c.id === caseId);
  if (idx === -1) {
    throw new ApiClientError({
      status: 404,
      code: 'case_not_found',
      requestId: 'req-fixture-case-404',
    });
  }
  const existing = FIXTURE_CASES[idx]!;
  const updated: CaseDto = {
    ...existing,
    study_date: payload.study_date ?? existing.study_date,
    notes: payload.notes !== undefined ? payload.notes : existing.notes,
    updated_at: new Date().toISOString(),
  };
  FIXTURE_CASES[idx] = updated;
  return updated;
}

export function fixtureDeleteCase(caseId: string): DeletionStatusOut {
  const idx = FIXTURE_CASES.findIndex((c) => c.id === caseId);
  if (idx === -1) {
    throw new ApiClientError({
      status: 404,
      code: 'case_not_found',
      requestId: 'req-fixture-case-404',
    });
  }
  const hasActiveJob = FIXTURE_JOBS.some(
    (j) =>
      j.case_id === caseId && (j.state === 'queued' || j.state === 'running'),
  );
  if (hasActiveJob) {
    throw new ApiClientError({
      status: 409,
      code: 'active_job_conflict',
      requestId: 'req-fixture-case-job-409',
    });
  }
  const removed = FIXTURE_CASES[idx]!;
  FIXTURE_CASES.splice(idx, 1);
  const pat = FIXTURE_PATIENTS.find((p) => p.id === removed.patient_id);
  if (pat && pat.case_count && pat.case_count > 0) {
    pat.case_count -= 1;
  }
  for (let v = FIXTURE_VOLUMES.length - 1; v >= 0; v -= 1) {
    if (FIXTURE_VOLUMES[v]!.case_id === caseId) {
      FIXTURE_VOLUMES.splice(v, 1);
    }
  }
  return {
    resource_type: 'case',
    resource_id: caseId,
    status: 'deleted',
    files_cleaned: 0,
    message: 'Đã xóa ca chụp.',
  };
}

function recomputeFixtureCaseReadiness(caseItem: CaseDto): void {
  const vols = FIXTURE_VOLUMES.filter(
    (v) => v.case_id === caseItem.id && v.validation_status === 'valid',
  );
  const hasFlair = vols.some((v) => v.modality === 'flair');
  const hasT1ce = vols.some((v) => v.modality === 't1ce');
  const reasons: string[] = [];
  if (!hasFlair) reasons.push('Thiếu xung FLAIR');
  if (!hasT1ce) reasons.push('Thiếu xung T1ce');
  caseItem.readiness = hasFlair && hasT1ce ? 'ready' : 'missing_inputs';
  caseItem.can_run_inference = hasFlair && hasT1ce;
  caseItem.blocking_reasons = reasons;
  const flairVol = vols.find((v) => v.modality === 'flair');
  if (!caseItem.reference_volume_id) {
    caseItem.reference_volume_id = flairVol?.id ?? vols[0]?.id ?? null;
  }
  caseItem.updated_at = new Date().toISOString();
}

export function fixtureUploadCaseVolume(
  caseId: string,
  modality: VolumeModality,
  file: File,
): VolumeDto {
  const caseItem = FIXTURE_CASES.find((c) => c.id === caseId);
  if (!caseItem) {
    throw new ApiClientError({
      status: 404,
      code: 'case_not_found',
      requestId: 'req-fixture-case-404',
    });
  }
  if (caseItem.is_inputs_locked || caseItem.latest_mask_version_id) {
    throw new ApiClientError({
      status: 409,
      code: 'inputs_locked',
      requestId: 'req-fixture-locked-409',
    });
  }
  if (
    FIXTURE_VOLUMES.some(
      (v) => v.case_id === caseId && v.modality === modality,
    )
  ) {
    throw new ApiClientError({
      status: 409,
      code: 'modality_exists',
      requestId: 'req-fixture-mod-409',
    });
  }
  const volume: VolumeDto = {
    id: nextFixtureUuid('30000000'),
    case_id: caseId,
    modality,
    file_id: nextFixtureUuid('40000000'),
    filename: file.name,
    validation_status: 'valid',
    validation_errors: null,
    validation_error: null,
    shape: [240, 240, 155],
    spacing_mm: [1, 1, 1],
    affine: [
      [1, 0, 0, -120],
      [0, 1, 0, -120],
      [0, 0, 1, -78],
      [0, 0, 0, 1],
    ],
    orientation: 'RAS',
    datatype: 'float32',
    size_bytes: file.size,
    sha256: 'fixture-sha256',
    created_at: new Date().toISOString(),
  };
  FIXTURE_VOLUMES.push(volume);
  recomputeFixtureCaseReadiness(caseItem);
  return volume;
}

export function fixtureDeleteCaseVolume(
  caseId: string,
  volumeId: string,
): DeletionStatusOut {
  const caseItem = FIXTURE_CASES.find((c) => c.id === caseId);
  if (!caseItem) {
    throw new ApiClientError({
      status: 404,
      code: 'case_not_found',
      requestId: 'req-fixture-case-404',
    });
  }
  if (caseItem.is_inputs_locked || caseItem.latest_mask_version_id) {
    throw new ApiClientError({
      status: 409,
      code: 'inputs_locked',
      requestId: 'req-fixture-locked-409',
    });
  }
  const idx = FIXTURE_VOLUMES.findIndex(
    (v) => v.case_id === caseId && v.id === volumeId,
  );
  if (idx === -1) {
    throw new ApiClientError({
      status: 404,
      code: 'volume_not_found',
      requestId: 'req-fixture-vol-404',
    });
  }
  FIXTURE_VOLUMES.splice(idx, 1);
  if (caseItem.reference_volume_id === volumeId) {
    caseItem.reference_volume_id = null;
  }
  recomputeFixtureCaseReadiness(caseItem);
  return {
    resource_type: 'volume',
    resource_id: volumeId,
    status: 'deleted',
    files_cleaned: 0,
    message: 'Đã xóa xung MRI.',
  };
}

const fixtureMaskFileBuffers = new Map<string, Uint8Array>();

export function getFixtureMaskFileBuffer(fileId: string): Uint8Array | null {
  return fixtureMaskFileBuffers.get(fileId) ?? null;
}

export function getFixtureMaskVersions(
  caseId: string,
): PaginatedResponse<MaskVersionDto> {
  const items = FIXTURE_MASK_VERSIONS.filter((m) => m.case_id === caseId).sort(
    (a, b) => b.version_number - a.version_number,
  );
  return {
    items,
    total: items.length,
    page: 1,
    page_size: 20,
  };
}

export function getFixtureMaskVersionMetadata(
  versionId: string,
): MaskMetadataExportOut | null {
  const version = FIXTURE_MASK_VERSIONS.find((m) => m.id === versionId);
  if (!version) return null;
  const caseItem = FIXTURE_CASES.find((c) => c.id === version.case_id);
  const refVol = FIXTURE_VOLUMES.find(
    (v) => v.id === version.reference_volume_id,
  );
  const perLabel = BRATS_TUMOR_LABEL_IDS.map((lbl) => {
    const count = version.label_voxel_counts[String(lbl)] ?? 0;
    const mm3 = version.label_volumes_mm3[String(lbl)] ?? 0;
    return {
      label: lbl,
      name: BRATS_LABELS[lbl].shortName,
      voxel_count: count,
      volume_mm3: mm3,
      volume_ml: mm3 / 1000,
    };
  });
  const totalVoxels = perLabel.reduce((s, item) => s + item.voxel_count, 0);
  const totalMm3 = perLabel.reduce((s, item) => s + item.volume_mm3, 0);
  const compositeGroups = BRATS_COMPOSITE_GROUPS.map((grp) => {
    const mm3 = grp.includedLabels.reduce(
      (s, lbl) => s + (version.label_volumes_mm3[String(lbl)] ?? 0),
      0,
    );
    return {
      group: grp.key,
      labels: [...grp.includedLabels],
      volume_mm3: mm3,
      volume_ml: mm3 / 1000,
    };
  });

  return {
    version_id: version.id,
    case_id: version.case_id,
    study_date: caseItem?.study_date ?? '2026-05-15',
    version_number: version.version_number,
    source: version.source,
    base_version_id: version.base_version_id,
    reference_volume_id: version.reference_volume_id,
    model_version_id: version.model_version_id,
    job_id: version.job_id,
    created_at: version.created_at,
    created_by_name: version.created_by_name ?? null,
    sha256: version.sha256,
    labels: {
      '0': BRATS_LABELS[0].shortName,
      '1': BRATS_LABELS[1].shortName,
      '2': BRATS_LABELS[2].shortName,
      '4': BRATS_LABELS[4].shortName,
    },
    coverage: {
      status: version.source === 'ai' ? 'ai_evaluated' : 'manual',
      coverage_file_id: version.coverage_file_id ?? null,
      note:
        version.source === 'ai'
          ? 'Vùng ngoài phạm vi crop của mô hình AI chưa được đánh giá tự động.'
          : 'Phiên bản chỉnh sửa thủ công; thống kê chỉ mô tả vùng đã đánh dấu trên mask đang chọn.',
    },
    geometry: {
      shape: refVol?.shape ? [...refVol.shape] : [240, 240, 155],
      spacing_mm: refVol?.spacing_mm ? [...refVol.spacing_mm] : [1, 1, 1],
      affine: refVol?.affine ?? [
        [1, 0, 0, -120],
        [0, 1, 0, -120],
        [0, 0, 1, -78],
        [0, 0, 0, 1],
      ],
      orientation: refVol?.orientation ?? 'RAS',
      units: 'mm',
    },
    statistics: {
      voxel_volume_mm3: 1,
      per_label: perLabel,
      composite_groups: compositeGroups,
      total_foreground_voxels: totalVoxels,
      total_foreground_volume_mm3: totalMm3,
      total_foreground_volume_ml: totalMm3 / 1000,
    },
  };
}

export function saveFixtureMaskVersion(
  caseId: string,
  params: {
    baseVersionId: string | null;
    referenceVolumeId: string;
    note?: string;
    idempotencyKey: string;
    maskBytes?: Uint8Array;
    labelVoxelCounts?: Record<string, number>;
    labelVolumesMm3?: Record<string, number>;
  },
): MaskVersionDto {
  const caseItem = FIXTURE_CASES.find((c) => c.id === caseId);
  if (!caseItem) {
    throw new ApiClientError({
      status: 404,
      code: 'case_not_found',
      requestId: 'req-fixture-case-404',
    });
  }

  const currentHeadId = caseItem.latest_mask_version_id ?? null;
  if (params.baseVersionId !== currentHeadId) {
    throw new ApiClientError({
      status: 409,
      code: 'mask_version_conflict',
      requestId: 'req-fixture-mask-conflict-409',
    });
  }

  const existing = FIXTURE_MASK_VERSIONS.filter((m) => m.case_id === caseId);
  const nextVersionNumber =
    existing.reduce((max, item) => Math.max(max, item.version_number), 0) + 1;
  const newId = `50000000-0000-4000-8000-${String(Date.now()).slice(-12).padStart(12, '0')}`;
  const newFileId = `40000000-0000-4000-8000-${String(Date.now() + 1).slice(-12).padStart(12, '0')}`;

  if (params.maskBytes) {
    fixtureMaskFileBuffers.set(newFileId, new Uint8Array(params.maskBytes));
  }

  const created: MaskVersionDto = {
    id: newId,
    case_id: caseId,
    version_number: nextVersionNumber,
    source: 'manual',
    base_version_id: params.baseVersionId,
    reference_volume_id: params.referenceVolumeId,
    file_id: newFileId,
    created_by: FIXTURE_USERS.doctor.id,
    created_by_name: FIXTURE_USERS.doctor.display_name,
    created_at: new Date().toISOString(),
    note: params.note?.trim() ? params.note.trim() : null,
    model_version_id: null,
    job_id: null,
    label_voxel_counts: params.labelVoxelCounts ?? { '1': 0, '2': 0, '4': 0 },
    label_volumes_mm3: params.labelVolumesMm3 ?? { '1': 0, '2': 0, '4': 0 },
    sha256: `fixture-${params.idempotencyKey.slice(0, 16)}`,
  };

  FIXTURE_MASK_VERSIONS.unshift(created);
  caseItem.latest_mask_version_id = created.id;
  caseItem.is_inputs_locked = true;
  caseItem.updated_at = created.created_at;

  return created;
}

export function deleteFixtureMaskVersion(
  maskVersionId: string,
): DeletionStatusOut {
  const index = FIXTURE_MASK_VERSIONS.findIndex((m) => m.id === maskVersionId);
  if (index === -1) {
    throw new ApiClientError({
      status: 404,
      code: 'mask_version_not_found',
      requestId: 'req-fixture-mask-404',
    });
  }

  const target = FIXTURE_MASK_VERSIONS[index]!;
  if (target.source !== 'manual') {
    throw new ApiClientError({
      status: 409,
      code: 'ai_mask_not_deletable',
      requestId: 'req-fixture-mask-ai-409',
    });
  }

  FIXTURE_MASK_VERSIONS.splice(index, 1);
  const stillUsed = FIXTURE_MASK_VERSIONS.some(
    (m) => m.file_id === target.file_id,
  );
  if (!stillUsed) {
    fixtureMaskFileBuffers.delete(target.file_id);
  }

  const caseItem = FIXTURE_CASES.find((c) => c.id === target.case_id);
  if (caseItem && caseItem.latest_mask_version_id === target.id) {
    const remaining = FIXTURE_MASK_VERSIONS.filter(
      (m) => m.case_id === target.case_id,
    ).sort((a, b) => b.version_number - a.version_number);
    caseItem.latest_mask_version_id = remaining[0]?.id ?? null;
    caseItem.updated_at = new Date().toISOString();
  }

  return {
    resource_type: 'mask_version',
    resource_id: target.id,
    status: 'deleted',
    files_cleaned: stillUsed ? 0 : 1,
    message: 'Đã xóa phiên bản mask thủ công.',
  };
}

export function updateFixtureMaskVersionNote(
  maskVersionId: string,
  note: string | null,
): MaskVersionDto {
  const target = FIXTURE_MASK_VERSIONS.find((m) => m.id === maskVersionId);
  if (!target) {
    throw new ApiClientError({
      status: 404,
      code: 'mask_version_not_found',
      requestId: 'req-fixture-mask-404',
    });
  }
  const trimmed = note !== null ? note.trim() : '';
  if (trimmed.length > 2000) {
    throw new ApiClientError({
      status: 422,
      code: 'validation_error',
      requestId: 'req-fixture-mask-note-422',
    });
  }
  target.note = trimmed ? trimmed : null;
  return { ...target };
}

const FIXTURE_BENCHMARKS: AdminBenchmarkDetailDto[] = [
  {
    id: '90000000-0000-4000-8000-000000000001',
    title: 'BraTS20_Training_001 - Worker GPU',
    notes: 'Kiểm định đối chiếu với nhãn chuẩn bác sĩ.',
    target_worker_id: 'worker-local-01',
    executed_worker_id: 'worker-local-01',
    worker_device_type: 'GPU',
    model_version_id: 'tda-segunet-v1.0',
    state: 'succeeded',
    stage: 'done',
    completed_slices: 155,
    total_slices: 155,
    error_code: null,
    mean_dice_brats: 0.9125,
    wt_dice: 0.9412,
    tc_dice: 0.9088,
    et_dice: 0.8875,
    inference_duration_ms: 4820,
    created_at: '2026-05-15T09:15:00Z',
    started_at: '2026-05-15T09:15:02Z',
    finished_at: '2026-05-15T09:15:07Z',
    shape: [240, 240, 155],
    spacing_mm: [1, 1, 1],
    affine: [
      [1, 0, 0, -120],
      [0, 1, 0, -120],
      [0, 0, 1, -78],
      [0, 0, 0, 1],
    ],
    metrics: {
      voxel_volume_mm3: 1,
      mean_dice_brats: 0.9125,
      best_slice_z: 77,
      regions: {
        WT: {
          dice: 0.9412,
          iou: 0.8889,
          precision: 0.952,
          recall: 0.9306,
          gt_voxels: 42000,
          pred_voxels: 41056,
          tp_voxels: 39085,
          fp_voxels: 1971,
          fn_voxels: 2915,
          gt_volume_ml: 42.0,
          pred_volume_ml: 41.056,
          volume_diff_ml: -0.944,
          both_empty: false,
        },
        TC: {
          dice: 0.9088,
          iou: 0.8328,
          precision: 0.915,
          recall: 0.9027,
          gt_voxels: 18500,
          pred_voxels: 18251,
          tp_voxels: 16700,
          fp_voxels: 1551,
          fn_voxels: 1800,
          gt_volume_ml: 18.5,
          pred_volume_ml: 18.251,
          volume_diff_ml: -0.249,
          both_empty: false,
        },
        ET: {
          dice: 0.8875,
          iou: 0.7977,
          precision: 0.892,
          recall: 0.883,
          gt_voxels: 9100,
          pred_voxels: 9008,
          tp_voxels: 8035,
          fp_voxels: 973,
          fn_voxels: 1065,
          gt_volume_ml: 9.1,
          pred_volume_ml: 9.008,
          volume_diff_ml: -0.092,
          both_empty: false,
        },
      },
      labels: {
        '1': {
          dice: 0.872,
          iou: 0.773,
          precision: 0.88,
          recall: 0.864,
          gt_voxels: 9400,
          pred_voxels: 9243,
          tp_voxels: 8121,
          fp_voxels: 1122,
          fn_voxels: 1279,
          gt_volume_ml: 9.4,
          pred_volume_ml: 9.243,
          volume_diff_ml: -0.157,
          both_empty: false,
        },
        '2': {
          dice: 0.925,
          iou: 0.8605,
          precision: 0.931,
          recall: 0.919,
          gt_voxels: 23500,
          pred_voxels: 22805,
          tp_voxels: 21596,
          fp_voxels: 1209,
          fn_voxels: 1904,
          gt_volume_ml: 23.5,
          pred_volume_ml: 22.805,
          volume_diff_ml: -0.695,
          both_empty: false,
        },
        '4': {
          dice: 0.8875,
          iou: 0.7977,
          precision: 0.892,
          recall: 0.883,
          gt_voxels: 9100,
          pred_voxels: 9008,
          tp_voxels: 8035,
          fp_voxels: 973,
          fn_voxels: 1065,
          gt_volume_ml: 9.1,
          pred_volume_ml: 9.008,
          volume_diff_ml: -0.092,
          both_empty: false,
        },
      },
      crop_capture: {
        gt_wt_voxels: 42000,
        inside_crop_voxels: 41890,
        outside_crop_voxels: 110,
        capture_recall: 0.9974,
      },
    },
    coverage: null,
    has_pred_mask: true,
    created_by_username: 'adminops',
  },
];

export function getFixtureAdminBenchmarks(
  params: AdminBenchmarksListParams,
): PaginatedResponse<AdminBenchmarkSummaryDto> {
  const q = (params.q ?? '').trim().toLowerCase();
  const filtered = FIXTURE_BENCHMARKS.filter((item) => {
    if (params.state && params.state !== 'all' && item.state !== params.state) {
      return false;
    }
    if (params.workerId && item.target_worker_id !== params.workerId) {
      return false;
    }
    if (q) {
      return (
        item.title.toLowerCase().includes(q) ||
        item.target_worker_id.toLowerCase().includes(q) ||
        item.id.toLowerCase().includes(q)
      );
    }
    return true;
  });
  const start = (params.page - 1) * params.pageSize;
  return {
    items: filtered.slice(start, start + params.pageSize),
    total: filtered.length,
    page: params.page,
    page_size: params.pageSize,
  };
}

export function getFixtureAdminBenchmarkDetail(
  benchmarkId: string,
): AdminBenchmarkDetailDto {
  const found = FIXTURE_BENCHMARKS.find((item) => item.id === benchmarkId);
  if (!found) {
    throw new ApiClientError({
      status: 404,
      code: 'benchmark_not_found',
      requestId: 'req-fixture-bench-404',
    });
  }
  return { ...found };
}

export function createFixtureAdminBenchmark(payload: {
  title: string;
  targetWorkerId: string;
  notes?: string;
}): AdminBenchmarkDetailDto {
  const id = nextFixtureUuid('90000000');
  const created: AdminBenchmarkDetailDto = {
    id,
    title: payload.title.trim(),
    notes: payload.notes?.trim() ? payload.notes.trim() : null,
    target_worker_id: payload.targetWorkerId,
    executed_worker_id: null,
    worker_device_type: null,
    model_version_id: null,
    state: 'queued',
    stage: 'queued',
    completed_slices: null,
    total_slices: null,
    error_code: null,
    mean_dice_brats: null,
    wt_dice: null,
    tc_dice: null,
    et_dice: null,
    inference_duration_ms: null,
    created_at: new Date().toISOString(),
    started_at: null,
    finished_at: null,
    shape: [240, 240, 155],
    spacing_mm: [1, 1, 1],
    affine: [
      [1, 0, 0, -120],
      [0, 1, 0, -120],
      [0, 0, 1, -78],
      [0, 0, 0, 1],
    ],
    metrics: null,
    coverage: null,
    has_pred_mask: false,
    created_by_username: 'adminops',
  };
  FIXTURE_BENCHMARKS.unshift(created);
  return created;
}

export function deleteFixtureAdminBenchmark(
  benchmarkId: string,
): BenchmarkDeletionDto {
  const idx = FIXTURE_BENCHMARKS.findIndex((item) => item.id === benchmarkId);
  if (idx === -1) {
    throw new ApiClientError({
      status: 404,
      code: 'benchmark_not_found',
      requestId: 'req-fixture-bench-404',
    });
  }
  if (FIXTURE_BENCHMARKS[idx]!.state === 'running') {
    throw new ApiClientError({
      status: 409,
      code: 'benchmark_running',
      requestId: 'req-fixture-bench-409',
    });
  }
  FIXTURE_BENCHMARKS.splice(idx, 1);
  return {
    resource_type: 'admin_benchmark',
    resource_id: benchmarkId,
    status: 'deleted',
    files_cleaned: 5,
    message: 'Đã xóa lượt kiểm định và dọn các tệp lưu trữ liên quan.',
  };
}

export function getFixtureAdminBenchmarkArtifactBuffer(
  _benchmarkId: string,
  _artifact: BenchmarkArtifactKind,
): ArrayBuffer {
  return new ArrayBuffer(0);
}
