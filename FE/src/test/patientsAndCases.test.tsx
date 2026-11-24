import { QueryClient } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/app/auth-store';
import { AppProviders } from '@/app/providers';
import { AppRoutes } from '@/app/router';
import { FIXTURE_USERS } from '@/shared/api/fixtures';
import { createAppQueryClient } from '@/shared/api/queryClient';
import type { CaseDto, PatientDto, VolumeDto } from '@/shared/api/types';

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

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(
  code: string,
  requestId: string,
  status: number,
  message = 'Lỗi máy chủ',
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
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

function createHealthResponse(url: string): Response | null {
  if (url.includes('/health/live')) {
    return jsonResponse({
      status: 'ok',
      service: 'brain-tumor-api',
      environment: 'local',
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

interface MockXhrInstance {
  method: string;
  url: string;
  withCredentials: boolean;
  headers: Record<string, string>;
  body: FormData | null;
  status: number;
  responseText: string;
  responseHeaders: Record<string, string>;
  upload: {
    onprogress: ((ev: ProgressEvent) => void) | null;
    onload: (() => void) | null;
  };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  aborted: boolean;
  open: (method: string, url: string, async?: boolean) => void;
  setRequestHeader: (k: string, v: string) => void;
  getResponseHeader: (k: string) => string | null;
  send: (body: FormData) => void;
  abort: () => void;
  emitProgress: (loaded: number, total: number) => void;
  emitUploadComplete: () => void;
  emitSuccess: (data: unknown, status?: number) => void;
  emitError: (code: string, requestId: string, status: number) => void;
}

function installMockXhr() {
  const instances: MockXhrInstance[] = [];
  const OriginalXhr = globalThis.XMLHttpRequest;

  class MockXMLHttpRequest {
    method = '';
    url = '';
    withCredentials = false;
    headers: Record<string, string> = {};
    body: FormData | null = null;
    status = 0;
    responseText = '';
    responseHeaders: Record<string, string> = {};
    upload: {
      onprogress: ((ev: ProgressEvent) => void) | null;
      onload: (() => void) | null;
    } = {
      onprogress: null,
      onload: null,
    };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    aborted = false;

    constructor() {
      instances.push(this as unknown as MockXhrInstance);
    }

    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }

    setRequestHeader(k: string, v: string) {
      this.headers[k] = v;
    }

    getResponseHeader(k: string): string | null {
      return this.responseHeaders[k] ?? null;
    }

    send(body: FormData) {
      this.body = body;
    }

    abort() {
      this.aborted = true;
      this.onabort?.();
    }

    emitProgress(loaded: number, total: number) {
      this.upload.onprogress?.({
        lengthComputable: true,
        loaded,
        total,
      } as ProgressEvent);
    }

    emitUploadComplete() {
      this.upload.onload?.();
    }

    emitSuccess(data: unknown, status = 201) {
      this.status = status;
      this.responseText = JSON.stringify(data);
      this.onload?.();
    }

    emitError(code: string, requestId: string, status: number) {
      this.status = status;
      this.responseHeaders['X-Request-ID'] = requestId;
      this.responseText = JSON.stringify({
        error: {
          code,
          message: 'Error',
          details: null,
          request_id: requestId,
        },
      });
      this.onload?.();
    }
  }

  vi.stubGlobal('XMLHttpRequest', MockXMLHttpRequest);

  return {
    instances,
    restore: () => {
      vi.stubGlobal('XMLHttpRequest', OriginalXhr);
    },
  };
}

describe('P3-FE Patient, Case & MRI Upload Flows', () => {
  beforeEach(() => {
    useAuthStore.setState({
      status: 'authenticated',
      user: FIXTURE_USERS.doctor,
      accessToken: 'doc-access-token',
      bootstrapError: null,
      fixtureMode: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('creates patient with 409 inline patient_code error preserving other fields, edits patient, and navigates after delete', async () => {
    const user = userEvent.setup();
    const patients: PatientDto[] = [
      {
        id: 'pat-1',
        patient_code: 'BN-001',
        full_name: 'Nguyễn Văn Cũ',
        birth_year: 1970,
        sex: 'male',
        owner_id: FIXTURE_USERS.doctor.id,
        case_count: 0,
        created_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-01T00:00:00Z',
      },
    ];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = createHealthResponse(url);
      if (health) return health;

      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/api/v1/patients') || url.includes('/api/v1/patients?')) {
        if (method === 'GET') {
          return jsonResponse({
            items: patients,
            total: patients.length,
            page: 1,
            page_size: 20,
          });
        }
        if (method === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}'));
          if (body.patient_code === 'BN-001') {
            return errorResponse('patient_code_exists', 'req-pat-409', 409);
          }
          const created: PatientDto = {
            id: 'pat-2',
            patient_code: body.patient_code,
            full_name: body.full_name,
            birth_year: body.birth_year,
            sex: body.sex,
            owner_id: FIXTURE_USERS.doctor.id,
            case_count: 0,
            created_at: '2026-05-10T00:00:00Z',
            updated_at: '2026-05-10T00:00:00Z',
          };
          patients.unshift(created);
          return jsonResponse(created, 201);
        }
      }

      if (url.endsWith('/api/v1/patients/pat-2') && method === 'GET') {
        return jsonResponse(patients.find((p) => p.id === 'pat-2'));
      }
      if (url.endsWith('/api/v1/patients/pat-2/cases') && method === 'GET') {
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
      }
      if (url.endsWith('/api/v1/patients/pat-2') && method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        const idx = patients.findIndex((p) => p.id === 'pat-2');
        patients[idx] = { ...patients[idx]!, ...body };
        return jsonResponse(patients[idx]);
      }
      if (url.endsWith('/api/v1/patients/pat-2') && method === 'DELETE') {
        const idx = patients.findIndex((p) => p.id === 'pat-2');
        patients.splice(idx, 1);
        return new Response(null, { status: 204 });
      }

      return jsonResponse({});
    });

    renderAppAt(['/doctor/patients']);
    expect(await screen.findByText('BN-001')).toBeInTheDocument();

    // Open create modal
    await user.click(screen.getByRole('button', { name: /Thêm bệnh nhân/i }));
    const dialog = screen.getByRole('dialog');

    await user.type(within(dialog).getByLabelText(/Mã bệnh nhân/i), 'BN-001');
    await user.type(within(dialog).getByLabelText(/Họ và tên/i), 'Trần Thị Mới');
    await user.type(within(dialog).getByLabelText(/Năm sinh/i), '1985');
    await user.selectOptions(within(dialog).getByLabelText(/Giới tính/i), 'female');

    await user.click(within(dialog).getByRole('button', { name: 'Tạo hồ sơ' }));

    // 409 inline error on patient_code & other fields preserved!
    expect(
      await within(dialog).findByText(/Mã bệnh nhân đã tồn tại/i, {
        selector: 'p[id$="-error"]',
      }),
    ).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/Họ và tên/i)).toHaveValue(
      'Trần Thị Mới',
    );
    expect(within(dialog).getByLabelText(/Năm sinh/i)).toHaveValue(1985);
    expect(within(dialog).getByLabelText(/Giới tính/i)).toHaveValue('female');

    // Fix patient_code and submit
    const codeInput = within(dialog).getByLabelText(/Mã bệnh nhân/i);
    await user.clear(codeInput);
    await user.type(codeInput, 'BN-002');
    await user.click(within(dialog).getByRole('button', { name: 'Tạo hồ sơ' }));

    expect(await screen.findByText('BN-002')).toBeInTheDocument();

    // Navigate to patient detail
    const detailLink = screen
      .getAllByRole('link', { name: /Xem hồ sơ/i })
      .find((el) => el.getAttribute('href') === '/doctor/patients/pat-2');
    expect(detailLink).toBeDefined();
    await user.click(detailLink!);

    expect(
      await screen.findByRole('heading', { name: 'Trần Thị Mới' }),
    ).toBeInTheDocument();

    // Edit patient
    await user.click(screen.getByRole('button', { name: /Sửa hồ sơ/i }));
    const editDialog = screen.getByRole('dialog');
    const nameInput = within(editDialog).getByLabelText(/Họ và tên/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'Trần Thị Đã Sửa');
    await user.click(
      within(editDialog).getByRole('button', { name: 'Lưu thay đổi' }),
    );

    expect(
      await screen.findByRole('heading', { name: 'Trần Thị Đã Sửa' }),
    ).toBeInTheDocument();

    // Delete patient and verify navigation back to /doctor/patients
    await user.click(screen.getByRole('button', { name: /Xóa hồ sơ/i }));
    const confirmDialog = screen.getByRole('alertdialog');
    expect(
      within(confirmDialog).getByText(/toàn bộ tệp MRI\/mask liên quan/i),
    ).toBeInTheDocument();
    await user.click(
      within(confirmDialog).getByRole('button', { name: 'Xóa hồ sơ' }),
    );

    expect(
      await screen.findByRole('heading', { name: 'Danh sách bệnh nhân' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('BN-002')).not.toBeInTheDocument();
  });

  it('persists Idempotency-Key across retry on 5xx and handles 409 idempotency_conflict / case_deleted', async () => {
    const user = userEvent.setup();
    const sentKeys: string[] = [];
    let attempt = 0;
    let casesFetchCount = 0;

    const patient: PatientDto = {
      id: 'pat-1',
      patient_code: 'BN-001',
      full_name: 'Bệnh nhân Ca Mới',
      birth_year: 1975,
      sex: 'male',
      owner_id: FIXTURE_USERS.doctor.id,
      case_count: 0,
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-05-01T00:00:00Z',
    };

    const createdCase: CaseDto = {
      id: 'case-new-1',
      patient_id: 'pat-1',
      study_date: '2026-05-10',
      notes: 'Ghi chú kiểm thử',
      reference_volume_id: null,
      readiness: 'missing_inputs',
      is_inputs_locked: false,
      can_run_inference: false,
      blocking_reasons: ['Thiếu xung FLAIR', 'Thiếu xung T1ce'],
      latest_mask_version_id: null,
      created_at: '2026-05-10T00:00:00Z',
      updated_at: '2026-05-10T00:00:00Z',
    };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = createHealthResponse(url);
      if (health) return health;

      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/api/v1/patients/pat-1') && method === 'GET') {
        return jsonResponse(patient);
      }
      if (url.endsWith('/api/v1/patients/pat-1/cases') && method === 'GET') {
        casesFetchCount += 1;
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
      }
      if (url.endsWith('/api/v1/patients/pat-1/cases') && method === 'POST') {
        attempt += 1;
        const headers = new Headers(init?.headers);
        sentKeys.push(headers.get('Idempotency-Key') ?? '');

        if (attempt === 1) {
          return errorResponse('internal_error', 'req-500-retry', 500);
        }
        if (attempt === 2) {
          return errorResponse('idempotency_conflict', 'req-409-idem', 409);
        }
        return jsonResponse(createdCase, 201);
      }

      if (url.endsWith('/api/v1/cases/case-new-1') && method === 'GET') {
        return jsonResponse(createdCase);
      }
      if (url.endsWith('/api/v1/cases/case-new-1/volumes')) {
        return jsonResponse([]);
      }
      if (url.endsWith('/api/v1/cases/case-new-1/jobs')) {
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
      }
      if (url.endsWith('/api/v1/cases/case-new-1/mask-versions')) {
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
      }

      return jsonResponse({});
    });

    renderAppAt(['/doctor/patients/pat-1']);
    expect(
      await screen.findByRole('heading', { name: 'Bệnh nhân Ca Mới' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Tạo ca chụp mới/i }));
    const dialog = screen.getByRole('dialog');

    const dateInput = within(dialog).getByLabelText(/Ngày chụp/i);
    await user.clear(dateInput);
    await user.type(dateInput, '2026-05-10');
    await user.type(
      within(dialog).getByLabelText(/Ghi chú lâm sàng/i),
      'Ghi chú kiểm thử',
    );

    await user.click(within(dialog).getByRole('button', { name: 'Tạo ca chụp' }));

    // 500 -> shows "Thử lại với cùng khóa"
    const retryBtn = await within(dialog).findByRole('button', {
      name: 'Thử lại với cùng khóa',
    });
    expect(sentKeys).toHaveLength(1);
    expect(sentKeys[0]).toMatch(/^[0-9a-f-]{36}$/i);

    const casesFetchBeforeConflict = casesFetchCount;
    await user.click(retryBtn);

    // Same Idempotency-Key reused!
    expect(sentKeys).toHaveLength(2);
    expect(sentKeys[1]).toBe(sentKeys[0]);

    // 409 idempotency_conflict -> refreshes cases, resets key, shows error with request_id
    expect(
      await within(dialog).findByText(/req-409-idem/i),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(casesFetchCount).toBeGreaterThan(casesFetchBeforeConflict);
    });

    // Submit again -> generates a NEW Idempotency-Key and succeeds (201 -> navigates to case detail)
    await user.click(within(dialog).getByRole('button', { name: 'Tạo ca chụp' }));
    expect(sentKeys).toHaveLength(3);
    expect(sentKeys[2]).not.toBe(sentKeys[0]);

    expect(
      await screen.findByRole('heading', { name: 'Ca chụp ngày 10/05/2026' }),
    ).toBeInTheDocument();
  });

  it('handles FLAIR & T1ce upload progress, validating phase, _seg warning, client rejections, 422 geometry_mismatch, abort, viewer/AI gating, and inputs_locked', async () => {
    const user = userEvent.setup();
    const xhrMock = installMockXhr();

    let caseState: CaseDto = {
      id: 'case-1',
      patient_id: 'pat-1',
      study_date: '2026-05-12',
      notes: 'Kiểm thử upload',
      reference_volume_id: null,
      readiness: 'missing_inputs',
      is_inputs_locked: false,
      can_run_inference: false,
      blocking_reasons: ['Thiếu xung FLAIR', 'Thiếu xung T1ce'],
      latest_mask_version_id: null,
      created_at: '2026-05-12T00:00:00Z',
      updated_at: '2026-05-12T00:00:00Z',
    };
    let volumes: VolumeDto[] = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = createHealthResponse(url);
      if (health) return health;

      if (url.endsWith('/api/v1/cases/case-1')) {
        return jsonResponse(caseState);
      }
      if (url.endsWith('/api/v1/cases/case-1/volumes')) {
        return jsonResponse(volumes);
      }
      if (url.endsWith('/api/v1/cases/case-1/jobs')) {
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
      }
      if (url.endsWith('/api/v1/cases/case-1/mask-versions')) {
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
      }
      return jsonResponse({});
    });

    const client = createTestQueryClient();
    renderAppAt(['/doctor/cases/case-1'], client);

    expect(
      await screen.findByRole('heading', { name: 'Ca chụp ngày 12/05/2026' }),
    ).toBeInTheDocument();

    // 0 valid volumes -> Viewer button disabled & AI button disabled
    expect(
      screen.getByRole('button', { name: /Mở Viewer \/ Chỉnh mask/i }),
    ).toBeDisabled();
    expect(
      screen.getByRole('button', { name: /Chạy phân đoạn AI/i }),
    ).toBeDisabled();

    const flairSlot = screen.getByTestId('volume-slot-flair');
    const t1ceSlot = screen.getByTestId('volume-slot-t1ce');

    // 1. Bad extension rejected on FLAIR
    const badFile = new File(['abc'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(within(flairSlot).getByLabelText(/Chọn tệp Xung FLAIR/i), {
      target: { files: [badFile] },
    });
    expect(
      await within(flairSlot).findByText(/Chỉ chấp nhận tệp NIfTI/i),
    ).toBeInTheDocument();
    expect(xhrMock.instances).toHaveLength(0);

    // 2. >100 MiB rejected on T1ce
    const hugeFile = new File(['x'], 'huge_t1ce.nii.gz');
    Object.defineProperty(hugeFile, 'size', { value: 101 * 1024 * 1024 });
    fireEvent.change(within(t1ceSlot).getByLabelText(/Chọn tệp Xung T1ce/i), {
      target: { files: [hugeFile] },
    });
    expect(
      await within(t1ceSlot).findByText(/vượt quá giới hạn tối đa 100 MiB/i),
    ).toBeInTheDocument();
    expect(xhrMock.instances).toHaveLength(0);

    // 3. _seg filename triggers warning and does NOT auto-upload
    const segFile = new File(['seg'], 'brats_001_seg.nii.gz');
    fireEvent.change(within(flairSlot).getByLabelText(/Chọn tệp Xung FLAIR/i), {
      target: { files: [segFile] },
    });
    expect(
      await within(flairSlot).findByText(/Cảnh báo tệp có chứa '_seg'/i),
    ).toBeInTheDocument();
    expect(xhrMock.instances).toHaveLength(0);

    await user.click(
      within(flairSlot).getByRole('button', { name: 'Chọn tệp khác' }),
    );

    // 4. Upload valid FLAIR -> progress -> "Đang kiểm tra ảnh..." -> abort test first
    const flairFile = new File(['nifti-flair'], 'patient_flair.nii.gz');
    fireEvent.change(within(flairSlot).getByLabelText(/Chọn tệp Xung FLAIR/i), {
      target: { files: [flairFile] },
    });

    await waitFor(() => {
      expect(xhrMock.instances).toHaveLength(1);
    });
    const firstXhr = xhrMock.instances[0]!;
    expect(firstXhr.withCredentials).toBe(true);
    expect(firstXhr.headers.Authorization).toBe('Bearer doc-access-token');

    act(() => {
      firstXhr.emitProgress(50, 100);
    });
    expect(await within(flairSlot).findByText('50%')).toBeInTheDocument();

    act(() => {
      firstXhr.emitUploadComplete();
    });
    expect(
      (await within(flairSlot).findAllByText('Đang kiểm tra ảnh...')).length,
    ).toBeGreaterThanOrEqual(1);

    // Abort upload & verify cancellation
    await user.click(
      within(flairSlot).getByRole('button', { name: /Hủy tải lên/i }),
    );
    expect(firstXhr.aborted).toBe(true);
    expect(
      await within(flairSlot).findByLabelText(/Chọn tệp Xung FLAIR/i),
    ).toBeInTheDocument();

    // Re-upload FLAIR and succeed
    fireEvent.change(within(flairSlot).getByLabelText(/Chọn tệp Xung FLAIR/i), {
      target: { files: [flairFile] },
    });
    await waitFor(() => {
      expect(xhrMock.instances).toHaveLength(2);
    });
    const secondXhr = xhrMock.instances[1]!;

    const flairVolume: VolumeDto = {
      id: 'vol-flair-1',
      case_id: 'case-1',
      modality: 'flair',
      file_id: 'file-flair-1',
      filename: 'patient_flair.nii.gz',
      validation_status: 'valid',
      shape: [240, 240, 155],
      spacing_mm: [1, 1, 1],
      affine: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
      orientation: 'RAS',
      size_bytes: 12_582_912,
      sha256: 'abc',
    };
    volumes = [flairVolume];
    caseState = {
      ...caseState,
      reference_volume_id: flairVolume.id,
      readiness: 'missing_inputs',
      can_run_inference: false,
      blocking_reasons: ['Thiếu xung T1ce'],
    };

    act(() => {
      secondXhr.emitSuccess(flairVolume, 201);
    });

    expect(
      await within(flairSlot).findByText('240×240×155 (RAS)'),
    ).toBeInTheDocument();
    expect(
      within(flairSlot).getByText('patient_flair.nii.gz'),
    ).toBeInTheDocument();

    // With 1 valid volume: Viewer link is enabled, AI remains disabled with reason
    expect(
      screen.getByRole('link', { name: /Mở Viewer \/ Chỉnh mask/i }),
    ).toHaveAttribute('href', '/doctor/cases/case-1/viewer');
    expect(
      screen.getByRole('button', { name: /Chạy phân đoạn AI/i }),
    ).toBeDisabled();
    expect(screen.getByText(/Thiếu xung T1ce/i)).toBeInTheDocument();

    // 5. Upload T1ce -> 422 geometry_mismatch keeps FLAIR intact!
    const t1ceFile = new File(['nifti-t1ce'], 'patient_t1ce.nii.gz');
    fireEvent.change(within(t1ceSlot).getByLabelText(/Chọn tệp Xung T1ce/i), {
      target: { files: [t1ceFile] },
    });
    await waitFor(() => {
      expect(xhrMock.instances).toHaveLength(3);
    });
    const thirdXhr = xhrMock.instances[2]!;
    act(() => {
      thirdXhr.emitError('geometry_mismatch', 'req-geom-422', 422);
    });

    expect(
      await within(t1ceSlot).findByText(/không khớp kích thước/i),
    ).toBeInTheDocument();
    expect(within(t1ceSlot).getByText(/req-geom-422/i)).toBeInTheDocument();
    // FLAIR stays intact!
    expect(
      within(flairSlot).getByText('patient_flair.nii.gz'),
    ).toBeInTheDocument();

    // 6. When inputs are locked, "Xóa xung" transitions to disabled with explanation
    expect(
      within(flairSlot).getByRole('button', { name: /Xóa xung FLAIR/i }),
    ).toBeEnabled();

    caseState = {
      ...caseState,
      is_inputs_locked: true,
      inputs_locked_at: '2026-05-12T01:00:00Z',
      latest_mask_version_id: 'mask-1',
    };
    await act(async () => {
      await client.invalidateQueries();
    });

    await waitFor(() => {
      expect(
        within(flairSlot).getByRole('button', { name: /Xóa xung FLAIR/i }),
      ).toBeDisabled();
    });

    xhrMock.restore();
  });

  it('disables volume delete when is_inputs_locked is true', async () => {
    const lockedCase: CaseDto = {
      id: 'case-locked',
      patient_id: 'pat-1',
      study_date: '2026-05-12',
      notes: null,
      reference_volume_id: 'vol-1',
      readiness: 'ready',
      is_inputs_locked: true,
      can_run_inference: true,
      blocking_reasons: [],
      latest_mask_version_id: 'mask-1',
      created_at: '2026-05-12T00:00:00Z',
      updated_at: '2026-05-12T00:00:00Z',
    };
    const vol: VolumeDto = {
      id: 'vol-1',
      case_id: 'case-locked',
      modality: 'flair',
      file_id: 'file-1',
      filename: 'locked_flair.nii.gz',
      validation_status: 'valid',
      shape: [240, 240, 155],
      spacing_mm: [1, 1, 1],
      affine: null,
      orientation: 'RAS',
      size_bytes: 1024 * 1024,
      sha256: 'abc',
    };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = createHealthResponse(url);
      if (health) return health;
      if (url.endsWith('/api/v1/cases/case-locked')) {
        return jsonResponse(lockedCase);
      }
      if (url.endsWith('/api/v1/cases/case-locked/volumes')) {
        return jsonResponse([vol]);
      }
      if (url.endsWith('/api/v1/cases/case-locked/jobs')) {
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
      }
      if (url.endsWith('/api/v1/cases/case-locked/mask-versions')) {
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
      }
      return jsonResponse({});
    });

    renderAppAt(['/doctor/cases/case-locked']);
    const flairSlot = await screen.findByTestId('volume-slot-flair');
    expect(
      within(flairSlot).getByRole('button', { name: /Xóa xung FLAIR/i }),
    ).toBeDisabled();
    expect(
      within(flairSlot).getByText(/Ca chụp đã có phiên bản mask/i),
    ).toBeInTheDocument();
  });

  it('preserves study_date, notes, and Idempotency-Key when closing/reopening CaseFormModal after 500, and handles 409 case_deleted', async () => {
    const user = userEvent.setup();
    const sentKeys: string[] = [];
    let attempt = 0;
    let casesFetchCount = 0;

    const patient: PatientDto = {
      id: 'pat-1',
      patient_code: 'BN-001',
      full_name: 'Bệnh nhân Đóng Mở Modal',
      birth_year: 1978,
      sex: 'female',
      owner_id: FIXTURE_USERS.doctor.id,
      case_count: 0,
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-05-01T00:00:00Z',
    };

    const createdCase: CaseDto = {
      id: 'case-reopen-1',
      patient_id: 'pat-1',
      study_date: '2026-05-11',
      notes: 'Ghi chú giữ lại',
      reference_volume_id: null,
      readiness: 'missing_inputs',
      is_inputs_locked: false,
      can_run_inference: false,
      blocking_reasons: ['Thiếu xung FLAIR', 'Thiếu xung T1ce'],
      latest_mask_version_id: null,
      created_at: '2026-05-11T00:00:00Z',
      updated_at: '2026-05-11T00:00:00Z',
    };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = createHealthResponse(url);
      if (health) return health;

      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.endsWith('/api/v1/patients/pat-1') && method === 'GET') {
        return jsonResponse(patient);
      }
      if (url.endsWith('/api/v1/patients/pat-1/cases') && method === 'GET') {
        casesFetchCount += 1;
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
      }
      if (url.endsWith('/api/v1/patients/pat-1/cases') && method === 'POST') {
        attempt += 1;
        const headers = new Headers(init?.headers);
        sentKeys.push(headers.get('Idempotency-Key') ?? '');
        if (attempt === 1) {
          return errorResponse('internal_error', 'req-500-reopen', 500);
        }
        if (attempt === 2) {
          return errorResponse('case_deleted', 'req-409-deleted', 409);
        }
        return jsonResponse(createdCase, 201);
      }
      if (url.endsWith('/api/v1/cases/case-reopen-1')) {
        return jsonResponse(createdCase);
      }
      if (url.endsWith('/api/v1/cases/case-reopen-1/volumes')) {
        return jsonResponse([]);
      }
      if (url.endsWith('/api/v1/cases/case-reopen-1/jobs')) {
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
      }
      if (url.endsWith('/api/v1/cases/case-reopen-1/mask-versions')) {
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
      }
      return jsonResponse({});
    });

    renderAppAt(['/doctor/patients/pat-1']);
    expect(
      await screen.findByRole('heading', { name: 'Bệnh nhân Đóng Mở Modal' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Tạo ca chụp mới/i }));
    const dialog1 = screen.getByRole('dialog');
    const dateInput = within(dialog1).getByLabelText(/Ngày chụp/i);
    await user.clear(dateInput);
    await user.type(dateInput, '2026-05-11');
    await user.type(
      within(dialog1).getByLabelText(/Ghi chú lâm sàng/i),
      'Ghi chú giữ lại',
    );
    await user.click(within(dialog1).getByRole('button', { name: 'Tạo ca chụp' }));

    await within(dialog1).findByRole('button', { name: 'Thử lại với cùng khóa' });

    // Close modal and reopen it
    await user.click(within(dialog1).getByRole('button', { name: 'Hủy' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Tạo ca chụp mới/i }));
    const dialog2 = screen.getByRole('dialog');
    expect(within(dialog2).getByLabelText(/Ngày chụp/i)).toHaveValue('2026-05-11');
    expect(within(dialog2).getByLabelText(/Ghi chú lâm sàng/i)).toHaveValue(
      'Ghi chú giữ lại',
    );

    const retryBtn = within(dialog2).getByRole('button', {
      name: 'Thử lại với cùng khóa',
    });
    const fetchBeforeCaseDeleted = casesFetchCount;
    await user.click(retryBtn);

    // Exact same Idempotency-Key reused across close/reopen!
    expect(sentKeys).toHaveLength(2);
    expect(sentKeys[1]).toBe(sentKeys[0]);

    // 409 case_deleted -> displays message + request_id, refreshes cases, resets key
    expect(
      await within(dialog2).findByText(/req-409-deleted/i),
    ).toBeInTheDocument();
    expect(
      within(dialog2).getByText(/Ca chụp liên quan đã bị xóa trước đó/i),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(casesFetchCount).toBeGreaterThan(fetchBeforeCaseDeleted);
    });

    // Next submit generates a fresh Idempotency-Key and succeeds
    await user.click(within(dialog2).getByRole('button', { name: 'Tạo ca chụp' }));
    expect(sentKeys).toHaveLength(3);
    expect(sentKeys[2]).not.toBe(sentKeys[0]);
    expect(
      await screen.findByRole('heading', { name: 'Ca chụp ngày 11/05/2026' }),
    ).toBeInTheDocument();
  });

  it('displays background cleanup toast when DELETE returns 202 with status deleting', async () => {
    const user = userEvent.setup();
    const caseDto: CaseDto = {
      id: 'case-del-202',
      patient_id: 'pat-1',
      study_date: '2026-05-12',
      notes: null,
      reference_volume_id: null,
      readiness: 'missing_inputs',
      is_inputs_locked: false,
      can_run_inference: false,
      blocking_reasons: ['Thiếu xung FLAIR', 'Thiếu xung T1ce'],
      latest_mask_version_id: null,
      created_at: '2026-05-12T00:00:00Z',
      updated_at: '2026-05-12T00:00:00Z',
    };
    const patient: PatientDto = {
      id: 'pat-1',
      patient_code: 'BN-001',
      full_name: 'Bệnh nhân Xóa 202',
      birth_year: 1980,
      sex: 'male',
      owner_id: FIXTURE_USERS.doctor.id,
      case_count: 0,
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-05-01T00:00:00Z',
    };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = createHealthResponse(url);
      if (health) return health;
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/api/v1/cases/case-del-202') && method === 'GET') {
        return jsonResponse(caseDto);
      }
      if (url.endsWith('/api/v1/cases/case-del-202') && method === 'DELETE') {
        return jsonResponse(
          {
            resource_type: 'case',
            resource_id: 'case-del-202',
            status: 'deleting',
            files_cleaned: 0,
            message: 'Đang xóa dữ liệu nền.',
          },
          202,
        );
      }
      if (url.endsWith('/api/v1/cases/case-del-202/volumes')) {
        return jsonResponse([]);
      }
      if (url.endsWith('/api/v1/cases/case-del-202/jobs')) {
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
      }
      if (url.endsWith('/api/v1/cases/case-del-202/mask-versions')) {
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
      }
      if (url.endsWith('/api/v1/patients/pat-1')) {
        return jsonResponse(patient);
      }
      if (url.endsWith('/api/v1/patients/pat-1/cases')) {
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
      }
      return jsonResponse({});
    });

    renderAppAt(['/doctor/cases/case-del-202']);
    expect(
      await screen.findByRole('heading', { name: 'Ca chụp ngày 12/05/2026' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Xóa ca chụp/i }));
    const confirmDialog = screen.getByRole('alertdialog');
    await user.click(
      within(confirmDialog).getByRole('button', { name: 'Xóa ca chụp' }),
    );

    expect(
      await screen.findByText(/Đã thu hồi truy cập ca chụp/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/đang tiếp tục dọn dẹp tệp lưu trữ nền/i),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Bệnh nhân Xóa 202' }),
    ).toBeInTheDocument();
  });

  it('requires case list reconciliation and confirmation before generating a new Idempotency-Key when editing fields after 500 error', async () => {
    const user = userEvent.setup();
    const sentKeys: string[] = [];
    let attempt = 0;
    let casesFetchCount = 0;

    const patient: PatientDto = {
      id: 'pat-1',
      patient_code: 'BN-001',
      full_name: 'Bệnh nhân Đối Soát',
      birth_year: 1982,
      sex: 'male',
      owner_id: FIXTURE_USERS.doctor.id,
      case_count: 0,
      created_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-05-01T00:00:00Z',
    };

    const createdCase: CaseDto = {
      id: 'case-reconcile-1',
      patient_id: 'pat-1',
      study_date: '2026-05-12',
      notes: 'Ghi chú sau sửa',
      reference_volume_id: null,
      readiness: 'missing_inputs',
      is_inputs_locked: false,
      can_run_inference: false,
      blocking_reasons: ['Thiếu xung FLAIR', 'Thiếu xung T1ce'],
      latest_mask_version_id: null,
      created_at: '2026-05-12T00:00:00Z',
      updated_at: '2026-05-12T00:00:00Z',
    };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = createHealthResponse(url);
      if (health) return health;
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/api/v1/patients/pat-1') && method === 'GET') {
        return jsonResponse(patient);
      }
      if (url.endsWith('/api/v1/patients/pat-1/cases') && method === 'GET') {
        casesFetchCount += 1;
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
      }
      if (url.endsWith('/api/v1/patients/pat-1/cases') && method === 'POST') {
        attempt += 1;
        const headers = new Headers(init?.headers);
        sentKeys.push(headers.get('Idempotency-Key') ?? '');
        if (attempt === 1) {
          return errorResponse('internal_error', 'req-500-edit', 500);
        }
        return jsonResponse(createdCase, 201);
      }
      if (url.endsWith('/api/v1/cases/case-reconcile-1')) {
        return jsonResponse(createdCase);
      }
      if (url.endsWith('/api/v1/cases/case-reconcile-1/volumes')) {
        return jsonResponse([]);
      }
      if (url.endsWith('/api/v1/cases/case-reconcile-1/jobs')) {
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
      }
      if (url.endsWith('/api/v1/cases/case-reconcile-1/mask-versions')) {
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
      }
      return jsonResponse({});
    });

    renderAppAt(['/doctor/patients/pat-1']);
    expect(
      await screen.findByRole('heading', { name: 'Bệnh nhân Đối Soát' }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Tạo ca chụp mới/i }));
    const dialog = screen.getByRole('dialog');
    const dateInput = within(dialog).getByLabelText(/Ngày chụp/i);
    await user.clear(dateInput);
    await user.type(dateInput, '2026-05-12');
    await user.type(
      within(dialog).getByLabelText(/Ghi chú lâm sàng/i),
      'Ghi chú ban đầu',
    );

    await user.click(within(dialog).getByRole('button', { name: 'Tạo ca chụp' }));
    await within(dialog).findByRole('button', { name: 'Thử lại với cùng khóa' });
    expect(sentKeys).toHaveLength(1);

    // Edit notes after 500 error -> triggers automatic case list refresh & blocks submit until confirmed
    const fetchCountBeforeEdit = casesFetchCount;
    const notesInput = within(dialog).getByLabelText(/Ghi chú lâm sàng/i);
    await user.clear(notesInput);
    await user.type(notesInput, 'Ghi chú sau sửa');

    expect(
      await within(dialog).findByText(
        /Cần đối soát danh sách ca trước khi tạo khóa mới/i,
      ),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(casesFetchCount).toBeGreaterThan(fetchCountBeforeEdit);
    });

    const submitBtn = within(dialog).getByRole('button', { name: 'Tạo ca chụp' });
    expect(submitBtn).toBeDisabled();

    const confirmCheckbox = within(dialog).getByRole('checkbox', {
      name: /Tôi đã kiểm tra danh sách ca chụp và xác nhận muốn tạo ca mới/i,
    });
    await user.click(confirmCheckbox);
    expect(submitBtn).toBeEnabled();

    await user.click(submitBtn);
    expect(sentKeys).toHaveLength(2);
    expect(sentKeys[1]).not.toBe(sentKeys[0]);
    expect(
      await screen.findByRole('heading', { name: 'Ca chụp ngày 12/05/2026' }),
    ).toBeInTheDocument();
  });

  it('uploads FLAIR and T1ce sequentially without getting stuck in queued state, and hides cached case data on 404/403 refetch', async () => {
    const xhrMock = installMockXhr();

    let shouldReturn404 = false;
    let caseState: CaseDto = {
      id: 'case-seq-1',
      patient_id: 'pat-1',
      study_date: '2026-05-15',
      notes: 'Ghi chú nhạy cảm không được hiển thị sau 404',
      reference_volume_id: null,
      readiness: 'missing_inputs',
      is_inputs_locked: false,
      can_run_inference: false,
      blocking_reasons: ['Thiếu xung FLAIR', 'Thiếu xung T1ce'],
      latest_mask_version_id: null,
      created_at: '2026-05-15T00:00:00Z',
      updated_at: '2026-05-15T00:00:00Z',
    };
    let volumes: VolumeDto[] = [];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = createHealthResponse(url);
      if (health) return health;

      if (url.endsWith('/api/v1/cases/case-seq-1')) {
        if (shouldReturn404) {
          return errorResponse('case_not_found', 'req-case-404', 404);
        }
        return jsonResponse(caseState);
      }
      if (url.endsWith('/api/v1/cases/case-seq-1/volumes')) {
        return jsonResponse(volumes);
      }
      if (url.endsWith('/api/v1/cases/case-seq-1/jobs')) {
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
      }
      if (url.endsWith('/api/v1/cases/case-seq-1/mask-versions')) {
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
      }
      return jsonResponse({});
    });

    const client = createTestQueryClient();
    renderAppAt(['/doctor/cases/case-seq-1'], client);

    expect(
      await screen.findByRole('heading', { name: 'Ca chụp ngày 15/05/2026' }),
    ).toBeInTheDocument();

    const flairSlot = screen.getByTestId('volume-slot-flair');
    const t1ceSlot = screen.getByTestId('volume-slot-t1ce');

    const flairFile = new File(['flair-bytes'], 'seq_flair.nii.gz');
    const t1ceFile = new File(['t1ce-bytes'], 'seq_t1ce.nii.gz');

    // Select FLAIR and T1ce back-to-back simultaneously
    fireEvent.change(within(flairSlot).getByLabelText(/Chọn tệp Xung FLAIR/i), {
      target: { files: [flairFile] },
    });
    fireEvent.change(within(t1ceSlot).getByLabelText(/Chọn tệp Xung T1ce/i), {
      target: { files: [t1ceFile] },
    });

    // Only FLAIR starts XHR #1; T1ce waits in queue
    await waitFor(() => {
      expect(xhrMock.instances).toHaveLength(1);
    });
    expect(
      await within(t1ceSlot).findByText(/Đang chờ hàng đợi/i),
    ).toBeInTheDocument();

    const flairVol: VolumeDto = {
      id: 'v-flair',
      case_id: 'case-seq-1',
      modality: 'flair',
      file_id: 'f-flair',
      filename: 'seq_flair.nii.gz',
      validation_status: 'valid',
      shape: [240, 240, 155],
      spacing_mm: [1, 1, 1],
      affine: null,
      orientation: 'RAS',
      size_bytes: 1024,
      sha256: 'sha1',
    };
    volumes = [flairVol];
    caseState = { ...caseState, reference_volume_id: flairVol.id };

    // Complete FLAIR XHR -> T1ce MUST automatically dequeue and start XHR #2 immediately!
    act(() => {
      xhrMock.instances[0]!.emitSuccess(flairVol, 201);
    });

    await waitFor(() => {
      expect(xhrMock.instances).toHaveLength(2);
    });

    const t1ceVol: VolumeDto = {
      id: 'v-t1ce',
      case_id: 'case-seq-1',
      modality: 't1ce',
      file_id: 'f-t1ce',
      filename: 'seq_t1ce.nii.gz',
      validation_status: 'valid',
      shape: [240, 240, 155],
      spacing_mm: [1, 1, 1],
      affine: null,
      orientation: 'RAS',
      size_bytes: 1024,
      sha256: 'sha2',
    };
    volumes = [flairVol, t1ceVol];
    caseState = {
      ...caseState,
      readiness: 'ready',
      can_run_inference: true,
      blocking_reasons: [],
    };

    act(() => {
      xhrMock.instances[1]!.emitSuccess(t1ceVol, 201);
    });

    expect(await within(flairSlot).findByText('seq_flair.nii.gz')).toBeInTheDocument();
    expect(await within(t1ceSlot).findByText('seq_t1ce.nii.gz')).toBeInTheDocument();

    // Now simulate case deleted/revoked on server -> refetch returns 404 -> ErrorState immediately replaces cached data!
    shouldReturn404 = true;
    await act(async () => {
      await client.invalidateQueries({
        queryKey: ['doctor', FIXTURE_USERS.doctor.id, 'case', 'case-seq-1'],
      });
    });

    expect(
      await screen.findByText('Không thể truy cập ca chụp'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Ghi chú nhạy cảm không được hiển thị sau 404'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Ca chụp ngày 15/05/2026' }),
    ).not.toBeInTheDocument();

    xhrMock.restore();
  });

  it('automatically steps back to page 1 when deleting the last patient on page 2', async () => {
    const user = userEvent.setup();
    const patients: PatientDto[] = [
      {
        id: 'pat-p1',
        patient_code: 'BN-P1',
        full_name: 'Bệnh nhân Trang 1',
        birth_year: 1975,
        sex: 'male',
        owner_id: FIXTURE_USERS.doctor.id,
        case_count: 0,
        created_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-01T00:00:00Z',
      },
      {
        id: 'pat-p2',
        patient_code: 'BN-P2',
        full_name: 'Bệnh nhân Trang 2',
        birth_year: 1982,
        sex: 'female',
        owner_id: FIXTURE_USERS.doctor.id,
        case_count: 0,
        created_at: '2026-05-02T00:00:00Z',
        updated_at: '2026-05-02T00:00:00Z',
      },
    ];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = createHealthResponse(url);
      if (health) return health;
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.includes('/api/v1/patients') && method === 'GET') {
        const parsed = new URL(url, 'http://127.0.0.1');
        const p = Number(parsed.searchParams.get('page') ?? '1');
        const ps = Number(parsed.searchParams.get('page_size') ?? '20');
        const slice = patients.slice((p - 1) * ps, p * ps);
        return jsonResponse({
          items: slice,
          total: patients.length,
          page: p,
          page_size: ps,
        });
      }
      if (url.endsWith('/api/v1/patients/pat-p2') && method === 'DELETE') {
        const idx = patients.findIndex((item) => item.id === 'pat-p2');
        if (idx >= 0) patients.splice(idx, 1);
        return new Response(null, { status: 204 });
      }
      return jsonResponse({});
    });

    renderAppAt(['/doctor/patients?page=2&page_size=1']);

    expect(await screen.findByText('BN-P2')).toBeInTheDocument();
    expect(screen.getByText('Trang 2 / 2')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Xóa hồ sơ BN-P2' }));
    const confirmDialog = screen.getByRole('alertdialog');
    await user.click(
      within(confirmDialog).getByRole('button', { name: 'Xóa hồ sơ' }),
    );

    // Automatically falls back to page 1 and displays BN-P1 instead of getting stuck on empty page 2!
    expect(await screen.findByText('BN-P1')).toBeInTheDocument();
    expect(screen.getByText('Trang 1 / 1')).toBeInTheDocument();
  });

  it('renders synced patient_code on DoctorOverviewPage instead of truncated UUID, links to patient detail, and filters by patient_code', async () => {
    const user = userEvent.setup();
    const overviewCases: CaseDto[] = [
      {
        id: '22222222-0000-4000-8000-000000000001',
        patient_id: '11111111-aaaa-4000-8000-000000000001',
        patient_code: 'BN-SYNC-101',
        study_date: '2026-05-14',
        notes: 'Ca theo dõi định kỳ',
        reference_volume_id: 'vol-sync-1',
        readiness: 'ready',
        is_inputs_locked: false,
        can_run_inference: true,
        blocking_reasons: [],
        latest_mask_version_id: null,
        latest_job_state: null,
        created_at: '2026-05-14T08:00:00Z',
        updated_at: '2026-05-14T09:00:00Z',
      },
      {
        id: '22222222-0000-4000-8000-000000000002',
        patient_id: '99999999-bbbb-4000-8000-000000000002',
        patient_code: 'BN-SYNC-202',
        study_date: '2026-05-10',
        notes: 'Ca mới tiếp nhận',
        reference_volume_id: null,
        readiness: 'missing_inputs',
        is_inputs_locked: false,
        can_run_inference: false,
        blocking_reasons: ['Thiếu xung FLAIR', 'Thiếu xung T1ce'],
        latest_mask_version_id: null,
        latest_job_state: null,
        created_at: '2026-05-10T08:00:00Z',
        updated_at: '2026-05-10T09:00:00Z',
      },
    ];

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = createHealthResponse(url);
      if (health) return health;

      if (url.includes('/api/v1/cases?')) {
        return jsonResponse({
          items: overviewCases,
          total: overviewCases.length,
          page: 1,
          page_size: 20,
        });
      }
      return jsonResponse({});
    });

    renderAppAt(['/doctor']);

    const codeLink1 = await screen.findByRole('link', { name: 'BN-SYNC-101' });
    const codeLink2 = screen.getByRole('link', { name: 'BN-SYNC-202' });

    expect(codeLink1).toHaveAttribute(
      'href',
      '/doctor/patients/11111111-aaaa-4000-8000-000000000001',
    );
    expect(codeLink2).toHaveAttribute(
      'href',
      '/doctor/patients/99999999-bbbb-4000-8000-000000000002',
    );
    expect(screen.queryByText('11111111')).not.toBeInTheDocument();
    expect(screen.queryByText('99999999')).not.toBeInTheDocument();

    const searchInput = screen.getByLabelText(
      /Tìm theo mã bệnh nhân hoặc ngày chụp/i,
    );
    await user.type(searchInput, 'bn-sync-202');

    expect(
      screen.getByRole('link', { name: 'BN-SYNC-202' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'BN-SYNC-101' }),
    ).not.toBeInTheDocument();
  });

  it('allows deleting manual mask versions only (hiding delete on AI versions) on CaseDetailPage', async () => {
    const user = userEvent.setup();
    const caseData: CaseDto = {
      id: 'case-mask-del-1',
      patient_id: 'pat-1',
      study_date: '2026-05-12',
      notes: null,
      reference_volume_id: 'vol-1',
      readiness: 'ready',
      is_inputs_locked: true,
      can_run_inference: true,
      blocking_reasons: [],
      latest_mask_version_id: 'mv-manual-2',
      created_at: '2026-05-12T00:00:00Z',
      updated_at: '2026-05-12T00:00:00Z',
    };
    const aiVersion = {
      id: 'mv-ai-1',
      case_id: 'case-mask-del-1',
      version_number: 1,
      source: 'ai' as const,
      base_version_id: null,
      reference_volume_id: 'vol-1',
      file_id: 'file-mv-1',
      created_by: null,
      created_by_name: null,
      model_version_id: 'tda-seg-unet:v1',
      job_id: 'job-1',
      note: 'AI baseline',
      label_voxel_counts: { '1': 10, '2': 20, '4': 5 },
      label_volumes_mm3: { '1': 10, '2': 20, '4': 5 },
      sha256: 'sha-ai-1',
      created_at: '2026-05-12T01:00:00Z',
    };
    const manualVersion = {
      id: 'mv-manual-2',
      case_id: 'case-mask-del-1',
      version_number: 2,
      source: 'manual' as const,
      base_version_id: 'mv-ai-1',
      reference_volume_id: 'vol-1',
      file_id: 'file-mv-2',
      created_by: FIXTURE_USERS.doctor.id,
      created_by_name: FIXTURE_USERS.doctor.display_name,
      model_version_id: null,
      job_id: null,
      note: 'Manual refinement',
      label_voxel_counts: { '1': 12, '2': 20, '4': 5 },
      label_volumes_mm3: { '1': 12, '2': 20, '4': 5 },
      sha256: 'sha-manual-2',
      created_at: '2026-05-12T02:00:00Z',
    };
    let versions = [manualVersion, aiVersion];
    let deleteCalled = false;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString();
      const health = createHealthResponse(url);
      if (health) return health;
      const method = (init?.method ?? 'GET').toUpperCase();

      if (url.endsWith('/api/v1/cases/case-mask-del-1') && method === 'GET') {
        return jsonResponse(caseData);
      }
      if (url.endsWith('/api/v1/cases/case-mask-del-1/volumes') && method === 'GET') {
        return jsonResponse([]);
      }
      if (url.endsWith('/api/v1/cases/case-mask-del-1/jobs') && method === 'GET') {
        return jsonResponse({ items: [], total: 0, page: 1, page_size: 20 });
      }
      if (url.endsWith('/api/v1/cases/case-mask-del-1/mask-versions') && method === 'GET') {
        return jsonResponse({
          items: versions,
          total: versions.length,
          page: 1,
          page_size: 20,
        });
      }
      if (url.endsWith('/api/v1/mask-versions/mv-manual-2') && method === 'DELETE') {
        deleteCalled = true;
        versions = [aiVersion];
        caseData.latest_mask_version_id = 'mv-ai-1';
        return jsonResponse(
          {
            resource_type: 'mask_version',
            resource_id: 'mv-manual-2',
            status: 'deleted',
            files_cleaned: 1,
            message: 'Đã xóa phiên bản mask thủ công.',
          },
          202,
        );
      }
      return jsonResponse({});
    });

    renderAppAt(['/doctor/cases/case-mask-del-1']);

    const deleteManualBtn = await screen.findByRole('button', {
      name: 'Xóa phiên bản v2',
    });
    expect(deleteManualBtn).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Xóa phiên bản v1' }),
    ).not.toBeInTheDocument();

    await user.click(deleteManualBtn);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(
      within(dialog).getByRole('button', { name: 'Xóa phiên bản' }),
    );

    await waitFor(() => {
      expect(deleteCalled).toBe(true);
      expect(screen.queryByText('Phiên bản v2')).not.toBeInTheDocument();
    });
    expect(screen.getByText('Phiên bản v1')).toBeInTheDocument();
  });
});
