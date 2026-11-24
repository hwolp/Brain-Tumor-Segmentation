export type BraTSLabelId = 0 | 1 | 2 | 4;

export type BraTSEditableLabelId = 1 | 2 | 4;

export interface BraTSLabelSpec {
  readonly id: BraTSLabelId;
  readonly code: string;
  readonly shortName: string;
  readonly description: string;
  readonly hexColor: string | null;
  readonly rgba: readonly [number, number, number, number];
}

/**
 * Bảng màu và tên nhãn chuẩn BraTS v1.
 * Luôn hiển thị mã chữ đi kèm màu để không phụ thuộc duy nhất vào màu sắc.
 */
export const BRATS_LABELS: Readonly<Record<BraTSLabelId, BraTSLabelSpec>> = {
  0: {
    id: 0,
    code: '0',
    shortName: 'Nền',
    description: 'Nền ngoài vùng u (Background)',
    hexColor: null,
    rgba: [0, 0, 0, 0],
  },
  1: {
    id: 1,
    code: 'NCR/NET',
    shortName: '1: NCR/NET',
    description: 'Nhân hoại tử / Không tăng quang',
    hexColor: '#F59E0B',
    rgba: [245, 158, 11, 255],
  },
  2: {
    id: 2,
    code: 'Edema',
    shortName: '2: Edema',
    description: 'Phù nề quanh u',
    hexColor: '#22C55E',
    rgba: [34, 197, 94, 255],
  },
  4: {
    id: 4,
    code: 'ET',
    shortName: '4: ET',
    description: 'Vùng tăng quang (Enhancing Tumor)',
    hexColor: '#A855F7',
    rgba: [168, 85, 247, 255],
  },
};

export const BRATS_ALL_LABEL_IDS: readonly BraTSLabelId[] = [0, 1, 2, 4];

export const BRATS_TUMOR_LABEL_IDS: readonly BraTSEditableLabelId[] = [1, 2, 4];

export interface BraTSCompositeGroup {
  readonly key: 'WT' | 'TC' | 'ET';
  readonly label: string;
  readonly includedLabels: readonly BraTSEditableLabelId[];
  readonly note: string;
}

/**
 * Nhóm thống kê tổng hợp BraTS; không cộng trực tiếp thành tổng do có sự chồng lấp giữa WT, TC, ET.
 */
export const BRATS_COMPOSITE_GROUPS: readonly BraTSCompositeGroup[] = [
  {
    key: 'WT',
    label: 'Whole Tumor (WT = 1 + 2 + 4)',
    includedLabels: [1, 2, 4],
    note: 'Tổng toàn bộ vùng tổn thương (không cộng gộp với TC/ET)',
  },
  {
    key: 'TC',
    label: 'Tumor Core (TC = 1 + 4)',
    includedLabels: [1, 4],
    note: 'Lõi u (nằm trong WT)',
  },
  {
    key: 'ET',
    label: 'Enhancing Tumor (ET = 4)',
    includedLabels: [4],
    note: 'Vùng tăng quang (nằm trong TC và WT)',
  },
];

export function isValidBraTSLabel(value: number): value is BraTSLabelId {
  return value === 0 || value === 1 || value === 2 || value === 4;
}

export function getBraTSLabelSpec(label: BraTSLabelId): BraTSLabelSpec {
  return BRATS_LABELS[label];
}
