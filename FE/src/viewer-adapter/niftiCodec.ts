import type { VolumeGeometry } from './types';

export interface ParsedNiftiVolume {
  shape: [number, number, number];
  spacingMm: [number, number, number];
  affine: number[][];
  datatype: number;
  bitpix: number;
  sclSlope: number;
  sclInter: number;
  qformCode: number;
  sformCode: number;
  data: Float32Array;
}

const NIFTI_HEADER_SIZE = 348;
const NIFTI_VOX_OFFSET = 352;

const DT_UINT8 = 2;
const DT_INT16 = 4;
const DT_INT32 = 8;
const DT_FLOAT32 = 16;
const DT_FLOAT64 = 64;
const DT_INT8 = 256;
const DT_UINT16 = 512;
const DT_UINT32 = 768;

function isGzipped(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function readStreamToUint8Array(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      totalLength += value.byteLength;
    }
  }

  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function getNodeZlib(): Promise<{
  gzipSync: (data: Uint8Array) => Uint8Array;
  gunzipSync: (data: Uint8Array) => Uint8Array;
} | null> {
  if (
    typeof process === 'undefined' ||
    !process.versions ||
    !process.versions.node
  ) {
    return null;
  }
  try {
    const modName = 'node:zlib';
    const zlibMod = (await import(/* @vite-ignore */ modName)) as {
      gzipSync: (data: Uint8Array) => Uint8Array;
      gunzipSync: (data: Uint8Array) => Uint8Array;
    };
    return zlibMod;
  } catch {
    return null;
  }
}

export async function gzipCompress(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream !== 'undefined') {
    try {
      const cs = new CompressionStream('gzip');
      const writer = cs.writable.getWriter();
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      void writer.write(copy).then(() => writer.close());
      return await readStreamToUint8Array(cs.readable);
    } catch {
      // Fallback to Node zlib below if Web stream fails in JSDOM
    }
  }
  const nodeZlib = await getNodeZlib();
  if (nodeZlib) {
    return new Uint8Array(nodeZlib.gzipSync(data));
  }
  throw new Error('Không hỗ trợ nén gzip trong môi trường hiện tại.');
}

export async function gzipDecompress(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'undefined') {
    try {
      const ds = new DecompressionStream('gzip');
      const writer = ds.writable.getWriter();
      const copy = new Uint8Array(data.byteLength);
      copy.set(data);
      void writer.write(copy).then(() => writer.close());
      return await readStreamToUint8Array(ds.readable);
    } catch {
      // Fallback to Node zlib below if Web stream fails in JSDOM
    }
  }
  const nodeZlib = await getNodeZlib();
  if (nodeZlib) {
    return new Uint8Array(nodeZlib.gunzipSync(data));
  }
  throw new Error('Không hỗ trợ giải nén gzip trong môi trường hiện tại.');
}

function getSpatialUnitScaleToMm(xyztUnits: number): number {
  const spatialCode = xyztUnits & 0x07;
  if (spatialCode === 1) return 1000; // meters -> mm
  if (spatialCode === 3) return 0.001; // microns -> mm
  return 1; // mm or unknown
}

function quaternionToAffine(
  qbIn: number,
  qcIn: number,
  qdIn: number,
  qx: number,
  qy: number,
  qz: number,
  pixdim: [number, number, number],
  qfac: number,
): number[][] {
  let qb = qbIn;
  let qc = qcIn;
  let qd = qdIn;
  const bcdSq = qb * qb + qc * qc + qd * qd;
  const aSq = 1 - bcdSq;
  let qa: number;
  if (aSq < 0) {
    const mag = Math.sqrt(bcdSq);
    if (mag > 0) {
      qb /= mag;
      qc /= mag;
      qd /= mag;
    }
    qa = 0;
  } else {
    qa = Math.sqrt(aSq);
  }

  const r11 = qa * qa + qb * qb - qc * qc - qd * qd;
  const r12 = 2 * (qb * qc - qa * qd);
  const r13 = 2 * (qb * qd + qa * qc);

  const r21 = 2 * (qb * qc + qa * qd);
  const r22 = qa * qa + qc * qc - qb * qb - qd * qd;
  const r23 = 2 * (qc * qd - qa * qb);

  const r31 = 2 * (qb * qd - qa * qc);
  const r32 = 2 * (qc * qd + qa * qb);
  const r33 = qa * qa + qd * qd - qb * qb - qc * qc;

  const sx = pixdim[0];
  const sy = pixdim[1];
  const sz = pixdim[2] * (qfac < 0 ? -1 : 1);

  return [
    [r11 * sx, r12 * sy, r13 * sz, qx],
    [r21 * sx, r22 * sy, r23 * sz, qy],
    [r31 * sx, r32 * sy, r33 * sz, qz],
    [0, 0, 0, 1],
  ];
}

function affineToQuaternion(affine: number[][]): {
  qb: number;
  qc: number;
  qd: number;
  qx: number;
  qy: number;
  qz: number;
  qfac: number;
  dx: number;
  dy: number;
  dz: number;
} {
  const col0 = [affine[0]?.[0] ?? 1, affine[1]?.[0] ?? 0, affine[2]?.[0] ?? 0];
  const col1 = [affine[0]?.[1] ?? 0, affine[1]?.[1] ?? 1, affine[2]?.[1] ?? 0];
  const col2 = [affine[0]?.[2] ?? 0, affine[1]?.[2] ?? 0, affine[2]?.[2] ?? 1];

  const norm = (v: number[]) =>
    Math.hypot(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0) || 1;
  const dx = norm(col0);
  const dy = norm(col1);
  const dz = norm(col2);

  let r11 = col0[0]! / dx;
  let r21 = col0[1]! / dx;
  let r31 = col0[2]! / dx;
  let r12 = col1[0]! / dy;
  let r22 = col1[1]! / dy;
  let r32 = col1[2]! / dy;
  let r13 = col2[0]! / dz;
  let r23 = col2[1]! / dz;
  let r33 = col2[2]! / dz;

  const det =
    r11 * (r22 * r33 - r23 * r32) -
    r12 * (r21 * r33 - r23 * r31) +
    r13 * (r21 * r32 - r22 * r31);

  let qfac = 1;
  if (det < 0) {
    qfac = -1;
    r13 = -r13;
    r23 = -r23;
    r33 = -r33;
  }

  let qa = 0;
  let qb = 0;
  let qc = 0;
  let qd = 0;
  const trace = r11 + r22 + r33 + 1;

  if (r11 + r22 + r33 > 0) {
    const s = 0.5 / Math.sqrt(trace);
    qa = 0.25 / s;
    qb = (r32 - r23) * s;
    qc = (r13 - r31) * s;
    qd = (r21 - r12) * s;
  } else if (r11 > r22 && r11 > r33) {
    const s = 2 * Math.sqrt(1 + r11 - r22 - r33);
    qa = (r32 - r23) / s;
    qb = 0.25 * s;
    qc = (r12 + r21) / s;
    qd = (r13 + r31) / s;
  } else if (r22 > r33) {
    const s = 2 * Math.sqrt(1 + r22 - r11 - r33);
    qa = (r13 - r31) / s;
    qb = (r12 + r21) / s;
    qc = 0.25 * s;
    qd = (r23 + r32) / s;
  } else {
    const s = 2 * Math.sqrt(1 + r33 - r11 - r22);
    qa = (r21 - r12) / s;
    qb = (r13 + r31) / s;
    qc = (r23 + r32) / s;
    qd = 0.25 * s;
  }

  const qMag = Math.hypot(qa, qb, qc, qd);
  if (qMag > 0) {
    qa /= qMag;
    qb /= qMag;
    qc /= qMag;
    qd /= qMag;
  }

  if (qa < 0) {
    qb = -qb;
    qc = -qc;
    qd = -qd;
  }

  return {
    qb,
    qc,
    qd,
    qx: affine[0]?.[3] ?? 0,
    qy: affine[1]?.[3] ?? 0,
    qz: affine[2]?.[3] ?? 0,
    qfac,
    dx,
    dy,
    dz,
  };
}

export async function parseNiftiVolume(
  input: ArrayBuffer | Uint8Array,
): Promise<ParsedNiftiVolume> {
  const rawBytes =
    input instanceof Uint8Array ? input : new Uint8Array(input);
  const bytes = isGzipped(rawBytes)
    ? await gzipDecompress(rawBytes)
    : rawBytes;

  if (bytes.byteLength < NIFTI_HEADER_SIZE) {
    throw new Error('Tệp NIfTI không hợp lệ: kích thước header nhỏ hơn 348 byte.');
  }

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );

  let littleEndian = true;
  let sizeofHdr = view.getInt32(0, true);
  if (sizeofHdr !== NIFTI_HEADER_SIZE) {
    const bigEndianHdr = view.getInt32(0, false);
    if (bigEndianHdr === NIFTI_HEADER_SIZE) {
      littleEndian = false;
      sizeofHdr = bigEndianHdr;
    } else {
      throw new Error('Header NIfTI-1 không hợp lệ (sizeof_hdr != 348).');
    }
  }

  const ndim = view.getInt16(40, littleEndian);
  if (ndim < 3 || ndim > 7) {
    throw new Error(
      `Chỉ chấp nhận ảnh NIfTI 3D scalar (dim[0] = ${ndim} không hợp lệ).`,
    );
  }
  for (let d = 4; d <= 7; d += 1) {
    const extraDim = view.getInt16(40 + d * 2, littleEndian);
    if (extraDim > 1) {
      throw new Error(
        `Không hỗ trợ ảnh NIfTI 4D/vector trong bản v1 (dim[${d}] = ${extraDim}).`,
      );
    }
  }

  const nx = view.getInt16(42, littleEndian);
  const ny = view.getInt16(44, littleEndian);
  const nz = view.getInt16(46, littleEndian);
  if (nx <= 0 || ny <= 0 || nz <= 0) {
    throw new Error(
      `Kích thước lưới NIfTI 3D phải dương (nhận ${nx}x${ny}x${nz}).`,
    );
  }
  const shape: [number, number, number] = [nx, ny, nz];

  const datatype = view.getInt16(70, littleEndian);
  const bitpix = view.getInt16(72, littleEndian);

  const qfacRaw = view.getFloat32(76, littleEndian);
  const qfac = qfacRaw < 0 ? -1 : 1;
  const xyztUnits = view.getUint8(123);
  const unitScale = getSpatialUnitScaleToMm(xyztUnits);

  const voxOffsetFloat = view.getFloat32(108, littleEndian);
  if (!Number.isFinite(voxOffsetFloat) || voxOffsetFloat < 0) {
    throw new Error('Header NIfTI có vox_offset không hợp lệ (< 0 hoặc NaN).');
  }
  const voxOffsetRaw = Math.floor(voxOffsetFloat);
  const voxOffset = voxOffsetRaw === 0 ? NIFTI_VOX_OFFSET : voxOffsetRaw;
  if (voxOffset < NIFTI_HEADER_SIZE) {
    throw new Error(
      `Header NIfTI có vox_offset (${voxOffset}) nhỏ hơn 348 byte.`,
    );
  }

  const rawSlope = view.getFloat32(112, littleEndian);
  const rawInter = view.getFloat32(116, littleEndian);
  if (!Number.isFinite(rawSlope) || !Number.isFinite(rawInter)) {
    throw new Error('Header NIfTI có scl_slope hoặc scl_inter không hữu hạn.');
  }
  const sclSlope = rawSlope !== 0 ? rawSlope : 1;
  const sclInter = rawSlope !== 0 ? rawInter : 0;

  const qformCode = view.getInt16(252, littleEndian);
  const sformCode = view.getInt16(254, littleEndian);

  if (sformCode <= 0 && qformCode <= 0) {
    throw new Error(
      'Tệp NIfTI thiếu hệ tọa độ không gian vật lý (sform_code <= 0 và qform_code <= 0).',
    );
  }

  let affine: number[][];
  if (sformCode > 0) {
    affine = [
      [
        view.getFloat32(280, littleEndian) * unitScale,
        view.getFloat32(284, littleEndian) * unitScale,
        view.getFloat32(288, littleEndian) * unitScale,
        view.getFloat32(292, littleEndian) * unitScale,
      ],
      [
        view.getFloat32(296, littleEndian) * unitScale,
        view.getFloat32(300, littleEndian) * unitScale,
        view.getFloat32(304, littleEndian) * unitScale,
        view.getFloat32(308, littleEndian) * unitScale,
      ],
      [
        view.getFloat32(312, littleEndian) * unitScale,
        view.getFloat32(316, littleEndian) * unitScale,
        view.getFloat32(320, littleEndian) * unitScale,
        view.getFloat32(324, littleEndian) * unitScale,
      ],
      [0, 0, 0, 1],
    ];
  } else {
    const rawSx = view.getFloat32(80, littleEndian);
    const rawSy = view.getFloat32(84, littleEndian);
    const rawSz = view.getFloat32(88, littleEndian);
    const qb = view.getFloat32(256, littleEndian);
    const qc = view.getFloat32(260, littleEndian);
    const qd = view.getFloat32(264, littleEndian);
    const qx = view.getFloat32(268, littleEndian);
    const qy = view.getFloat32(272, littleEndian);
    const qz = view.getFloat32(276, littleEndian);
    if (
      !Number.isFinite(rawSx) ||
      !Number.isFinite(rawSy) ||
      !Number.isFinite(rawSz) ||
      !Number.isFinite(qb) ||
      !Number.isFinite(qc) ||
      !Number.isFinite(qd) ||
      !Number.isFinite(qx) ||
      !Number.isFinite(qy) ||
      !Number.isFinite(qz)
    ) {
      throw new Error('Tham số qform / pixdim của NIfTI chứa giá trị không hữu hạn.');
    }
    const qSpacing: [number, number, number] = [
      Math.abs(rawSx) * unitScale,
      Math.abs(rawSy) * unitScale,
      Math.abs(rawSz) * unitScale,
    ];
    if (qSpacing[0] <= 0 || qSpacing[1] <= 0 || qSpacing[2] <= 0) {
      throw new Error('Voxel spacing trong pixdim của NIfTI phải dương.');
    }
    affine = quaternionToAffine(
      qb,
      qc,
      qd,
      qx * unitScale,
      qy * unitScale,
      qz * unitScale,
      qSpacing,
      qfac,
    );
  }

  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      if (!Number.isFinite(affine[r]?.[c])) {
        throw new Error('Ma trận affine NIfTI chứa giá trị không hữu hạn.');
      }
    }
  }

  const colNorm = (c: 0 | 1 | 2): number =>
    Math.hypot(affine[0]![c]!, affine[1]![c]!, affine[2]![c]!);
  const spacingMm: [number, number, number] = [
    colNorm(0),
    colNorm(1),
    colNorm(2),
  ];
  if (
    !Number.isFinite(spacingMm[0]) ||
    !Number.isFinite(spacingMm[1]) ||
    !Number.isFinite(spacingMm[2]) ||
    spacingMm[0] <= 0 ||
    spacingMm[1] <= 0 ||
    spacingMm[2] <= 0
  ) {
    throw new Error('Voxel spacing suy từ ma trận affine phải dương và hữu hạn.');
  }

  const detAffine =
    affine[0]![0]! * (affine[1]![1]! * affine[2]![2]! - affine[1]![2]! * affine[2]![1]!) -
    affine[0]![1]! * (affine[1]![0]! * affine[2]![2]! - affine[1]![2]! * affine[2]![0]!) +
    affine[0]![2]! * (affine[1]![0]! * affine[2]![1]! - affine[1]![1]! * affine[2]![0]!);
  if (!Number.isFinite(detAffine) || Math.abs(detAffine) <= 1e-8) {
    throw new Error('Ma trận affine NIfTI suy biến (không khả nghịch).');
  }

  const totalVoxels = nx * ny * nz;
  const data = new Float32Array(totalVoxels);

  const bytesPerVoxel =
    datatype === DT_UINT8 || datatype === DT_INT8
      ? 1
      : datatype === DT_INT16 || datatype === DT_UINT16
        ? 2
        : datatype === DT_FLOAT64
          ? 8
          : 4;

  if (voxOffset + totalVoxels * bytesPerVoxel > bytes.byteLength) {
    throw new Error('Dữ liệu voxel NIfTI không đủ kích thước theo shape khai báo.');
  }

  for (let i = 0; i < totalVoxels; i += 1) {
    const bytePos = voxOffset + i * bytesPerVoxel;
    let rawVal = 0;
    switch (datatype) {
      case DT_UINT8:
        rawVal = view.getUint8(bytePos);
        break;
      case DT_INT8:
        rawVal = view.getInt8(bytePos);
        break;
      case DT_INT16:
        rawVal = view.getInt16(bytePos, littleEndian);
        break;
      case DT_UINT16:
        rawVal = view.getUint16(bytePos, littleEndian);
        break;
      case DT_INT32:
        rawVal = view.getInt32(bytePos, littleEndian);
        break;
      case DT_UINT32:
        rawVal = view.getUint32(bytePos, littleEndian);
        break;
      case DT_FLOAT32:
        rawVal = view.getFloat32(bytePos, littleEndian);
        break;
      case DT_FLOAT64:
        rawVal = view.getFloat64(bytePos, littleEndian);
        break;
      default:
        throw new Error(`Không hỗ trợ kiểu dữ liệu NIfTI datatype=${datatype}.`);
    }
    if (!Number.isFinite(rawVal)) {
      throw new Error('Dữ liệu voxel NIfTI chứa giá trị NaN hoặc Infinity không hợp lệ.');
    }
    const scaledVal = rawVal * sclSlope + sclInter;
    if (!Number.isFinite(scaledVal)) {
      throw new Error('Dữ liệu voxel NIfTI sau quy đổi chứa giá trị không hữu hạn.');
    }
    data[i] = scaledVal;
  }

  return {
    shape,
    spacingMm,
    affine,
    datatype,
    bitpix,
    sclSlope,
    sclInter,
    qformCode,
    sformCode,
    data,
  };
}

export function parsedVolumeToUint8Mask(parsed: ParsedNiftiVolume): Uint8Array {
  const src = parsed.data;
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 1) {
    const val = src[i]!;
    if (val !== 0 && val !== 1 && val !== 2 && val !== 4) {
      throw new Error(
        `Giá trị voxel mask không hợp lệ tại vị trí ${i}: ${String(val)} (chỉ chấp nhận số nguyên hữu hạn thuộc {0, 1, 2, 4}).`,
      );
    }
    out[i] = val;
  }
  return out;
}

export async function serializeNiftiMask(
  mask: Uint8Array,
  geometry: VolumeGeometry,
  options?: { gzip?: boolean },
): Promise<Uint8Array> {
  const [nx, ny, nz] = geometry.shape;
  const expectedLength = nx * ny * nz;
  if (mask.length !== expectedLength) {
    throw new Error(
      `Kích thước buffer mask (${mask.length}) không khớp shape (${nx}x${ny}x${nz}).`,
    );
  }

  const totalBytes = NIFTI_VOX_OFFSET + expectedLength;
  const buffer = new Uint8Array(totalBytes);
  const view = new DataView(buffer.buffer);

  view.setInt32(0, NIFTI_HEADER_SIZE, true);
  // dim[0..7]
  view.setInt16(40, 3, true);
  view.setInt16(42, nx, true);
  view.setInt16(44, ny, true);
  view.setInt16(46, nz, true);
  view.setInt16(48, 1, true);
  view.setInt16(50, 1, true);
  view.setInt16(52, 1, true);
  view.setInt16(54, 1, true);

  // datatype = DT_UINT8 (2), bitpix = 8
  view.setInt16(70, DT_UINT8, true);
  view.setInt16(72, 8, true);

  const col0Norm = Math.hypot(
    geometry.affine[0]?.[0] ?? 0,
    geometry.affine[1]?.[0] ?? 0,
    geometry.affine[2]?.[0] ?? 0,
  );
  const col1Norm = Math.hypot(
    geometry.affine[0]?.[1] ?? 0,
    geometry.affine[1]?.[1] ?? 0,
    geometry.affine[2]?.[1] ?? 0,
  );
  const col2Norm = Math.hypot(
    geometry.affine[0]?.[2] ?? 0,
    geometry.affine[1]?.[2] ?? 0,
    geometry.affine[2]?.[2] ?? 0,
  );
  if (
    !Number.isFinite(col0Norm) ||
    !Number.isFinite(col1Norm) ||
    !Number.isFinite(col2Norm) ||
    col0Norm <= 0 ||
    col1Norm <= 0 ||
    col2Norm <= 0
  ) {
    throw new Error('Ma trận affine của mask không hợp lệ (chuẩn cột <= 0 hoặc không hữu hạn).');
  }

  const quat = affineToQuaternion(geometry.affine);
  // pixdim[0..3]: ghi từ chính độ dài vector cột dx, dy, dz của affine để qform và sform khớp tuyệt đối
  view.setFloat32(76, quat.qfac, true);
  view.setFloat32(80, col0Norm, true);
  view.setFloat32(84, col1Norm, true);
  view.setFloat32(88, col2Norm, true);
  view.setFloat32(92, 1, true);

  view.setFloat32(108, NIFTI_VOX_OFFSET, true);
  view.setFloat32(112, 1, true); // scl_slope
  view.setFloat32(116, 0, true); // scl_inter
  view.setUint8(123, 2); // xyzt_units = mm

  // qform_code = 1, sform_code = 1
  view.setInt16(252, 1, true);
  view.setInt16(254, 1, true);

  view.setFloat32(256, quat.qb, true);
  view.setFloat32(260, quat.qc, true);
  view.setFloat32(264, quat.qd, true);
  view.setFloat32(268, quat.qx, true);
  view.setFloat32(272, quat.qy, true);
  view.setFloat32(276, quat.qz, true);

  // srow_x, srow_y, srow_z
  for (let row = 0; row < 3; row += 1) {
    const affineRow = geometry.affine[row] ?? [0, 0, 0, 0];
    const base = 280 + row * 16;
    view.setFloat32(base, affineRow[0] ?? 0, true);
    view.setFloat32(base + 4, affineRow[1] ?? 0, true);
    view.setFloat32(base + 8, affineRow[2] ?? 0, true);
    view.setFloat32(base + 12, affineRow[3] ?? 0, true);
  }

  // magic "n+1\0"
  buffer[344] = 0x6e; // 'n'
  buffer[345] = 0x2b; // '+'
  buffer[346] = 0x31; // '1'
  buffer[347] = 0x00; // '\0'

  buffer.set(mask, NIFTI_VOX_OFFSET);

  if (options?.gzip === false) {
    return buffer;
  }
  return gzipCompress(buffer);
}

export function createEmptyMaskBuffer(
  shape: readonly [number, number, number],
): Uint8Array {
  return new Uint8Array(shape[0] * shape[1] * shape[2]);
}

export interface SyntheticBrainVolumes {
  shape: [number, number, number];
  flair: Float32Array;
  t1ce: Float32Array;
  aiMask: Uint8Array;
}

/**
 * Tạo khối MRI não 3D tổng hợp bất đối xứng (FLAIR, T1ce, và AI mask {0,1,2,4})
 * dùng cho chế độ VITE_USE_FIXTURES=true và kiểm thử định hướng L/R.
 */
export function createSyntheticBrainVolumes(
  shape: readonly [number, number, number] = [240, 240, 155],
): SyntheticBrainVolumes {
  const [nx, ny, nz] = shape;
  const total = nx * ny * nz;
  const flair = new Float32Array(total);
  const t1ce = new Float32Array(total);
  const aiMask = new Uint8Array(total);

  const cx = nx * 0.5;
  const cy = ny * 0.5;
  const cz = nz * 0.5;
  const rx = nx * 0.36;
  const ry = ny * 0.42;
  const rz = nz * 0.42;

  // Khối u bất đối xứng nằm ở bán cầu trái giải phẫu (x < cx trong RAS chuẩn)
  const tumorCx = nx * 0.34;
  const tumorCy = ny * 0.46;
  const tumorCz = nz * 0.5;
  const edemaR = Math.max(6, Math.min(nx, ny) * 0.11);
  const coreR = Math.max(4, Math.min(nx, ny) * 0.065);
  const ncrR = Math.max(2, Math.min(nx, ny) * 0.032);

  // Điểm mốc phụ nhỏ ở bán cầu phải để kiểm tra bất đối xứng
  const markerCx = nx * 0.68;
  const markerCy = ny * 0.56;
  const markerCz = nz * 0.5;
  const markerR = Math.max(2, Math.min(nx, ny) * 0.025);

  const sliceStride = nx * ny;
  const zMin = Math.max(0, Math.floor(cz - rz));
  const zMax = Math.min(nz - 1, Math.ceil(cz + rz));
  const yMin = Math.max(0, Math.floor(cy - ry));
  const yMax = Math.min(ny - 1, Math.ceil(cy + ry));
  const xMin = Math.max(0, Math.floor(cx - rx));
  const xMax = Math.min(nx - 1, Math.ceil(cx + rx));

  for (let z = zMin; z <= zMax; z += 1) {
    const dzNorm = (z - cz) / rz;
    const dz2 = dzNorm * dzNorm;
    if (dz2 > 1) continue;

    const dzTumor = z - tumorCz;
    const dzMarker = z - markerCz;
    const zOffset = z * sliceStride;

    for (let y = yMin; y <= yMax; y += 1) {
      const dyNorm = (y - cy) / ry;
      const dy2 = dyNorm * dyNorm + dz2;
      if (dy2 > 1) continue;

      const dyTumor = y - tumorCy;
      const dyMarker = y - markerCy;
      const rowOffset = zOffset + y * nx;

      for (let x = xMin; x <= xMax; x += 1) {
        const dxNorm = (x - cx) / rx;
        const r2 = dxNorm * dxNorm + dy2;
        if (r2 > 1) continue;

        const idx = rowOffset + x;
        // Nền nhu mô não
        const cortex = r2 > 0.72 ? 420 : 620 - r2 * 140;
        let flairVal = cortex;
        let t1ceVal = r2 > 0.72 ? 520 : 580 - r2 * 80;

        // Vùng u bất đối xứng ở bán cầu trái
        const dxTumor = x - tumorCx;
        const distTumor = Math.sqrt(
          dxTumor * dxTumor + dyTumor * dyTumor + dzTumor * dzTumor,
        );

        if (distTumor <= edemaR) {
          flairVal = 920;
          if (distTumor <= ncrR) {
            aiMask[idx] = 1; // NCR/NET
            flairVal = 380;
            t1ceVal = 290;
          } else if (distTumor <= coreR) {
            aiMask[idx] = 4; // ET
            flairVal = 780;
            t1ceVal = 1080;
          } else {
            aiMask[idx] = 2; // Edema
            t1ceVal = 460;
          }
        } else {
          // Điểm mốc nhỏ ở bán cầu phải (không phải u, chỉ để phân biệt L/R)
          const dxMarker = x - markerCx;
          const distMarkerSq =
            dxMarker * dxMarker + dyMarker * dyMarker + dzMarker * dzMarker;
          if (distMarkerSq <= markerR * markerR) {
            flairVal = 840;
            t1ceVal = 840;
          }
        }

        flair[idx] = flairVal;
        t1ce[idx] = t1ceVal;
      }
    }
  }

  return {
    shape: [nx, ny, nz],
    flair,
    t1ce,
    aiMask,
  };
}
