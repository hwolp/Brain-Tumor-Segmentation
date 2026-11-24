import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/app/auth-store';
import { ViewerWorkspacePage } from '@/features/viewer/ViewerWorkspacePage';
import { FIXTURE_USERS } from '@/shared/api/fixtures';
import { ToastProvider } from '@/shared/ui';
import { useViewerStore } from '@/viewer-adapter';

const { saveManualMaskVersionSpy } = vi.hoisted(() => ({
  saveManualMaskVersionSpy: vi.fn(),
}));

vi.mock('@/shared/api/maskVersions', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/shared/api/maskVersions')>();
  saveManualMaskVersionSpy.mockImplementation(actual.saveManualMaskVersion);
  return {
    ...actual,
    saveManualMaskVersion: saveManualMaskVersionSpy,
  };
});

const FIXTURE_CASE_ID = '20000000-0000-4000-8000-000000000001';

function setViewportWidth(width: number): void {
  act(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: width,
    });
    window.dispatchEvent(new Event('resize'));
  });
}

function renderViewerFixture(caseId = FIXTURE_CASE_ID) {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[`/doctor/cases/${caseId}/viewer`]}>
          <Routes>
            <Route
              path="/doctor/cases/:id/viewer"
              element={<ViewerWorkspacePage />}
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('P7 Responsive Viewport Gating, Draft Safety & Export Filename Hygiene', () => {
  let restoreUrlMock: (() => void) | null = null;

  beforeEach(() => {
    if (typeof window.PointerEvent === 'undefined') {
      class MockPointerEvent extends MouseEvent {
        readonly pointerId: number;
        constructor(type: string, params: PointerEventInit = {}) {
          super(type, params);
          this.pointerId = params.pointerId ?? 1;
        }
      }
      Object.defineProperty(window, 'PointerEvent', {
        configurable: true,
        writable: true,
        value: MockPointerEvent,
      });
    }
    saveManualMaskVersionSpy.mockClear();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    useViewerStore.getState().resetViewerState();
    useAuthStore.setState({
      status: 'authenticated',
      user: FIXTURE_USERS.doctor,
      accessToken: 'doc-token',
      bootstrapError: null,
      fixtureMode: true,
      reauthRequired: false,
    });
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 1920,
    });
  });

  afterEach(() => {
    restoreUrlMock?.();
    restoreUrlMock = null;
    useViewerStore.getState().resetViewerState();
  });

  it('enables brush & 3 layout modes at desktop widths [1920, 1440, 1024] and gates to read-only at [768, 375] while keeping slice & modality controls active', async () => {
    const user = userEvent.setup();
    renderViewerFixture();

    await waitFor(() => {
      expect(screen.getByTestId('mri-viewer-workspace')).toHaveAttribute(
        'data-volume-status',
        'ready',
      );
    });

    for (const width of [1920, 1440, 1024] as const) {
      setViewportWidth(width);
      expect(screen.getByRole('button', { name: 'Tô mask' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Xóa mask' })).toBeEnabled();
      expect(screen.getByText('Chế độ chỉnh sửa')).toBeInTheDocument();
      expect(
        screen.queryByText('Chỉnh sửa mask đang tạm khóa'),
      ).not.toBeInTheDocument();

      const layoutGroup = screen.getByRole('group', { name: 'Bố cục khung nhìn' });
      expect(layoutGroup).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Đối chiếu' }),
      ).toBeEnabled();
      expect(
        screen.getByRole('button', { name: 'Lát lân cận' }),
      ).toBeEnabled();
      expect(
        screen.getByRole('button', { name: 'Ba mặt phẳng' }),
      ).toBeEnabled();
    }

    // Kiểm chứng chuyển đổi đủ 3 chế độ bố cục ở ngưỡng desktop 1024px
    await user.click(screen.getByRole('button', { name: 'Lát lân cận' }));
    expect(screen.getByTestId('pane-adjacent-prev')).toBeInTheDocument();
    expect(screen.getByTestId('pane-adjacent-next')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ba mặt phẳng' }));
    expect(screen.getByTestId('pane-coronal-readonly')).toBeInTheDocument();
    expect(screen.getByTestId('pane-sagittal-readonly')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Đối chiếu' }));
    expect(screen.getByTestId('pane-original')).toBeInTheDocument();

    for (const narrowWidth of [768, 375] as const) {
      setViewportWidth(narrowWidth);

      expect(screen.getByRole('button', { name: 'Tô mask' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Xóa mask' })).toBeDisabled();
      expect(screen.getByText('Chế độ chỉ đọc')).toBeInTheDocument();
      expect(
        screen.getByText('Chỉnh sửa mask đang tạm khóa'),
      ).toBeInTheDocument();
      expect(screen.getByText(/1024 px/)).toBeInTheDocument();
      expect(
        screen.queryByRole('group', { name: 'Bố cục khung nhìn' }),
      ).not.toBeInTheDocument();

      // Điều hướng lát cắt & chọn xung vẫn hoạt động ở màn hình hẹp
      const sliceInput = screen.getByLabelText('Số lát:');
      expect(sliceInput).toBeEnabled();
      const nextSliceBtn = screen.getByRole('button', { name: 'Lát kế tiếp' });
      expect(nextSliceBtn).toBeEnabled();
      const sliceBefore = useViewerStore.getState().currentSliceZeroBased;
      await user.click(nextSliceBtn);
      expect(useViewerStore.getState().currentSliceZeroBased).toBe(
        sliceBefore + 1,
      );

      const t1ceBtn = screen.getByRole('button', { name: 't1ce' });
      const flairBtn = screen.getByRole('button', { name: 'flair' });
      expect(t1ceBtn).toBeEnabled();
      expect(flairBtn).toBeEnabled();
      await user.click(t1ceBtn);
      expect(t1ceBtn).toHaveAttribute('aria-pressed', 'true');
      await user.click(flairBtn);
      expect(flairBtn).toHaveAttribute('aria-pressed', 'true');
    }
  });

  it('disables edit buttons on resize 1440 -> 768 while isDirty=true without auto-committing and keeps unsaved badge', async () => {
    const user = userEvent.setup();
    setViewportWidth(1440);
    renderViewerFixture();

    await waitFor(() => {
      expect(screen.getByTestId('mri-viewer-workspace')).toHaveAttribute(
        'data-volume-status',
        'ready',
      );
    });

    await user.click(screen.getByRole('button', { name: 'Tô mask' }));
    const editCanvas = screen
      .getByTestId('pane-axial-editable')
      .querySelector('canvas');
    expect(editCanvas).not.toBeNull();

    vi.spyOn(editCanvas!, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 240,
      height: 240,
      right: 240,
      bottom: 240,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(editCanvas!, { button: 0, clientX: 60, clientY: 60 });
    fireEvent.pointerUp(editCanvas!, { button: 0, clientX: 60, clientY: 60 });

    expect(useViewerStore.getState().isDirty).toBe(true);
    expect(screen.getByText('Có thay đổi chưa lưu')).toBeInTheDocument();
    expect(screen.getByText('Chưa lưu (ước tính)')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Lưu phiên bản' }),
    ).toBeEnabled();

    // Thu nhỏ từ 1440 xuống 768 khi đang có thay đổi chưa lưu
    setViewportWidth(768);

    expect(screen.getByRole('button', { name: 'Tô mask' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Xóa mask' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Hoàn tác' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Lưu phiên bản' }),
    ).toBeDisabled();

    // Tuyệt đối không tự động lưu (auto-commit) và vẫn giữ nhãn thay đổi chưa lưu
    expect(saveManualMaskVersionSpy).not.toHaveBeenCalled();
    expect(useViewerStore.getState().isDirty).toBe(true);
    expect(screen.getByText('Có thay đổi chưa lưu')).toBeInTheDocument();
    expect(screen.getByText('Chưa lưu (ước tính)')).toBeInTheDocument();
  });

  it('uses purely technical export filenames without patient full_name or patient_code', async () => {
    const user = userEvent.setup();
    const capturedFilenames: string[] = [];

    const originalCreateObjectURL = URL.createObjectURL;
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => 'blob:p7-hygiene-export',
    });
    restoreUrlMock = () => {
      if (originalCreateObjectURL) {
        Object.defineProperty(URL, 'createObjectURL', {
          configurable: true,
          value: originalCreateObjectURL,
        });
      } else {
        delete (URL as unknown as { createObjectURL?: unknown })
          .createObjectURL;
      }
    };

    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(
      function handleAnchorClick(this: HTMLAnchorElement) {
        capturedFilenames.push(this.download);
      },
    );

    setViewportWidth(1440);
    renderViewerFixture();

    await waitFor(() => {
      expect(screen.getByTestId('mri-viewer-workspace')).toHaveAttribute(
        'data-volume-status',
        'ready',
      );
    });

    await user.click(screen.getByRole('button', { name: 'Xuất (.nii.gz)' }));
    await waitFor(() => {
      expect(capturedFilenames.length).toBeGreaterThanOrEqual(1);
    });

    const maskFilename = capturedFilenames[0]!;
    expect(maskFilename).toMatch(
      new RegExp(`^mask-case-${FIXTURE_CASE_ID}-v1\\.nii\\.gz$`),
    );

    // Tuyệt đối không chứa họ tên hay mã bệnh nhân của FIXTURE_PATIENTS[0] ("Trần Văn An (Mẫu)", "BN-BRATS-001")
    const lowerMaskFilename = maskFilename.toLowerCase();
    for (const forbiddenToken of [
      'trần',
      'tran',
      'văn',
      'van',
      'bn-brats-001',
      'brats-001',
    ]) {
      expect(lowerMaskFilename).not.toContain(forbiddenToken);
    }

    await user.click(screen.getByRole('button', { name: 'JSON metadata' }));
    await waitFor(() => {
      expect(capturedFilenames.length).toBeGreaterThanOrEqual(2);
    });

    const metadataFilename = capturedFilenames[1]!;
    expect(metadataFilename).toMatch(
      new RegExp(`^mask-case-${FIXTURE_CASE_ID}-v1-metadata\\.json$`),
    );
    const lowerMetadataFilename = metadataFilename.toLowerCase();
    for (const forbiddenToken of [
      'trần',
      'tran',
      'văn',
      'van',
      'bn-brats-001',
      'brats-001',
    ]) {
      expect(lowerMetadataFilename).not.toContain(forbiddenToken);
    }
  });
});
