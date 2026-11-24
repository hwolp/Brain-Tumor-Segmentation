import { apiRequest } from './client';
import { FIXTURE_HEALTH_LIVE, FIXTURE_HEALTH_READY } from './fixtures';
import type { LivenessResponse, ReadinessResponse } from './types';

export interface HealthFetchOptions {
  signal?: AbortSignal;
  fixtureMode?: boolean;
}

/**
 * Kiểm tra trạng thái sống của API (`/api/v1/health/live`).
 * Chỉ trả fixture khi `fixtureMode === true` rõ ràng; tuyệt đối không fallback âm thầm khi API lỗi.
 */
export async function fetchHealthLive(
  options: HealthFetchOptions = {},
): Promise<LivenessResponse> {
  if (options.fixtureMode) {
    return FIXTURE_HEALTH_LIVE;
  }
  return apiRequest<LivenessResponse>('/health/live', {
    method: 'GET',
    signal: options.signal,
    skipAuth: true,
  });
}

/**
 * Kiểm tra mức độ sẵn sàng DB & storage (`/api/v1/health/ready`).
 * Chỉ trả fixture khi `fixtureMode === true` rõ ràng; tuyệt đối không fallback âm thầm khi API lỗi.
 */
export async function fetchHealthReady(
  options: HealthFetchOptions = {},
): Promise<ReadinessResponse> {
  if (options.fixtureMode) {
    return FIXTURE_HEALTH_READY;
  }
  return apiRequest<ReadinessResponse>('/health/ready', {
    method: 'GET',
    signal: options.signal,
    skipAuth: true,
  });
}
