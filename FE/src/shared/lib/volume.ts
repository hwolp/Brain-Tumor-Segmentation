/**
 * Chuyển đổi thể tích từ mm³ sang mL (1 mL = 1000 mm³).
 */
export function mm3ToMl(mm3: number): number {
  if (!Number.isFinite(mm3) || mm3 < 0) {
    return Number.NaN;
  }
  return mm3 / 1000;
}

/**
 * Định dạng thể tích theo đơn vị mm³ (theo chuẩn số Việt Nam).
 */
export function formatVolumeMm3(
  mm3: number | null | undefined,
  maximumFractionDigits = 1,
): string {
  if (mm3 === null || mm3 === undefined || !Number.isFinite(mm3) || mm3 < 0) {
    return '—';
  }
  const formatted = new Intl.NumberFormat('vi-VN', {
    minimumFractionDigits: 0,
    maximumFractionDigits,
  }).format(mm3);
  return `${formatted} mm³`;
}

/**
 * Định dạng thể tích từ mm³ sang mL (mm³ / 1000).
 */
export function formatVolumeMl(
  mm3: number | null | undefined,
  fractionDigits = 2,
): string {
  if (mm3 === null || mm3 === undefined || !Number.isFinite(mm3) || mm3 < 0) {
    return '—';
  }
  const ml = mm3 / 1000;
  const formatted = new Intl.NumberFormat('vi-VN', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(ml);
  return `${formatted} mL`;
}

/**
 * Định dạng song song mL và mm³ phục vụ đối chiếu lâm sàng.
 */
export function formatVolumeSummary(mm3: number | null | undefined): string {
  if (mm3 === null || mm3 === undefined || !Number.isFinite(mm3) || mm3 < 0) {
    return '—';
  }
  return `${formatVolumeMl(mm3)} (${formatVolumeMm3(mm3)})`;
}
