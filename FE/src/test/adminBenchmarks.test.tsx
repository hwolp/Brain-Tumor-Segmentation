import { QueryClient } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAuthStore } from '@/app/auth-store';
import { AppProviders } from '@/app/providers';
import { AppRoutes } from '@/app/router';
import {
  computeAutoWindowLevel,
  computeErrorMapVolume,
  computeSliceErrorCounts,
  ERROR_CODE_FN,
  ERROR_CODE_FP,
  ERROR_CODE_NONE,
  ERROR_CODE_TP,
} from '@/features/admin/benchmarkErrorMap';
import { FIXTURE_USERS } from '@/shared/api/fixtures';
import { createAppQueryClient } from '@/shared/api/queryClient';

function createTestClient(): QueryClient {
  const client = createAppQueryClient();
  client.setDefaultOptions({
    queries: { retry: false, gcTime: 0 },
  });
  return client;
}

describe('benchmarkErrorMap helpers', () => {
  it('computes TP, FP, FN voxels and slice counts accurately across WT and label scopes', () => {
    const shape: [number, number, number] = [4, 4, 2];
    const affine = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
    ];
    const total = 4 * 4 * 2;
    const gt = new Uint8Array(total);
    const pred = new Uint8Array(total);

    // Flat index for Nibabel column-major (x + y*nx + z*nx*ny)
    const idx = (x: number, y: number, z: number) => x + y * 4 + z * 16;

    // z=1:
    // (0,0,1): GT=2, Pred=2 -> TP
    gt[idx(0, 0, 1)] = 2;
    pred[idx(0, 0, 1)] = 2;
    // (1,0,1): GT=0, Pred=4 -> FP
    pred[idx(1, 0, 1)] = 4;
    // (2,0,1): GT=1, Pred=0 -> FN
    gt[idx(2, 0, 1)] = 1;

    const wtMap = computeErrorMapVolume(pred, gt, 'WT');
    expect(wtMap[idx(0, 0, 1)]).toBe(ERROR_CODE_TP);
    expect(wtMap[idx(1, 0, 1)]).toBe(ERROR_CODE_FP);
    expect(wtMap[idx(2, 0, 1)]).toBe(ERROR_CODE_FN);
    expect(wtMap[idx(3, 3, 1)]).toBe(ERROR_CODE_NONE);

    const countsZ1 = computeSliceErrorCounts(wtMap, 'axial', 1, shape, affine);
    expect(countsZ1).toEqual({ tp: 1, fp: 1, fn: 1 });

    // Under TC ({1, 4}), (0,0,1) label=2 is ignored while (1,0,1) is FP and (2,0,1) is FN
    const tcMap = computeErrorMapVolume(pred, gt, 'TC');
    const tcCounts = computeSliceErrorCounts(tcMap, 'axial', 1, shape, affine);
    expect(tcCounts).toEqual({ tp: 0, fp: 1, fn: 1 });
  });

  it('computes non-zero finite window/level bounds cleanly', () => {
    const mri = new Float32Array([0, 0, 10, 50, Number.NaN, 0]);
    const wl = computeAutoWindowLevel(mri);
    expect(wl.center).toBeCloseTo(30);
    expect(wl.width).toBeCloseTo(40);
  });
});

describe('AdminBenchmarksPage & Route Guard', () => {
  beforeEach(() => {
    useAuthStore.setState({
      status: 'authenticated',
      user: FIXTURE_USERS.admin,
      accessToken: 'admin-tok',
      bootstrapError: null,
      fixtureMode: true,
    });
  });

  function renderBenchmarks(client = createTestClient()) {
    return render(
      <AppProviders client={client} autoBootstrap={false}>
        <MemoryRouter initialEntries={['/admin/benchmarks']}>
          <AppRoutes />
        </MemoryRouter>
      </AppProviders>,
    );
  }

  it('blocks Doctor from /admin/benchmarks (403)', () => {
    useAuthStore.setState({
      status: 'authenticated',
      user: FIXTURE_USERS.doctor,
      accessToken: 'doc-tok',
      fixtureMode: true,
    });
    renderBenchmarks();
    expect(screen.getByText('Không có quyền truy cập')).toBeInTheDocument();
  });

  it('renders worker selector, loads fixture history, shows quantitative metrics, and deletes a benchmark', async () => {
    const user = userEvent.setup();
    renderBenchmarks();

    // Navigation & Heading
    expect(
      screen.getByRole('heading', {
        name: /Kiểm định & So sánh AI với Nhãn Bác sĩ/i,
      }),
    ).toBeInTheDocument();

    // Worker dropdown populated
    await waitFor(() => {
      expect(
        screen.getByRole('option', { name: /worker-local-01/i }),
      ).toBeInTheDocument();
    });

    // History table populated from fixture
    await waitFor(() => {
      expect(
        screen.getByText('BraTS20_Training_001 - Worker GPU'),
      ).toBeInTheDocument();
    });

    // Click "Xem kết quả" -> Quantitative table appears
    await user.click(screen.getByRole('button', { name: 'Xem kết quả' }));
    await waitFor(() => {
      expect(screen.getByText('Mean Dice (BraTS)')).toBeInTheDocument();
      expect(screen.getAllByText('0.9125').length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText('WT — Toàn bộ khối u (1 + 2 + 4)')).toBeInTheDocument();
      expect(screen.getByText('99.7%')).toBeInTheDocument();
    });

    // Delete the benchmark via ConfirmDialog
    await user.click(
      screen.getByRole('button', {
        name: 'Xóa BraTS20_Training_001 - Worker GPU',
      }),
    );
    expect(
      screen.getByText('Xóa lượt kiểm định AI?'),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Xóa và dọn tệp' }));
    await waitFor(() => {
      expect(
        screen.getByText('Chưa có lượt kiểm định AI nào'),
      ).toBeInTheDocument();
    });
  });
});
