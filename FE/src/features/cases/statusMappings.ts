import type {
  CaseReadiness,
  JobStage,
  JobState,
  PatientSex,
  VolumeValidationStatus,
} from '@/shared/api/types';
import type { StatusTone } from '@/shared/ui';

export function formatPatientSex(sex: PatientSex): string {
  switch (sex) {
    case 'male':
      return 'Nam';
    case 'female':
      return 'Nữ';
    case 'other':
      return 'Khác';
    case 'unknown':
    default:
      return 'Chưa rõ';
  }
}

export function getCaseReadinessMeta(readiness: CaseReadiness): {
  label: string;
  tone: StatusTone;
} {
  switch (readiness) {
    case 'ready':
      return { label: 'Sẵn sàng chạy AI', tone: 'success' };
    case 'validating':
      return { label: 'Đang kiểm tra ảnh', tone: 'info' };
    case 'invalid':
      return { label: 'Không hợp lệ', tone: 'error' };
    case 'missing_inputs':
    default:
      return { label: 'Thiếu dữ liệu xung', tone: 'warning' };
  }
}

export function getVolumeValidationMeta(status: VolumeValidationStatus): {
  label: string;
  tone: StatusTone;
} {
  switch (status) {
    case 'valid':
      return { label: 'Hợp lệ', tone: 'success' };
    case 'validating':
      return { label: 'Đang kiểm tra', tone: 'info' };
    case 'invalid':
    default:
      return { label: 'Không hợp lệ', tone: 'error' };
  }
}

export function getJobStateMeta(state: JobState): {
  label: string;
  tone: StatusTone;
} {
  switch (state) {
    case 'queued':
      return { label: 'Đang chờ', tone: 'neutral' };
    case 'running':
      return { label: 'Đang xử lý', tone: 'info' };
    case 'succeeded':
      return { label: 'Hoàn tất', tone: 'success' };
    case 'failed':
      return { label: 'Thất bại', tone: 'error' };
    case 'cancelled':
      return { label: 'Đã hủy', tone: 'warning' };
  }
}

export function formatJobStage(stage: JobStage): string {
  switch (stage) {
    case 'queued':
      return 'Trong hàng đợi';
    case 'loading':
      return 'Đọc và kiểm tra ảnh';
    case 'preprocessing':
      return 'Tiền xử lý / TDA';
    case 'inference':
      return 'Chạy mô hình theo lát';
    case 'reconstructing':
      return 'Dựng lại lưới gốc';
    case 'saving':
      return 'Lưu phiên bản kết quả';
    case 'done':
      return 'Hoàn thành';
  }
}

export function formatJobErrorReason(
  errorCode: string | null | undefined,
): string {
  if (!errorCode) {
    return 'Tác vụ không hoàn tất. Vui lòng thử gửi lại khi hệ thống sẵn sàng.';
  }
  switch (errorCode.trim().toLowerCase()) {
    case 'worker_lost':
    case 'worker_lease_expired':
    case 'worker_disconnected':
      return 'Worker mất kết nối quá thời hạn trong lúc xử lý (đã hết lượt tự động thử lại).';
    case 'missing_inputs':
    case 'case_not_ready':
      return 'Ca chụp thiếu xung MRI hợp lệ (FLAIR hoặc T1ce) khi bắt đầu xử lý.';
    case 'unsupported_geometry':
    case 'geometry_mismatch':
      return 'Hình học khối ảnh không tương thích với cấu hình mô hình AI.';
    case 'out_of_memory':
    case 'insufficient_resources':
    case 'storage_quota_exceeded':
      return 'Tài nguyên tính toán hoặc hạn mức lưu trữ không đủ để hoàn tất phân đoạn.';
    case 'model_error':
    case 'inference_failed':
    case 'invalid_mask_output':
      return 'Mô hình AI gặp lỗi khi suy luận hoặc dựng lại kết quả mask.';
    case 'invalid_nifti':
    case 'non_finite_intensity':
      return 'Dữ liệu khối ảnh NIfTI không hợp lệ hoặc chứa giá trị không hữu hạn.';
    default:
      return 'Tác vụ phân đoạn gặp sự cố kỹ thuật khi xử lý trên worker.';
  }
}
