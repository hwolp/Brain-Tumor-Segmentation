import { cmapper } from '@niivue/niivue';
import { describe, expect, it, vi } from 'vitest';
import {
  BRATS_LABELS,
  BRATS_TUMOR_LABEL_IDS,
  isValidBraTSLabel,
} from '@/shared/lib/labels';
import {
  buildBraTSColorMap,
  checkViewportEditorCapability,
  checkVolumeGeometryEditable,
  clampBrushRadius,
  clampSliceIndex,
  computeMaskStatistics,
  getAdjacentSliceIndices,
  getAxialAxisIndex,
  getAxialSliceCount,
  isAffineAxisAligned,
  planeDisplayPointToVoxelCoord,
  resolveAxialSliceAxes,
  resolvePlaneAxes,
  toOneBasedSlice,
  toZeroBasedSlice,
  voxelCoordToDisplayPoint,
  voxelCoordToFlatIndex,
} from '@/viewer-adapter/geometry';
import { MaskEditorEngine } from '@/viewer-adapter/maskEditorEngine';
import {
  createEmptyMaskBuffer,
  parseNiftiVolume,
  parsedVolumeToUint8Mask,
  serializeNiftiMask,
} from '@/viewer-adapter/niftiCodec';
import { isWebGLAvailable } from '@/viewer-adapter/niivueAdapter';
import type { VolumeGeometry } from '@/viewer-adapter/types';

describe('viewer-adapter pure slice & boundary logic', () => {
  it('maps 0-based voxel slice indices <-> 1-based UI indices accurately and clamps bounds', () => {
    expect(toOneBasedSlice(0, 155)).toBe(1);
    expect(toOneBasedSlice(154, 155)).toBe(155);
    expect(toOneBasedSlice(-10, 155)).toBe(1);
    expect(toOneBasedSlice(500, 155)).toBe(155);

    expect(toZeroBasedSlice(1, 155)).toBe(0);
    expect(toZeroBasedSlice(155, 155)).toBe(154);
    expect(toZeroBasedSlice(0, 155)).toBe(0);
    expect(toZeroBasedSlice(999, 155)).toBe(154);

    // Supports non-155 volumes dynamically (no hardcoded 155)
    expect(toOneBasedSlice(79, 80)).toBe(80);
    expect(clampSliceIndex(90, 80)).toBe(79);
  });

  it('derives axial axis and slice count from affine world-Z row without hardcoding shape[2]', () => {
    const standardAffine = [
      [1, 0, 0, -120],
      [0, 1, 0, -120],
      [0, 0, 1, -78],
      [0, 0, 0, 1],
    ];
    expect(getAxialAxisIndex(standardAffine)).toBe(2);
    expect(getAxialSliceCount([240, 240, 155], standardAffine)).toBe(155);

    const permutedAxis1Affine = [
      [1, 0, 0, -100],
      [0, 0, 1, -100],
      [0, -1.5, 0, 90],
      [0, 0, 0, 1],
    ];
    expect(getAxialAxisIndex(permutedAxis1Affine)).toBe(1);
    expect(getAxialSliceCount([240, 128, 240], permutedAxis1Affine)).toBe(128);

    const permutedAxis0Affine = [
      [0, 1, 0, -100],
      [0, 0, 1, -100],
      [2, 0, 0, -60],
      [0, 0, 0, 1],
    ];
    expect(getAxialAxisIndex(permutedAxis0Affine)).toBe(0);
    expect(getAxialSliceCount([96, 240, 240], permutedAxis0Affine)).toBe(96);

    expect(getAxialAxisIndex(null)).toBe(2);
    expect(getAxialSliceCount([240, 240, 155], null)).toBe(155);
  });

  it('returns adjacent slice triplet [k-1, k, k+1] without wrap-around at boundaries', () => {
    expect(getAdjacentSliceIndices(0, 155)).toEqual([null, 0, 1]);
    expect(getAdjacentSliceIndices(50, 155)).toEqual([49, 50, 51]);
    expect(getAdjacentSliceIndices(154, 155)).toEqual([153, 154, null]);
    expect(getAdjacentSliceIndices(0, 1)).toEqual([null, 0, null]);
    expect(getAdjacentSliceIndices(0, 0)).toEqual([null, null, null]);
  });

  it('clamps brush radius to 1..20 voxel range', () => {
    expect(clampBrushRadius(0)).toBe(1);
    expect(clampBrushRadius(3)).toBe(3);
    expect(clampBrushRadius(25)).toBe(20);
    expect(clampBrushRadius(Number.NaN)).toBe(3);
  });
});

describe('BraTS v1 label palette {0, 1, 2, 4} & NiiVue discrete LUT', () => {
  it('preserves raw BraTS label indices {0, 1, 2, 4} without compressing 4 to 3', () => {
    expect(isValidBraTSLabel(0)).toBe(true);
    expect(isValidBraTSLabel(1)).toBe(true);
    expect(isValidBraTSLabel(2)).toBe(true);
    expect(isValidBraTSLabel(3)).toBe(false);
    expect(isValidBraTSLabel(4)).toBe(true);

    expect(BRATS_TUMOR_LABEL_IDS).toEqual([1, 2, 4]);
    expect(BRATS_LABELS[1].hexColor).toBe('#F59E0B');
    expect(BRATS_LABELS[2].hexColor).toBe('#22C55E');
    expect(BRATS_LABELS[4].hexColor).toBe('#A855F7');

    const cmap = buildBraTSColorMap();
    expect(cmap.I).toEqual([0, 1, 2, 4]);
    expect(cmap.labels).toEqual(['Nền', '1: NCR/NET', '2: Edema', '4: ET']);
    expect(cmap.A[0]).toBe(0);
    expect(cmap.R[1]).toBe(245);
    expect(cmap.G[2]).toBe(197);
    expect(cmap.B[3]).toBe(247);
  });

  it('produces exact non-interpolated RGB entries in NiiVue cmapper.makeLabelLut for labels 0, 1, 2, 4', () => {
    const labelLut = cmapper.makeLabelLut(buildBraTSColorMap());

    expect(labelLut.min).toBe(0);
    expect(labelLut.max).toBe(4);
    expect(labelLut.labels?.[0]).toBe('Nền');
    expect(labelLut.labels?.[1]).toBe('1: NCR/NET');
    expect(labelLut.labels?.[2]).toBe('2: Edema');
    expect(labelLut.labels?.[4]).toBe('4: ET');

    // Label 0: transparent
    expect(Array.from(labelLut.lut.slice(0, 4))).toEqual([0, 0, 0, 0]);
    // Label 1: #F59E0B -> (245, 158, 11, 255)
    expect(Array.from(labelLut.lut.slice(4, 8))).toEqual([245, 158, 11, 255]);
    // Label 2: #22C55E -> (34, 197, 94, 255)
    expect(Array.from(labelLut.lut.slice(8, 12))).toEqual([34, 197, 94, 255]);
    // Unused label 3: empty
    expect(Array.from(labelLut.lut.slice(12, 16))).toEqual([0, 0, 0, 0]);
    // Label 4: #A855F7 -> (168, 85, 247, 255)
    expect(Array.from(labelLut.lut.slice(16, 20))).toEqual([168, 85, 247, 255]);
  });
});

describe('viewport >=1024px & affine geometry editor gates', () => {
  const axisAlignedGeometry: VolumeGeometry = {
    shape: [240, 240, 155],
    spacingMm: [1, 1, 1],
    affine: [
      [1, 0, 0, -120],
      [0, -1, 0, 120],
      [0, 0, 1, -78],
      [0, 0, 0, 1],
    ],
  };

  const permutedAxisGeometry: VolumeGeometry = {
    shape: [240, 240, 155],
    spacingMm: [1, 1, 1],
    affine: [
      [0, 1, 0, -100],
      [-1, 0, 0, 100],
      [0, 0, 1.5, -50],
      [0, 0, 0, 1],
    ],
  };

  const obliqueGeometry: VolumeGeometry = {
    shape: [240, 240, 155],
    spacingMm: [1, 1, 1],
    affine: [
      [0.866, -0.5, 0, -120],
      [0.5, 0.866, 0, -120],
      [0, 0, 1, -78],
      [0, 0, 0, 1],
    ],
  };

  it('locks editing when viewport width < 1024px and explains why', () => {
    const mobile = checkViewportEditorCapability(375, axisAlignedGeometry);
    expect(mobile.canEdit).toBe(false);
    expect(mobile.reason).toContain('1024 px');

    const tablet = checkViewportEditorCapability(1023, axisAlignedGeometry);
    expect(tablet.canEdit).toBe(false);
    expect(tablet.reason).toContain('1024 px');
  });

  it('unlocks editing at viewport >= 1024px for axis-aligned affines', () => {
    expect(checkViewportEditorCapability(1024, axisAlignedGeometry)).toEqual({
      canEdit: true,
      reason: null,
    });
    expect(checkViewportEditorCapability(1440, permutedAxisGeometry)).toEqual({
      canEdit: true,
      reason: null,
    });
    expect(isAffineAxisAligned(permutedAxisGeometry.affine)).toBe(true);
  });

  it('locks editing for oblique volumes even on wide desktop viewports', () => {
    expect(isAffineAxisAligned(obliqueGeometry.affine)).toBe(false);
    const capability = checkVolumeGeometryEditable(obliqueGeometry);
    expect(capability.canEdit).toBe(false);
    expect(capability.reason).toContain('oblique');

    const desktopOblique = checkViewportEditorCapability(1440, obliqueGeometry);
    expect(desktopOblique.canEdit).toBe(false);
    expect(desktopOblique.reason).toContain('oblique');
  });
});

describe('L-05 NIfTI-1 Quaternion 180° (LPS/LAS), qform/sform consistency & strict validation', () => {
  it('round-trips 180° LPS and LAS rotations via qform quaternion without degenerating to (0,0,0) and aligns pixdim with affine column norms', async () => {
    const lpsGeometry: VolumeGeometry = {
      shape: [6, 5, 4],
      // Intentionally mismatched spacingMm order to verify serializeNiftiMask derives pixdim from affine columns
      spacingMm: [9, 9, 9],
      affine: [
        [-1.25, 0, 0, 20],
        [0, -1.5, 0, 30],
        [0, 0, 2.0, -10],
        [0, 0, 0, 1],
      ],
    };
    const mask = createEmptyMaskBuffer(lpsGeometry.shape);
    mask[0] = 1;
    mask[5] = 4;

    const rawNii = await serializeNiftiMask(mask, lpsGeometry, { gzip: false });
    const view = new DataView(rawNii.buffer, rawNii.byteOffset, rawNii.byteLength);

    // pixdim[1..3] written from exact column norms [1.25, 1.5, 2.0]
    expect(view.getFloat32(80, true)).toBeCloseTo(1.25, 5);
    expect(view.getFloat32(84, true)).toBeCloseTo(1.5, 5);
    expect(view.getFloat32(88, true)).toBeCloseTo(2.0, 5);

    // Quaternion for 180° Z-rotation (LPS) must be (qb=0, qc=0, |qd|=1), NOT (0,0,0)
    const qb = view.getFloat32(256, true);
    const qc = view.getFloat32(260, true);
    const qd = view.getFloat32(264, true);
    expect(Math.hypot(qb, qc, qd)).toBeCloseTo(1, 5);
    expect(Math.abs(qd)).toBeCloseTo(1, 5);

    // Force sform_code = 0 so parseNiftiVolume reconstructs affine purely from qform
    const qformOnlyBuf = new Uint8Array(rawNii);
    new DataView(qformOnlyBuf.buffer).setInt16(254, 0, true);
    const parsedFromQform = await parseNiftiVolume(qformOnlyBuf);
    expect(parsedFromQform.spacingMm[0]).toBeCloseTo(1.25, 5);
    expect(parsedFromQform.spacingMm[1]).toBeCloseTo(1.5, 5);
    expect(parsedFromQform.spacingMm[2]).toBeCloseTo(2.0, 5);
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 4; c += 1) {
        expect(parsedFromQform.affine[r]![c]!).toBeCloseTo(
          lpsGeometry.affine[r]![c]!,
          4,
        );
      }
    }

    // LAS (det < 0, qfac = -1, 180° rotation after z-reflection)
    const lasGeometry: VolumeGeometry = {
      shape: [4, 4, 4],
      spacingMm: [1, 1.5, 2],
      affine: [
        [-1, 0, 0, 10],
        [0, 1.5, 0, -15],
        [0, 0, 2, -20],
        [0, 0, 0, 1],
      ],
    };
    const lasNii = await serializeNiftiMask(
      createEmptyMaskBuffer(lasGeometry.shape),
      lasGeometry,
      { gzip: false },
    );
    new DataView(lasNii.buffer).setInt16(254, 0, true);
    const parsedLas = await parseNiftiVolume(lasNii);
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 4; c += 1) {
        expect(parsedLas.affine[r]![c]!).toBeCloseTo(
          lasGeometry.affine[r]![c]!,
          4,
        );
      }
    }

    // Over-unit quaternion (qb^2+qc^2+qd^2 > 1 -> aSq < 0) normalizes cleanly
    const overUnitBuf = new Uint8Array(rawNii);
    const overView = new DataView(overUnitBuf.buffer);
    overView.setInt16(254, 0, true); // qform only
    overView.setFloat32(256, 0, true);
    overView.setFloat32(260, 0, true);
    overView.setFloat32(264, 1.25, true); // qd > 1
    const parsedNormalized = await parseNiftiVolume(overUnitBuf);
    expect(parsedNormalized.affine[0]![0]!).toBeCloseTo(-1.25, 4);
    expect(parsedNormalized.affine[1]![1]!).toBeCloseTo(-1.5, 4);
    expect(parsedNormalized.affine[2]![2]!).toBeCloseTo(2.0, 4);
  });

  it('rejects missing qform/sform, 4D volumes, invalid vox_offset, NaN voxels, and invalid mask labels', async () => {
    const validGeom: VolumeGeometry = {
      shape: [4, 4, 4],
      spacingMm: [1, 1, 1],
      affine: [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
      ],
    };
    const baseNii = await serializeNiftiMask(
      createEmptyMaskBuffer(validGeom.shape),
      validGeom,
      { gzip: false },
    );

    // Missing both qform_code <= 0 and sform_code <= 0
    const noTransform = new Uint8Array(baseNii);
    const noTransformView = new DataView(noTransform.buffer);
    noTransformView.setInt16(252, 0, true);
    noTransformView.setInt16(254, 0, true);
    await expect(parseNiftiVolume(noTransform)).rejects.toThrow(/qform_code|sform_code/);

    // 4D volume (dim[0]=4, dim[4]=2)
    const fourDim = new Uint8Array(baseNii);
    const fourDimView = new DataView(fourDim.buffer);
    fourDimView.setInt16(40, 4, true);
    fourDimView.setInt16(48, 2, true);
    await expect(parseNiftiVolume(fourDim)).rejects.toThrow(/4D/);

    // Invalid vox_offset (0 < vox_offset < 348) and (< 0)
    const badOffset = new Uint8Array(baseNii);
    new DataView(badOffset.buffer).setFloat32(108, 200, true);
    await expect(parseNiftiVolume(badOffset)).rejects.toThrow(/vox_offset/);

    const negOffset = new Uint8Array(baseNii);
    new DataView(negOffset.buffer).setFloat32(108, -16, true);
    await expect(parseNiftiVolume(negOffset)).rejects.toThrow(/vox_offset/);

    // vox_offset === 0 defaults to 352 and parses cleanly
    const zeroOffset = new Uint8Array(baseNii);
    new DataView(zeroOffset.buffer).setFloat32(108, 0, true);
    const parsedZeroOffset = await parseNiftiVolume(zeroOffset);
    expect(parsedZeroOffset.shape).toEqual([4, 4, 4]);

    // Invalid mask label (e.g. 3 or 256) throws instead of silent modulo
    const badLabelNii = new Uint8Array(baseNii);
    badLabelNii[352] = 3;
    const parsedBadLabel = await parseNiftiVolume(badLabelNii);
    expect(() => parsedVolumeToUint8Mask(parsedBadLabel)).toThrow(/0, 1, 2, 4/);
  });
});

describe('L-13 Anisotropic/Oblique 1-to-1 axis bijection, 3-plane crosshair & O(1) Engine stats', () => {
  it('assigns a strict 1-to-1 permutation of [0,1,2] for oblique anisotropic affines and round-trips 3-plane coordinates', () => {
    const theta = (25 * Math.PI) / 180;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    // In-plane spacing 0.5mm, slice thickness 6.0mm tilted by 25° -> |affine[0][2]| = 2.53 > |affine[0][0]| = 0.45
    const anisotropicObliqueAffine = [
      [0.5 * cosT, 0, 6.0 * sinT, -60],
      [0, 0.5, 0, -60],
      [-0.5 * sinT, 0, 6.0 * cosT, -40],
      [0, 0, 0, 1],
    ];
    const shape: [number, number, number] = [256, 256, 30];

    const axial = resolveAxialSliceAxes(anisotropicObliqueAffine, shape);
    expect(new Set([axial.colAxis, axial.rowAxis, axial.axialAxis])).toEqual(
      new Set([0, 1, 2]),
    );
    expect(axial.colAxis).toBe(0);
    expect(axial.rowAxis).toBe(1);
    expect(axial.axialAxis).toBe(2);
    expect(getAxialAxisIndex(anisotropicObliqueAffine)).toBe(axial.axialAxis);

    for (const plane of ['axial', 'coronal', 'sagittal'] as const) {
      const pAxes = resolvePlaneAxes(plane, anisotropicObliqueAffine, shape);
      expect(new Set([pAxes.colAxis, pAxes.rowAxis, pAxes.sliceAxis])).toEqual(
        new Set([0, 1, 2]),
      );

      const vox = planeDisplayPointToVoxelCoord(
        plane,
        7,
        11,
        5,
        anisotropicObliqueAffine,
        shape,
      );
      const disp = voxelCoordToDisplayPoint(
        vox,
        plane,
        anisotropicObliqueAffine,
        shape,
      );
      expect(disp).toEqual({ displayX: 7, displayY: 11, sliceIndex: 5 });
    }
  });

  it('maintains exact O(1) labelCounts/volumeStatistics across strokes, undo/redo, replaceBaseMask, and auto-commits unfinished strokes on beginStroke', () => {
    const shape: [number, number, number] = [6, 6, 4];
    const affine = [
      [1.5, 0, 0, 0],
      [0, 2.0, 0, 0],
      [0, 0, 1.0, 0],
      [0, 0, 0, 1],
    ]; // voxel volume = 3 mm³
    const base = createEmptyMaskBuffer(shape);
    base[voxelCoordToFlatIndex(0, 0, 0, shape)] = 1;
    base[voxelCoordToFlatIndex(1, 0, 0, shape)] = 2;

    const engine = new MaskEditorEngine();
    engine.initialize(base, shape, affine);
    expect(engine.getLabelCounts()).toEqual({ 1: 1, 2: 1, 4: 0 });
    expect(engine.getVolumeStatistics().volumesMm3).toEqual({
      1: 3,
      2: 3,
      4: 0,
    });

    // Unfinished stroke followed by beginStroke auto-commits first stroke
    const idxA = voxelCoordToFlatIndex(2, 2, 1, shape);
    const idxB = voxelCoordToFlatIndex(3, 2, 1, shape);
    engine.beginStroke(1, 4);
    engine.extendStroke([idxA], 1);
    expect(engine.hasActiveStroke()).toBe(true);

    // Calling beginStroke again without commitStroke must auto-commit the first stroke
    engine.beginStroke(1, 2);
    engine.extendStroke([idxA, idxB], 1);
    engine.commitStroke();
    expect(engine.hasActiveStroke()).toBe(false);
    expect(engine.getLabelCounts()).toEqual({ 1: 1, 2: 3, 4: 0 });

    // Undo second stroke -> idxA returns to 4, idxB returns to 0
    expect(engine.undo(1)).toBe(true);
    expect(engine.getWorkingBuffer()[idxA]).toBe(4);
    expect(engine.getLabelCounts()).toEqual({ 1: 1, 2: 1, 4: 1 });

    // Undo first stroke -> idxA returns to 0 (proving oldValues was NOT lost!)
    expect(engine.undo(1)).toBe(true);
    expect(engine.getWorkingBuffer()[idxA]).toBe(0);
    expect(engine.isDirty()).toBe(false);
    expect(engine.getLabelCounts()).toEqual({ 1: 1, 2: 1, 4: 0 });

    // Redo & compare against full scan computeMaskStatistics
    expect(engine.redo(1)).toBe(true);
    const fullScan = computeMaskStatistics(engine.getWorkingBuffer(), affine, shape);
    expect(engine.getVolumeStatistics()).toEqual(fullScan);

    // replaceBaseMask updates O(1) counts accurately
    const nextBase = createEmptyMaskBuffer(shape);
    nextBase[voxelCoordToFlatIndex(4, 4, 2, shape)] = 4;
    nextBase[voxelCoordToFlatIndex(5, 4, 2, shape)] = 4;
    engine.replaceBaseMask(nextBase);
    expect(engine.isDirty()).toBe(false);
    expect(engine.getLabelCounts()).toEqual({ 1: 0, 2: 0, 4: 2 });
    expect(engine.getVolumeStatistics().volumesMm3).toEqual({
      1: 0,
      2: 0,
      4: 6,
    });
  });

  it('releases temporary WebGL2 context via WEBGL_lose_context in isWebGLAvailable', () => {
    const loseContextSpy = vi.fn();
    const fakeGl = {
      getExtension: vi.fn((name: string) =>
        name === 'WEBGL_lose_context' ? { loseContext: loseContextSpy } : null,
      ),
    } as unknown as WebGL2RenderingContext;
    const getCtxSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(((contextId: string) =>
        contextId === 'webgl2' ? fakeGl : null) as typeof HTMLCanvasElement.prototype.getContext);

    expect(isWebGLAvailable()).toBe(true);
    expect(loseContextSpy).toHaveBeenCalledTimes(1);
    getCtxSpy.mockRestore();
  });
});
