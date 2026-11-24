import { apiRequest } from './client';
import type { AdminUsersListParams } from './endpointParams';
import { getFixtureAdminUsers } from './fixtures';
import type {
  AdminCreateDoctorRequestDto,
  AdminDoctorUserDto,
  AdminResetPasswordResponseDto,
  AdminUpdateDoctorRequestDto,
  PaginatedResponse_AdminDoctorUserOut_,
} from './types';

export const USERNAME_PATTERN = /^[a-z0-9._-]{3,64}$/;
export const DISPLAY_NAME_MIN_LENGTH = 1;
export const DISPLAY_NAME_MAX_LENGTH = 150;
export const TEMP_PASSWORD_MIN_LENGTH = 12;
export const TEMP_PASSWORD_MAX_LENGTH = 128;

function buildAdminUsersQueryString(params: AdminUsersListParams): string {
  const sp = new URLSearchParams();
  if (params.q && params.q.trim() !== '') {
    sp.set('q', params.q.trim());
  }
  if (params.status && params.status !== 'all') {
    sp.set('status', params.status);
  }
  sp.set('page', String(params.page));
  sp.set('page_size', String(params.pageSize));
  const serialized = sp.toString();
  return serialized ? `?${serialized}` : '';
}

export async function listAdminUsers(
  params: AdminUsersListParams,
  options: { signal?: AbortSignal; fixtureMode?: boolean } = {},
): Promise<PaginatedResponse_AdminDoctorUserOut_> {
  if (options.fixtureMode) {
    return getFixtureAdminUsers(params);
  }
  const qs = buildAdminUsersQueryString(params);
  return apiRequest<PaginatedResponse_AdminDoctorUserOut_>(
    `/admin/users${qs}`,
    {
      method: 'GET',
      signal: options.signal,
    },
  );
}

export async function createAdminDoctorUser(
  payload: AdminCreateDoctorRequestDto,
  options: { fixtureMode?: boolean } = {},
): Promise<AdminDoctorUserDto> {
  if (options.fixtureMode) {
    const now = new Date().toISOString();
    return {
      id: `00000000-0000-4000-8000-${Date.now().toString().slice(-12).padStart(12, '0')}`,
      username: payload.username,
      display_name: payload.display_name,
      role: 'doctor',
      is_active: true,
      must_change_password: true,
      created_at: now,
      updated_at: now,
    };
  }
  return apiRequest<AdminDoctorUserDto>('/admin/users', {
    method: 'POST',
    body: {
      username: payload.username,
      display_name: payload.display_name,
      temporary_password: payload.temporary_password,
    },
  });
}

export async function updateAdminDoctorUser(
  userId: string,
  payload: AdminUpdateDoctorRequestDto,
  options: { fixtureMode?: boolean } = {},
): Promise<AdminDoctorUserDto> {
  if (options.fixtureMode) {
    const now = new Date().toISOString();
    return {
      id: userId,
      username: 'bs.fixture',
      display_name: payload.display_name ?? 'Bác sĩ (Mẫu)',
      role: 'doctor',
      is_active: payload.is_active ?? true,
      must_change_password: false,
      created_at: now,
      updated_at: now,
    };
  }
  return apiRequest<AdminDoctorUserDto>(
    `/admin/users/${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      body: { ...payload },
    },
  );
}

export async function resetAdminDoctorPassword(
  userId: string,
  options: { fixtureMode?: boolean } = {},
): Promise<AdminResetPasswordResponseDto> {
  if (options.fixtureMode) {
    return {
      temporary_password: 'fixture-temp-password-1234',
    };
  }
  return apiRequest<AdminResetPasswordResponseDto>(
    `/admin/users/${encodeURIComponent(userId)}/reset-password`,
    {
      method: 'POST',
    },
  );
}
