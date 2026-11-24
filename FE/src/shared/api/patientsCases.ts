import {
  API_BASE_URL,
  apiRequest,
  ensureFreshAccessToken,
  getAccessToken,
  getSessionEpoch,
  isNonRefreshable401Code,
  notifyAuthFailureFromError,
} from './client';
import { ApiClientError, parseErrorEnvelope } from './errors';
import {
  fixtureCreateCase,
  fixtureCreatePatient,
  fixtureDeleteCase,
  fixtureDeleteCaseVolume,
  fixtureDeletePatient,
  fixtureUpdateCase,
  fixtureUpdatePatient,
  fixtureUploadCaseVolume,
} from './fixtures';
import type {
  CaseCreateRequest,
  CaseDto,
  CaseUpdateRequest,
  DeletionStatusOut,
  PatientCreateRequest,
  PatientDto,
  PatientUpdateRequest,
  VolumeDto,
  VolumeModality,
} from './types';

export const PATIENT_CODE_MAX_LENGTH = 50;
export const PATIENT_NAME_MAX_LENGTH = 150;
export const PATIENT_MIN_BIRTH_YEAR = 1900;
export const CASE_NOTES_MAX_LENGTH = 5000;
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MiB

export function generateIdempotencyKey(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.getRandomValues === 'function'
  ) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(
    '',
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function createPatient(
  payload: PatientCreateRequest,
  options: { fixtureMode?: boolean } = {},
): Promise<PatientDto> {
  if (options.fixtureMode) {
    return fixtureCreatePatient(payload);
  }
  return apiRequest<PatientDto>('/patients', {
    method: 'POST',
    body: {
      patient_code: payload.patient_code,
      full_name: payload.full_name,
      birth_year: payload.birth_year,
      sex: payload.sex,
    },
  });
}

export async function updatePatient(
  patientId: string,
  payload: PatientUpdateRequest,
  options: { fixtureMode?: boolean } = {},
): Promise<PatientDto> {
  if (options.fixtureMode) {
    return fixtureUpdatePatient(patientId, payload);
  }
  return apiRequest<PatientDto>(`/patients/${encodeURIComponent(patientId)}`, {
    method: 'PATCH',
    body: { ...payload },
  });
}

export async function deletePatient(
  patientId: string,
  options: { fixtureMode?: boolean } = {},
): Promise<DeletionStatusOut> {
  if (options.fixtureMode) {
    return fixtureDeletePatient(patientId);
  }
  const result = await apiRequest<DeletionStatusOut | undefined>(
    `/patients/${encodeURIComponent(patientId)}`,
    {
      method: 'DELETE',
    },
  );
  return (
    result ?? {
      resource_type: 'patient',
      resource_id: patientId,
      status: 'deleted',
      files_cleaned: 0,
      message: 'Đã xóa hồ sơ bệnh nhân.',
    }
  );
}

export async function createCase(
  patientId: string,
  payload: CaseCreateRequest,
  idempotencyKey: string,
  options: { fixtureMode?: boolean } = {},
): Promise<CaseDto> {
  if (options.fixtureMode) {
    return fixtureCreateCase(patientId, payload, idempotencyKey);
  }
  return apiRequest<CaseDto>(
    `/patients/${encodeURIComponent(patientId)}/cases`,
    {
      method: 'POST',
      headers: {
        'Idempotency-Key': idempotencyKey,
      },
      body: {
        study_date: payload.study_date,
        notes: payload.notes ?? null,
      },
    },
  );
}

export async function updateCase(
  caseId: string,
  payload: CaseUpdateRequest,
  options: { fixtureMode?: boolean } = {},
): Promise<CaseDto> {
  if (options.fixtureMode) {
    return fixtureUpdateCase(caseId, payload);
  }
  return apiRequest<CaseDto>(`/cases/${encodeURIComponent(caseId)}`, {
    method: 'PATCH',
    body: { ...payload },
  });
}

export async function deleteCase(
  caseId: string,
  options: { fixtureMode?: boolean } = {},
): Promise<DeletionStatusOut> {
  if (options.fixtureMode) {
    return fixtureDeleteCase(caseId);
  }
  const result = await apiRequest<DeletionStatusOut | undefined>(
    `/cases/${encodeURIComponent(caseId)}`,
    {
      method: 'DELETE',
    },
  );
  return (
    result ?? {
      resource_type: 'case',
      resource_id: caseId,
      status: 'deleted',
      files_cleaned: 0,
      message: 'Đã xóa ca chụp.',
    }
  );
}

export interface UploadCaseVolumeOptions {
  onProgress?: (loaded: number, total: number) => void;
  onValidatingPhase?: () => void;
  signal?: AbortSignal;
  fixtureMode?: boolean;
}

export async function uploadCaseVolume(
  caseId: string,
  modality: VolumeModality,
  file: File,
  options: UploadCaseVolumeOptions = {},
): Promise<VolumeDto> {
  if (options.signal?.aborted) {
    throw new DOMException('Đã hủy tải lên.', 'AbortError');
  }

  const requestEpoch = getSessionEpoch();
  const createSessionChangedAbortError = () =>
    new DOMException(
      'Phiên làm việc đã thay đổi trong lúc tải tệp lên.',
      'AbortError',
    );

  if (options.fixtureMode) {
    options.onProgress?.(file.size, file.size);
    options.onValidatingPhase?.();
    const res = await fixtureUploadCaseVolume(caseId, modality, file);
    if (requestEpoch !== getSessionEpoch()) {
      throw createSessionChangedAbortError();
    }
    return res;
  }

  let token = getAccessToken();
  if (!token) {
    token = await ensureFreshAccessToken(null);
    if (requestEpoch !== getSessionEpoch()) {
      throw createSessionChangedAbortError();
    }
    if (options.signal?.aborted) {
      throw new DOMException('Đã hủy tải lên.', 'AbortError');
    }
  }

  const handleUploadAuthFailure = async (
    apiError: ApiClientError,
  ): Promise<void> => {
    if (apiError.status !== 401 && apiError.status !== 403) {
      return;
    }
    const handled = await notifyAuthFailureFromError(apiError);
    if (
      !handled &&
      apiError.status === 401 &&
      !isNonRefreshable401Code(apiError.code)
    ) {
      await ensureFreshAccessToken(token);
    }
  };

  const url = `${API_BASE_URL}/cases/${encodeURIComponent(caseId)}/volumes`;
  const formData = new FormData();
  formData.append('modality', modality);
  formData.append('file', file);

  if (typeof XMLHttpRequest === 'undefined') {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: formData,
      credentials: 'include',
      signal: options.signal,
    });
    if (requestEpoch !== getSessionEpoch()) {
      throw createSessionChangedAbortError();
    }
    options.onProgress?.(file.size, file.size);
    options.onValidatingPhase?.();
    const text = await response.text();
    if (requestEpoch !== getSessionEpoch()) {
      throw createSessionChangedAbortError();
    }
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }
    if (!response.ok) {
      const apiError = parseErrorEnvelope(
        parsed,
        response.status,
        response.headers.get('X-Request-ID'),
        response.headers.get('Retry-After'),
      );
      await handleUploadAuthFailure(apiError);
      if (requestEpoch !== getSessionEpoch() && getAccessToken() !== null) {
        throw createSessionChangedAbortError();
      }
      throw apiError;
    }
    return parsed as VolumeDto;
  }

  return new Promise<VolumeDto>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;

    const cleanupAbort = () => {
      if (options.signal) {
        options.signal.removeEventListener('abort', handleAbortSignal);
      }
    };

    const handleAbortSignal = () => {
      if (!settled) {
        xhr.abort();
      }
    };

    if (options.signal) {
      options.signal.addEventListener('abort', handleAbortSignal, {
        once: true,
      });
    }

    xhr.open('POST', url, true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    if (token) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    }

    if (xhr.upload) {
      xhr.upload.onprogress = (event: ProgressEvent) => {
        if (requestEpoch !== getSessionEpoch()) {
          return;
        }
        const total = event.lengthComputable && event.total > 0 ? event.total : file.size;
        const loaded = Math.min(event.loaded, total);
        options.onProgress?.(loaded, total);
        if (total > 0 && loaded >= total) {
          options.onValidatingPhase?.();
        }
      };
      xhr.upload.onload = () => {
        if (requestEpoch !== getSessionEpoch()) {
          return;
        }
        options.onProgress?.(file.size, file.size);
        options.onValidatingPhase?.();
      };
    }

    xhr.onabort = () => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      reject(new DOMException('Đã hủy tải lên.', 'AbortError'));
    };

    xhr.onerror = () => {
      if (settled) return;
      settled = true;
      cleanupAbort();
      if (requestEpoch !== getSessionEpoch()) {
        reject(createSessionChangedAbortError());
        return;
      }
      reject(
        new ApiClientError({
          status: 0,
          code: 'network_error',
          isNetworkError: true,
        }),
      );
    };

    xhr.onload = () => {
      if (settled) return;
      settled = true;
      cleanupAbort();

      if (requestEpoch !== getSessionEpoch()) {
        reject(createSessionChangedAbortError());
        return;
      }

      const headerRequestId = xhr.getResponseHeader('X-Request-ID');
      const retryAfterHeader = xhr.getResponseHeader('Retry-After');
      let parsedBody: unknown = null;
      if (xhr.responseText) {
        try {
          parsedBody = JSON.parse(xhr.responseText);
        } catch {
          parsedBody = null;
        }
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(parsedBody as VolumeDto);
        return;
      }

      const apiError = parseErrorEnvelope(
        parsedBody,
        xhr.status,
        headerRequestId,
        retryAfterHeader,
      );

      void (async () => {
        try {
          await handleUploadAuthFailure(apiError);
        } catch {
          // Bỏ qua lỗi phụ khi đồng bộ phiên để trả đúng lỗi gốc hoặc AbortError
        }
        if (requestEpoch !== getSessionEpoch() && getAccessToken() !== null) {
          reject(createSessionChangedAbortError());
          return;
        }
        reject(apiError);
      })();
    };

    xhr.send(formData);
  });
}

export async function deleteCaseVolume(
  caseId: string,
  volumeId: string,
  options: { fixtureMode?: boolean } = {},
): Promise<DeletionStatusOut> {
  if (options.fixtureMode) {
    return fixtureDeleteCaseVolume(caseId, volumeId);
  }
  const result = await apiRequest<DeletionStatusOut | undefined>(
    `/cases/${encodeURIComponent(caseId)}/volumes/${encodeURIComponent(volumeId)}`,
    {
      method: 'DELETE',
    },
  );
  return (
    result ?? {
      resource_type: 'volume',
      resource_id: volumeId,
      status: 'deleted',
      files_cleaned: 0,
      message: 'Đã xóa xung MRI.',
    }
  );
}
