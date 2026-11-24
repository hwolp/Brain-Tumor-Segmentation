import { describe, expect, it } from 'vitest';
import {
  ApiClientError,
  normalizeApiError,
  parseErrorEnvelope,
  shouldSuppressErrorToast,
} from '@/shared/api/errors';
import { shouldRetryQuery } from '@/shared/api/queryClient';
import {
  formatDateVN,
  formatDateTimeVN,
  formatStudyDate,
} from '@/shared/lib/datetime';
import {
  formatVolumeMl,
  formatVolumeMm3,
  formatVolumeSummary,
  mm3ToMl,
} from '@/shared/lib/volume';

describe('datetime formatters (Asia/Ho_Chi_Minh & date-only study_date)', () => {
  it('converts ISO UTC timestamps to Asia/Ho_Chi_Minh dd/MM/yyyy HH:mm across midnight boundary', () => {
    // 17:30 UTC on May 15 = 00:30 ICT (UTC+7) on May 16
    expect(formatDateTimeVN('2026-05-15T17:30:00Z')).toBe('16/05/2026 00:30');
    expect(formatDateVN('2026-05-15T17:30:00Z')).toBe('16/05/2026');
    expect(formatDateTimeVN('2026-05-15T01:05:00Z')).toBe('15/05/2026 08:05');
  });

  it('handles invalid or empty timestamps gracefully', () => {
    expect(formatDateTimeVN(null)).toBe('—');
    expect(formatDateTimeVN('')).toBe('—');
    expect(formatDateTimeVN('not-a-date')).toBe('—');
    expect(formatDateVN(undefined)).toBe('—');
  });

  it('formats date-only study_date YYYY-MM-DD without timezone shifting', () => {
    expect(formatStudyDate('2026-05-15')).toBe('15/05/2026');
    expect(formatStudyDate('2026-01-01')).toBe('01/01/2026');
    expect(formatStudyDate('2024-02-29')).toBe('29/02/2024');
    expect(formatStudyDate('2026-02-30')).toBe('—');
    expect(formatStudyDate('2026-05-15T00:00:00Z')).toBe('—');
    expect(formatStudyDate(null)).toBe('—');
  });
});

describe('volume formatters (mm³ <-> mL)', () => {
  it('converts mm³ to mL accurately and formats Vietnamese units', () => {
    expect(mm3ToMl(12500)).toBe(12.5);
    expect(mm3ToMl(0)).toBe(0);
    expect(mm3ToMl(-5)).toBeNaN();

    expect(formatVolumeMm3(12500)).toContain('mm³');
    expect(formatVolumeMm3(12500)).toMatch(/12[.,]500/);
    expect(formatVolumeMl(12500)).toBe('12,50 mL');
    expect(formatVolumeMl(0)).toBe('0,00 mL');
    expect(formatVolumeSummary(12500)).toContain('12,50 mL');
    expect(formatVolumeSummary(12500)).toContain('mm³');
  });

  it('handles missing or negative volumes safely', () => {
    expect(formatVolumeMm3(null)).toBe('—');
    expect(formatVolumeMl(undefined)).toBe('—');
    expect(formatVolumeSummary(-10)).toBe('—');
    expect(formatVolumeSummary(Number.NaN)).toBe('—');
  });
});

describe('API error envelope mapping and query retry rules', () => {
  it('maps backend error envelope codes to Vietnamese and preserves request_id', () => {
    const err = parseErrorEnvelope(
      {
        error: {
          code: 'mask_version_conflict',
          message: 'Stale base version',
          details: [{ field: 'base_version_id', reason: 'stale' }],
          request_id: 'req-conflict-123',
        },
      },
      409,
    );

    expect(err).toBeInstanceOf(ApiClientError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('mask_version_conflict');
    expect(err.requestId).toBe('req-conflict-123');
    expect(err.userMessage).toContain('phiên bản mask mới hơn');
  });

  it('uses X-Request-ID header when body omits request_id and suppresses unsafe server traces', () => {
    const err = parseErrorEnvelope(
      {
        error: {
          code: 'unmapped_custom_error',
          message: 'Traceback (most recent call last): /app/be/main.py',
          request_id: '',
        },
      },
      500,
      'req-header-999',
    );

    const normalized = normalizeApiError(err);
    expect(normalized.requestId).toBe('req-header-999');
    expect(normalized.message).not.toContain('Traceback');
    expect(normalized.message).not.toContain('/app/be');
  });

  it('identifies AbortError to suppress spurious toast notifications', () => {
    const domAbort = new DOMException('The operation was aborted.', 'AbortError');
    const errAbort = new Error('Aborted');
    errAbort.name = 'AbortError';

    expect(shouldSuppressErrorToast(domAbort)).toBe(true);
    expect(shouldSuppressErrorToast(errAbort)).toBe(true);
    expect(
      shouldSuppressErrorToast(new ApiClientError({ status: 500, code: 'internal_error' })),
    ).toBe(false);
  });

  it('retries GET up to 2 times for network/5xx and never retries 401/403/404/422 or AbortError', () => {
    const networkErr = new ApiClientError({ status: 0, code: 'network_error', isNetworkError: true });
    const serverErr = new ApiClientError({ status: 503, code: 'service_unavailable' });
    const err401 = new ApiClientError({ status: 401, code: 'unauthenticated' });
    const err403 = new ApiClientError({ status: 403, code: 'forbidden' });
    const err404 = new ApiClientError({ status: 404, code: 'not_found' });
    const err422 = new ApiClientError({ status: 422, code: 'validation_error' });
    const abortErr = new DOMException('Aborted', 'AbortError');

    expect(shouldRetryQuery(0, networkErr)).toBe(true);
    expect(shouldRetryQuery(1, networkErr)).toBe(true);
    expect(shouldRetryQuery(2, networkErr)).toBe(false);

    expect(shouldRetryQuery(0, serverErr)).toBe(true);
    expect(shouldRetryQuery(2, serverErr)).toBe(false);

    expect(shouldRetryQuery(0, err401)).toBe(false);
    expect(shouldRetryQuery(0, err403)).toBe(false);
    expect(shouldRetryQuery(0, err404)).toBe(false);
    expect(shouldRetryQuery(0, err422)).toBe(false);
    expect(shouldRetryQuery(0, abortErr)).toBe(false);
  });
});
