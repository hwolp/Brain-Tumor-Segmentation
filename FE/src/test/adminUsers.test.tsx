import { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/app/auth-store';
import { AppProviders } from '@/app/providers';
import { AppRoutes } from '@/app/router';
import { FIXTURE_USERS } from '@/shared/api/fixtures';
import { createAppQueryClient } from '@/shared/api/queryClient';
import type { AdminDoctorUserDto } from '@/shared/api/types';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(
  status: number,
  code: string,
  requestId: string,
  message = 'Error',
): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message,
        details: null,
        request_id: requestId,
      },
    }),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': requestId,
      },
    },
  );
}

function createTestClient(): QueryClient {
  const client = createAppQueryClient();
  client.setDefaultOptions({
    queries: { retry: false, gcTime: 0 },
  });
  return client;
}

function renderAdminUsers(client = createTestClient()) {
  return {
    client,
    ...render(
      <AppProviders client={client} autoBootstrap={false}>
        <MemoryRouter initialEntries={['/admin/users']}>
          <AppRoutes />
        </MemoryRouter>
      </AppProviders>,
    ),
  };
}

describe('P2 Admin Doctor Accounts Management UI', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    useAuthStore.setState({
      status: 'authenticated',
      user: { ...FIXTURE_USERS.admin, must_change_password: false },
      accessToken: 'admin-jwt-token',
      bootstrapError: null,
      fixtureMode: false,
      reauthRequired: false,
    });
  });

  it('loads doctor list, creates a doctor with conflict handling (409 preserves form) & one-time copyable password, edits display name, locks/unlocks with confirm & refetch, and resets temporary password', async () => {
    const user = userEvent.setup();
    const writeTextSpy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: { writeText: writeTextSpy },
    });

    let usersDb: AdminDoctorUserDto[] = [
      {
        id: 'doc-1',
        username: 'bs.minh',
        display_name: 'BS. Nguyễn Hoàng Minh',
        role: 'doctor',
        is_active: true,
        must_change_password: false,
        created_at: '2026-05-01T08:00:00Z',
        updated_at: '2026-05-01T08:00:00Z',
      },
    ];

    let createAttempts = 0;
    let capturedCreateBody: Record<string, unknown> | null = null;
    let capturedPatchBodies: Array<{ url: string; body: Record<string, unknown> }> = [];
    let listFetchCount = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.includes('/health/live')) {
        return jsonResponse({ status: 'ok', service: 'brain-tumor-api', environment: 'test' });
      }
      if (url.includes('/health/ready')) {
        return jsonResponse({
          status: 'ready',
          checks: { database: 'ok', storage: 'ok' },
        });
      }

      if (url.includes('/api/v1/admin/users') && method === 'GET') {
        listFetchCount += 1;
        return jsonResponse({
          items: usersDb,
          total: usersDb.length,
          page: 1,
          page_size: 20,
        });
      }

      if (url.endsWith('/api/v1/admin/users') && method === 'POST') {
        createAttempts += 1;
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        capturedCreateBody = body;

        if (createAttempts === 1) {
          return errorResponse(409, 'username_conflict', 'req-create-409');
        }

        const created: AdminDoctorUserDto = {
          id: 'doc-2',
          username: String(body.username),
          display_name: String(body.display_name),
          role: 'doctor',
          is_active: true,
          must_change_password: true,
          created_at: '2026-05-15T10:00:00Z',
          updated_at: '2026-05-15T10:00:00Z',
        };
        usersDb = [...usersDb, created];
        return jsonResponse(created, 201);
      }

      if (url.endsWith('/reset-password') && method === 'POST') {
        usersDb = usersDb.map((u) =>
          u.id === 'doc-1' ? { ...u, must_change_password: true } : u,
        );
        return jsonResponse({ temporary_password: 'ResetTempPassword 2026!' });
      }

      if (url.includes('/api/v1/admin/users/') && method === 'PATCH') {
        const id = url.split('/').pop() ?? '';
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        capturedPatchBodies.push({ url, body });

        let updatedRow: AdminDoctorUserDto | undefined;
        usersDb = usersDb.map((u) => {
          if (u.id !== id) return u;
          updatedRow = {
            ...u,
            display_name:
              typeof body.display_name === 'string'
                ? body.display_name
                : u.display_name,
            is_active:
              typeof body.is_active === 'boolean' ? body.is_active : u.is_active,
          };
          return updatedRow;
        });
        return jsonResponse(updatedRow);
      }

      return jsonResponse({});
    });

    const { client } = renderAdminUsers();

    expect(await screen.findByText('bs.minh')).toBeInTheDocument();
    expect(screen.getByText('BS. Nguyễn Hoàng Minh')).toBeInTheDocument();
    // Ensure no delete button and no admin role switcher exist
    expect(screen.queryByRole('button', { name: /Xóa/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Chuyển thành Admin/i)).not.toBeInTheDocument();

    // 1. Open Create Doctor Modal & test 409 username_conflict retains form values
    await user.click(screen.getByRole('button', { name: 'Tạo tài khoản bác sĩ' }));
    const createDialog = await screen.findByRole('dialog', {
      name: 'Tạo tài khoản bác sĩ',
    });

    const usernameField = within(createDialog).getByLabelText(/Tên đăng nhập/);
    const displayNameField = within(createDialog).getByLabelText(/Họ và tên hiển thị/);
    const tempPassField = within(createDialog).getByLabelText(/Mật khẩu tạm ban đầu/);

    // Client-side validation: invalid username & short password (< 12 chars)
    await user.type(usernameField, 'BS INV!');
    await user.type(displayNameField, 'BS. Lê Thị Hoa');
    await user.type(tempPassField, 'short-pass');
    await user.click(within(createDialog).getByRole('button', { name: 'Tạo tài khoản' }));
    expect(
      within(createDialog).getByText(/Tên đăng nhập phải dài 3–64 ký tự/),
    ).toBeInTheDocument();
    expect(
      within(createDialog).getByText(/Mật khẩu tạm phải từ 12 đến 128 ký tự/),
    ).toBeInTheDocument();
    expect(createAttempts).toBe(0);

    const tempPassWithSpaces = ' MatKhauTam 1234 ';
    await user.clear(usernameField);
    await user.type(usernameField, 'bs.minh');
    await user.clear(tempPassField);
    await user.type(tempPassField, tempPassWithSpaces);
    await user.click(within(createDialog).getByRole('button', { name: 'Tạo tài khoản' }));

    const conflictMessages = await within(createDialog).findAllByText(
      /Tên đăng nhập đã tồn tại trong hệ thống/,
    );
    expect(conflictMessages).toHaveLength(1);
    expect(usernameField).toHaveAttribute('aria-invalid', 'true');
    const createReqIdEl = within(createDialog).getByText(/req-create-409/);
    expect(createReqIdEl).toBeInTheDocument();
    expect(createReqIdEl).toHaveClass('sr-only');
    expect(usernameField).toHaveValue('bs.minh');
    expect(displayNameField).toHaveValue('BS. Lê Thị Hoa');
    expect(tempPassField).toHaveValue(tempPassWithSpaces);

    // Fix username & submit again -> 201, refetch list, and open One-Time Password Modal
    await user.clear(usernameField);
    await user.type(usernameField, 'bs.hoa');
    await user.click(within(createDialog).getByRole('button', { name: 'Tạo tài khoản' }));

    const oneTimeModal = await screen.findByRole('dialog', {
      name: /Đã tạo tài khoản bác sĩ — Mật khẩu tạm một lần/,
    });
    expect(capturedCreateBody).toEqual({
      username: 'bs.hoa',
      display_name: 'BS. Lê Thị Hoa',
      temporary_password: tempPassWithSpaces,
    });
    expect(
      within(oneTimeModal).getByTestId('one-time-temp-password'),
    ).toHaveTextContent('MatKhauTam 1234');

    await user.click(
      within(oneTimeModal).getByRole('button', { name: 'Sao chép mật khẩu tạm' }),
    );
    expect(writeTextSpy).toHaveBeenCalledWith(tempPassWithSpaces);

    // Secret must never persist to storage, Query cache, or Mutation cache
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(JSON.stringify(client.getQueryCache().getAll())).not.toContain(
      tempPassWithSpaces,
    );
    expect(JSON.stringify(client.getMutationCache().getAll())).not.toContain(
      tempPassWithSpaces,
    );

    await user.click(
      within(oneTimeModal).getByRole('button', { name: 'Đã ghi nhận, đóng hộp thoại' }),
    );
    expect(await screen.findByText('bs.hoa')).toBeInTheDocument();

    // 2. Edit display name
    const rowMinh = screen.getByText('bs.minh').closest('tr')!;
    await user.click(within(rowMinh).getByRole('button', { name: 'Sửa tên' }));
    const editDialog = await screen.findByRole('dialog', {
      name: 'Chỉnh sửa tên hiển thị bác sĩ',
    });
    const editInput = within(editDialog).getByLabelText(/Họ và tên hiển thị/);
    await user.clear(editInput);
    await user.type(editInput, 'BS. Nguyễn Minh (Đã cập nhật)');
    await user.click(within(editDialog).getByRole('button', { name: 'Lưu thay đổi' }));

    expect(
      await screen.findByText('BS. Nguyễn Minh (Đã cập nhật)'),
    ).toBeInTheDocument();
    expect(capturedPatchBodies[0]?.body).toEqual({
      display_name: 'BS. Nguyễn Minh (Đã cập nhật)',
    });

    // 3. Lock account with ConfirmDialog + refetch
    const fetchCountBeforeLock = listFetchCount;
    const rowMinhUpdated = screen.getByText('bs.minh').closest('tr')!;
    await user.click(within(rowMinhUpdated).getByRole('button', { name: 'Khóa' }));

    const lockDialog = await screen.findByRole('alertdialog', {
      name: 'Xác nhận khóa tài khoản bác sĩ',
    });
    expect(
      within(lockDialog).getByText(
        /thu hồi ngay mọi phiên đăng nhập của bác sĩ\. Toàn bộ hồ sơ bệnh nhân vẫn được giữ nguyên\./,
      ),
    ).toBeInTheDocument();
    await user.click(
      within(lockDialog).getByRole('button', { name: 'Khóa tài khoản' }),
    );

    await waitFor(() => {
      expect(listFetchCount).toBeGreaterThan(fetchCountBeforeLock);
    });
    const rowMinhLocked = screen.getByText('bs.minh').closest('tr')!;
    expect(within(rowMinhLocked).getByText('Đã khóa')).toBeInTheDocument();

    // Unlock account
    await user.click(within(rowMinhLocked).getByRole('button', { name: 'Mở khóa' }));
    const unlockDialog = await screen.findByRole('alertdialog', {
      name: 'Xác nhận mở khóa tài khoản bác sĩ',
    });
    await user.click(
      within(unlockDialog).getByRole('button', { name: 'Mở khóa tài khoản' }),
    );
    await waitFor(() => {
      const row = screen.getByText('bs.minh').closest('tr')!;
      expect(within(row).getByText('Hoạt động')).toBeInTheDocument();
    });

    // 4. Reset temporary password -> ConfirmDialog -> one-time password modal
    const rowMinhActive = screen.getByText('bs.minh').closest('tr')!;
    await user.click(
      within(rowMinhActive).getByRole('button', { name: 'Đặt lại mật khẩu' }),
    );
    const resetConfirm = await screen.findByRole('alertdialog', {
      name: 'Xác nhận đặt lại mật khẩu tạm',
    });
    expect(
      within(resetConfirm).getByText(
        /Mọi phiên đang mở của bác sĩ @bs\.minh sẽ bị thu hồi ngay lập tức/,
      ),
    ).toBeInTheDocument();
    await user.click(
      within(resetConfirm).getByRole('button', { name: 'Đặt lại mật khẩu' }),
    );

    const resetSecretModal = await screen.findByRole('dialog', {
      name: /Đã đặt lại mật khẩu tạm — Hiển thị một lần/,
    });
    expect(
      within(resetSecretModal).getByTestId('one-time-temp-password'),
    ).toHaveTextContent('ResetTempPassword 2026!');

    await user.click(
      within(resetSecretModal).getByRole('button', { name: 'Sao chép mật khẩu tạm' }),
    );
    expect(writeTextSpy).toHaveBeenCalledWith('ResetTempPassword 2026!');

    // Reset secret must never enter MutationCache or QueryCache either
    expect(JSON.stringify(client.getMutationCache().getAll())).not.toContain(
      'ResetTempPassword 2026!',
    );
    expect(JSON.stringify(client.getQueryCache().getAll())).not.toContain(
      'ResetTempPassword 2026!',
    );

    // When clipboard API is unavailable, do NOT report copied success
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    await user.click(
      within(resetSecretModal).getByRole('button', { name: /Đã sao chép|Sao chép mật khẩu tạm/ }),
    );
    expect(
      screen.getByText('Trình duyệt không hỗ trợ tự động sao chép'),
    ).toBeInTheDocument();
    expect(
      within(resetSecretModal).getByRole('button', { name: 'Sao chép mật khẩu tạm' }),
    ).toBeInTheDocument();
  });
});
