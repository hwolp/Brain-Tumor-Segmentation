import type { components } from './schema';

export type ErrorResponse = components['schemas']['ErrorResponse'];
export type ErrorEnvelope = ErrorResponse;
export type ErrorBody = components['schemas']['ErrorBody'];
export type ErrorDetailItem = components['schemas']['ErrorDetailItem'];
export type LivenessResponse = components['schemas']['LivenessResponse'];
export type ReadinessChecks = components['schemas']['ReadinessChecks'];
export type ReadinessResponse = components['schemas']['ReadinessResponse'];
export type HealthLiveResponse = LivenessResponse;
export type HealthReadyResponse = ReadinessResponse;

export type UserOut = components['schemas']['UserOut'];
export type UserDto = UserOut;
export type UserRole = UserOut['role'];

export type AuthTokenResponse = components['schemas']['AuthTokenResponse'];
export type AuthTokenResponseDto = AuthTokenResponse;
export type LoginRequest = components['schemas']['LoginRequest'];
export type LoginRequestDto = LoginRequest;
export type ChangePasswordRequest = components['schemas']['ChangePasswordRequest'];
export type ChangePasswordRequestDto = ChangePasswordRequest;
export type JwkItem = components['schemas']['JwkItem'];
export type JwksResponse = components['schemas']['JwksResponse'];

export type AdminDoctorUserOut = components['schemas']['AdminDoctorUserOut'];
export type AdminDoctorUserDto = AdminDoctorUserOut;
export type AdminCreateDoctorRequest = components['schemas']['AdminCreateDoctorRequest'];
export type AdminCreateDoctorRequestDto = AdminCreateDoctorRequest;
export type AdminUpdateDoctorRequest = components['schemas']['AdminUpdateDoctorRequest'];
export type AdminUpdateDoctorRequestDto = AdminUpdateDoctorRequest;
export type TemporaryPasswordResponse = components['schemas']['TemporaryPasswordResponse'];
export type AdminResetPasswordResponseDto = TemporaryPasswordResponse;
export type PaginatedResponse_AdminDoctorUserOut_ =
  components['schemas']['PaginatedResponse_AdminDoctorUserOut_'];

export type PatientOut = components['schemas']['PatientOut'];
export type PatientCreateRequest = components['schemas']['PatientCreateRequest'];
export type PatientUpdateRequest = components['schemas']['PatientUpdateRequest'];
export type DeletionStatusOut = components['schemas']['DeletionStatusOut'];
export type CaseOut = components['schemas']['CaseOut'];
export type CaseCreateRequest = components['schemas']['CaseCreateRequest'];
export type CaseUpdateRequest = components['schemas']['CaseUpdateRequest'];
export type VolumeOut = components['schemas']['VolumeOut'];

export type PatientSex = PatientOut['sex'];
export type CaseReadiness = CaseOut['readiness'];
export type VolumeModality = VolumeOut['modality'];
export type VolumeValidationStatus = VolumeOut['validation_status'];

export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type JobStage =
  | 'queued'
  | 'loading'
  | 'preprocessing'
  | 'inference'
  | 'reconstructing'
  | 'saving'
  | 'done';

export type MaskSource = 'ai' | 'manual';

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export type PatientDto = Omit<PatientOut, 'case_count'> & {
  case_count?: number;
};

export type CaseDto = Omit<
  CaseOut,
  | 'owner_id'
  | 'patient_code'
  | 'input_revision'
  | 'inputs_locked_at'
  | 'is_inputs_locked'
  | 'can_run_inference'
  | 'blocking_reasons'
> & {
  owner_id?: string;
  patient_code?: string | null;
  input_revision?: number;
  inputs_locked_at?: string | null;
  is_inputs_locked?: boolean;
  can_run_inference?: boolean;
  blocking_reasons?: string[];
  latest_job_state?: JobState | null;
};

export type VolumeDto = Omit<
  VolumeOut,
  | 'shape'
  | 'spacing_mm'
  | 'affine'
  | 'datatype'
  | 'sha256'
  | 'validation_errors'
  | 'model_profile_compatible'
  | 'model_profile_warnings'
  | 'created_at'
> & {
  filename?: string | null;
  validation_errors?: string[] | null;
  validation_error?: string | null;
  shape: [number, number, number] | null;
  spacing_mm: [number, number, number] | null;
  affine: number[][] | null;
  orientation: string | null;
  datatype?: string | null;
  sha256: string | null;
  model_profile_compatible?: boolean;
  model_profile_warnings?: string[];
  created_at?: string;
};

export type SystemAvailabilityOut =
  components['schemas']['SystemAvailabilityOut'];
export type SystemAvailabilityDto = SystemAvailabilityOut;

export interface InferenceJobDto {
  id: string;
  case_id: string;
  model_version_id: string;
  state: JobState;
  stage: JobStage;
  completed_slices: number | null;
  total_slices: number | null;
  attempt_count: number;
  max_auto_retries: number;
  error_code: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  result_mask_version_id: string | null;
}

export type MaskVersionOut = components['schemas']['MaskVersionOut'];
export type MaskMetadataExportOut = components['schemas']['MaskMetadataExportOut'];
export type MaskCoverageOut = components['schemas']['MaskCoverageOut'];
export type MaskGeometryOut = components['schemas']['MaskGeometryOut'];
export type MaskStatisticsOut = components['schemas']['MaskStatisticsOut'];

export type MaskVersionDto = Omit<
  MaskVersionOut,
  'created_by' | 'coverage_file_id' | 'composite_volumes_mm3'
> & {
  created_by: string | null;
  coverage_file_id?: string | null;
  composite_volumes_mm3?: Record<string, number> | null;
};

export interface AdminOverviewDto {
  active_doctors: number;
  locked_doctors: number;
  queued_jobs: number;
  running_jobs: number;
  failed_jobs: number;
  storage_used_bytes: number;
  storage_quota_bytes: number;
  worker_online: boolean;
  updated_at: string;
}

export interface AdminJobDto {
  id: string;
  case_id: string;
  doctor_username: string;
  model_version: string;
  state: JobState;
  stage: JobStage;
  attempt_count: number;
  error_code: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface AdminJobAttemptDto {
  id: string;
  attempt_number: number;
  worker_id: string;
  state: 'running' | 'succeeded' | 'failed' | 'expired';
  stage: JobStage;
  error_code: string | null;
  started_at: string;
  finished_at: string | null;
}

export interface AdminJobDetailDto extends AdminJobDto {
  attempts: AdminJobAttemptDto[];
}

export interface AdminWorkerDto {
  worker_id: string;
  online: boolean;
  device_type: 'GPU' | 'CPU';
  active_jobs: number;
  last_heartbeat_at: string;
  model_version: string;
}

export interface AdminModelDto {
  id: string;
  name: string;
  version: string;
  checkpoint_sha256: string;
  expected_shape: [number, number, number];
  expected_spacing_mm: [number, number, number];
  is_active: boolean;
  verified: boolean;
}

export interface AdminSettingsDto {
  version: number;
  accepting_jobs: boolean;
  max_upload_mib: number;
  max_decompressed_mib: number;
  default_doctor_quota_gib: number;
  system_quota_gib: number;
  updated_at: string;
}

export interface AuditEventDto {
  id: string;
  created_at: string;
  actor_username: string;
  action: string;
  target_id: string;
  outcome: 'success' | 'failure';
  request_id: string;
}

export type BenchmarkArtifactKind = 'flair' | 't1ce' | 'gt_mask' | 'pred_mask';

export interface BenchmarkRegionMetricsDto {
  dice: number;
  iou: number;
  precision: number;
  recall: number;
  gt_voxels: number;
  pred_voxels: number;
  tp_voxels: number;
  fp_voxels: number;
  fn_voxels: number;
  gt_volume_ml: number;
  pred_volume_ml: number;
  volume_diff_ml: number;
  both_empty: boolean;
}

export interface BenchmarkCropCaptureDto {
  gt_wt_voxels: number;
  inside_crop_voxels: number;
  outside_crop_voxels: number;
  capture_recall: number;
}

export interface BenchmarkMetricsDto {
  voxel_volume_mm3: number;
  mean_dice_brats: number;
  best_slice_z: number;
  regions: {
    WT: BenchmarkRegionMetricsDto;
    TC: BenchmarkRegionMetricsDto;
    ET: BenchmarkRegionMetricsDto;
  };
  labels: {
    '1': BenchmarkRegionMetricsDto;
    '2': BenchmarkRegionMetricsDto;
    '4': BenchmarkRegionMetricsDto;
  };
  crop_capture: BenchmarkCropCaptureDto | null;
}

export interface AdminBenchmarkSummaryDto {
  id: string;
  title: string;
  notes: string | null;
  target_worker_id: string;
  executed_worker_id: string | null;
  worker_device_type: string | null;
  model_version_id: string | null;
  state: JobState;
  stage: JobStage;
  completed_slices: number | null;
  total_slices: number | null;
  error_code: string | null;
  mean_dice_brats: number | null;
  wt_dice: number | null;
  tc_dice: number | null;
  et_dice: number | null;
  inference_duration_ms: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface AdminBenchmarkDetailDto extends AdminBenchmarkSummaryDto {
  shape: [number, number, number];
  spacing_mm: [number, number, number];
  affine: number[][];
  metrics: BenchmarkMetricsDto | null;
  coverage: Record<string, unknown> | null;
  has_pred_mask: boolean;
  created_by_username: string;
}

export interface BenchmarkDeletionDto {
  resource_type: 'admin_benchmark';
  resource_id: string;
  status: 'deleted';
  files_cleaned: number;
  message: string;
}
