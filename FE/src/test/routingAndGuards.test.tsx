import { QueryClient } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerTrackedObjectUrl,
  useAuthStore,
} from '@/app/auth-store';
import { AppProviders } from '@/app/providers';
import { AppRoutes } from '@/app/router';
import { FIXTURE_USERS } from '@/shared/api/fixtures';
import {
  createAppQueryClient,
  queryClient as singletonQueryClient,
} from '@/shared/api/queryClient';
import { useViewerStore } from '@/viewer-adapter';

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

function renderAppAt(
  initialEntries: string[],
  client = createTestQueryClient(),
) {
  return {
    client,
    ...render(
      <AppProviders client={client} autoBootstrap={false}>
        <MemoryRouter initialEntries={initialEntries}>
          <AppRoutes />
        </MemoryRouter>
      </AppProviders>,
    ),
  };
}

function HistoryHarness() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <div>
      <output data-testid="router-location">
        {location.pathname + location.search}
      </output>
      <button type="button" onClick={() => navigate(-1)}>
        Test Back
      </button>
      <button type="button" onClick={() => navigate(1)}>
        Test Forward
      </button>
    </div>
  );
}

function setViewportWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', {
    writable: true,
    configurable: true,
    value: width,
  });
  window.dispatchEvent(new Event('resize'));
}

function createMockHealthResponse(url: string): Response | null {
  if (url.includes('/health/live')) {
    return new Response(
      JSON.stringify({
        status: 'ok',
        service: 'brain-tumor-api',
        environment: 'local',
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }
  if (url.includes('/health/ready')) {
    return new Response(
      JSON.stringify({
        status: 'ready',
        checks: { database: 'ok', storage: 'ok' },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }
  return null;
}

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonError(code: string, requestId: string, status = 500): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message: 'Backend error',
        details: null,
        request_id: requestId,
      },
    }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

describe('Routing, Role Guards, Auth Bootstrap, AbortError & Responsive Viewer', () => {
  beforeEach(() => {
    singletonQueryClient.clear();
    useViewerStore.getState().resetViewerState();
    useAuthStore.setState({
      status: 'anonymous',
      user: null,
      accessToken: null,
      bootstrapError: null,
      fixtureMode: true,
    });
    setViewportWidth(1280);
  });

  it('waits during auth bootstrapping without flashing protected doctor content or redirecting prematurely', () => {
    useAuthStore.setState({
      status: 'bootstrapping',
      user: null,
      accessToken: null,
      bootstrapError: null,
      fixtureMode: false,
    });

    renderAppAt(['/doctor/patients']);

    expect(
      screen.getByText('Đang kiểm tra phiên đăng nhập...'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Danh sách bệnh nhân')).not.toBeInTheDocument();
    expect(screen.queryByText('Đăng nhập hệ thống')).not.toBeInTheDocument();
  });

  it('redirects anonymous users to /login and must_change_password users to /change-password', () => {
    const anonView = renderAppAt(['/doctor/patients']);
    expect(
      screen.getByRole('heading', { name: 'Đăng nhập hệ thống' }),
    ).toBeInTheDocument();
    anonView.unmount();

    useAuthStore.setState({
      status: 'must_change_password',
      user: { ...FIXTURE_USERS.doctor, must_change_password: true },
      accessToken: 'tok',
      fixtureMode: true,
    });

    renderAppAt(['/doctor/patients']);
    expect(
      screen.getByRole('heading', { name: 'Đổi mật khẩu tài khoản' }),
    ).toBeInTheDocument();
  });

  it('blocks Doctor from /admin/* (403) and blocks Admin from /doctor/* (403) with role-safe back link', () => {
    useAuthStore.setState({
      status: 'authenticated',
      user: FIXTURE_USERS.doctor,
      accessToken: 'doc-tok',
      fixtureMode: true,
    });

    const { unmount } = renderAppAt(['/admin/users']);
    expect(screen.getByText('Không có quyền truy cập')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Quay lại khu vực Bác sĩ' }),
    ).toHaveAttribute('href', '/doctor');
    unmount();

    useAuthStore.setState({
      status: 'authenticated',
      user: FIXTURE_USERS.admin,
      accessToken: 'admin-tok',
      fixtureMode: true,
    });

    renderAppAt(['/doctor/patients']);
    expect(screen.getByText('Không có quyền truy cập')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Quay lại khu vực Quản trị' }),
    ).toHaveAttribute('href', '/admin');
  });

  it('Admin shell strictly excludes any navigation links to patient data or MRI viewer', () => {
    useAuthStore.setState({
      status: 'authenticated',
      user: FIXTURE_USERS.admin,
      accessToken: 'admin-tok',
      fixtureMode: true,
    });

    renderAppAt(['/admin']);
    expect(
      screen.getByRole('heading', { name: 'Tổng quan vận hành hệ thống' }),
    ).toBeInTheDocument();

    const links = screen.getAllByRole('link');
    for (const link of links) {
      const href = link.getAttribute('href') ?? '';
      expect(href).not.toContain('/doctor');
      expect(href).not.toContain('patients');
      expect(href).not.toContain('viewer');
    }
  });

  it('supports deep linking across all Doctor and Admin routes and renders 404 for unknown routes', async () => {
    useAuthStore.setState({
      status: 'authenticated',
      user: FIXTURE_USERS.doctor,
      accessToken: 'doc-tok',
      fixtureMode: true,
    });

    const doctorRoutes = [
      { path: '/doctor', heading: 'Tổng quan ca chụp của tôi' },
      { path: '/doctor/patients', heading: 'Danh sách bệnh nhân' },
      {
        path: '/doctor/patients/10000000-0000-4000-8000-000000000001',
        heading: 'Trần Văn An (Mẫu)',
      },
      {
        path: '/doctor/cases/20000000-0000-4000-8000-000000000001',
        heading: 'Ca chụp ngày 15/05/2026',
      },
      { path: '/doctor/profile', heading: 'Tài khoản cá nhân' },
    ];

    for (const item of doctorRoutes) {
      const view = renderAppAt([item.path]);
      expect(
        await screen.findByRole('heading', { name: item.heading }),
      ).toBeInTheDocument();
      view.unmount();
    }

    const notFoundView = renderAppAt(['/unknown/path']);
    expect(
      screen.getByRole('heading', { name: 'Không tìm thấy trang yêu cầu' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'Quay lại khu vực Bác sĩ' }),
    ).toHaveAttribute('href', '/doctor');
    notFoundView.unmount();

    useAuthStore.setState({
      status: 'authenticated',
      user: FIXTURE_USERS.admin,
      accessToken: 'admin-tok',
      fixtureMode: true,
    });

    const adminRoutes = [
      { path: '/admin', heading: 'Tổng quan vận hành hệ thống' },
      { path: '/admin/users', heading: 'Quản lý tài khoản bác sĩ' },
      { path: '/admin/jobs', heading: 'Quản lý tác vụ AI' },
      { path: '/admin/settings', heading: 'Cấu hình vận hành & Mô hình' },
      { path: '/admin/audit-events', heading: 'Nhật ký sự kiện quản trị' },
    ];

    for (const item of adminRoutes) {
      const view = renderAppAt([item.path]);
      expect(
        await screen.findByRole('heading', { name: item.heading }),
      ).toBeInTheDocument();
      view.unmount();
    }
  });

  it('keeps ToastProvider mounted during route transition and suppresses error toast on AbortError', async () => {
    const user = userEvent.setup();
    useAuthStore.setState({
      status: 'authenticated',
      user: FIXTURE_USERS.doctor,
      accessToken: 'doc-tok',
      fixtureMode: false,
    });

    let abortedSignalObserved = false;

    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const healthRes = createMockHealthResponse(url);
      if (healthRes) {
        return Promise.resolve(healthRes);
      }
      if (url.includes('/patients')) {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            abortedSignalObserved = true;
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }
      if (url.includes('/cases')) {
        return Promise.resolve(
          jsonOk({ items: [], total: 0, page: 1, page_size: 20 }),
        );
      }
      return Promise.resolve(jsonOk({}));
    });

    renderAppAt(['/doctor/patients']);

    expect(
      screen.getByRole('status', { name: 'Đang tải danh sách' }),
    ).toBeInTheDocument();

    // Navigate inside mounted AppProviders/ToastProvider/AppShell via sidebar link
    await user.click(screen.getByRole('link', { name: 'Tổng quan ca' }));

    expect(
      await screen.findByRole('heading', { name: 'Tổng quan ca chụp của tôi' }),
    ).toBeInTheDocument();
    expect(abortedSignalObserved).toBe(true);
    expect(
      screen.queryByText('Không thể tải danh sách bệnh nhân'),
    ).not.toBeInTheDocument();
  });

  it('verifies loading, empty, and error (request_id) states across Doctor & Admin list/detail pages', async () => {
    const scenarios = [
      {
        role: 'doctor' as const,
        path: '/doctor',
        loadingTest: () =>
          expect(
            screen.getByRole('status', { name: 'Đang tải danh sách' }),
          ).toBeInTheDocument(),
        emptyText: 'Chưa có ca chụp nào',
        emptyPayload: { items: [], total: 0, page: 1, page_size: 20 },
        requestId: 'req-doc-overview-500',
      },
      {
        role: 'doctor' as const,
        path: '/doctor/patients/pat-1',
        loadingTest: () =>
          expect(
            screen.getByRole('status', { name: 'Đang tải thông tin' }),
          ).toBeInTheDocument(),
        emptyText: 'Chưa có ca chụp nào',
        emptyPayload: (url: string) =>
          url.endsWith('/cases')
            ? { items: [], total: 0, page: 1, page_size: 20 }
            : {
                id: 'pat-1',
                patient_code: 'BN-001',
                full_name: 'Bệnh nhân Test',
                birth_year: 1980,
                sex: 'female',
                owner_id: FIXTURE_USERS.doctor.id,
                created_at: '2026-05-01T00:00:00Z',
                updated_at: '2026-05-01T00:00:00Z',
              },
        requestId: 'req-patient-detail-500',
      },
      {
        role: 'admin' as const,
        path: '/admin/users',
        loadingTest: () =>
          expect(
            screen.getByRole('status', { name: 'Đang tải danh sách' }),
          ).toBeInTheDocument(),
        emptyText: 'Chưa có tài khoản bác sĩ phù hợp',
        emptyPayload: { items: [], total: 0, page: 1, page_size: 20 },
        requestId: 'req-admin-users-500',
      },
      {
        role: 'admin' as const,
        path: '/admin/jobs',
        loadingTest: () =>
          expect(
            screen.getByRole('status', { name: 'Đang tải danh sách' }),
          ).toBeInTheDocument(),
        emptyText: 'Chưa có tác vụ nào',
        emptyPayload: { items: [], total: 0, page: 1, page_size: 20 },
        requestId: 'req-admin-jobs-500',
      },
      {
        role: 'admin' as const,
        path: '/admin/audit-events',
        loadingTest: () =>
          expect(
            screen.getByRole('status', { name: 'Đang tải danh sách' }),
          ).toBeInTheDocument(),
        emptyText: 'Chưa có sự kiện nào',
        emptyPayload: { items: [], total: 0, page: 1, page_size: 20 },
        requestId: 'req-admin-audit-500',
      },
    ];

    for (const scenario of scenarios) {
      useAuthStore.setState({
        status: 'authenticated',
        user: FIXTURE_USERS[scenario.role],
        accessToken: 'tok',
        fixtureMode: false,
      });

      // 1. Loading state (pending request)
      const fetchMock = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation((input) => {
          const url = typeof input === 'string' ? input : input.toString();
          const healthRes = createMockHealthResponse(url);
          if (healthRes) return Promise.resolve(healthRes);
          return new Promise(() => {});
        });

      const loadingView = renderAppAt([scenario.path]);
      scenario.loadingTest();
      loadingView.unmount();

      // 2. Empty state
      fetchMock.mockImplementation((input) => {
        const url = typeof input === 'string' ? input : input.toString();
        const healthRes = createMockHealthResponse(url);
        if (healthRes) return Promise.resolve(healthRes);
        const payload =
          typeof scenario.emptyPayload === 'function'
            ? scenario.emptyPayload(url)
            : scenario.emptyPayload;
        return Promise.resolve(jsonOk(payload));
      });

      const emptyView = renderAppAt([scenario.path]);
      expect(await screen.findByText(scenario.emptyText)).toBeInTheDocument();
      emptyView.unmount();

      // 3. Error state with request_id
      fetchMock.mockImplementation((input) => {
        const url = typeof input === 'string' ? input : input.toString();
        const healthRes = createMockHealthResponse(url);
        if (healthRes) return Promise.resolve(healthRes);
        return Promise.resolve(jsonError('internal_error', scenario.requestId, 500));
      });

      const errorView = renderAppAt([scenario.path]);
      expect(await screen.findByText(scenario.requestId)).toBeInTheDocument();
      errorView.unmount();

      fetchMock.mockRestore();
    }
  });

  it('synchronizes search/status/pagination URL query params and restores them on Back/Forward', async () => {
    const user = userEvent.setup();
    useAuthStore.setState({
      status: 'authenticated',
      user: FIXTURE_USERS.admin,
      accessToken: 'admin-tok',
      fixtureMode: false,
    });

    const requestedUrls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input.toString();
      const healthRes = createMockHealthResponse(url);
      if (healthRes) return Promise.resolve(healthRes);
      requestedUrls.push(url);
      const parsed = new URL(url, 'http://127.0.0.1');
      const page = Number(parsed.searchParams.get('page') ?? '1');
      return Promise.resolve(
        jsonOk({
          items: [
            {
              id: `u-${page}`,
              username: `bs.page${page}`,
              display_name: `Bác sĩ trang ${page}`,
              role: 'doctor',
              is_active: true,
              must_change_password: false,
              created_at: '2026-05-01T00:00:00Z',
              updated_at: '2026-05-01T00:00:00Z',
            },
          ],
          total: 45,
          page,
          page_size: 20,
        }),
      );
    });

    const client = createTestQueryClient();
    render(
      <AppProviders client={client} autoBootstrap={false}>
        <MemoryRouter initialEntries={['/admin/users']}>
          <HistoryHarness />
          <AppRoutes />
        </MemoryRouter>
      </AppProviders>,
    );

    expect(
      await screen.findByText('Trang 1 / 3'),
    ).toBeInTheDocument();

    // Change status filter (push history entry)
    await user.selectOptions(
      screen.getByLabelText('Lọc trạng thái tài khoản'),
      'locked',
    );
    await waitFor(() => {
      expect(screen.getByTestId('router-location')).toHaveTextContent(
        '/admin/users?status=locked',
      );
    });

    // Change pagination to page 2 (push history entry)
    await user.click(screen.getByRole('button', { name: 'Trang sau' }));
    await waitFor(() => {
      expect(screen.getByTestId('router-location')).toHaveTextContent(
        '/admin/users?status=locked&page=2',
      );
    });
    expect(await screen.findByText('Trang 2 / 3')).toBeInTheDocument();

    // Enter search query (300ms debounce)
    const searchBox = screen.getByLabelText('Tìm theo username hoặc tên hiển thị');
    await user.type(searchBox, 'minh');
    await waitFor(() => {
      expect(screen.getByTestId('router-location')).toHaveTextContent(
        'q=minh',
      );
    });

    // Back restores previous URL state (page 1 / status=locked without q)
    await user.click(screen.getByRole('button', { name: 'Test Back' }));
    await waitFor(() => {
      expect(screen.getByTestId('router-location')).toHaveTextContent(
        '/admin/users?status=locked',
      );
    });
    expect(screen.getByLabelText('Lọc trạng thái tài khoản')).toHaveValue(
      'locked',
    );

    // Forward restores page 2 & query
    await user.click(screen.getByRole('button', { name: 'Test Forward' }));
    await waitFor(() => {
      expect(screen.getByTestId('router-location')).toHaveTextContent(
        'q=minh',
      );
    });
    expect(
      requestedUrls.some((u) => u.includes('/admin/users') && u.includes('status=locked')),
    ).toBe(true);
  });

  it('lazy-loads viewer, enforces <1024px read-only mode, and resets out-of-bounds slice input at boundary slices', async () => {
    const user = userEvent.setup();
    useAuthStore.setState({
      status: 'authenticated',
      user: FIXTURE_USERS.doctor,
      accessToken: 'doc-tok',
      fixtureMode: true,
    });

    setViewportWidth(768);
    renderAppAt(['/doctor/cases/20000000-0000-4000-8000-000000000001/viewer']);

    expect(
      await screen.findByRole('heading', {
        name: 'Trình xem & chỉnh sửa Mask MRI',
      }),
    ).toBeInTheDocument();

    expect(screen.getByText('Chế độ chỉ đọc')).toBeInTheDocument();
    expect(
      screen.getByText(
        /Công cụ chỉnh sửa mask chỉ mở trên màn hình desktop từ 1024 px trở lên/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tô mask' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Xóa mask' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Lưu phiên bản' })).toBeDisabled();

    // Out-of-bounds input while at boundary slice 1 resets back to '1'
    const sliceInput = screen.getByLabelText('Số lát:') as HTMLInputElement;
    expect(sliceInput.value).toBe('1');
    await user.clear(sliceInput);
    await user.type(sliceInput, '-5{Enter}');
    expect(sliceInput.value).toBe('1');

    // Jump to slice 155, then enter 999 -> resets cleanly to '155'
    await user.clear(sliceInput);
    await user.type(sliceInput, '155{Enter}');
    expect(sliceInput.value).toBe('155');
    await user.clear(sliceInput);
    await user.type(sliceInput, '999{Enter}');
    expect(sliceInput.value).toBe('155');

    // Slice navigation button works in read-only mode
    const prevBtn = screen.getByRole('button', { name: 'Lát trước' });
    expect(prevBtn).toBeEnabled();
    await user.click(prevBtn);
    expect(screen.getByText('Lát 154 / 155')).toBeInTheDocument();

    // Resizing to desktop >= 1024px unlocks editing controls
    act(() => {
      setViewportWidth(1280);
    });
    expect(screen.getByText('Chế độ chỉnh sửa')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tô mask' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Xóa mask' })).toBeEnabled();
  });

  it('clears singleton query cache, viewer state, and object URLs on logout even if POST /auth/logout fails', async () => {
    const revokeSpy = vi.fn();
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: revokeSpy,
    });

    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('Network unreachable'));

    // Seed real query cache entry and viewer draft state before logout
    singletonQueryClient.setQueryData(
      ['doctor', FIXTURE_USERS.doctor.id, 'patients'],
      { items: [{ id: 'p-1' }], total: 1, page: 1, page_size: 20 },
    );
    expect(singletonQueryClient.getQueryCache().getAll().length).toBe(1);

    registerTrackedObjectUrl('blob:http://127.0.0.1:5173/test-volume');
    useViewerStore.getState().setDirty(true);
    useViewerStore.getState().setSliceIndex(42);

    useAuthStore.setState({
      status: 'authenticated',
      user: FIXTURE_USERS.doctor,
      accessToken: 'doc-tok',
      fixtureMode: false,
    });

    await useAuthStore.getState().logout();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/auth/logout',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(singletonQueryClient.getQueryCache().getAll().length).toBe(0);
    expect(revokeSpy).toHaveBeenCalledWith(
      'blob:http://127.0.0.1:5173/test-volume',
    );
    expect(useAuthStore.getState().status).toBe('anonymous');
    expect(useAuthStore.getState().accessToken).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().logoutSyncPending).toBe(true);
    expect(useAuthStore.getState().authNotice?.variant).toBe('warning');
    expect(useViewerStore.getState().isDirty).toBe(false);
    expect(useViewerStore.getState().currentSliceZeroBased).toBe(0);

    // Retrying server logout from LoginPage resolves warning once server returns 204
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const user = userEvent.setup();
    renderAppAt(['/login']);
    expect(
      await screen.findByText('Chưa thể xác nhận đăng xuất với máy chủ'),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Thử thu hồi phiên trên máy chủ' }),
    );
    expect(
      await screen.findByText('Đã thu hồi phiên trên máy chủ'),
    ).toBeInTheDocument();
    expect(useAuthStore.getState().logoutSyncPending).toBe(false);
  });

  it('guards sidebar NavLink clicks with ConfirmDialog when viewer has unsaved mask draft (isDirty)', async () => {
    const user = userEvent.setup();
    useAuthStore.setState({
      status: 'authenticated',
      user: FIXTURE_USERS.doctor,
      accessToken: 'doc-tok',
      fixtureMode: true,
    });

    renderAppAt(['/doctor/cases/20000000-0000-4000-8000-000000000001']);
    expect(
      await screen.findByRole('heading', { name: 'Ca chụp ngày 15/05/2026' }),
    ).toBeInTheDocument();

    useViewerStore.getState().setDirty(true);

    // Click sidebar NavLink "Bệnh nhân" while dirty -> blocked by ConfirmDialog
    await user.click(screen.getByRole('link', { name: 'Bệnh nhân' }));
    const confirmLeave = await screen.findByRole('alertdialog', {
      name: 'Xác nhận bỏ thay đổi và rời trang',
    });
    expect(confirmLeave).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { name: 'Ca chụp ngày 15/05/2026' }),
    ).toBeInTheDocument();

    // Cancel keeps user on current page and preserves dirty flag
    await user.click(screen.getByRole('button', { name: 'Quay lại để lưu' }));
    expect(useViewerStore.getState().isDirty).toBe(true);
    expect(
      screen.getByRole('heading', { name: 'Ca chụp ngày 15/05/2026' }),
    ).toBeInTheDocument();

    // Click again and confirm -> resets dirty flag and navigates to /doctor/patients
    await user.click(screen.getByRole('link', { name: 'Bệnh nhân' }));
    await screen.findByRole('alertdialog', {
      name: 'Xác nhận bỏ thay đổi và rời trang',
    });
    await user.click(
      screen.getByRole('button', { name: 'Bỏ thay đổi và rời trang' }),
    );

    expect(
      await screen.findByRole('heading', { name: 'Danh sách bệnh nhân' }),
    ).toBeInTheDocument();
    expect(useViewerStore.getState().isDirty).toBe(false);
  });
});
