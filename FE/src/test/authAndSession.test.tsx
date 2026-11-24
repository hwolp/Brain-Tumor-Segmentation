import { QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isAllowedReturnPath,
  registerTrackedObjectUrl,
  useAuthStore,
} from '@/app/auth-store';
import { AppProviders } from '@/app/providers';
import { AppRoutes } from '@/app/router';
import {
  AUTH_BROADCAST_CHANNEL_NAME,
  AUTH_REFRESH_LOCK_NAME,
  closeAuthBroadcastChannel,
} from '@/app/sessionCoordinator';
import { apiRequest } from '@/shared/api/client';
import {
  mapErrorCodeToVietnamese,
  parseErrorEnvelope,
} from '@/shared/api/errors';
import { FIXTURE_USERS } from '@/shared/api/fixtures';
import { downloadProtectedFileBuffer } from '@/shared/api/maskVersions';
import { uploadCaseVolume } from '@/shared/api/patientsCases';
import {
  createAppQueryClient,
  queryClient as singletonQueryClient,
} from '@/shared/api/queryClient';
import type { UserDto } from '@/shared/api/types';
import { useViewerStore } from '@/viewer-adapter';

const DOCTOR_USER: UserDto = {
  ...FIXTURE_USERS.doctor,
  must_change_password: false,
};

const DOCTOR_B_USER: UserDto = {
  id: '00000000-0000-4000-8000-000000000202',
  username: 'bs.hung',
  display_name: 'BS. Trần Quốc Hùng',
  role: 'doctor',
  is_active: true,
  must_change_password: false,
  created_at: '2026-01-12T03:00:00Z',
};

const ADMIN_USER: UserDto = {
  ...FIXTURE_USERS.admin,
  must_change_password: false,
};

function jsonResponse(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}

function errorResponse(
  status: number,
  code: string,
  requestId = 'req-test-001',
  message = 'Error from mock API',
  extraHeaders: Record<string, string> = {},
): Response {
  return jsonResponse(
    {
      error: {
        code,
        message,
        details: null,
        request_id: requestId,
      },
    },
    status,
    { 'X-Request-ID': requestId, ...extraHeaders },
  );
}

function healthResponseIfMatched(url: string): Response | null {
  if (url.includes('/health/live')) {
    return jsonResponse({
      status: 'ok',
      service: 'brain-tumor-api',
      environment: 'test',
    });
  }
  if (url.includes('/health/ready')) {
    return jsonResponse({
      status: 'ready',
      checks: { database: 'ok', storage: 'ok' },
    });
  }
  return null;
}

function createTestQueryClient(): QueryClient {
  const client = createAppQueryClient();
  client.setDefaultOptions({
    queries: {
      retry: false,
      gcTime: 0,
    },
  });
  return client;
}

function renderWithApp(
  initialEntries: string[],
  options: { client?: QueryClient; autoBootstrap?: boolean } = {},
) {
  const client = options.client ?? createTestQueryClient();
  return {
    client,
    ...render(
      <AppProviders
        client={client}
        autoBootstrap={options.autoBootstrap ?? false}
      >
        <MemoryRouter initialEntries={initialEntries}>
          <AppRoutes />
        </MemoryRouter>
      </AppProviders>,
    ),
  };
}

describe('P2 Auth, Single-Flight Refresh, Multi-Tab Coordination & Draft Protection', () => {
  const originalBroadcastChannel = globalThis.BroadcastChannel;
  const originalNavigatorLocks = navigator.locks;

  beforeEach(() => {
    closeAuthBroadcastChannel();
    singletonQueryClient.clear();
    useViewerStore.getState().resetViewerState();
    localStorage.clear();
    sessionStorage.clear();
    useAuthStore.setState({
      status: 'anonymous',
      user: null,
      accessToken: null,
      bootstrapError: null,
      fixtureMode: false,
      reauthRequired: false,
      reauthUserId: null,
      reauthUsername: null,
      reauthReason: null,
      authNotice: null,
      logoutSyncPending: false,
      suppressReturnTo: false,
    });
  });

  afterEach(() => {
    closeAuthBroadcastChannel();
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: originalBroadcastChannel,
    });
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      writable: true,
      value: originalNavigatorLocks,
    });
  });

  it('maps all P2 auth and admin error codes to clear Vietnamese messages', () => {
    const codes = [
      'login_failed',
      'invalid_current_password',
      'invalid_password',
      'weak_password',
      'bad_request',
      'conflict',
      'refresh_reused',
      'csrf_origin_denied',
      'rate_limit_exceeded',
      'username_conflict',
      'cannot_modify_admin',
      'password_change_required',
      'account_disabled',
    ];
    for (const code of codes) {
      const msg = mapErrorCodeToVietnamese(code, 400);
      expect(msg.length).toBeGreaterThan(10);
      expect(msg).not.toBe('Yêu cầu không hợp lệ.');
    }
    expect(mapErrorCodeToVietnamese('LOGIN_FAILED', 401)).toBe(
      mapErrorCodeToVietnamese('login_failed', 401),
    );
    expect(
      mapErrorCodeToVietnamese(
        'unknown_custom_code',
        400,
        '[UNKNOWN_CUSTOM_CODE] Dữ liệu không hợp lệ.',
      ),
    ).toBe('Dữ liệu không hợp lệ.');
  });

  it('QA-AUTH-03: 10 concurrent GET requests hitting 401 trigger exactly 1 POST /auth/refresh and replay each GET once', async () => {
    useAuthStore.setState({
      status: 'authenticated',
      user: DOCTOR_USER,
      accessToken: 'expired-access-token',
      fixtureMode: false,
    });

    let refreshCallCount = 0;
    let getCallCount = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = new Headers(init?.headers);

      if (url.endsWith('/api/v1/auth/refresh')) {
        refreshCallCount += 1;
        await new Promise((r) => setTimeout(r, 15));
        return jsonResponse({
          access_token: 'fresh-access-token',
          token_type: 'bearer',
          expires_in: 900,
          user: DOCTOR_USER,
        });
      }

      if (url.includes('/api/v1/patients')) {
        getCallCount += 1;
        const auth = headers.get('Authorization');
        if (auth === 'Bearer fresh-access-token') {
          return jsonResponse({ ok: true, url });
        }
        return errorResponse(401, 'token_expired', 'req-expired');
      }

      return jsonResponse({});
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, idx) =>
        apiRequest<{ ok: boolean; url: string }>(`/patients?i=${idx}`),
      ),
    );

    expect(refreshCallCount).toBe(1);
    expect(getCallCount).toBe(20); // 10 initial 401 + 10 single replays
    expect(results).toHaveLength(10);
    expect(results.every((item) => item.ok)).toBe(true);
    expect(useAuthStore.getState().accessToken).toBe('fresh-access-token');
  });

  it('QA-AUTH-03: prevents 401 -> refresh -> 401 loops and never silently replays unsafe mutations', async () => {
    useAuthStore.setState({
      status: 'authenticated',
      user: DOCTOR_USER,
      accessToken: 'expired-token-1',
      fixtureMode: false,
    });

    let refreshCalls = 0;
    let getReplayCalls = 0;
    let postMutationCalls = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/v1/auth/refresh')) {
        refreshCalls += 1;
        return jsonResponse({
          access_token: `new-token-${refreshCalls}`,
          token_type: 'bearer',
          expires_in: 900,
          user: DOCTOR_USER,
        });
      }
      if (url.includes('/api/v1/patients/always-401')) {
        getReplayCalls += 1;
        return errorResponse(401, 'unauthenticated', 'req-still-401');
      }
      if (url.includes('/api/v1/patients') && !url.includes('always-401')) {
        postMutationCalls += 1;
        return errorResponse(401, 'token_expired', 'req-post-401');
      }
      return jsonResponse({});
    });

    await expect(apiRequest('/patients/always-401')).rejects.toMatchObject({
      status: 401,
      code: 'unauthenticated',
    });
    expect(refreshCalls).toBe(1);
    expect(getReplayCalls).toBe(2); // 1 initial + max 1 replay

    await expect(
      apiRequest('/patients', {
        method: 'POST',
        body: { patient_code: 'BN-999' },
      }),
    ).rejects.toMatchObject({
      status: 401,
      code: 'token_expired',
    });
    // Unsafe POST must NOT replay silently; refresh is still called once to sync session
    expect(postMutationCalls).toBe(1);
    expect(refreshCalls).toBe(2);
    expect(useAuthStore.getState().accessToken).toBe('new-token-2');
  });

  it('bootstraps session via refresh cookie for doctor/admin, handles 401 -> /login, and shows retry screen on 503/network', async () => {
    // 1. Valid cookie restores admin session in memory only (not localStorage)
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = healthResponseIfMatched(url);
      if (health) return health;
      if (url.endsWith('/api/v1/auth/refresh')) {
        return jsonResponse({
          access_token: 'bootstrapped-admin-jwt',
          token_type: 'bearer',
          expires_in: 900,
          user: ADMIN_USER,
        });
      }
      return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
    });

    const validView = renderWithApp(['/'], { autoBootstrap: true });
    expect(
      await screen.findByRole('heading', { name: 'Tổng quan vận hành hệ thống' }),
    ).toBeInTheDocument();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(useAuthStore.getState().accessToken).toBe('bootstrapped-admin-jwt');
    validView.unmount();

    // 2. 401 on bootstrap navigates to /login
    useAuthStore.setState({
      status: 'bootstrapping',
      user: null,
      accessToken: null,
      bootstrapError: null,
    });
    fetchSpy.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/v1/auth/refresh')) {
        return errorResponse(401, 'unauthenticated', 'req-boot-401');
      }
      return jsonResponse({});
    });

    const unauthView = renderWithApp(['/doctor/patients'], { autoBootstrap: true });
    expect(
      await screen.findByRole('heading', { name: 'Đăng nhập hệ thống' }),
    ).toBeInTheDocument();
    expect(useAuthStore.getState().status).toBe('anonymous');
    unauthView.unmount();

    // 3. 503 on bootstrap shows retry screen instead of treating user as logged out
    useAuthStore.setState({
      status: 'bootstrapping',
      user: null,
      accessToken: null,
      bootstrapError: null,
    });
    let attempt = 0;
    fetchSpy.mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = healthResponseIfMatched(url);
      if (health) return health;
      if (url.endsWith('/api/v1/auth/refresh')) {
        attempt += 1;
        if (attempt === 1) {
          return errorResponse(503, 'service_unavailable', 'req-boot-503');
        }
        return jsonResponse({
          access_token: 'recovered-doc-jwt',
          token_type: 'bearer',
          expires_in: 900,
          user: DOCTOR_USER,
        });
      }
      return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
    });

    const user = userEvent.setup();
    renderWithApp(['/'], { autoBootstrap: true });
    expect(
      await screen.findByText('Không thể kiểm tra phiên làm việc'),
    ).toBeInTheDocument();
    expect(screen.getByText('req-boot-503')).toBeInTheDocument();
    expect(useAuthStore.getState().status).toBe('bootstrapping');

    await user.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(
      await screen.findByRole('heading', { name: 'Tổng quan ca chụp của tôi' }),
    ).toBeInTheDocument();
  });

  it('handles login failure (keeps username, shows request_id & 429 hint), must_change_password guard without prefetch, and password change rules (12-128 chars, spaces preserved)', async () => {
    const user = userEvent.setup();
    let businessEndpointCalled = false;
    let capturedChangePasswordBody: Record<string, unknown> | null = null;
    let loginAttempt = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = healthResponseIfMatched(url);
      if (health) return health;

      if (url.includes('/api/v1/patients') || url.includes('/api/v1/cases')) {
        businessEndpointCalled = true;
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
      }

      if (url.endsWith('/api/v1/auth/login')) {
        loginAttempt += 1;
        if (loginAttempt === 1) {
          return errorResponse(401, 'login_failed', 'req-login-401');
        }
        if (loginAttempt === 2) {
          return errorResponse(
            429,
            'rate_limit_exceeded',
            'req-login-429',
            'Too many login attempts',
            { 'Retry-After': '120' },
          );
        }
        return jsonResponse({
          access_token: 'temp-jwt-token',
          token_type: 'bearer',
          expires_in: 900,
          user: { ...DOCTOR_USER, must_change_password: true },
        });
      }

      if (url.endsWith('/api/v1/auth/change-password')) {
        capturedChangePasswordBody = JSON.parse(String(init?.body ?? '{}'));
        return new Response(null, { status: 204 });
      }

      return jsonResponse({});
    });

    const mainView = renderWithApp(['/doctor/patients']);

    const usernameInput = screen.getByLabelText(/Tên đăng nhập/);
    const passwordInput = screen.getByLabelText(/^Mật khẩu/);

    await user.type(usernameInput, 'bs.minh');
    await user.type(passwordInput, 'wrong-password');
    await user.click(screen.getByRole('button', { name: 'Đăng nhập' }));

    // 401 login_failed preserves username and displays request_id
    expect(
      await screen.findByText(/Tên đăng nhập hoặc mật khẩu không đúng/),
    ).toBeInTheDocument();
    expect(screen.getByText(/req-login-401/)).toBeInTheDocument();
    expect(usernameInput).toHaveValue('bs.minh');

    // 429 rate_limit_exceeded shows wait guidance + request_id
    await user.click(screen.getByRole('button', { name: 'Đăng nhập' }));
    expect(
      await screen.findByText(/Vui lòng đợi khoảng 120 giây/),
    ).toBeInTheDocument();
    expect(screen.getByText(/req-login-429/)).toBeInTheDocument();
    expect(usernameInput).toHaveValue('bs.minh');

    // Login succeeds with must_change_password=true -> redirects to /change-password, no business API prefetched
    await user.click(screen.getByRole('button', { name: 'Đăng nhập' }));
    expect(
      await screen.findByRole('heading', { name: 'Đổi mật khẩu tài khoản' }),
    ).toBeInTheDocument();
    expect(businessEndpointCalled).toBe(false);

    // Password < 12 chars rejected client-side
    await user.type(screen.getByLabelText(/Mật khẩu hiện tại/), ' old pass ');
    await user.type(screen.getByLabelText(/^Mật khẩu mới/), 'short123');
    await user.type(screen.getByLabelText(/Nhập lại mật khẩu mới/), 'short123');
    await user.click(screen.getByRole('button', { name: 'Lưu mật khẩu mới' }));
    expect(
      screen.getByText(/Mật khẩu mới phải có từ 12 đến 128 ký tự/),
    ).toBeInTheDocument();
    expect(capturedChangePasswordBody).toBeNull();

    // Password with leading/trailing spaces (12-128 chars) is preserved verbatim (no .trim())
    const validWithSpaces = '  mat khau moi co khoang trang  ';
    const newPassInput = screen.getByLabelText(/^Mật khẩu mới/);
    const confirmInput = screen.getByLabelText(/Nhập lại mật khẩu mới/);
    await user.clear(newPassInput);
    await user.type(newPassInput, validWithSpaces);
    await user.clear(confirmInput);
    await user.type(confirmInput, validWithSpaces);
    await user.click(screen.getByRole('button', { name: 'Lưu mật khẩu mới' }));

    expect(
      await screen.findByRole('heading', { name: 'Đăng nhập hệ thống' }),
    ).toBeInTheDocument();
    expect(capturedChangePasswordBody).toEqual({
      current_password: ' old pass ',
      new_password: validWithSpaces,
    });
    expect(
      within(screen.getByRole('main')).getByText(
        'Đổi mật khẩu thành công. Vui lòng đăng nhập lại bằng mật khẩu mới.',
      ),
    ).toBeInTheDocument();
    expect(useAuthStore.getState().status).toBe('anonymous');
    mainView.unmount();

    // Direct navigation to /doctor/patients or /admin/users when must_change_password=true stays blocked without prefetching
    useAuthStore.setState({
      status: 'must_change_password',
      user: { ...DOCTOR_USER, must_change_password: true },
      accessToken: 'temp-jwt-token',
      fixtureMode: false,
    });

    const guardDoctor = renderWithApp(['/doctor/patients']);
    expect(
      screen.getByRole('heading', { name: 'Đổi mật khẩu tài khoản' }),
    ).toBeInTheDocument();
    guardDoctor.unmount();

    const guardAdmin = renderWithApp(['/admin/users']);
    expect(
      screen.getByRole('heading', { name: 'Đổi mật khẩu tài khoản' }),
    ).toBeInTheDocument();
    guardAdmin.unmount();
    expect(businessEndpointCalled).toBe(false);
  });

  it('QA-AUTH-04: preserves dirty viewer draft across ReauthModal when the same doctor re-authenticates', async () => {
    const user = userEvent.setup();
    const revokeSpy = vi.fn();
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: revokeSpy,
    });

    useAuthStore.setState({
      status: 'authenticated',
      user: DOCTOR_USER,
      accessToken: 'expired-doc-jwt',
      fixtureMode: false,
    });

    const client = createTestQueryClient();
    client.setQueryData(
      ['doctor', DOCTOR_USER.id, 'cases-overview', { fixtureMode: false }],
      { items: [], total: 0, page: 1, page_size: 20 },
    );

    registerTrackedObjectUrl('blob:http://127.0.0.1:5173/keep-draft-url');
    useViewerStore.getState().setDirty(true);
    useViewerStore.getState().setSliceIndex(42);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = healthResponseIfMatched(url);
      if (health) return health;
      if (url.endsWith('/api/v1/auth/refresh')) {
        return errorResponse(401, 'unauthenticated', 'req-refresh-expired');
      }
      if (url.endsWith('/api/v1/auth/login')) {
        return jsonResponse({
          access_token: 'reauthed-doc-jwt',
          token_type: 'bearer',
          expires_in: 900,
          user: DOCTOR_USER,
        });
      }
      if (url.includes('/api/v1/cases')) {
        const auth = new Headers(init?.headers).get('Authorization');
        if (auth !== 'Bearer reauthed-doc-jwt') {
          return errorResponse(401, 'token_expired', 'req-cases-401');
        }
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
      }
      return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
    });

    renderWithApp(['/doctor'], { client });

    // Simulate API encountering 401 + expired refresh while dirty draft exists
    await act(async () => {
      await expect(apiRequest('/cases')).rejects.toMatchObject({ status: 401 });
    });

    const reauthDialog = await screen.findByRole('alertdialog', {
      name: 'Xác thực lại phiên làm việc',
    });
    expect(reauthDialog).toBeInTheDocument();
    expect(within(reauthDialog).getByLabelText(/Tên đăng nhập/)).toHaveValue(
      DOCTOR_USER.username,
    );
    expect(within(reauthDialog).getByLabelText(/Tên đăng nhập/)).toHaveAttribute(
      'readonly',
    );
    expect(useViewerStore.getState().isDirty).toBe(true);
    expect(useViewerStore.getState().currentSliceZeroBased).toBe(42);
    expect(revokeSpy).not.toHaveBeenCalled();

    await user.type(within(reauthDialog).getByLabelText(/^Mật khẩu/), 'same-doctor-password-123');
    await user.click(within(reauthDialog).getByRole('button', { name: 'Đăng nhập lại' }));

    await waitFor(() => {
      expect(
        screen.queryByRole('alertdialog', { name: 'Xác thực lại phiên làm việc' }),
      ).not.toBeInTheDocument();
    });

    expect(useAuthStore.getState().accessToken).toBe('reauthed-doc-jwt');
    expect(useViewerStore.getState().isDirty).toBe(true);
    expect(useViewerStore.getState().currentSliceZeroBased).toBe(42);
    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it('QA-AUTH-05: clears cache, viewer draft and object URLs when switching accounts in ReauthModal, on account_disabled, or on confirmed dirty Logout', async () => {
    const user = userEvent.setup();
    const revokeSpy = vi.fn();
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: revokeSpy,
    });

    // Part A: Switching to a different doctor in ReauthModal wipes old draft + cache + object URLs
    useAuthStore.setState({
      status: 'authenticated',
      user: DOCTOR_USER,
      accessToken: 'tok-a',
      fixtureMode: false,
      reauthRequired: true,
      reauthUserId: DOCTOR_USER.id,
      reauthUsername: DOCTOR_USER.username,
      reauthReason: 'Phiên đã hết hạn.',
    });

    singletonQueryClient.setQueryData(['doctor', DOCTOR_USER.id, 'secret'], {
      patient: 'secret-A',
    });
    registerTrackedObjectUrl('blob:http://127.0.0.1:5173/doc-a-volume');
    useViewerStore.getState().setDirty(true);
    useViewerStore.getState().setSliceIndex(77);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = healthResponseIfMatched(url);
      if (health) return health;
      if (url.endsWith('/api/v1/auth/login')) {
        return jsonResponse({
          access_token: 'tok-doctor-b',
          token_type: 'bearer',
          expires_in: 900,
          user: DOCTOR_B_USER,
        });
      }
      if (url.endsWith('/api/v1/auth/logout')) {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
    });

    const view = renderWithApp(['/doctor'], { client: singletonQueryClient });

    const dialog = await screen.findByRole('alertdialog', {
      name: 'Xác thực lại phiên làm việc',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Đổi tài khoản khác' }));
    const unameInput = within(dialog).getByLabelText(/Tên đăng nhập/);
    await user.clear(unameInput);
    await user.type(unameInput, DOCTOR_B_USER.username);
    await user.type(within(dialog).getByLabelText(/^Mật khẩu/), 'doctor-b-password-123');
    await user.click(within(dialog).getByRole('button', { name: 'Đăng nhập lại' }));

    await waitFor(() => {
      expect(useAuthStore.getState().user?.id).toBe(DOCTOR_B_USER.id);
    });
    expect(
      singletonQueryClient.getQueryData(['doctor', DOCTOR_USER.id, 'secret']),
    ).toBeUndefined();
    expect(revokeSpy).toHaveBeenCalledWith(
      'blob:http://127.0.0.1:5173/doc-a-volume',
    );
    expect(useViewerStore.getState().isDirty).toBe(false);
    expect(useViewerStore.getState().currentSliceZeroBased).toBe(0);

    // Part B: Clicking Logout in AppShell with dirty draft opens ConfirmDialog
    useViewerStore.getState().setDirty(true);
    useViewerStore.getState().setSliceIndex(19);
    registerTrackedObjectUrl('blob:http://127.0.0.1:5173/doc-b-volume');

    await user.click(screen.getByRole('button', { name: 'Đăng xuất' }));
    const confirmLogout = await screen.findByRole('alertdialog', {
      name: 'Xác nhận bỏ thay đổi và đăng xuất',
    });
    expect(
      within(confirmLogout).getByText(
        'Bạn đang có chỉnh sửa mask chưa lưu. Quay lại để lưu hoặc bỏ thay đổi và đăng xuất?',
      ),
    ).toBeInTheDocument();

    // Cancel keeps draft and session
    await user.click(within(confirmLogout).getByRole('button', { name: 'Quay lại để lưu' }));
    expect(useViewerStore.getState().isDirty).toBe(true);
    expect(useAuthStore.getState().status).toBe('authenticated');

    // Confirm discards draft and logs out cleanly
    await user.click(screen.getByRole('button', { name: 'Đăng xuất' }));
    const confirmLogout2 = await screen.findByRole('alertdialog', {
      name: 'Xác nhận bỏ thay đổi và đăng xuất',
    });
    await user.click(
      within(confirmLogout2).getByRole('button', { name: 'Bỏ thay đổi và đăng xuất' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Đăng nhập hệ thống' }),
    ).toBeInTheDocument();
    expect(useViewerStore.getState().isDirty).toBe(false);
    expect(revokeSpy).toHaveBeenCalledWith(
      'blob:http://127.0.0.1:5173/doc-b-volume',
    );
    view.unmount();

    // Part C: account_disabled wipes dirty draft immediately (cannot be retained by ReauthModal)
    useAuthStore.setState({
      status: 'authenticated',
      user: DOCTOR_USER,
      accessToken: 'tok-locked',
      fixtureMode: false,
    });
    singletonQueryClient.setQueryData(['doctor', DOCTOR_USER.id, 'cases'], ['c1']);
    registerTrackedObjectUrl('blob:http://127.0.0.1:5173/locked-volume');
    useViewerStore.getState().setDirty(true);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      errorResponse(403, 'account_disabled', 'req-locked-403'),
    );

    await expect(apiRequest('/patients')).rejects.toMatchObject({
      code: 'account_disabled',
    });

    expect(useAuthStore.getState().status).toBe('anonymous');
    expect(useAuthStore.getState().reauthRequired).toBe(false);
    expect(useViewerStore.getState().isDirty).toBe(false);
    expect(singletonQueryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(revokeSpy).toHaveBeenCalledWith(
      'blob:http://127.0.0.1:5173/locked-volume',
    );
  });

  it('coordinates refresh via navigator.locks and BroadcastChannel without leaking raw tokens', async () => {
    const lockCalls: string[] = [];
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      writable: true,
      value: {
        request: vi.fn(async (name: string, cb: () => Promise<unknown>) => {
          lockCalls.push(name);
          return cb();
        }),
      },
    });

    const postedMessages: unknown[] = [];
    const createdChannels: Array<{
      name: string;
      onmessage: ((event: MessageEvent) => void) | null;
    }> = [];

    class MockBroadcastChannel {
      name: string;
      onmessage: ((event: MessageEvent) => void) | null = null;

      constructor(name: string) {
        this.name = name;
        createdChannels.push(this);
      }

      postMessage(data: unknown) {
        postedMessages.push(data);
      }

      close() {}
    }

    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: MockBroadcastChannel,
    });

    const revokeSpy = vi.fn();
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: revokeSpy,
    });

    useAuthStore.setState({
      status: 'authenticated',
      user: DOCTOR_USER,
      accessToken: 'old-jwt',
      fixtureMode: false,
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse({
        access_token: 'super-secret-new-jwt',
        token_type: 'bearer',
        expires_in: 900,
        user: DOCTOR_USER,
      }),
    );

    const token = await useAuthStore.getState().refreshSession('old-jwt');
    expect(token).toBe('super-secret-new-jwt');
    expect(lockCalls).toEqual([AUTH_REFRESH_LOCK_NAME]);
    const activeChannelInstance = createdChannels.at(-1);
    expect(activeChannelInstance?.name).toBe(AUTH_BROADCAST_CHANNEL_NAME);
    expect(postedMessages).toHaveLength(1);
    const serialized = JSON.stringify(postedMessages[0]);
    expect(serialized).toContain('refresh_succeeded');
    expect(serialized).toContain(DOCTOR_USER.id);
    expect(serialized).not.toContain('super-secret-new-jwt');
    expect(serialized).not.toContain('access_token');
    expect(serialized).not.toContain('refresh_token');

    // Simulate receiving logged_out from another tab -> clears query cache, viewer state & object URLs
    singletonQueryClient.setQueryData(['doctor', DOCTOR_USER.id, 'patients'], ['p1']);
    registerTrackedObjectUrl('blob:http://127.0.0.1:5173/tab-sync-url');
    useViewerStore.getState().setDirty(true);

    await act(async () => {
      activeChannelInstance?.onmessage?.({
        data: {
          type: 'logged_out',
          userId: DOCTOR_USER.id,
          tabId: 'other-tab-id',
          timestamp: Date.now(),
        },
      } as MessageEvent);
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(useAuthStore.getState().status).toBe('anonymous');
    expect(useViewerStore.getState().isDirty).toBe(false);
    expect(singletonQueryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(revokeSpy).toHaveBeenCalledWith(
      'blob:http://127.0.0.1:5173/tab-sync-url',
    );
  });

  it('QA-AUTH-05: discards draft & clears session when clicking "Hủy bản nháp & đăng xuất" in ReauthModal and loads DoctorProfilePage from /auth/me', async () => {
    const user = userEvent.setup();
    const revokeSpy = vi.fn();
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: revokeSpy,
    });

    useAuthStore.setState({
      status: 'authenticated',
      user: DOCTOR_USER,
      accessToken: 'doc-tok',
      fixtureMode: false,
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = healthResponseIfMatched(url);
      if (health) return health;
      if (url.endsWith('/api/v1/auth/me')) {
        return jsonResponse({
          ...DOCTOR_USER,
          display_name: 'BS. Minh (Từ /auth/me)',
        });
      }
      if (url.endsWith('/api/v1/auth/logout')) {
        return new Response(null, { status: 204 });
      }
      return jsonResponse({});
    });

    const profileView = renderWithApp(['/doctor/profile'], {
      client: singletonQueryClient,
    });
    expect(await screen.findByText('BS. Minh (Từ /auth/me)')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Đổi mật khẩu tài khoản' }),
    ).toHaveAttribute('href', '/change-password');

    // Trigger ReauthModal while dirty and click "Hủy bản nháp & đăng xuất"
    singletonQueryClient.setQueryData(['doctor', DOCTOR_USER.id, 'draft-case'], ['c1']);
    registerTrackedObjectUrl('blob:http://127.0.0.1:5173/discard-draft-url');
    useViewerStore.getState().setDirty(true);

    act(() => {
      useAuthStore.setState({
        reauthRequired: true,
        reauthUserId: DOCTOR_USER.id,
        reauthUsername: DOCTOR_USER.username,
        reauthReason: 'Phiên đã hết hạn.',
      });
    });

    const reauthDialog = await screen.findByRole('alertdialog', {
      name: 'Xác thực lại phiên làm việc',
    });
    await user.click(
      within(reauthDialog).getByRole('button', { name: 'Hủy bản nháp & đăng xuất' }),
    );

    expect(
      await screen.findByRole('heading', { name: 'Đăng nhập hệ thống' }),
    ).toBeInTheDocument();
    expect(useViewerStore.getState().isDirty).toBe(false);
    expect(singletonQueryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(revokeSpy).toHaveBeenCalledWith(
      'blob:http://127.0.0.1:5173/discard-draft-url',
    );
    profileView.unmount();
  });

  it('aborts late response if session changes while reading response body stream', async () => {
    useAuthStore.setState({
      status: 'authenticated',
      user: DOCTOR_USER,
      accessToken: 'doc-tok-old',
      fixtureMode: false,
    });

    let resolveBodyText!: (value: string) => void;
    const bodyPromise = new Promise<string>((resolve) => {
      resolveBodyText = resolve;
    });

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers({ 'Content-Type': 'application/json' }),
      text: () => bodyPromise,
    } as unknown as Response);

    const requestPromise = apiRequest<{ stale: boolean }>('/patients');
    await Promise.resolve();
    await Promise.resolve();

    // Session switches/logs out while body stream is still being awaited
    await useAuthStore.getState().clearLocalSession();
    resolveBodyText(JSON.stringify({ stale: true }));

    await expect(requestPromise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('clears local session immediately while /auth/logout is in flight and discards late refresh responses after epoch change', async () => {
    const revokeSpy = vi.fn();
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: revokeSpy,
    });

    useAuthStore.setState({
      status: 'authenticated',
      user: DOCTOR_USER,
      accessToken: 'doc-tok-live',
      fixtureMode: false,
    });
    singletonQueryClient.setQueryData(['doctor', DOCTOR_USER.id, 'patients'], ['p1']);
    registerTrackedObjectUrl('blob:http://127.0.0.1:5173/logout-immediate-url');

    let resolveLogoutFetch!: (value: Response) => void;
    let resolveRefreshFetch!: (value: Response) => void;
    let capturedLogoutAuth: string | null = null;

    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/v1/auth/logout')) {
        capturedLogoutAuth = new Headers(init?.headers).get('Authorization');
        return new Promise<Response>((resolve) => {
          resolveLogoutFetch = resolve;
        });
      }
      if (url.endsWith('/api/v1/auth/refresh')) {
        return new Promise<Response>((resolve) => {
          resolveRefreshFetch = resolve;
        });
      }
      return Promise.resolve(jsonResponse({}));
    });

    // 1. Late refresh response must NOT restore previous user after logout bumps sessionEpoch
    const refreshPromise = useAuthStore.getState().refreshSession('doc-tok-live');
    await waitFor(() => {
      expect(typeof resolveRefreshFetch).toBe('function');
    });

    const logoutPromise = useAuthStore.getState().logout();
    // Local session is wiped immediately without waiting for /auth/logout to finish
    await waitFor(() => {
      expect(useAuthStore.getState().status).toBe('anonymous');
      expect(useAuthStore.getState().accessToken).toBeNull();
      expect(useAuthStore.getState().user).toBeNull();
      expect(singletonQueryClient.getQueryCache().getAll()).toHaveLength(0);
      expect(revokeSpy).toHaveBeenCalledWith(
        'blob:http://127.0.0.1:5173/logout-immediate-url',
      );
      expect(typeof resolveLogoutFetch).toBe('function');
    });
    expect(capturedLogoutAuth).toBe('Bearer doc-tok-live');

    // Old /auth/refresh settles late -> must return null and leave state anonymous
    resolveRefreshFetch(
      jsonResponse({
        access_token: 'stale-refreshed-tok',
        token_type: 'bearer',
        expires_in: 900,
        user: DOCTOR_USER,
      }),
    );
    await expect(refreshPromise).resolves.toBeNull();
    expect(useAuthStore.getState().status).toBe('anonymous');
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();

    resolveLogoutFetch(new Response(null, { status: 204 }));
    await logoutPromise;
    expect(useAuthStore.getState().logoutSyncPending).toBe(false);

    // 2. Stale retryServerLogout settling after a new login must not overwrite new session state
    let rejectRetryLogout!: (err: unknown) => void;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/v1/auth/logout')) {
        return new Promise<Response>((_, reject) => {
          rejectRetryLogout = reject;
        });
      }
      if (url.endsWith('/api/v1/auth/login')) {
        return Promise.resolve(
          jsonResponse({
            access_token: 'new-login-tok',
            token_type: 'bearer',
            expires_in: 900,
            user: DOCTOR_USER,
          }),
        );
      }
      return Promise.resolve(jsonResponse({}));
    });

    const retryPromise = useAuthStore.getState().retryServerLogout();
    await waitFor(() => {
      expect(typeof rejectRetryLogout).toBe('function');
    });
    await useAuthStore.getState().login('bs.minh', 'valid-password-1234');
    rejectRetryLogout(new Error('network lost'));
    await expect(retryPromise).resolves.toBe(false);
    expect(useAuthStore.getState().status).toBe('authenticated');
    expect(useAuthStore.getState().logoutSyncPending).toBe(false);
    expect(useAuthStore.getState().authNotice).toBeNull();
  });

  it('broadcasts user_changed when logging in from anonymous /login, recovers same-doctor ReauthModal draft, and preserves dirty draft on non-fatal cross-tab session_revoked', async () => {
    const postedMessages: unknown[] = [];
    const createdChannels: Array<{
      name: string;
      onmessage: ((event: MessageEvent) => void) | null;
    }> = [];

    class MockBroadcastChannel {
      name: string;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(name: string) {
        this.name = name;
        createdChannels.push(this);
      }
      postMessage(data: unknown) {
        postedMessages.push(data);
      }
      close() {}
    }

    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      writable: true,
      value: MockBroadcastChannel,
    });

    const revokeSpy = vi.fn();
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: revokeSpy,
    });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/v1/auth/login')) {
        return jsonResponse({
          access_token: 'login-from-anon-tok',
          token_type: 'bearer',
          expires_in: 900,
          user: DOCTOR_B_USER,
        });
      }
      if (url.endsWith('/api/v1/auth/refresh')) {
        return jsonResponse({
          access_token: 'recovered-from-other-tab-tok',
          token_type: 'bearer',
          expires_in: 900,
          user: DOCTOR_USER,
        });
      }
      return jsonResponse({});
    });

    // 1. Login from anonymous state (/login, previousUser === null) still cleans cache/URLs and broadcasts user_changed
    singletonQueryClient.setQueryData(['stale', 'anon'], { leaked: true });
    registerTrackedObjectUrl('blob:http://127.0.0.1:5173/anon-stale-url');
    expect(useAuthStore.getState().user).toBeNull();

    await useAuthStore.getState().login('bs.hung', 'doctor-b-valid-pass-123');

    expect(revokeSpy).toHaveBeenCalledWith(
      'blob:http://127.0.0.1:5173/anon-stale-url',
    );
    expect(singletonQueryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(postedMessages).toEqual([
      expect.objectContaining({
        type: 'user_changed',
        userId: DOCTOR_B_USER.id,
      }),
    ]);

    const activeChannel = createdChannels.at(-1)!;

    // 2. Tab A has dirty draft for DOCTOR_USER and receives session_revoked(reason='expired') from Tab B -> opens ReauthModal instead of wiping draft!
    useAuthStore.setState({
      status: 'authenticated',
      user: DOCTOR_USER,
      accessToken: 'doc-a-tok',
      reauthRequired: false,
      reauthUserId: null,
      reauthUsername: null,
      fixtureMode: false,
    });
    registerTrackedObjectUrl('blob:http://127.0.0.1:5173/keep-dirty-across-tabs');
    useViewerStore.getState().setDirty(true);
    useViewerStore.getState().setSliceIndex(33);
    revokeSpy.mockClear();

    await act(async () => {
      activeChannel.onmessage?.({
        data: {
          type: 'session_revoked',
          userId: DOCTOR_USER.id,
          reason: 'expired',
          tabId: 'tab-secondary',
          timestamp: Date.now(),
        },
      } as MessageEvent);
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(useAuthStore.getState().reauthRequired).toBe(true);
    expect(useAuthStore.getState().reauthUserId).toBe(DOCTOR_USER.id);
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useViewerStore.getState().isDirty).toBe(true);
    expect(useViewerStore.getState().currentSliceZeroBased).toBe(33);
    expect(revokeSpy).not.toHaveBeenCalled();

    // 3. Same doctor logs in from another tab (broadcasts user_changed with DOCTOR_USER.id) -> Tab A auto-refreshes and preserves dirty draft!
    await act(async () => {
      activeChannel.onmessage?.({
        data: {
          type: 'user_changed',
          userId: DOCTOR_USER.id,
          tabId: 'tab-secondary',
          timestamp: Date.now(),
        },
      } as MessageEvent);
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(useAuthStore.getState().reauthRequired).toBe(false);
    expect(useAuthStore.getState().accessToken).toBe(
      'recovered-from-other-tab-tok',
    );
    expect(useViewerStore.getState().isDirty).toBe(true);
    expect(useViewerStore.getState().currentSliceZeroBased).toBe(33);

    // 4. Put Tab A back into ReauthModal (even if user is null and only reauthUserId is set), then different user logs in on Tab B -> wipes Tab A!
    useAuthStore.setState({
      status: 'authenticated',
      user: null,
      accessToken: null,
      reauthRequired: true,
      reauthUserId: DOCTOR_USER.id,
      reauthUsername: DOCTOR_USER.username,
    });
    singletonQueryClient.setQueryData(['doctor', DOCTOR_USER.id, 'cases'], ['c1']);

    await act(async () => {
      activeChannel.onmessage?.({
        data: {
          type: 'user_changed',
          userId: DOCTOR_B_USER.id,
          tabId: 'tab-secondary',
          timestamp: Date.now(),
        },
      } as MessageEvent);
      await new Promise((r) => setTimeout(r, 15));
    });

    expect(useAuthStore.getState().status).toBe('anonymous');
    expect(useAuthStore.getState().reauthRequired).toBe(false);
    expect(useViewerStore.getState().isDirty).toBe(false);
    expect(singletonQueryClient.getQueryCache().getAll()).toHaveLength(0);
    expect(revokeSpy).toHaveBeenCalledWith(
      'blob:http://127.0.0.1:5173/keep-dirty-across-tabs',
    );
  });

  it('prevents /change-password return loops and prevents Doctor A case URL from leaking to Doctor B after voluntary logout', async () => {
    expect(isAllowedReturnPath('/change-password', 'doctor')).toBe(false);
    expect(isAllowedReturnPath('/change-password', 'admin')).toBe(false);
    expect(isAllowedReturnPath('/doctor/cases/case-a', 'doctor')).toBe(true);

    const user = userEvent.setup();
    useAuthStore.setState({
      status: 'authenticated',
      user: DOCTOR_USER,
      accessToken: 'doc-a-jwt',
      fixtureMode: false,
    });

    const requestedDoctorBCaseA: string[] = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = healthResponseIfMatched(url);
      if (health) return health;
      const authHeader = new Headers(init?.headers).get('Authorization');

      if (url.includes('case-owned-by-doc-a')) {
        if (authHeader === 'Bearer doc-b-jwt') {
          requestedDoctorBCaseA.push(url);
        }
        if (url.endsWith('/volumes')) return jsonResponse([]);
        return jsonResponse({
          id: 'case-owned-by-doc-a',
          patient_id: 'pat-a',
          study_date: '2026-05-10',
          notes: null,
          reference_volume_id: null,
          readiness: 'missing_inputs',
          is_inputs_locked: false,
          can_run_inference: false,
          latest_mask_version_id: null,
          created_at: '2026-05-10T00:00:00Z',
          updated_at: '2026-05-10T00:00:00Z',
          items: [],
          total: 0,
          page: 1,
          page_size: 20,
        });
      }
      if (url.endsWith('/api/v1/auth/logout')) {
        // Simulate server logout failure -> logoutSyncPending=true on /login
        throw new TypeError('Failed to fetch');
      }
      if (url.endsWith('/api/v1/auth/login')) {
        return jsonResponse({
          access_token: 'doc-b-jwt',
          token_type: 'bearer',
          expires_in: 900,
          user: DOCTOR_B_USER,
        });
      }
      return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
    });

    renderWithApp(['/doctor/cases/case-owned-by-doc-a']);
    expect(
      await screen.findByRole('heading', { name: 'Ca chụp ngày 10/05/2026' }),
    ).toBeInTheDocument();

    // Doctor A clicks voluntary Logout
    await user.click(screen.getByRole('button', { name: 'Đăng xuất' }));
    expect(
      await screen.findByRole('heading', { name: 'Đăng nhập hệ thống' }),
    ).toBeInTheDocument();

    // Doctor B logs in on the same screen -> must go to /doctor overview, NEVER Doctor A's case URL!
    await user.type(screen.getByLabelText(/Tên đăng nhập/), DOCTOR_B_USER.username);
    await user.type(screen.getByLabelText(/^Mật khẩu/), 'doctor-b-password-123');
    await user.click(screen.getByRole('button', { name: 'Đăng nhập' }));

    expect(
      await screen.findByRole('heading', { name: 'Tổng quan ca chụp của tôi' }),
    ).toBeInTheDocument();
    expect(requestedDoctorBCaseA).toHaveLength(0);
  });

  it('deduplicates refresh across concurrent binary downloads via failedWithToken and enforces auth/epoch guards on uploadCaseVolume', async () => {
    useAuthStore.setState({
      status: 'authenticated',
      user: DOCTOR_USER,
      accessToken: 'expired-bin-tok',
      fixtureMode: false,
    });

    let refreshCount = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const auth = new Headers(init?.headers).get('Authorization');
      if (url.endsWith('/api/v1/auth/refresh')) {
        refreshCount += 1;
        await new Promise((r) => setTimeout(r, 15));
        return jsonResponse({
          access_token: 'fresh-bin-tok',
          token_type: 'bearer',
          expires_in: 900,
          user: DOCTOR_USER,
        });
      }
      if (url.includes('/api/v1/files/')) {
        if (auth === 'Bearer fresh-bin-tok') {
          return new Response(new Uint8Array([1, 2, 3, 4]).buffer, {
            status: 200,
          });
        }
        return errorResponse(401, 'token_expired', 'req-bin-401');
      }
      return jsonResponse({});
    });

    // Two binary fetches failing sequentially/overlapping with the same expired token rotate refresh ONLY ONCE
    const [buf1, buf2] = await Promise.all([
      downloadProtectedFileBuffer('f-flair'),
      (async () => {
        await new Promise((r) => setTimeout(r, 25));
        return downloadProtectedFileBuffer('f-t1ce');
      })(),
    ]);
    expect(buf1.byteLength).toBe(4);
    expect(buf2.byteLength).toBe(4);
    expect(refreshCount).toBe(1);

    // Binary fetch encountering 403 account_disabled revokes session immediately
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      errorResponse(403, 'account_disabled', 'req-bin-locked'),
    );
    await expect(downloadProtectedFileBuffer('f-locked')).rejects.toMatchObject({
      code: 'account_disabled',
    });
    expect(useAuthStore.getState().status).toBe('anonymous');

    // Multipart XHR upload: 401 with expired refresh while dirty opens ReauthModal without replaying XHR; epoch change rejects with AbortError
    const OriginalXhr = globalThis.XMLHttpRequest;
    const xhrInstances: Array<{
      onload: (() => void) | null;
      status: number;
      responseText: string;
      headers: Record<string, string>;
    }> = [];

    class MockUploadXhr {
      headers: Record<string, string> = {};
      withCredentials = false;
      status = 0;
      responseText = '';
      upload = { onprogress: null, onload: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      constructor() {
        xhrInstances.push(this);
      }
      open() {}
      setRequestHeader(k: string, v: string) {
        this.headers[k] = v;
      }
      getResponseHeader() {
        return 'req-xhr';
      }
      send() {}
      abort() {
        this.onabort?.();
      }
    }

    vi.stubGlobal('XMLHttpRequest', MockUploadXhr);
    try {
      useAuthStore.setState({
        status: 'authenticated',
        user: DOCTOR_USER,
        accessToken: 'expired-upload-tok',
        fixtureMode: false,
      });
      useViewerStore.getState().setDirty(true);
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        errorResponse(401, 'unauthenticated', 'req-refresh-expired-up'),
      );

      const file = new File(['nifti'], 'flair.nii.gz');
      const uploadPromise = uploadCaseVolume('case-1', 'flair', file);
      expect(xhrInstances).toHaveLength(1);

      xhrInstances[0]!.status = 401;
      xhrInstances[0]!.responseText = JSON.stringify({
        error: {
          code: 'token_expired',
          message: 'Expired',
          details: null,
          request_id: 'req-xhr-401',
        },
      });
      xhrInstances[0]!.onload?.();

      await expect(uploadPromise).rejects.toMatchObject({ status: 401 });
      expect(xhrInstances).toHaveLength(1); // Never blindly replayed!
      expect(useAuthStore.getState().reauthRequired).toBe(true);
      expect(useViewerStore.getState().isDirty).toBe(true);

      // Stale XHR upload settling after session epoch bump rejects with AbortError
      useAuthStore.setState({
        status: 'authenticated',
        user: DOCTOR_USER,
        accessToken: 'active-tok',
        reauthRequired: false,
      });
      const staleUploadPromise = uploadCaseVolume('case-1', 't1ce', file);
      const staleXhr = xhrInstances[1]!;
      await useAuthStore.getState().clearLocalSession();
      staleXhr.status = 201;
      staleXhr.responseText = JSON.stringify({ id: 'vol-stale' });
      staleXhr.onload?.();
      await expect(staleUploadPromise).rejects.toMatchObject({
        name: 'AbortError',
      });
    } finally {
      Object.defineProperty(globalThis, 'XMLHttpRequest', {
        configurable: true,
        writable: true,
        value: OriginalXhr,
      });
    }
  });

  it('validates login/change-password/reauth errors with Vietnamese messages and aria-invalid field state', async () => {
    const user = userEvent.setup();

    // Unit checks on new error code mappings and context-sensitive Vietnamese server messages
    expect(mapErrorCodeToVietnamese('file_not_found', 404)).toMatch(
      /Không tìm thấy tệp/,
    );
    expect(mapErrorCodeToVietnamese('model_unavailable', 503)).toMatch(
      /Mô hình AI hiện không khả dụng/,
    );
    expect(mapErrorCodeToVietnamese('retry_case_deleted', 409)).toMatch(
      /ca chụp liên quan đã bị xóa/,
    );
    expect(mapErrorCodeToVietnamese('invalid_signature', 401)).toMatch(
      /Chữ ký phiên xác thực không hợp lệ/,
    );
    expect(
      mapErrorCodeToVietnamese(
        'invalid_credentials',
        400,
        'Mật khẩu hiện tại không chính xác.',
      ),
    ).toBe('Mật khẩu hiện tại không chính xác.');
    expect(
      parseErrorEnvelope({ detail: 'Lỗi cấu hình tạm thời.' }, 502, 'req-502')
        .userMessage,
    ).toBe('Lỗi cấu hình tạm thời.');
    expect(parseErrorEnvelope({}, 504, 'req-504').userMessage).toMatch(
      /cổng kết nối/,
    );

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = healthResponseIfMatched(url);
      if (health) return health;
      if (url.endsWith('/api/v1/auth/login')) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'rate_limit_exceeded',
              message: 'Too many requests',
              details: null,
              request_id: 'req-login-429',
            },
          }),
          {
            status: 429,
            headers: {
              'Content-Type': 'application/json',
              'Retry-After': '45',
            },
          },
        );
      }
      if (url.endsWith('/api/v1/auth/change-password')) {
        return new Response(
          JSON.stringify({
            error: {
              code: 'invalid_credentials',
              message: 'Mật khẩu hiện tại không chính xác.',
              details: null,
              request_id: 'req-cp-wrong',
            },
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return jsonResponse({});
    });

    // 1. Login empty submit + 429 Retry-After
    const loginView = renderWithApp(['/login']);
    await user.click(screen.getByRole('button', { name: 'Đăng nhập' }));
    expect(screen.getByText('Vui lòng nhập tên đăng nhập.')).toBeInTheDocument();
    expect(screen.getByText('Vui lòng nhập mật khẩu.')).toBeInTheDocument();
    expect(screen.getByLabelText(/Tên đăng nhập/)).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByLabelText(/^Mật khẩu/)).toHaveAttribute(
      'aria-invalid',
      'true',
    );

    await user.type(screen.getByLabelText(/Tên đăng nhập/), 'bs.minh');
    await user.type(screen.getByLabelText(/^Mật khẩu/), 'wrong-password-123');
    await user.click(screen.getByRole('button', { name: 'Đăng nhập' }));

    expect(
      await screen.findByText('Tạm giới hạn đăng nhập'),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Vui lòng đợi khoảng 45 giây trước khi thử đăng nhập lại/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Mã yêu cầu: req-login-429/)).toBeInTheDocument();
    loginView.unmount();

    // 2. ChangePasswordPage maps 400 invalid_credentials accurately to current_password
    useAuthStore.setState({
      status: 'must_change_password',
      user: { ...DOCTOR_USER, must_change_password: true },
      accessToken: 'temp-jwt-cp',
      fixtureMode: false,
    });
    const cpView = renderWithApp(['/change-password']);
    await user.type(screen.getByLabelText(/Mật khẩu hiện tại/), 'wrong-current-pass');
    await user.type(screen.getByLabelText(/^Mật khẩu mới/), 'ValidNewPass1234!');
    await user.type(screen.getByLabelText(/Nhập lại mật khẩu mới/), 'ValidNewPass1234!');
    await user.click(screen.getByRole('button', { name: 'Lưu mật khẩu mới' }));

    const matches = await screen.findAllByText(
      'Mật khẩu hiện tại không chính xác.',
    );
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByLabelText(/Mật khẩu hiện tại/)).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByText(/Mã yêu cầu: req-cp-wrong/)).toBeInTheDocument();
    cpView.unmount();
  });
});
