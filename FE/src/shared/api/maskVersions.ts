import {
  API_BASE_URL,
  apiRequest,
  ensureFreshAccessToken,
  getAccessToken,
  getSessionEpoch,
  isNonRefreshable401Code,
  notifyAuthFailureFromError,
} from './client';
import { ApiClientError, isAbortError, parseErrorEnvelope } from './errors';
import {
  deleteFixtureMaskVersion,
  getFixtureMaskFileBuffer,
  getFixtureMaskVersionMetadata,
  getFixtureMaskVersions,
  saveFixtureMaskVersion,
} from './fixtures';
import type {
  DeletionStatusOut,
  MaskMetadataExportOut,
  MaskVersionDto,
  PaginatedResponse,
} from './types';

export type MaskVersionMetadataDto = MaskMetadataExportOut;

export interface SaveManualMaskParams {
  maskBlob: Blob;
  referenceVolumeId: string;
  baseVersionId: string | null;
  note?: string;
  idempotencyKey: string;
  fixtureMaskBytes?: Uint8Array;
  fixtureCounts?: Record<string, number>;
  fixtureVolumesMm3?: Record<string, number>;
}

async function fetchProtectedBinary(
  path: string,
  options: { signal?: AbortSignal },
): Promise<{ response: Response; requestEpoch: number }> {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = normalizedPath.startsWith(API_BASE_URL)
    ? normalizedPath
    : `${API_BASE_URL}${normalizedPath}`;

  const attempt = async (
    retried: boolean,
    overrideToken?: string | null,
  ): Promise<{ response: Response; requestEpoch: number }> => {
    const requestEpoch = getSessionEpoch();
    const headers = new Headers();
    const token =
      overrideToken !== undefined ? overrideToken : getAccessToken();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers,
        signal: options.signal,
        credentials: 'include',
      });
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      throw new ApiClientError({
        status: 0,
        code: 'network_error',
        isNetworkError: true,
      });
    }

    if (requestEpoch !== getSessionEpoch()) {
      throw new DOMException(
        'Phiên làm việc đã thay đổi trong lúc tải tệp.',
        'AbortError',
      );
    }

    if (!response.ok) {
      let parsedBody: unknown = null;
      const contentType = response.headers.get('Content-Type') ?? '';
      if (contentType.includes('application/json')) {
        try {
          parsedBody = await response.json();
        } catch {
          parsedBody = null;
        }
      }
      if (requestEpoch !== getSessionEpoch()) {
        throw new DOMException(
          'Phiên làm việc đã thay đổi trong lúc tải tệp.',
          'AbortError',
        );
      }
      const apiError = parseErrorEnvelope(
        parsedBody,
        response.status,
        response.headers.get('X-Request-ID'),
        response.headers.get('Retry-After'),
      );

      const handledAuthFailure = await notifyAuthFailureFromError(apiError);
      if (handledAuthFailure) {
        throw apiError;
      }

      if (
        response.status === 401 &&
        !retried &&
        !isNonRefreshable401Code(apiError.code)
      ) {
        const nextToken = await ensureFreshAccessToken(token);
        if (requestEpoch !== getSessionEpoch()) {
          throw new DOMException(
            'Phiên làm việc đã thay đổi trong lúc làm mới xác thực.',
            'AbortError',
          );
        }
        if (nextToken) {
          return attempt(true, nextToken);
        }
      }

      throw apiError;
    }

    return { response, requestEpoch };
  };

  return attempt(false);
}

function assertBinaryRequestCurrent(
  requestEpoch: number,
  signal?: AbortSignal,
): void {
  if (requestEpoch !== getSessionEpoch() || signal?.aborted) {
    throw new DOMException(
      'Phiên làm việc đã thay đổi hoặc yêu cầu tải tệp đã bị hủy.',
      'AbortError',
    );
  }
}

export async function fetchMaskVersions(
  caseId: string,
  options: {
    page?: number;
    pageSize?: number;
    signal?: AbortSignal;
    fixtureMode?: boolean;
  } = {},
): Promise<PaginatedResponse<MaskVersionDto>> {
  const page = Math.max(1, Math.floor(options.page ?? 1));
  const pageSize = Math.max(1, Math.floor(options.pageSize ?? 50));
  if (options.fixtureMode) {
    const result = getFixtureMaskVersions(caseId);
    const start = (page - 1) * pageSize;
    return {
      ...result,
      items: result.items.slice(start, start + pageSize),
      page,
      page_size: pageSize,
    };
  }
  const encodedId = encodeURIComponent(caseId);
  return apiRequest<PaginatedResponse<MaskVersionDto>>(
    `/cases/${encodedId}/mask-versions?page=${page}&page_size=${pageSize}`,
    {
      method: 'GET',
      signal: options.signal,
    },
  );
}

export async function fetchAllMaskVersions(
  caseId: string,
  options: { signal?: AbortSignal; fixtureMode?: boolean } = {},
): Promise<PaginatedResponse<MaskVersionDto>> {
  const pageSize = 100;
  const items: MaskVersionDto[] = [];
  let total = Number.POSITIVE_INFINITY;
  let page = 1;

  while (items.length < total) {
    const result = await fetchMaskVersions(caseId, {
      ...options,
      page,
      pageSize,
    });
    items.push(...result.items);
    total = Math.max(0, result.total);
    if (result.items.length === 0 || items.length >= total) break;
    page += 1;
  }

  return {
    items: items.slice(0, total),
    total,
    page: 1,
    page_size: pageSize,
  };
}

export async function fetchMaskVersionMetadata(
  versionId: string,
  options: { signal?: AbortSignal; fixtureMode?: boolean } = {},
): Promise<MaskVersionMetadataDto | null> {
  if (options.fixtureMode) {
    return getFixtureMaskVersionMetadata(versionId);
  }
  const encodedId = encodeURIComponent(versionId);
  return apiRequest<MaskVersionMetadataDto>(
    `/mask-versions/${encodedId}/metadata`,
    {
      method: 'GET',
      signal: options.signal,
    },
  );
}

export async function downloadProtectedFileBuffer(
  fileId: string,
  options: { signal?: AbortSignal; fixtureMode?: boolean } = {},
): Promise<ArrayBuffer> {
  if (options.fixtureMode) {
    const fixtureBuf = getFixtureMaskFileBuffer(fileId);
    if (fixtureBuf) {
      const copy = new Uint8Array(fixtureBuf.byteLength);
      copy.set(fixtureBuf);
      return copy.buffer;
    }
    return new ArrayBuffer(0);
  }
  const { response, requestEpoch } = await fetchProtectedBinary(
    `/files/${encodeURIComponent(fileId)}/content`,
    { signal: options.signal },
  );
  const bytes = await response.arrayBuffer();
  assertBinaryRequestCurrent(requestEpoch, options.signal);
  return bytes;
}

export async function downloadMaskVersionExport(
  versionId: string,
  options: { signal?: AbortSignal; fixtureMode?: boolean } = {},
): Promise<Blob> {
  if (options.fixtureMode) {
    return new Blob([], { type: 'application/gzip' });
  }
  const { response, requestEpoch } = await fetchProtectedBinary(
    `/mask-versions/${encodeURIComponent(versionId)}/export`,
    { signal: options.signal },
  );
  const blob = await response.blob();
  assertBinaryRequestCurrent(requestEpoch, options.signal);
  return blob;
}

export async function saveManualMaskVersion(
  caseId: string,
  params: SaveManualMaskParams,
  options: { signal?: AbortSignal; fixtureMode?: boolean } = {},
): Promise<MaskVersionDto> {
  if (options.fixtureMode) {
    return saveFixtureMaskVersion(caseId, {
      baseVersionId: params.baseVersionId,
      referenceVolumeId: params.referenceVolumeId,
      note: params.note,
      idempotencyKey: params.idempotencyKey,
      maskBytes: params.fixtureMaskBytes,
      labelVoxelCounts: params.fixtureCounts,
      labelVolumesMm3: params.fixtureVolumesMm3,
    });
  }

  const formData = new FormData();
  formData.append('mask', params.maskBlob, 'mask.nii.gz');
  formData.append('reference_volume_id', params.referenceVolumeId);
  if (params.baseVersionId) {
    formData.append('base_version_id', params.baseVersionId);
  }
  if (params.note && params.note.trim()) {
    formData.append('note', params.note.trim());
  }

  return apiRequest<MaskVersionDto>(
    `/cases/${encodeURIComponent(caseId)}/mask-versions`,
    {
      method: 'POST',
      headers: {
        'Idempotency-Key': params.idempotencyKey,
      },
      body: formData,
      signal: options.signal,
    },
  );
}

export async function deleteMaskVersion(
  versionId: string,
  options: { fixtureMode?: boolean } = {},
): Promise<DeletionStatusOut> {
  if (options.fixtureMode) {
    return deleteFixtureMaskVersion(versionId);
  }
  return apiRequest<DeletionStatusOut>(
    `/mask-versions/${encodeURIComponent(versionId)}`,
    {
      method: 'DELETE',
    },
  );
}
