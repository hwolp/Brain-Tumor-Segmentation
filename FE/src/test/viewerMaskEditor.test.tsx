import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useAuthStore } from '@/app/auth-store';
import { bumpSessionEpoch } from '@/shared/api/client';
import { downloadMaskVersionExport } from '@/shared/api/maskVersions';
import { FIXTURE_USERS } from '@/shared/api/fixtures';
import { ToastProvider } from '@/shared/ui';
import { ViewerWorkspacePage } from '@/features/viewer/ViewerWorkspacePage';
import type { MaskVersionDto } from '@/shared/api/types';
import {
  MaskEditorEngine,
  computeMaskStatistics,
  computeSliceBrushIndices,
  createEmptyMaskBuffer,
  createSyntheticBrainVolumes,
  displayPointToVoxelCoord,
  findNextMaskSlice,
  interpolateDisplayStroke,
  parseNiftiVolume,
  parsedVolumeToUint8Mask,
  resolveAxialSliceAxes,
  serializeNiftiMask,
  useViewerStore,
  voxelCoordToFlatIndex,
  type VolumeGeometry,
} from '@/viewer-adapter';

function renderViewer(caseId = '20000000-0000-4000-8000-000000000001') {
  const qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  const view = render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <MemoryRouter initialEntries={[`/doctor/cases/${caseId}/viewer`]}>
          <Routes>
            <Route
              path="/doctor/cases/:id/viewer"
              element={<ViewerWorkspacePage />}
            />
            <Route
              path="/doctor/cases/:id"
              element={<div data-testid="case-detail-page">Chi tiết ca</div>}
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );

  return { ...view, queryClient: qc };
}

interface MockVersionSpec {
  id: string;
  version_number: number;
  mask?: Uint8Array;
  source?: 'ai' | 'manual';
}

async function mockLiveViewerApi(options: {
  caseId: string;
  geometry: VolumeGeometry;
  versions?: MockVersionSpec[];
  onPost?: (body: FormData) => Response;
}) {
  const versions = [...(options.versions ?? [])].sort(
    (a, b) => b.version_number - a.version_number,
  );
  const empty = createEmptyMaskBuffer(options.geometry.shape);
  const mriBytes = await serializeNiftiMask(empty, options.geometry, {
    gzip: true,
  });
  const fileBytes = new Map<string, Uint8Array>([
    ['file-mri', mriBytes],
  ]);
  const versionDtos: MaskVersionDto[] = [];
  for (const version of versions) {
    const fileId = `file-${version.id}`;
    const bytes = await serializeNiftiMask(
      version.mask ?? empty,
      options.geometry,
      { gzip: true },
    );
    fileBytes.set(fileId, bytes);
    versionDtos.push({
      id: version.id,
      case_id: options.caseId,
      version_number: version.version_number,
      source: version.source ?? 'manual',
      base_version_id: null,
      reference_volume_id: 'vol-mri',
      file_id: fileId,
      created_by: FIXTURE_USERS.doctor.id,
      job_id: null,
      model_version_id: null,
      created_at: `2026-05-${String(version.version_number).padStart(2, '0')}T00:00:00Z`,
      note: null,
      label_voxel_counts: { '1': 0, '2': 0, '4': 0 },
      label_volumes_mm3: { '1': 0, '2': 0, '4': 0 },
      sha256: `hash-${version.id}`,
    });
  }

  const { shape, spacingMm, affine } = options.geometry;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input.toString(),
      'http://localhost',
    );
    const path = url.pathname;
    const method = init?.method ?? 'GET';
    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });

    if (path.endsWith(`/cases/${options.caseId}`) && method === 'GET') {
      return json({
        id: options.caseId,
        patient_id: 'patient-1',
        study_date: '2026-05-01',
        notes: null,
        reference_volume_id: 'vol-mri',
        readiness: 'ready',
        latest_mask_version_id: versionDtos[0]?.id ?? null,
        created_at: '2026-05-01T00:00:00Z',
        updated_at: '2026-05-01T00:00:00Z',
      });
    }
    if (path.endsWith(`/cases/${options.caseId}/volumes`) && method === 'GET') {
      return json([
        {
          id: 'vol-mri',
          case_id: options.caseId,
          modality: 'flair',
          file_id: 'file-mri',
          filename: 'mri.nii.gz',
          validation_status: 'valid',
          validation_error: null,
          shape,
          spacing_mm: spacingMm,
          affine,
          orientation: 'RAS',
          size_bytes: mriBytes.byteLength,
          sha256: 'mri-hash',
        },
      ]);
    }
    if (path.endsWith(`/cases/${options.caseId}/jobs`) && method === 'GET') {
      return json({ items: [], total: 0, page: 1, page_size: 20 });
    }
    if (path.endsWith(`/cases/${options.caseId}/mask-versions`) && method === 'POST') {
      return options.onPost?.(init?.body as FormData) ?? json({ error: { code: 'internal_error' } }, 500);
    }
    if (path.endsWith(`/cases/${options.caseId}/mask-versions`) && method === 'GET') {
      const page = Number(url.searchParams.get('page') ?? 1);
      const pageSize = Number(url.searchParams.get('page_size') ?? 20);
      const start = (page - 1) * pageSize;
      return json({
        items: versionDtos.slice(start, start + pageSize),
        total: versionDtos.length,
        page,
        page_size: pageSize,
      });
    }
    const delMaskMatch = path.match(/\/mask-versions\/([^/]+)$/);
    if (delMaskMatch && method === 'DELETE') {
      const targetId = decodeURIComponent(delMaskMatch[1]!);
      const idx = versionDtos.findIndex((item) => item.id === targetId);
      if (idx === -1) {
        return json({ error: { code: 'mask_version_not_found' } }, 404);
      }
      if (versionDtos[idx]!.source !== 'manual') {
        return json({ error: { code: 'ai_mask_not_deletable' } }, 409);
      }
      versionDtos.splice(idx, 1);
      return json(
        {
          resource_type: 'mask_version',
          resource_id: targetId,
          status: 'deleted',
          files_cleaned: 1,
          message: 'Đã xóa phiên bản mask thủ công.',
        },
        202,
      );
    }
    const fileMatch = path.match(/\/files\/([^/]+)\/content$/);
    if (fileMatch && method === 'GET') {
      const bytes = fileBytes.get(decodeURIComponent(fileMatch[1]!));
      return bytes
        ? new Response(bytes.slice().buffer, { status: 200 })
        : new Response(null, { status: 404 });
    }
    if (/\/mask-versions\/[^/]+\/metadata$/.test(path)) {
      return json({ error: { code: 'not_found' } }, 404);
    }
    return new Response(null, { status: 404 });
  });
}

let restoreObjectUrlMock: (() => void) | null = null;

function captureDownloadBlobs(): Blob[] {
  const original = URL.createObjectURL;
  const blobs: Blob[] = [];
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob) => {
      blobs.push(blob);
      return `blob:viewer-test-${blobs.length}`;
    },
  });
  restoreObjectUrlMock = () => {
    if (original) {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: original,
      });
    } else {
      delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    }
    restoreObjectUrlMock = null;
  };
  return blobs;
}

async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'));
    reader.readAsArrayBuffer(blob);
  });
}

async function exportCurrentDraft(
  user: ReturnType<typeof userEvent.setup>,
  blobs: Blob[],
) {
  const previousCount = blobs.length;
  await user.click(screen.getByRole('button', { name: 'Xuất (.nii.gz)' }));
  if (useViewerStore.getState().isDirty) {
    await user.click(
      screen.getByRole('button', { name: 'Xuất bản nháp cục bộ (.nii.gz)' }),
    );
  }
  await waitFor(() => expect(blobs.length).toBeGreaterThan(previousCount));
  return parseNiftiVolume(await blobToArrayBuffer(blobs[blobs.length - 1]!));
}

describe('P4 NIfTI-1 Codec, Geometry & MaskEditorEngine', () => {
  it('round-trips NIfTI-1 (.nii.gz) preserving {0,1,2,4} labels, asymmetric landmarks, affine & spacing', async () => {
    const geometry: VolumeGeometry = {
      shape: [16, 12, 8],
      spacingMm: [1.25, 1.5, 2.0],
      affine: [
        [-1.25, 0, 0, 10],
        [0, 1.5, 0, -9],
        [0, 0, 2.0, -8],
        [0, 0, 0, 1],
      ],
    };
    const mask = createEmptyMaskBuffer(geometry.shape);
    const idx1 = voxelCoordToFlatIndex(2, 3, 4, geometry.shape);
    const idx2 = voxelCoordToFlatIndex(13, 9, 5, geometry.shape);
    const idx4 = voxelCoordToFlatIndex(7, 5, 2, geometry.shape);
    mask[idx1] = 1;
    mask[idx2] = 2;
    mask[idx4] = 4;

    const gz = await serializeNiftiMask(mask, geometry, { gzip: true });
    expect(gz[0]).toBe(0x1f);
    expect(gz[1]).toBe(0x8b);

    const parsed = await parseNiftiVolume(gz);
    expect(parsed.shape).toEqual([16, 12, 8]);
    expect(parsed.spacingMm[0]).toBeCloseTo(1.25, 4);
    expect(parsed.spacingMm[1]).toBeCloseTo(1.5, 4);
    expect(parsed.spacingMm[2]).toBeCloseTo(2.0, 4);
    expect(parsed.affine[0]).toEqual([-1.25, 0, 0, 10]);
    expect(parsed.affine[1]).toEqual([0, 1.5, 0, -9]);
    expect(parsed.affine[2]).toEqual([0, 0, 2.0, -8]);

    const restored = parsedVolumeToUint8Mask(parsed);
    expect(restored[idx1]).toBe(1);
    expect(restored[idx2]).toBe(2);
    expect(restored[idx4]).toBe(4);
    expect(restored.reduce((acc, v) => acc + (v > 0 ? 1 : 0), 0)).toBe(3);
  });

  it('QA-MASK-01: maps asymmetric display coordinates -> exact voxel coordinates across flipped/permuted affine & brush radius', () => {
    const shape: [number, number, number] = [32, 24, 16];
    const permutedFlippedAffine = [
      [0, 1.5, 0, -18],
      [-2.0, 0, 0, 32],
      [0, 0, 3.0, -24],
      [0, 0, 0, 1],
    ];

    const axes = resolveAxialSliceAxes(permutedFlippedAffine, shape);
    expect(axes.axialAxis).toBe(2);
    expect(axes.colAxis).toBe(1); // affine[0][1] = 1.5
    expect(axes.rowAxis).toBe(0); // affine[1][0] = -2.0
    expect(axes.flipHorizontal).toBe(true); // +X on left (radiological R)
    expect(axes.flipVertical).toBe(false);
    expect(axes.leftRightAnnotation).toEqual({ left: 'R', right: 'L' });

    const voxel = displayPointToVoxelCoord(
      2,
      5,
      7,
      permutedFlippedAffine,
      shape,
    );
    // colDim = 24 -> flipped displayX=2 => col=21 (axis 1); rowDim = 32 -> displayY=5 (axis 0)
    expect(voxel).toEqual([5, 21, 7]);

    // Circular brush on slice 7 only, never modifying slice 6 or 8
    const brushIndices = computeSliceBrushIndices(
      voxel,
      3,
      7,
      permutedFlippedAffine,
      shape,
    );
    expect(brushIndices.length).toBeGreaterThan(1);
    const sliceStride = shape[0] * shape[1];
    for (const flat of brushIndices) {
      const z = Math.floor(flat / sliceStride);
      expect(z).toBe(7);
    }

    const interiorCenter: [number, number, number] = [16, 12, 7];
    const radiusOne = computeSliceBrushIndices(
      interiorCenter,
      1,
      7,
      permutedFlippedAffine,
      shape,
    );
    const radiusThree = computeSliceBrushIndices(
      interiorCenter,
      3,
      7,
      permutedFlippedAffine,
      shape,
    );
    expect(radiusOne).toHaveLength(5);
    expect(radiusThree).toHaveLength(29);
    expect(radiusThree).toContain(
      voxelCoordToFlatIndex(16, 15, 7, shape),
    );

    // Stroke interpolation leaves no gaps on fast pointer movement
    const pts = interpolateDisplayStroke({ x: 2, y: 5 }, { x: 10, y: 5 });
    expect(pts.length).toBe(9);
  });

  it('QA-MASK-03: per-slice undo/redo, dirty clearing when back to base, occupancy jump & history eviction', () => {
    const shape: [number, number, number] = [16, 16, 10];
    const affine = [
      [1, 0, 0, 0],
      [0, 1, 0, 0],
      [0, 0, 2, 0],
      [0, 0, 0, 1],
    ];
    const base = createEmptyMaskBuffer(shape);
    const engine = new MaskEditorEngine({ maxStrokesPerSlice: 3 });
    engine.initialize(base, shape, affine);

    const idxSlice2 = voxelCoordToFlatIndex(4, 4, 2, shape);
    const idxSlice6 = voxelCoordToFlatIndex(5, 5, 6, shape);

    engine.applyStroke(2, [idxSlice2], 1);
    engine.applyStroke(6, [idxSlice6], 4);
    expect(engine.isDirty()).toBe(true);
    expect(engine.getDirtySlices()).toEqual(new Set([2, 6]));

    // Occupancy jump prev/next
    expect(
      findNextMaskSlice(
        engine.getOccupiedSlices(),
        engine.getDirtySlices(),
        4,
        'prev',
      ),
    ).toBe(2);
    expect(
      findNextMaskSlice(
        engine.getOccupiedSlices(),
        engine.getDirtySlices(),
        4,
        'next',
      ),
    ).toBe(6);

    // Undo slice 2 & slice 6 -> back to exact base clears dirty
    expect(engine.undo(2)).toBe(true);
    expect(engine.isDirty()).toBe(true);
    expect(engine.undo(6)).toBe(true);
    expect(engine.isDirty()).toBe(false);

    // Redo restores slice 2
    expect(engine.redo(2)).toBe(true);
    expect(engine.isDirty()).toBe(true);
    expect(engine.getWorkingBuffer()[idxSlice2]).toBe(1);

    // Exceeding maxStrokesPerSlice (3) evicts oldest history without discarding edits
    engine.applyStroke(2, [voxelCoordToFlatIndex(1, 1, 2, shape)], 2);
    engine.applyStroke(2, [voxelCoordToFlatIndex(2, 1, 2, shape)], 2);
    engine.applyStroke(2, [voxelCoordToFlatIndex(3, 1, 2, shape)], 2);
    expect(engine.getHistoryLimitMessage()).toContain('giới hạn 3 nét');
    expect(
      engine.getWorkingBuffer()[voxelCoordToFlatIndex(3, 1, 2, shape)],
    ).toBe(2);

    // Stats calculation uses abs(det(affine)) = 2 mm3 per voxel
    const stats = computeMaskStatistics(engine.getWorkingBuffer(), affine, shape);
    expect(stats.volumesMm3[1]).toBe(2);
    expect(stats.volumesMm3[2]).toBe(6);
    expect(stats.compositeMm3.WT).toBe(8);
  });

  it('QA-MASK-03: serializes and reloads the redone engine buffer with labels and geometry intact', async () => {
    const geometry: VolumeGeometry = {
      shape: [16, 12, 8],
      spacingMm: [1.25, 1.5, 2],
      affine: [
        [-1.25, 0, 0, 10],
        [0, 1.5, 0, -9],
        [0, 0, 2, -8],
        [0, 0, 0, 1],
      ],
    };
    const base = createEmptyMaskBuffer(geometry.shape);
    const label1 = voxelCoordToFlatIndex(2, 3, 4, geometry.shape);
    const label2 = voxelCoordToFlatIndex(13, 9, 5, geometry.shape);
    const label4 = voxelCoordToFlatIndex(7, 5, 2, geometry.shape);
    const edited = voxelCoordToFlatIndex(8, 6, 3, geometry.shape);
    base[label1] = 1;
    base[label2] = 2;
    base[label4] = 4;

    const engine = new MaskEditorEngine();
    engine.initialize(base, geometry.shape, geometry.affine);
    expect(engine.applyStroke(3, [edited], 4)).toBe(true);
    expect(engine.undo(3)).toBe(true);
    expect(engine.redo(3)).toBe(true);

    const encoded = await serializeNiftiMask(engine.getWorkingMaskSnapshot(), geometry, {
      gzip: true,
    });
    const restored = await parseNiftiVolume(encoded);
    const restoredMask = parsedVolumeToUint8Mask(restored);
    expect(restored.shape).toEqual(geometry.shape);
    expect(restored.spacingMm[0]).toBeCloseTo(1.25, 4);
    expect(restored.spacingMm[1]).toBeCloseTo(1.5, 4);
    expect(restored.spacingMm[2]).toBeCloseTo(2, 4);
    expect(restored.affine).toEqual(geometry.affine);
    expect(restoredMask[label1]).toBe(1);
    expect(restoredMask[label2]).toBe(2);
    expect(restoredMask[label4]).toBe(4);
    expect(restoredMask[edited]).toBe(4);
  });

  it('generates deterministic asymmetric synthetic brain volumes', () => {
    const synth = createSyntheticBrainVolumes([48, 48, 24]);
    expect(synth.flair.length).toBe(48 * 48 * 24);
    expect(synth.aiMask.some((v) => v === 1)).toBe(true);
    expect(synth.aiMask.some((v) => v === 2)).toBe(true);
    expect(synth.aiMask.some((v) => v === 4)).toBe(true);
  });
});

describe('P4 ViewerWorkspacePage Interactive Flows (QA-MASK-02/04/05)', () => {
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
    restoreObjectUrlMock?.();
    vi.restoreAllMocks();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    useViewerStore.getState().resetViewerState();
    useAuthStore.setState({
      status: 'authenticated',
      user: FIXTURE_USERS.doctor,
      accessToken: 'doc-token',
      fixtureMode: true,
      reauthRequired: false,
    });
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 1280,
    });
  });

  afterEach(() => {
    restoreObjectUrlMock?.();
    useViewerStore.getState().resetViewerState();
  });

  it('QA-MASK-01: exports the exact clicked voxel after zoom and pan; the original pane remains unchanged', async () => {
    const user = userEvent.setup();
    const blobs = captureDownloadBlobs();
    const caseId = '20000000-0000-4000-8000-000000000011';
    const geometry: VolumeGeometry = {
      shape: [9, 8, 4],
      spacingMm: [2, 1.5, 2],
      affine: [
        [0, 1.5, 0, -18],
        [-2, 0, 0, 32],
        [0, 0, 2, -24],
        [0, 0, 0, 1],
      ],
    };
    await mockLiveViewerApi({ caseId, geometry });
    useAuthStore.setState({ fixtureMode: false });
    useViewerStore.getState().setBrushRadius(1);
    useViewerStore.getState().setZoomLevel(1.5);
    useViewerStore.getState().setPanOffset({ x: 13, y: -8 });
    expect(useViewerStore.getState().zoomLevel).toBe(1.5);
    expect(useViewerStore.getState().panOffset).toEqual({ x: 13, y: -8 });
    renderViewer(caseId);

    await waitFor(() => {
      expect(screen.getByTestId('mri-viewer-workspace')).toHaveAttribute(
        'data-volume-status',
        'ready',
      );
    });
    act(() => useViewerStore.getState().setSliceIndex(1));
    await user.click(screen.getByRole('button', { name: 'Tô mask' }));

    const pointerX = 113 + (2.2 / 8) * 120;
    const pointerY = 62 + (4.2 / 9) * 135;
    const originalCanvas = screen
      .getByTestId('pane-original')
      .querySelector('canvas')!;
    vi.spyOn(originalCanvas, 'getBoundingClientRect').mockReturnValue({
      left: 113,
      top: 62,
      width: 120,
      height: 135,
      right: 233,
      bottom: 197,
      x: 113,
      y: 62,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(originalCanvas, {
      button: 0,
      clientX: pointerX,
      clientY: pointerY,
    });
    fireEvent.pointerUp(originalCanvas, {
      button: 0,
      clientX: pointerX,
      clientY: pointerY,
    });
    expect(useViewerStore.getState().isDirty).toBe(false);
    const afterOriginalClick = await exportCurrentDraft(user, blobs);
    expect(parsedVolumeToUint8Mask(afterOriginalClick).every((value) => value === 0)).toBe(true);

    const editCanvas = screen
      .getByTestId('pane-axial-editable')
      .querySelector('canvas')!;
    vi.spyOn(editCanvas, 'getBoundingClientRect').mockReturnValue({
      left: 113,
      top: 62,
      width: 120,
      height: 135,
      right: 233,
      bottom: 197,
      x: 113,
      y: 62,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(editCanvas, {
      button: 0,
      clientX: pointerX,
      clientY: pointerY,
    });
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(useViewerStore.getState().currentSliceZeroBased).toBe(1);
    fireEvent.pointerUp(editCanvas, {
      button: 0,
      clientX: pointerX,
      clientY: pointerY,
    });

    const exported = await exportCurrentDraft(user, blobs);
    expect(exported.shape).toEqual(geometry.shape);
    const exportedMask = parsedVolumeToUint8Mask(exported);
    const expectedVoxel = displayPointToVoxelCoord(
      2,
      4,
      1,
      geometry.affine,
      geometry.shape,
    );
    expect(expectedVoxel).toEqual([4, 5, 1]);
    expect(exportedMask[voxelCoordToFlatIndex(...expectedVoxel, geometry.shape)]).toBe(1);
    expect(exportedMask.reduce((count, value) => count + Number(value > 0), 0)).toBe(5);
  });

  it('rejects an export when the session changes while the response body is being read', async () => {
    useAuthStore.setState({ fixtureMode: false });
    let releaseBody!: () => void;
    const body = new Promise<Blob>((resolve) => {
      releaseBody = () => resolve(new Blob([new Uint8Array([1, 2, 3]).buffer]));
    });
    const response = new Response(null, { status: 200 });
    const blobSpy = vi.spyOn(response, 'blob').mockImplementation(() => body);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);

    const exportPromise = downloadMaskVersionExport('version-export-test');
    await waitFor(() => expect(blobSpy).toHaveBeenCalled());
    bumpSessionEpoch();
    releaseBody();

    await expect(exportPromise).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('QA-MASK-02: keeps the edited voxel on slice k and leaves slice k+1 empty in the exported mask', async () => {
    const user = userEvent.setup();
    const blobs = captureDownloadBlobs();
    const caseId = '20000000-0000-4000-8000-000000000012';
    const geometry: VolumeGeometry = {
      shape: [8, 8, 4],
      spacingMm: [1, 1, 1],
      affine: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
    };
    await mockLiveViewerApi({ caseId, geometry });
    useAuthStore.setState({ fixtureMode: false });
    useViewerStore.getState().setBrushRadius(1);
    renderViewer(caseId);

    await waitFor(() => {
      expect(screen.getByTestId('mri-viewer-workspace')).toHaveAttribute(
        'data-volume-status',
        'ready',
      );
    });
    await user.click(screen.getByRole('button', { name: 'Tô mask' }));
    const canvas = screen
      .getByTestId('pane-axial-editable')
      .querySelector('canvas')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 80,
      height: 80,
      right: 80,
      bottom: 80,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(canvas, { button: 0, clientX: 35, clientY: 25 });
    fireEvent.pointerUp(canvas, { button: 0, clientX: 35, clientY: 25 });
    await user.click(screen.getByRole('button', { name: 'Lát kế tiếp' }));
    expect(useViewerStore.getState().currentSliceZeroBased).toBe(1);
    await user.click(screen.getByRole('button', { name: 'Lát trước' }));
    expect(useViewerStore.getState().currentSliceZeroBased).toBe(0);

    const exported = await exportCurrentDraft(user, blobs);
    const mask = parsedVolumeToUint8Mask(exported);
    const paintedVoxel = displayPointToVoxelCoord(
      3,
      2,
      0,
      geometry.affine,
      geometry.shape,
    );
    expect(mask[voxelCoordToFlatIndex(...paintedVoxel, geometry.shape)]).toBe(1);
    expect(mask.slice(geometry.shape[0] * geometry.shape[1], 2 * geometry.shape[0] * geometry.shape[1]).every((value) => value === 0)).toBe(true);
  });

  it('loads and selects mask versions beyond the first 20', async () => {
    const user = userEvent.setup();
    const caseId = '20000000-0000-4000-8000-000000000013';
    const geometry: VolumeGeometry = {
      shape: [8, 8, 4],
      spacingMm: [1, 1, 1],
      affine: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
    };
    const versions = Array.from({ length: 21 }, (_, index) => ({
      id: `version-${index + 1}`,
      version_number: index + 1,
    }));
    await mockLiveViewerApi({ caseId, geometry, versions });
    useAuthStore.setState({ fixtureMode: false });
    renderViewer(caseId);

    const selector = await screen.findByRole('combobox', {
      name: 'Chọn phiên bản mask',
    });
    await waitFor(() => {
      expect(selector.querySelectorAll('option')).toHaveLength(21);
    });
    expect(screen.getByRole('option', { name: /v1 · Thủ công/ })).toBeInTheDocument();
    await user.selectOptions(selector, 'version-1');
    await waitFor(() => expect(selector).toHaveValue('version-1'));
  });

  it('sends the selected older version as the save base version', async () => {
    const user = userEvent.setup();
    const caseId = '20000000-0000-4000-8000-000000000014';
    const geometry: VolumeGeometry = {
      shape: [8, 8, 4],
      spacingMm: [1, 1, 1],
      affine: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
    };
    let savedBaseVersion: FormDataEntryValue | null = null;
    await mockLiveViewerApi({
      caseId,
      geometry,
      versions: [
        { id: 'version-old', version_number: 1 },
        { id: 'version-head', version_number: 2 },
      ],
      onPost: (body) => {
        savedBaseVersion = body.get('base_version_id');
        return new Response(
          JSON.stringify({
            error: {
              code: 'mask_version_conflict',
              message: 'Conflict',
              request_id: 'old-base-test',
            },
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    useAuthStore.setState({ fixtureMode: false });
    useViewerStore.getState().setBrushRadius(1);
    renderViewer(caseId);

    await waitFor(() => {
      expect(screen.getByTestId('mri-viewer-workspace')).toHaveAttribute(
        'data-volume-status',
        'ready',
      );
    });
    const selector = screen.getByRole('combobox', {
      name: 'Chọn phiên bản mask',
    });
    await user.selectOptions(selector, 'version-old');
    await waitFor(() => expect(selector).toHaveValue('version-old'));
    await waitFor(() => {
      expect(useViewerStore.getState().activeVersionId).toBe('version-old');
    });
    await user.click(screen.getByRole('button', { name: 'Tô mask' }));
    const canvas = screen
      .getByTestId('pane-axial-editable')
      .querySelector('canvas')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 8,
      height: 8,
      right: 8,
      bottom: 8,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(canvas, { button: 0, clientX: 3, clientY: 3 });
    fireEvent.pointerUp(canvas, { button: 0, clientX: 3, clientY: 3 });
    await user.click(screen.getByRole('button', { name: 'Lưu phiên bản' }));
    await user.click(screen.getByRole('button', { name: 'Xác nhận lưu phiên bản' }));

    await screen.findByText('Xung đột phiên bản mask (409)');
    expect(savedBaseVersion).toBe('version-old');
  });

  it('preserves edits made after a retry snapshot when that retry succeeds', async () => {
    const user = userEvent.setup();
    const blobs = captureDownloadBlobs();
    const caseId = '20000000-0000-4000-8000-000000000015';
    const geometry: VolumeGeometry = {
      shape: [8, 8, 4],
      spacingMm: [1, 1, 1],
      affine: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
    };
    let postCount = 0;
    await mockLiveViewerApi({
      caseId,
      geometry,
      onPost: () => {
        postCount += 1;
        if (postCount === 1) {
          return new Response(
            JSON.stringify({
              error: { code: 'internal_error', message: 'Timeout', request_id: 'retry-snapshot' },
            }),
            { status: 503, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            id: 'version-saved',
            case_id: caseId,
            version_number: 1,
            source: 'manual',
            base_version_id: null,
            reference_volume_id: 'vol-mri',
            file_id: 'file-mri',
            created_by: FIXTURE_USERS.doctor.id,
            created_at: '2026-05-22T00:00:00Z',
            note: null,
            label_voxel_counts: { '1': 5, '2': 0, '4': 0 },
            label_volumes_mm3: { '1': 5, '2': 0, '4': 0 },
            sha256: 'saved-mask',
          }),
          { status: 201, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    useAuthStore.setState({ fixtureMode: false });
    useViewerStore.getState().setBrushRadius(1);
    renderViewer(caseId);

    await waitFor(() => {
      expect(screen.getByTestId('mri-viewer-workspace')).toHaveAttribute(
        'data-volume-status',
        'ready',
      );
    });
    await user.click(screen.getByRole('button', { name: 'Tô mask' }));
    const canvas = screen
      .getByTestId('pane-axial-editable')
      .querySelector('canvas')!;
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 8,
      height: 8,
      right: 8,
      bottom: 8,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(canvas, { button: 0, clientX: 2, clientY: 2 });
    fireEvent.pointerUp(canvas, { button: 0, clientX: 2, clientY: 2 });
    await user.click(screen.getByRole('button', { name: 'Lưu phiên bản' }));
    await user.click(screen.getByRole('button', { name: 'Xác nhận lưu phiên bản' }));
    await screen.findByRole('button', { name: 'Thử lại lưu (cùng khóa)' });

    fireEvent.pointerDown(canvas, { button: 0, clientX: 5, clientY: 2 });
    fireEvent.pointerUp(canvas, { button: 0, clientX: 5, clientY: 2 });
    expect(useViewerStore.getState().isDirty).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Thử lại lưu (cùng khóa)' }));

    await waitFor(() => {
      expect(postCount).toBe(2);
      expect(screen.getByRole('button', { name: 'Lưu phiên bản' })).toBeEnabled();
    });
    expect(useViewerStore.getState().isDirty).toBe(true);
    const exported = await exportCurrentDraft(user, blobs);
    const mask = parsedVolumeToUint8Mask(exported);
    const firstCenter = displayPointToVoxelCoord(2, 2, 0, geometry.affine, geometry.shape);
    const secondCenter = displayPointToVoxelCoord(5, 2, 0, geometry.affine, geometry.shape);
    const firstDisk = computeSliceBrushIndices(firstCenter, 1, 0, geometry.affine, geometry.shape);
    const secondDisk = computeSliceBrushIndices(secondCenter, 1, 0, geometry.affine, geometry.shape);
    expect(firstDisk.every((index) => mask[index] === 1)).toBe(true);
    expect(secondDisk.every((index) => mask[index] === 1)).toBe(true);
    expect(mask.reduce((count, value) => count + Number(value > 0), 0)).toBe(
      firstDisk.length + secondDisk.length,
    );
  });

  it('QA-MASK-02: paints only on editable axial pane (never original/adjacent/coronal/sagittal), preserves across slice/modality/layout switch', async () => {
    const user = userEvent.setup();
    renderViewer();

    await screen.findByTestId('pane-axial-editable');
    await waitFor(() => {
      expect(screen.getByTestId('mri-viewer-workspace')).toHaveAttribute(
        'data-volume-status',
        'ready',
      );
    });

    // Chọn công cụ Tô mask + nhãn 4: ET
    await user.click(screen.getByRole('button', { name: 'Tô mask' }));
    await user.click(screen.getByRole('button', { name: /4: ET/ }));

    // Click lên khung MRI gốc (bên trái) -> KHÔNG làm dirty
    const origPane = screen.getByTestId('pane-original');
    const origCanvas = origPane.querySelector('canvas')!;
    fireEvent.pointerDown(origCanvas, { button: 0, clientX: 50, clientY: 50 });
    fireEvent.pointerUp(origCanvas, { button: 0, clientX: 50, clientY: 50 });
    expect(useViewerStore.getState().isDirty).toBe(false);

    // Vẽ lên khung Axial có thể tô -> tạo dirty ở lát 0
    const editPane = screen.getByTestId('pane-axial-editable');
    const editCanvas = editPane.querySelector('canvas')!;
    vi.spyOn(editCanvas, 'getBoundingClientRect').mockReturnValue({
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

    fireEvent.pointerDown(editCanvas, { button: 0, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(editCanvas, { button: 0, clientX: 25, clientY: 20 });
    fireEvent.pointerUp(editCanvas, { button: 0, clientX: 25, clientY: 20 });

    expect(useViewerStore.getState().isDirty).toBe(true);
    expect(useViewerStore.getState().dirtySlices).toContain(0);
    expect(screen.getByText('Chưa lưu (ước tính)')).toBeInTheDocument();

    // Đổi sang lát kế tiếp (lát 1) -> không mất dirty lát 0
    await user.click(screen.getByRole('button', { name: 'Lát kế tiếp' }));
    expect(useViewerStore.getState().currentSliceZeroBased).toBe(1);
    expect(useViewerStore.getState().isDirty).toBe(true);

    // Đổi sang T1ce & bố cục Lát lân cận -> giữ nguyên dirty & hiển thị "Không có lát" ở biên k=0
    await user.click(screen.getByRole('button', { name: 't1ce' }));
    await user.click(screen.getByRole('button', { name: 'Lát trước' }));
    await user.click(screen.getByRole('button', { name: 'Lát lân cận' }));

    const prevAdj = screen.getByTestId('pane-adjacent-prev');
    expect(prevAdj).toHaveTextContent('Không có lát');

    // Đổi sang Ba mặt phẳng -> Coronal & Sagittal chỉ đọc
    await user.click(screen.getByRole('button', { name: 'Ba mặt phẳng' }));
    expect(screen.getByTestId('pane-coronal-readonly')).toHaveTextContent(
      'Chỉ đọc',
    );
    expect(screen.getByTestId('pane-sagittal-readonly')).toHaveTextContent(
      'Chỉ đọc',
    );

    // Hoàn tác trên lát 0 -> trở về bản nền -> hết dirty
    await user.click(screen.getByRole('button', { name: 'Hoàn tác' }));
    expect(useViewerStore.getState().isDirty).toBe(false);
  });

  it('QA-MASK-04 & QA-MASK-05: handles 409 conflict, timeout retry with same Idempotency-Key, <1024px draft preservation, and dirty navigation guard', async () => {
    const user = userEvent.setup();
    renderViewer();

    await screen.findByTestId('pane-axial-editable');
    await waitFor(() => {
      expect(screen.getByTestId('mri-viewer-workspace')).toHaveAttribute(
        'data-volume-status',
        'ready',
      );
    });

    // Tô một nét ở lát 0
    await user.click(screen.getByRole('button', { name: 'Tô mask' }));
    const editCanvas = screen
      .getByTestId('pane-axial-editable')
      .querySelector('canvas')!;
    fireEvent.pointerDown(editCanvas, { button: 0, clientX: 30, clientY: 30 });
    fireEvent.pointerUp(editCanvas, { button: 0, clientX: 30, clientY: 30 });
    expect(useViewerStore.getState().isDirty).toBe(true);

    // Thu nhỏ < 1024px -> khóa chỉnh sửa nhưng KHÔNG làm mất bản nháp đang sửa
    act(() => {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: 800,
      });
      window.dispatchEvent(new Event('resize'));
    });
    expect(screen.getByRole('button', { name: 'Tô mask' })).toBeDisabled();
    expect(useViewerStore.getState().isDirty).toBe(true);
    expect(screen.queryByTestId('pane-original')).not.toBeInTheDocument();
    act(() => useViewerStore.getState().setLayoutMode('adjacent'));
    expect(screen.getByTestId('pane-axial-editable')).toBeInTheDocument();
    expect(screen.queryByTestId('pane-adjacent-prev')).not.toBeInTheDocument();
    act(() => useViewerStore.getState().setLayoutMode('three-plane'));
    expect(screen.getByTestId('pane-axial-editable')).toBeInTheDocument();
    expect(screen.queryByTestId('pane-coronal-readonly')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pane-sagittal-readonly')).not.toBeInTheDocument();

    // Phóng to lại >= 1024px -> mở lại chỉnh sửa
    act(() => {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: 1280,
      });
      window.dispatchEvent(new Event('resize'));
    });
    expect(screen.getByRole('button', { name: 'Lưu phiên bản' })).toBeEnabled();

    // Bấm "Chi tiết ca" khi dirty -> mở modal 3 lựa chọn
    await user.click(screen.getByRole('link', { name: 'Chi tiết ca' }));
    expect(
      screen.getByText('Bạn có thay đổi mask chưa lưu'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ở lại' }));
    expect(screen.queryByTestId('case-detail-page')).not.toBeInTheDocument();

    // Lưu thành công phiên bản thủ công trong fixture mode
    await user.click(screen.getByRole('button', { name: 'Lưu phiên bản' }));
    await user.type(
      screen.getByLabelText(/Ghi chú phiên bản/),
      'Chỉnh sửa ranh giới u P4',
    );
    await user.click(
      screen.getByRole('button', { name: 'Xác nhận lưu phiên bản' }),
    );

    await waitFor(() => {
      expect(useViewerStore.getState().isDirty).toBe(false);
    });
  });

  it('QA-MASK-04b: live API save handles timeout retry with same Idempotency-Key and 409 conflict modal', async () => {
    useAuthStore.setState({ fixtureMode: false });
    const blobs = captureDownloadBlobs();

    const caseId = '20000000-0000-4000-8000-000000000099';
    const smallGeom: VolumeGeometry = {
      shape: [8, 8, 4],
      spacingMm: [1, 1, 1],
      affine: [
        [1, 0, 0, -4],
        [0, 1, 0, -4],
        [0, 0, 1, -2],
        [0, 0, 0, 1],
      ],
    };
    const mriGz = await serializeNiftiMask(
      createEmptyMaskBuffer(smallGeom.shape),
      smallGeom,
      { gzip: true },
    );
    const maskGz = await serializeNiftiMask(
      createEmptyMaskBuffer(smallGeom.shape),
      smallGeom,
      { gzip: true },
    );

    const capturedKeys: string[] = [];
    let postCallCount = 0;

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith(`/cases/${caseId}`)) {
          return new Response(
            JSON.stringify({
              id: caseId,
              patient_id: 'p-1',
              study_date: '2026-05-01',
              notes: null,
              reference_volume_id: 'vol-1',
              readiness: 'ready',
              latest_mask_version_id: 'mv-1',
              created_at: '2026-05-01T00:00:00Z',
              updated_at: '2026-05-01T00:00:00Z',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.endsWith(`/cases/${caseId}/volumes`)) {
          return new Response(
            JSON.stringify([
              {
                id: 'vol-1',
                case_id: caseId,
                modality: 'flair',
                file_id: 'file-mri',
                validation_status: 'valid',
                shape: smallGeom.shape,
                spacing_mm: smallGeom.spacingMm,
                affine: smallGeom.affine,
                orientation: 'RAS',
                size_bytes: mriGz.byteLength,
                sha256: 'abc',
              },
            ]),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.endsWith(`/cases/${caseId}/jobs`)) {
          return new Response(
            JSON.stringify({ items: [], total: 0, page: 1, page_size: 20 }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.includes(`/cases/${caseId}/mask-versions`) && (!init?.method || init.method === 'GET')) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: 'mv-1',
                  case_id: caseId,
                  version_number: 1,
                  source: 'ai',
                  base_version_id: null,
                  reference_volume_id: 'vol-1',
                  file_id: 'file-mask',
                  created_by: 'u-1',
                  created_at: '2026-05-01T00:00:00Z',
                  note: null,
                  label_voxel_counts: { '1': 0, '2': 0, '4': 0 },
                  label_volumes_mm3: { '1': 0, '2': 0, '4': 0 },
                  sha256: 'def',
                },
              ],
              total: 1,
              page: 1,
              page_size: 50,
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (url.endsWith('/files/file-mri/content')) {
          return new Response(Uint8Array.from(mriGz).buffer, { status: 200 });
        }
        if (url.endsWith('/files/file-mask/content')) {
          return new Response(Uint8Array.from(maskGz).buffer, { status: 200 });
        }
        if (url.endsWith('/mask-versions/mv-1/metadata')) {
          return new Response(
            JSON.stringify({
              version_id: 'mv-1',
              case_id: caseId,
              study_date: '2026-05-01',
              version_number: 1,
              source: 'ai',
              base_version_id: null,
              reference_volume_id: 'vol-1',
              model_version_id: null,
              job_id: null,
              coverage: {
                status: 'ai_evaluated',
                coverage_file_id: null,
                note: 'Vùng ngoài crop chưa đánh giá tự động.',
              },
              geometry: {
                shape: smallGeom.shape,
                spacing_mm: smallGeom.spacingMm,
                affine: smallGeom.affine,
                orientation: 'RAS',
                units: 'mm',
              },
              labels: { '0': 'Nền', '1': 'NCR', '2': 'ED', '4': 'ET' },
              statistics: {
                voxel_volume_mm3: 1,
                per_label: [],
                composite_groups: [],
                total_foreground_voxels: 0,
                total_foreground_volume_mm3: 0,
                total_foreground_volume_ml: 0,
              },
              sha256: 'def',
              created_by_name: 'AI',
              created_at: '2026-05-01T00:00:00Z',
            }),
            {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }
        if (url.endsWith(`/cases/${caseId}/mask-versions`) && init?.method === 'POST') {
          postCallCount += 1;
          const headers = new Headers(init.headers);
          capturedKeys.push(headers.get('Idempotency-Key') ?? '');
          if (postCallCount === 1) {
            return new Response(
              JSON.stringify({
                error: { code: 'internal_error', message: 'Timeout', request_id: 'r1' },
              }),
              { status: 503, headers: { 'Content-Type': 'application/json' } },
            );
          }
          return new Response(
            JSON.stringify({
              error: {
                code: 'mask_version_conflict',
                message: 'Conflict',
                request_id: 'r2',
              },
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(null, { status: 404 });
      });

    const user = userEvent.setup();
    useViewerStore.getState().setBrushRadius(1);
    renderViewer(caseId);

    await waitFor(() => {
      expect(screen.getByTestId('mri-viewer-workspace')).toHaveAttribute(
        'data-volume-status',
        'ready',
      );
      expect(screen.getByRole('button', { name: 'Tô mask' })).toBeEnabled();
    });

    await user.click(screen.getByRole('button', { name: 'Tô mask' }));
    const editCanvas = screen
      .getByTestId('pane-axial-editable')
      .querySelector('canvas')!;
    vi.spyOn(editCanvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 8,
      height: 8,
      right: 8,
      bottom: 8,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(editCanvas, { button: 0, clientX: 2, clientY: 2 });
    fireEvent.pointerUp(editCanvas, { button: 0, clientX: 2, clientY: 2 });

    await user.click(screen.getByRole('button', { name: 'Lưu phiên bản' }));
    await user.click(
      screen.getByRole('button', { name: 'Xác nhận lưu phiên bản' }),
    );

    // Lần 1 trả 503 -> hiện nút "Thử lại lưu (cùng khóa)"
    const retryBtn = await screen.findByRole('button', {
      name: 'Thử lại lưu (cùng khóa)',
    });
    expect(useViewerStore.getState().isDirty).toBe(true);
    await user.click(retryBtn);

    // Kiểm tra 2 lần gửi dùng CÙNG 1 Idempotency-Key, và lần 2 gặp 409 -> mở modal xung đột
    await waitFor(() => {
      expect(
        screen.getByText('Xung đột phiên bản mask (409)'),
      ).toBeInTheDocument();
    });
    expect(useViewerStore.getState().isDirty).toBe(true);
    expect(capturedKeys.length).toBe(2);
    expect(capturedKeys[0]).toBeTruthy();
    expect(capturedKeys[0]).toBe(capturedKeys[1]);
    expect(
      screen.getByRole('button', { name: 'Tải bản nháp về máy (.nii.gz)' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Bỏ bản nháp & mở phiên bản mới nhất',
      }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: 'Tải bản nháp về máy (.nii.gz)' }),
    );
    await waitFor(() => expect(blobs).toHaveLength(1));
    const draft = await parseNiftiVolume(await blobToArrayBuffer(blobs[0]!));
    const exportedMask = parsedVolumeToUint8Mask(draft);
    const expectedCenter = displayPointToVoxelCoord(
      2,
      2,
      0,
      smallGeom.affine,
      smallGeom.shape,
    );
    const expectedBrush = computeSliceBrushIndices(
      expectedCenter,
      1,
      0,
      smallGeom.affine,
      smallGeom.shape,
    );
    expect(expectedBrush.every((index) => exportedMask[index] === 1)).toBe(true);
    expect(exportedMask.reduce((count, value) => count + Number(value > 0), 0)).toBe(expectedBrush.length);

    fetchSpy.mockRestore();
  });

  it('L-06: saves a manual mask version in fixtureMode and switches back and forth between v1 and v2 without NIfTI header crash', async () => {
    const user = userEvent.setup();
    renderViewer();

    await waitFor(() => {
      expect(screen.getByTestId('mri-viewer-workspace')).toHaveAttribute(
        'data-volume-status',
        'ready',
      );
    });

    await user.click(screen.getByRole('button', { name: 'Tô mask' }));
    const editCanvas = screen
      .getByTestId('pane-axial-editable')
      .querySelector('canvas')!;
    vi.spyOn(editCanvas, 'getBoundingClientRect').mockReturnValue({
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
    fireEvent.pointerDown(editCanvas, { button: 0, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(editCanvas, { button: 0, clientX: 40, clientY: 40 });
    expect(useViewerStore.getState().isDirty).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Lưu phiên bản' }));
    await user.click(
      screen.getByRole('button', { name: 'Xác nhận lưu phiên bản' }),
    );

    await waitFor(() => {
      expect(useViewerStore.getState().isDirty).toBe(false);
    });

    const selector = screen.getByRole('combobox', {
      name: 'Chọn phiên bản mask',
    });
    const options = Array.from(selector.querySelectorAll('option'));
    expect(options.length).toBeGreaterThanOrEqual(2);
    const savedV2Id = selector.getAttribute('value') ?? (selector as HTMLSelectElement).value;
    const aiV1Option = options.find((opt) => opt.value !== savedV2Id)!;

    // Switch back to AI v1
    await user.selectOptions(selector, aiV1Option.value);
    await waitFor(() => {
      expect(selector).toHaveValue(aiV1Option.value);
      expect(screen.getByTestId('mri-viewer-workspace')).toHaveAttribute(
        'data-volume-status',
        'ready',
      );
    });
    expect(screen.queryByText('Lỗi nạp dữ liệu ảnh')).not.toBeInTheDocument();

    // Switch back to saved manual v2 -> must parse valid NIfTI header without sizeof_hdr != 348 error
    await user.selectOptions(selector, savedV2Id);
    await waitFor(() => {
      expect(selector).toHaveValue(savedV2Id);
      expect(screen.getByTestId('mri-viewer-workspace')).toHaveAttribute(
        'data-volume-status',
        'ready',
      );
    });
    expect(screen.queryByText('Lỗi nạp dữ liệu ảnh')).not.toBeInTheDocument();
    expect(useViewerStore.getState().occupiedSlices).toContain(0);
  });

  it('L-13: ends active stroke on window blur / layout unmount (ignoring secondary multi-touch) and synchronizes 3-plane crosshair', async () => {
    const user = userEvent.setup();
    const caseId = '20000000-0000-4000-8000-000000000077';
    const geometry: VolumeGeometry = {
      shape: [12, 10, 6],
      spacingMm: [1, 1, 1],
      affine: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
    };
    await mockLiveViewerApi({ caseId, geometry });
    useAuthStore.setState({ fixtureMode: false });
    useViewerStore.getState().setBrushRadius(1);
    const view = renderViewer(caseId);

    await waitFor(() => {
      expect(screen.getByTestId('mri-viewer-workspace')).toHaveAttribute(
        'data-volume-status',
        'ready',
      );
    });

    // Crosshair is initialized even in Live API mode
    expect(useViewerStore.getState().crosshairVoxel).toEqual([6, 5, 0]);

    await user.click(screen.getByRole('button', { name: 'Tô mask' }));
    const editCanvas = screen
      .getByTestId('pane-axial-editable')
      .querySelector('canvas')!;
    vi.spyOn(editCanvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 12,
      height: 10,
      right: 12,
      bottom: 10,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    // Begin stroke with pointerId 1, try interfering with pointerId 2, then blur window without pointerUp
    fireEvent.pointerDown(editCanvas, {
      button: 0,
      pointerId: 1,
      clientX: 3,
      clientY: 4,
    });
    fireEvent.pointerDown(editCanvas, {
      button: 0,
      pointerId: 2,
      clientX: 10,
      clientY: 8,
    });
    fireEvent.pointerMove(editCanvas, {
      button: 0,
      pointerId: 2,
      clientX: 11,
      clientY: 9,
    });
    fireEvent.pointerUp(editCanvas, {
      button: 0,
      pointerId: 2,
      clientX: 11,
      clientY: 9,
    });
    // Pointer 1 is still active until window blurs
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });

    // Slice navigation is NOT stuck after blur mid-stroke
    await user.click(screen.getByRole('button', { name: 'Lát kế tiếp' }));
    expect(useViewerStore.getState().currentSliceZeroBased).toBe(1);
    expect(useViewerStore.getState().crosshairVoxel?.[2]).toBe(1);

    // Switch to Three-Plane layout and click Coronal & Sagittal panes to move crosshair
    await user.click(screen.getByRole('button', { name: 'Xem lát' }));
    await user.click(screen.getByRole('button', { name: 'Ba mặt phẳng' }));

    const coronalCanvas = screen
      .getByTestId('pane-coronal-readonly')
      .querySelector('canvas')!;
    vi.spyOn(coronalCanvas, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 12,
      height: 6,
      right: 12,
      bottom: 6,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(coronalCanvas, {
      button: 0,
      pointerId: 1,
      clientX: 2.5,
      clientY: 1.5,
    });
    fireEvent.pointerUp(coronalCanvas, {
      button: 0,
      pointerId: 1,
      clientX: 2.5,
      clientY: 1.5,
    });

    // Coronal displayX=2 -> flipHorizontal(true) => vx = 12 - 1 - 2 = 9; displayY=1 -> flipVertical(true) => vz = 6 - 1 - 1 = 4
    expect(useViewerStore.getState().crosshairVoxel).toEqual([9, 5, 4]);
    expect(useViewerStore.getState().currentSliceZeroBased).toBe(4);

    // Unmounting Viewer while dirty resets isDirty in store so it never leaks to other routes
    expect(useViewerStore.getState().isDirty).toBe(true);
    view.unmount();
    expect(useViewerStore.getState().isDirty).toBe(false);
  });

  it('L-14: prevents overlapping DirtySwitch/Save modals, avoids MRI/Mask double-load, disables missing modality, and shows ErrorState on 404 refetch', async () => {
    const user = userEvent.setup();
    const caseId = '20000000-0000-4000-8000-000000000088';
    const geometry: VolumeGeometry = {
      shape: [8, 8, 4],
      spacingMm: [1, 1, 1],
      affine: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
    };

    let mriFetchCount = 0;
    let v1FetchCount = 0;
    let shouldFailCase404 = false;

    const empty = createEmptyMaskBuffer(geometry.shape);
    const mriBytes = await serializeNiftiMask(empty, geometry, { gzip: true });
    const v1Bytes = await serializeNiftiMask(empty, geometry, { gzip: true });

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input, init) => {
        const url = new URL(
          typeof input === 'string' ? input : input.toString(),
          'http://localhost',
        );
        const path = url.pathname;
        const method = init?.method ?? 'GET';
        const json = (payload: unknown, status = 200) =>
          new Response(JSON.stringify(payload), {
            status,
            headers: { 'Content-Type': 'application/json' },
          });

        if (path.endsWith(`/cases/${caseId}`) && method === 'GET') {
          if (shouldFailCase404) {
            return json(
              {
                error: {
                  code: 'case_not_found',
                  message: 'Ca chụp không còn tồn tại.',
                  request_id: 'r-404',
                },
              },
              404,
            );
          }
          return json({
            id: caseId,
            patient_id: 'p-1',
            study_date: '2026-05-01',
            notes: null,
            reference_volume_id: 'vol-flair',
            readiness: 'missing_inputs',
            latest_mask_version_id: 'ver-2',
            created_at: '2026-05-01T00:00:00Z',
            updated_at: '2026-05-01T00:00:00Z',
          });
        }
        if (path.endsWith(`/cases/${caseId}/volumes`) && method === 'GET') {
          return json([
            {
              id: 'vol-flair',
              case_id: caseId,
              modality: 'flair',
              file_id: 'file-flair',
              validation_status: 'valid',
              shape: geometry.shape,
              spacing_mm: geometry.spacingMm,
              affine: geometry.affine,
              orientation: 'RAS',
              size_bytes: mriBytes.byteLength,
              sha256: 'flair-sha',
            },
          ]);
        }
        if (path.endsWith(`/cases/${caseId}/jobs`) && method === 'GET') {
          return json({ items: [], total: 0, page: 1, page_size: 20 });
        }
        if (path.endsWith(`/cases/${caseId}/mask-versions`) && method === 'GET') {
          return json({
            items: [
              {
                id: 'ver-2',
                case_id: caseId,
                version_number: 2,
                source: 'manual',
                base_version_id: 'ver-1',
                reference_volume_id: 'vol-flair',
                file_id: 'file-v2',
                created_by: FIXTURE_USERS.doctor.id,
                created_at: '2026-05-02T00:00:00Z',
                note: null,
                label_voxel_counts: { '1': 0, '2': 0, '4': 0 },
                label_volumes_mm3: { '1': 0, '2': 0, '4': 0 },
                sha256: 'v2-sha',
              },
              {
                id: 'ver-1',
                case_id: caseId,
                version_number: 1,
                source: 'ai',
                base_version_id: null,
                reference_volume_id: 'vol-flair',
                file_id: 'file-v1',
                created_by: FIXTURE_USERS.doctor.id,
                created_at: '2026-05-01T00:00:00Z',
                note: null,
                label_voxel_counts: { '1': 0, '2': 0, '4': 0 },
                label_volumes_mm3: { '1': 0, '2': 0, '4': 0 },
                sha256: 'v1-sha',
              },
            ],
            total: 2,
            page: 1,
            page_size: 100,
          });
        }
        if (path.endsWith('/files/file-flair/content')) {
          mriFetchCount += 1;
          return new Response(mriBytes.slice().buffer, { status: 200 });
        }
        if (path.endsWith('/files/file-v2/content') || path.endsWith('/files/file-v1/content')) {
          v1FetchCount += 1;
          return new Response(v1Bytes.slice().buffer, { status: 200 });
        }
        if (/\/mask-versions\/[^/]+\/metadata$/.test(path)) {
          return json({ error: { code: 'not_found' } }, 404);
        }
        return new Response(null, { status: 404 });
      });

    useAuthStore.setState({ fixtureMode: false });
    // Start with modality='t1ce' in store even though case only has 'flair'
    useViewerStore.getState().setModality('t1ce');
    const view = renderViewer(caseId);

    await waitFor(() => {
      expect(screen.getByTestId('mri-viewer-workspace')).toHaveAttribute(
        'data-volume-status',
        'ready',
      );
    });

    // Missing t1ce modality button is disabled and modality auto-synced to flair; MRI & initial mask loaded exactly once
    expect(screen.getByRole('button', { name: 't1ce' })).toBeDisabled();
    expect(useViewerStore.getState().modality).toBe('flair');
    expect(mriFetchCount).toBe(1);
    expect(v1FetchCount).toBe(1);

    // Paint to make dirty, trigger DirtySwitchModal, click "Lưu rồi chuyển" -> DirtySwitchModal closes before SaveMaskNoteModal opens
    await user.click(screen.getByRole('button', { name: 'Tô mask' }));
    const editCanvas = screen
      .getByTestId('pane-axial-editable')
      .querySelector('canvas')!;
    fireEvent.pointerDown(editCanvas, { button: 0, clientX: 2, clientY: 2 });
    fireEvent.pointerUp(editCanvas, { button: 0, clientX: 2, clientY: 2 });

    await user.click(screen.getByRole('link', { name: 'Chi tiết ca' }));
    expect(screen.getByText('Bạn có thay đổi mask chưa lưu')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Lưu rồi chuyển' }));
    expect(
      screen.queryByText('Bạn có thay đổi mask chưa lưu'),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Lưu phiên bản mask mới')).toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);

    // Cancel SaveMaskNoteModal -> closes cleanly without re-opening DirtySwitchModal
    await user.click(screen.getByRole('button', { name: 'Hủy' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Switching mask version (after discarding) does NOT re-download cached FLAIR MRI
    const selector = screen.getByRole('combobox', {
      name: 'Chọn phiên bản mask',
    });
    await user.selectOptions(selector, 'ver-1');
    await user.click(screen.getByRole('button', { name: 'Bỏ thay đổi' }));
    await waitFor(() => expect(selector).toHaveValue('ver-1'));
    await waitFor(() => {
      expect(screen.getByTestId('mri-viewer-workspace')).toHaveAttribute(
        'data-volume-status',
        'ready',
      );
    });
    expect(mriFetchCount).toBe(1);
    expect(v1FetchCount).toBe(2);

    // Simulate 404 on refetch (e.g. case deleted) -> shows ErrorState instead of stale cached workspace
    shouldFailCase404 = true;
    await act(async () => {
      await view.queryClient.refetchQueries();
    });
    await waitFor(() => {
      expect(
        screen.getByText('Không thể mở Viewer cho ca chụp này'),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId('mri-viewer-workspace'),
    ).not.toBeInTheDocument();
    fetchSpy.mockRestore();
  });

  it('supports Fullscreen workstation (button & F/Escape), Maximize Pane, Live Brush Cursor Preview, clinical shortcuts (B, E, V, 1/2/4, [/], M) and non-passive Wheel layer scrolling', async () => {
    const user = userEvent.setup();
    renderViewer();

    await waitFor(() => {
      expect(screen.getByTestId('mri-viewer-workspace')).toHaveAttribute(
        'data-volume-status',
        'ready',
      );
    });

    const workspace = screen.getByTestId('mri-viewer-workspace');
    expect(workspace).toHaveAttribute('data-fullscreen', 'false');

    // 1. Chế độ Toàn màn hình qua nút bấm & phím F / Escape
    const fullscreenBtn = screen.getByRole('button', {
      name: 'Toàn màn hình',
    });
    await user.click(fullscreenBtn);
    expect(workspace).toHaveAttribute('data-fullscreen', 'true');
    expect(workspace.className).toContain('fixed');
    expect(
      screen.getByRole('button', { name: 'Thu nhỏ' }),
    ).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'f' });
    expect(workspace).toHaveAttribute('data-fullscreen', 'false');

    fireEvent.keyDown(window, { key: 'F' });
    expect(workspace).toHaveAttribute('data-fullscreen', 'true');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(workspace).toHaveAttribute('data-fullscreen', 'false');

    // 2. Phóng đại riêng khung ảnh (Maximize Pane)
    const maxPaneBtn = screen.getByRole('button', {
      name: 'Phóng đại khung MRI + Lớp phủ Mask (Axial)',
    });
    await user.click(maxPaneBtn);
    expect(screen.queryByTestId('pane-original')).not.toBeInTheDocument();
    await user.click(
      screen.getByRole('button', {
        name: 'Thu nhỏ khung MRI + Lớp phủ Mask (Axial)',
      }),
    );
    expect(screen.getByTestId('pane-original')).toBeInTheDocument();

    // 3. Phím tắt lâm sàng (B, E, V, 1/2/4, [, ], M) & Live Brush Cursor Preview
    fireEvent.keyDown(window, { key: 'b' });
    expect(useViewerStore.getState().activeTool).toBe('brush');

    fireEvent.keyDown(window, { key: '4' });
    expect(useViewerStore.getState().activeLabel).toBe(4);

    const initialRadius = useViewerStore.getState().brushRadius;
    fireEvent.keyDown(window, { key: ']' });
    expect(useViewerStore.getState().brushRadius).toBe(initialRadius + 1);
    fireEvent.keyDown(window, { key: '[' });
    expect(useViewerStore.getState().brushRadius).toBe(initialRadius);

    const editPane = screen.getByTestId('pane-axial-editable');
    const editCanvas = editPane.querySelector('canvas')!;
    vi.spyOn(editCanvas, 'getBoundingClientRect').mockReturnValue({
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

    fireEvent.pointerMove(editCanvas, { clientX: 60, clientY: 80 });
    const brushPreview = screen.getByTestId('brush-cursor-preview');
    expect(brushPreview).toBeInTheDocument();
    const circle = brushPreview.querySelector('circle')!;
    expect(circle).toHaveAttribute('stroke', '#A855F7');

    // Chuyển sang công cụ Xóa mask (phím E) -> vòng tròn cọ đổi sang nét đứt màu đỏ #F87171
    fireEvent.keyDown(window, { key: 'e' });
    expect(useViewerStore.getState().activeTool).toBe('erase');
    expect(
      screen.getByTestId('brush-cursor-preview').querySelector('circle'),
    ).toHaveAttribute('stroke', '#F87171');

    // Phím M bật/tắt nhanh lớp phủ mask giữa 40% và 0%
    expect(useViewerStore.getState().maskOpacityPercent).toBe(40);
    fireEvent.keyDown(window, { key: 'm' });
    expect(useViewerStore.getState().maskOpacityPercent).toBe(0);
    fireEvent.keyDown(window, { key: 'm' });
    expect(useViewerStore.getState().maskOpacityPercent).toBe(40);

    // 4. Lăn chuột (Wheel) non-passive chuyển lát cắt, nhảy nhanh ±5 lát (Shift+Wheel), Zoom (Ctrl+Wheel) & Cỡ cọ (Alt+Wheel)
    const sliceBeforeWheel = useViewerStore.getState().currentSliceZeroBased;
    const wheelDownEvent = new WheelEvent('wheel', {
      deltaY: 100,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      editCanvas.dispatchEvent(wheelDownEvent);
    });
    expect(wheelDownEvent.defaultPrevented).toBe(true);
    expect(useViewerStore.getState().currentSliceZeroBased).toBe(
      sliceBeforeWheel + 1,
    );

    fireEvent.wheel(editCanvas, { deltaY: 100, shiftKey: true });
    expect(useViewerStore.getState().currentSliceZeroBased).toBe(
      sliceBeforeWheel + 6,
    );

    const zoomBefore = useViewerStore.getState().zoomLevel;
    fireEvent.wheel(editCanvas, { deltaY: -100, ctrlKey: true });
    expect(useViewerStore.getState().zoomLevel).toBeCloseTo(
      zoomBefore + 0.15,
      5,
    );

    const radiusBeforeWheel = useViewerStore.getState().brushRadius;
    fireEvent.wheel(editCanvas, { deltaY: -100, altKey: true });
    expect(useViewerStore.getState().brushRadius).toBe(radiusBeforeWheel + 1);

    // 5. Kéo ảnh (Pan) lên/xuống/trái/phải ở chế độ Xem lát, click ngắn đặt crosshair, và giữ Space khi đang chọn cọ vẽ
    await user.click(screen.getByRole('button', { name: 'Xem lát' }));
    const initialCrosshair = useViewerStore.getState().crosshairVoxel;
    expect(useViewerStore.getState().panOffset).toEqual({ x: 0, y: 0 });

    fireEvent.pointerDown(editCanvas, { button: 0, pointerId: 1, clientX: 100, clientY: 120 });
    fireEvent.pointerMove(editCanvas, { button: 0, pointerId: 1, clientX: 125, clientY: 80 });
    fireEvent.pointerUp(editCanvas, { button: 0, pointerId: 1, clientX: 125, clientY: 80 });
    expect(useViewerStore.getState().panOffset).toEqual({ x: 25, y: -40 });
    expect(useViewerStore.getState().crosshairVoxel).toEqual(initialCrosshair);

    // Click ngắn (< 3px) trong chế độ Xem lát vẫn cập nhật crosshair
    fireEvent.pointerDown(editCanvas, { button: 0, pointerId: 2, clientX: 40, clientY: 40 });
    fireEvent.pointerUp(editCanvas, { button: 0, pointerId: 2, clientX: 40, clientY: 40 });
    expect(useViewerStore.getState().panOffset).toEqual({ x: 25, y: -40 });
    expect(useViewerStore.getState().crosshairVoxel).not.toEqual(initialCrosshair);

    // Giữ Space trong chế độ Tô mask -> kéo ảnh mà không tô nét (isDirty vẫn false)
    await user.click(screen.getByRole('button', { name: 'Tô mask' }));
    expect(useViewerStore.getState().isDirty).toBe(false);
    fireEvent.keyDown(window, { code: 'Space', key: ' ' });
    fireEvent.pointerDown(editCanvas, { button: 0, pointerId: 3, clientX: 50, clientY: 60 });
    fireEvent.pointerMove(editCanvas, { button: 0, pointerId: 3, clientX: 60, clientY: 90 });
    fireEvent.pointerUp(editCanvas, { button: 0, pointerId: 3, clientX: 60, clientY: 90 });
    fireEvent.keyUp(window, { code: 'Space', key: ' ' });
    expect(useViewerStore.getState().panOffset).toEqual({ x: 35, y: -10 });
    expect(useViewerStore.getState().isDirty).toBe(false);

    // Nhấn nút 1:1 để đặt lại zoom & pan
    await user.click(
      screen.getByRole('button', {
        name: 'Đặt lại góc nhìn MRI + Lớp phủ Mask (Axial)',
      }),
    );
    expect(useViewerStore.getState().zoomLevel).toBe(1);
    expect(useViewerStore.getState().panOffset).toEqual({ x: 0, y: 0 });

    // 6. Nút "1 khung vẽ" & phím tắt I (thu gọn/mở bảng thông số) mở rộng tối đa tầm nhìn não
    const onePaneBtn = screen.getByRole('button', { name: '1 khung vẽ' });
    await user.click(onePaneBtn);
    expect(onePaneBtn).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('pane-original')).not.toBeInTheDocument();
    await user.click(onePaneBtn);
    expect(onePaneBtn).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('pane-original')).toBeInTheDocument();

    const inspectorBtn = screen.getByRole('button', {
      name: 'Thu gọn bảng thông số',
    });
    expect(inspectorBtn).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(window, { key: 'i' });
    expect(
      screen.getByRole('button', { name: 'Mở bảng thông số' }),
    ).toHaveAttribute('aria-pressed', 'false');
    fireEvent.keyDown(window, { key: 'i' });
    expect(
      screen.getByRole('button', { name: 'Thu gọn bảng thông số' }),
    ).toHaveAttribute('aria-pressed', 'true');

    // 7. Auto-fit phóng tỷ lệ canvas khi vùng chứa lớn hơn 240x240 (giữ nguyên tỷ lệ 1:1 của lát cắt)
  });

  it('scales SliceCanvasPane canvas up proportionally to fill a larger viewport (auto-fit)', async () => {
    const callbacks: ResizeObserverCallback[] = [];
    const OriginalRO = globalThis.ResizeObserver;
    class MockResizeObserver {
      constructor(cb: ResizeObserverCallback) {
        callbacks.push(cb);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    try {
      renderViewer();
      await waitFor(() => {
        expect(screen.getByTestId('mri-viewer-workspace')).toHaveAttribute(
          'data-volume-status',
          'ready',
        );
      });
      const editCanvas = screen
        .getByTestId('pane-axial-editable')
        .querySelector('canvas')!;
      const canvasFrame = editCanvas.parentElement!;
      expect(canvasFrame.getAttribute('style')).toBeNull();

      act(() => {
        for (const cb of callbacks) {
          cb(
            [
              {
                contentRect: { width: 600, height: 500 } as DOMRectReadOnly,
              } as ResizeObserverEntry,
            ],
            {} as ResizeObserver,
          );
        }
      });

      expect(canvasFrame).toHaveStyle({ width: '488px', height: '488px' });
      expect(editCanvas.className).toContain('w-full');
      expect(editCanvas.className).toContain('h-full');
    } finally {
      vi.stubGlobal('ResizeObserver', OriginalRO);
    }
  });

  it('shows manual mask delete action in Viewer only for manual versions and falls back to remaining version after delete', async () => {
    const user = userEvent.setup();
    const geometry: VolumeGeometry = {
      shape: [8, 8, 8],
      spacingMm: [1, 1, 1],
      affine: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
    };

    useAuthStore.setState({
      user: FIXTURE_USERS.doctor,
      accessToken: 'live-token',
      fixtureMode: false,
      reauthRequired: false,
    });

    await mockLiveViewerApi({
      caseId: 'case-viewer-del-1',
      geometry,
      versions: [
        { id: 'ver-ai-1', version_number: 1, source: 'ai' },
        { id: 'ver-manual-2', version_number: 2, source: 'manual' },
      ],
    });

    renderViewer('case-viewer-del-1');

    const selectEl = (await screen.findByLabelText(
      'Chọn phiên bản mask',
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(selectEl.value).toBe('ver-manual-2');
    });

    const deleteBtn = screen.getByRole('button', {
      name: 'Xóa phiên bản mask thủ công',
    });
    expect(deleteBtn).toBeInTheDocument();

    await user.click(deleteBtn);
    await screen.findByRole('alertdialog');
    await user.click(screen.getByRole('button', { name: 'Xóa phiên bản' }));

    await waitFor(() => {
      expect(selectEl.value).toBe('ver-ai-1');
    });
    expect(
      screen.queryByRole('button', { name: 'Xóa phiên bản mask thủ công' }),
    ).not.toBeInTheDocument();
  });
});
