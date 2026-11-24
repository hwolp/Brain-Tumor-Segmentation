import type { ErrorDetailItem, ErrorResponse } from './types';

export type ApiErrorDetailItem = ErrorDetailItem;

const ERROR_CODE_MESSAGES: Readonly<Record<string, string>> = {
  unauthenticated:
    'Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.',
  unauthorized:
    'Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Vui lòng đăng nhập lại.',
  invalid_token: 'Phiên xác thực không hợp lệ. Vui lòng đăng nhập lại.',
  invalid_token_alg:
    'Token xác thực sử dụng thuật toán không hợp lệ. Vui lòng đăng nhập lại.',
  unknown_kid:
    'Không nhận diện được khóa ký xác thực (kid). Vui lòng đăng nhập lại.',
  invalid_issuer:
    'Nguồn phát hành phiên xác thực không hợp lệ. Vui lòng đăng nhập lại.',
  invalid_audience:
    'Phạm vi phiên xác thực không hợp lệ. Vui lòng đăng nhập lại.',
  invalid_signature:
    'Chữ ký phiên xác thực không hợp lệ. Vui lòng đăng nhập lại.',
  token_expired: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
  login_failed:
    'Tên đăng nhập hoặc mật khẩu không đúng, hoặc tài khoản đang bị khóa.',
  invalid_credentials: 'Tên đăng nhập hoặc mật khẩu không chính xác.',
  invalid_current_password: 'Mật khẩu hiện tại không chính xác.',
  invalid_password: 'Mật khẩu không đáp ứng yêu cầu bảo mật.',
  weak_password: 'Mật khẩu mới chưa đủ mạnh. Vui lòng dùng ít nhất 12 ký tự.',
  bad_request: 'Yêu cầu không hợp lệ. Vui lòng kiểm tra lại dữ liệu.',
  conflict: 'Dữ liệu bị xung đột với trạng thái hiện tại.',
  refresh_reused:
    'Phiên đăng nhập đã bị thu hồi do phát hiện dùng lại khóa làm mới. Vui lòng đăng nhập lại.',
  csrf_origin_denied:
    'Yêu cầu xác thực bị từ chối do nguồn gốc truy cập (Origin) không hợp lệ.',
  account_locked: 'Tài khoản đã bị khóa. Vui lòng liên hệ quản trị viên.',
  account_disabled:
    'Tài khoản của bạn đã bị khóa hoặc vô hiệu hóa. Vui lòng liên hệ quản trị viên.',
  password_change_required:
    'Bạn cần đổi mật khẩu tạm trước khi sử dụng chức năng của hệ thống.',
  forbidden: 'Bạn không có quyền truy cập hoặc thực hiện thao tác này.',
  insufficient_role:
    'Vai trò hiện tại không được phép thực hiện thao tác này.',
  not_found: 'Không tìm thấy dữ liệu hoặc bạn không có quyền truy cập.',
  username_conflict:
    'Tên đăng nhập đã tồn tại trong hệ thống. Vui lòng chọn tên đăng nhập khác.',
  cannot_modify_admin:
    'Không được phép chỉnh sửa, khóa hoặc đặt lại mật khẩu tài khoản quản trị viên tại đây.',
  patient_code_conflict: 'Mã bệnh nhân đã tồn tại trong danh sách của bạn.',
  patient_code_exists: 'Mã bệnh nhân đã tồn tại trong danh sách của bạn.',
  patient_not_found:
    'Không tìm thấy hồ sơ bệnh nhân hoặc bạn không có quyền truy cập.',
  case_not_found: 'Không tìm thấy ca chụp hoặc bạn không có quyền truy cập.',
  volume_not_found: 'Không tìm thấy khối ảnh MRI trong ca chụp.',
  file_not_found: 'Không tìm thấy tệp dữ liệu hoặc ảnh NIfTI trên hệ thống lưu trữ.',
  idempotency_conflict:
    'Yêu cầu bị xung đột khóa thao tác (Idempotency-Key). Vui lòng tải lại dữ liệu trước khi thử lại.',
  case_deleted: 'Ca chụp liên quan đã bị xóa trước đó.',
  retry_case_deleted: 'Không thể gửi lại job vì ca chụp liên quan đã bị xóa.',
  method_not_allowed: 'Phương thức HTTP không được hỗ trợ cho tài nguyên này.',
  mask_version_conflict:
    'Đã có phiên bản mask mới hơn trên máy chủ. Hãy giữ bản nháp cục bộ hoặc mở phiên bản mới.',
  mask_version_not_found:
    'Không tìm thấy phiên bản mask hoặc bạn không có quyền truy cập.',
  ai_mask_not_deletable:
    'Không thể xóa phiên bản mask do mô hình AI tạo ra. Chỉ được phép xóa các phiên bản chỉnh sửa thủ công.',
  invalid_mask_labels:
    'Tệp mask chứa nhãn không hợp lệ. Chỉ chấp nhận các nhãn BraTS {0, 1, 2, 4}.',
  reference_volume_mismatch:
    'Khối ảnh tham chiếu của mask không khớp với khối ảnh tham chiếu hiện tại của ca chụp.',
  invalid_reference_volume:
    'Khối ảnh tham chiếu không hợp lệ hoặc chưa hoàn tất kiểm tra.',
  active_job_exists: 'Ca chụp đang có tác vụ AI chờ xử lý hoặc đang chạy.',
  active_job_conflict:
    'Không thể thực hiện thao tác vì đang có tác vụ AI chờ xử lý hoặc đang chạy. Vui lòng chờ hoàn tất hoặc hủy tác vụ đang chờ.',
  case_not_ready:
    'Ca chụp chưa có đủ xung MRI hợp lệ hoặc hình học chưa tương thích để chạy AI.',
  job_not_found: 'Không tìm thấy tác vụ AI hoặc bạn không có quyền xem tác vụ này.',
  job_not_cancellable: 'Chỉ có thể hủy job đang chờ worker nhận xử lý.',
  job_not_retryable: 'Chỉ có thể gửi lại job đã thất bại.',
  retry_owner_inactive:
    'Không thể gửi lại job vì tài khoản bác sĩ sở hữu ca chụp đang bị khóa hoặc vô hiệu hóa. Hãy kích hoạt lại tài khoản trước khi thử lại.',
  owner_disabled:
    'Không thể thực hiện thao tác vì tài khoản bác sĩ sở hữu đang bị khóa hoặc vô hiệu hóa.',
  no_active_model:
    'Chưa có mô hình AI hợp lệ được kích hoạt để chạy phân đoạn.',
  model_not_ready: 'Mô hình AI hiện chưa sẵn sàng nhận tác vụ.',
  model_unavailable:
    'Mô hình AI hiện không khả dụng. Vui lòng thử lại hoặc liên hệ quản trị viên.',
  intake_paused: 'Hệ thống hiện tạm ngừng nhận tác vụ phân đoạn mới.',
  stale_attempt: 'Phiên xử lý của worker đã hết hiệu lực.',
  settings_version_conflict:
    'Cấu hình đã được cập nhật ở một phiên khác. Hãy tải lại trước khi lưu.',
  modality_exists:
    'Xung MRI này đã tồn tại trong ca chụp. Hãy xóa xung cũ trước khi tải lên lại.',
  inputs_locked:
    'Không thể thay đổi hoặc xóa xung MRI vì ca chụp đã có tác vụ AI hoặc phiên bản mask.',
  invalid_file_extension:
    'Định dạng tệp không hợp lệ. Chỉ chấp nhận tệp NIfTI (.nii hoặc .nii.gz).',
  invalid_nifti: 'Tệp MRI không phải định dạng NIfTI (.nii / .nii.gz) hợp lệ.',
  non_finite_intensity:
    'Tệp NIfTI chứa giá trị cường độ không hữu hạn (NaN hoặc Infinity).',
  unsupported_geometry:
    'Hình học khối ảnh không đáp ứng yêu cầu v1 của hệ thống.',
  geometry_mismatch:
    'Hai xung FLAIR và T1ce không khớp kích thước, spacing hoặc hệ tọa độ affine.',
  storage_quota_exceeded:
    'Dung lượng lưu trữ đã vượt quá hạn mức cho phép.',
  payload_too_large: 'Dung lượng tệp vượt quá giới hạn cho phép (tối đa 100 MiB).',
  validation_error:
    'Dữ liệu đầu vào chưa hợp lệ. Vui lòng kiểm tra lại các trường đánh dấu.',
  rate_limited: 'Bạn thao tác quá nhanh. Vui lòng đợi một lát rồi thử lại.',
  rate_limit_exceeded:
    'Bạn đã thử đăng nhập hoặc thao tác quá số lần cho phép. Vui lòng đợi một lát rồi thử lại.',
  service_unavailable: 'Hệ thống tạm thời gián đoạn hoặc đang bảo trì.',
  not_accepting_jobs: 'Hệ thống hiện tạm ngừng nhận tác vụ phân đoạn mới.',
  network_error:
    'Không thể kết nối tới máy chủ API. Vui lòng kiểm tra kết nối mạng hoặc dịch vụ cục bộ.',
  internal_error: 'Máy chủ gặp sự cố xử lý nội bộ. Vui lòng thử lại sau.',
};

function fallbackMessageByStatus(status: number): string {
  if (status === 400) return 'Yêu cầu không hợp lệ.';
  if (status === 401)
    return ERROR_CODE_MESSAGES.unauthenticated ?? 'Chưa xác thực.';
  if (status === 403)
    return ERROR_CODE_MESSAGES.forbidden ?? 'Không có quyền.';
  if (status === 404)
    return ERROR_CODE_MESSAGES.not_found ?? 'Không tìm thấy dữ liệu.';
  if (status === 405)
    return ERROR_CODE_MESSAGES.method_not_allowed ?? 'Phương thức không được phép.';
  if (status === 409) return 'Dữ liệu đang bị xung đột phiên bản hoặc trạng thái.';
  if (status === 413)
    return ERROR_CODE_MESSAGES.payload_too_large ?? 'Tệp quá lớn.';
  if (status === 422)
    return ERROR_CODE_MESSAGES.validation_error ?? 'Dữ liệu không hợp lệ.';
  if (status === 429)
    return ERROR_CODE_MESSAGES.rate_limit_exceeded ?? 'Quá nhiều yêu cầu.';
  if (status === 502 || status === 504)
    return 'Máy chủ cổng kết nối phản hồi chậm hoặc tạm gián đoạn. Vui lòng thử lại sau.';
  if (status === 503)
    return (
      ERROR_CODE_MESSAGES.service_unavailable ??
      'Hệ thống tạm thời gián đoạn hoặc đang bảo trì.'
    );
  if (status >= 500)
    return ERROR_CODE_MESSAGES.internal_error ?? 'Lỗi máy chủ.';
  return 'Đã xảy ra lỗi khi liên lạc với máy chủ.';
}

export function normalizeErrorCode(code: string): string {
  return code.trim().toLowerCase();
}

export function parseRetryAfterSeconds(
  retryAfterHeader: string | null | undefined,
): number | null {
  if (!retryAfterHeader) return null;
  const trimmed = retryAfterHeader.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  }
  const timestampMs = Date.parse(trimmed);
  if (Number.isFinite(timestampMs)) {
    const diffSeconds = Math.ceil((timestampMs - Date.now()) / 1000);
    return diffSeconds > 0 ? diffSeconds : null;
  }
  return null;
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly serverMessage: string;
  readonly userMessage: string;
  readonly details: ApiErrorDetailItem[] | Record<string, unknown> | null;
  readonly requestId: string | null;
  readonly isNetworkError: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(params: {
    status: number;
    code: string;
    serverMessage?: string;
    userMessage?: string;
    details?: ApiErrorDetailItem[] | Record<string, unknown> | null;
    requestId?: string | null;
    isNetworkError?: boolean;
    retryAfterSeconds?: number | null;
  }) {
    const mappedMessage =
      params.userMessage ??
      mapErrorCodeToVietnamese(params.code, params.status, params.serverMessage);

    super(mappedMessage);
    this.name = 'ApiClientError';
    this.status = params.status;
    this.code = params.code;
    this.serverMessage = params.serverMessage ?? mappedMessage;
    this.userMessage = mappedMessage;
    this.details = params.details ?? null;
    this.requestId = params.requestId ?? null;
    this.isNetworkError = params.isNetworkError ?? false;
    this.retryAfterSeconds = params.retryAfterSeconds ?? null;
  }
}

export function isAbortError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }
  return (
    typeof error === 'object' &&
    'name' in error &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * Yêu cầu bị hủy chủ động khi người dùng chuyển trang không được hiện toast lỗi giả.
 */
export function shouldSuppressErrorToast(error: unknown): boolean {
  return isAbortError(error);
}

const PREFER_SERVER_MESSAGE_CODES = new Set([
  'invalid_credentials',
  'validation_error',
  'invalid_nifti',
  'geometry_mismatch',
  'unsupported_geometry',
  'storage_quota_exceeded',
]);

function hasVietnameseDiacritics(msg: string): boolean {
  return /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ]/.test(
    msg,
  );
}

export function mapErrorCodeToVietnamese(
  code: string,
  status = 500,
  fallbackMessage?: string,
): string {
  const normalizedCode = normalizeErrorCode(code);
  const cleanedServer =
    fallbackMessage && !looksUnsafeInternalMessage(fallbackMessage)
      ? fallbackMessage.replace(/^\[[A-Z0-9_]+\]\s*/i, '').trim()
      : '';

  if (
    PREFER_SERVER_MESSAGE_CODES.has(normalizedCode) &&
    cleanedServer &&
    hasVietnameseDiacritics(cleanedServer)
  ) {
    return cleanedServer;
  }

  const mapped = ERROR_CODE_MESSAGES[normalizedCode];
  if (mapped) {
    return mapped;
  }
  if (cleanedServer) {
    return cleanedServer;
  }
  return fallbackMessageByStatus(status);
}

function looksUnsafeInternalMessage(msg: string): boolean {
  const lower = msg.toLowerCase();
  return (
    lower.includes('traceback') ||
    lower.includes('sql') ||
    lower.includes('/app/') ||
    lower.includes('c:\\') ||
    lower.includes('d:\\')
  );
}

export function parseErrorEnvelope(
  payload: unknown,
  status: number,
  headerRequestId?: string | null,
  retryAfterHeader?: string | null,
): ApiClientError {
  const retryAfterSeconds = parseRetryAfterSeconds(retryAfterHeader);

  if (
    payload &&
    typeof payload === 'object' &&
    'error' in payload &&
    payload.error &&
    typeof payload.error === 'object'
  ) {
    const envelope = payload as ErrorResponse;
    const err = envelope.error;
    const code =
      typeof err.code === 'string' && err.code ? err.code : 'unknown_error';
    const rawMsg = typeof err.message === 'string' ? err.message : '';
    const requestId =
      typeof err.request_id === 'string' && err.request_id.trim()
        ? err.request_id.trim()
        : (headerRequestId ?? null);

    return new ApiClientError({
      status,
      code,
      serverMessage: rawMsg,
      userMessage: mapErrorCodeToVietnamese(code, status, rawMsg),
      details: err.details ?? null,
      requestId,
      isNetworkError: false,
      retryAfterSeconds,
    });
  }

  const rawDetail =
    payload &&
    typeof payload === 'object' &&
    'detail' in payload &&
    typeof (payload as { detail?: unknown }).detail === 'string'
      ? (payload as { detail: string }).detail.trim()
      : '';

  const fallbackCode =
    status === 429
      ? 'rate_limit_exceeded'
      : status >= 500
        ? 'internal_error'
        : 'http_error';

  const safeDetail =
    rawDetail && !looksUnsafeInternalMessage(rawDetail) && hasVietnameseDiacritics(rawDetail)
      ? rawDetail
      : undefined;

  return new ApiClientError({
    status,
    code: fallbackCode,
    serverMessage: rawDetail || undefined,
    userMessage: safeDetail ?? fallbackMessageByStatus(status),
    requestId: headerRequestId ?? null,
    isNetworkError: false,
    retryAfterSeconds,
  });
}

export function normalizeApiError(error: unknown): {
  message: string;
  requestId: string | null;
  code: string;
  status: number;
  retryAfterSeconds: number | null;
} {
  if (error instanceof ApiClientError) {
    return {
      message: error.userMessage,
      requestId: error.requestId,
      code: error.code,
      status: error.status,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  }
  if (isAbortError(error)) {
    return {
      message: 'Yêu cầu đã được hủy.',
      requestId: null,
      code: 'ABORTED',
      status: 0,
      retryAfterSeconds: null,
    };
  }
  return {
    message: ERROR_CODE_MESSAGES.network_error ?? 'Lỗi kết nối máy chủ.',
    requestId: null,
    code: 'network_error',
    status: 0,
    retryAfterSeconds: null,
  };
}

export function extractFieldErrors(error: unknown): Record<string, string> {
  if (!(error instanceof ApiClientError) || !Array.isArray(error.details)) {
    return {};
  }
  const map: Record<string, string> = {};
  for (const item of error.details) {
    if (!item || typeof item !== 'object') continue;
    const rawField = typeof item.field === 'string' ? item.field : '';
    const fieldName = rawField.split('.').pop() ?? rawField;
    if (fieldName && typeof item.reason === 'string' && item.reason && !map[fieldName]) {
      map[fieldName] = item.reason;
    }
  }
  return map;
}
