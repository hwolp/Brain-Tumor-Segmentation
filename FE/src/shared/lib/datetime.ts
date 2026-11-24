const VIETNAM_TIMEZONE = 'Asia/Ho_Chi_Minh';

const vnDateTimeFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: VIETNAM_TIMEZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const vnDateFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: VIETNAM_TIMEZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

function extractPartMap(
  formatter: Intl.DateTimeFormat,
  date: Date,
): Record<string, string> {
  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') {
      parts[part.type] = part.value;
    }
  }
  return parts;
}

function parseIsoUtc(isoString: string | null | undefined): Date | null {
  if (!isoString || typeof isoString !== 'string') {
    return null;
  }
  const trimmed = isoString.trim();
  if (!trimmed) {
    return null;
  }
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

/**
 * Định dạng thời điểm ISO 8601 UTC sang múi giờ Asia/Ho_Chi_Minh (dd/MM/yyyy HH:mm).
 */
export function formatDateTimeVN(isoUtc: string | null | undefined): string {
  const date = parseIsoUtc(isoUtc);
  if (!date) {
    return '—';
  }
  const parts = extractPartMap(vnDateTimeFormatter, date);
  const day = parts.day ?? '00';
  const month = parts.month ?? '00';
  const year = parts.year ?? '0000';
  const hour = parts.hour === '24' ? '00' : (parts.hour ?? '00');
  const minute = parts.minute ?? '00';
  return `${day}/${month}/${year} ${hour}:${minute}`;
}

/**
 * Định dạng thời điểm ISO 8601 UTC sang ngày theo múi giờ Asia/Ho_Chi_Minh (dd/MM/yyyy).
 */
export function formatDateVN(isoUtc: string | null | undefined): string {
  const date = parseIsoUtc(isoUtc);
  if (!date) {
    return '—';
  }
  const parts = extractPartMap(vnDateFormatter, date);
  const day = parts.day ?? '00';
  const month = parts.month ?? '00';
  const year = parts.year ?? '0000';
  return `${day}/${month}/${year}`;
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Định dạng ngày chụp date-only (YYYY-MM-DD) sang dd/MM/yyyy.
 * Tuyệt đối không chuyển qua Date/timezone để tránh lệch ngày giữa các múi giờ.
 */
export function formatStudyDate(studyDate: string | null | undefined): string {
  if (!studyDate || typeof studyDate !== 'string') {
    return '—';
  }
  const match = DATE_ONLY_PATTERN.exec(studyDate.trim());
  if (!match) {
    return '—';
  }
  const yearStr = match[1];
  const monthStr = match[2];
  const dayStr = match[3];
  if (!yearStr || !monthStr || !dayStr) {
    return '—';
  }

  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return '—';
  }

  const calendarCheck = new Date(Date.UTC(year, month - 1, day));
  if (
    calendarCheck.getUTCFullYear() !== year ||
    calendarCheck.getUTCMonth() !== month - 1 ||
    calendarCheck.getUTCDate() !== day
  ) {
    return '—';
  }

  return `${dayStr}/${monthStr}/${yearStr}`;
}

/**
 * Lấy ngày hiện tại theo múi giờ Asia/Ho_Chi_Minh dưới dạng YYYY-MM-DD.
 */
export function getTodayDateVN(now: Date = new Date()): string {
  const parts = extractPartMap(vnDateFormatter, now);
  const year = parts.year ?? '1970';
  const month = parts.month ?? '01';
  const day = parts.day ?? '01';
  return `${year}-${month}-${day}`;
}
