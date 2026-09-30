import { AppError } from "./errors";

/** Asia/Jakarta is a fixed UTC+7 offset with no DST. */
export const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
export const BUSINESS_TZ = "Asia/Jakarta";
export const MAX_RANGE_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Business date (YYYY-MM-DD, WIB) of an instant. */
export function toBusinessDate(instant: Date): string {
  return new Date(instant.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

export function todayBusinessDate(now: Date = new Date()): string {
  return toBusinessDate(now);
}

export function isValidDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/** UTC instants of [date 00:00 WIB, date+1 00:00 WIB). */
export function businessDayRangeUtc(date: string): { start: Date; end: Date } {
  const start = new Date(new Date(`${date}T00:00:00Z`).getTime() - WIB_OFFSET_MS);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

export function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** Inclusive number of days between two YYYY-MM-DD dates. */
export function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
}

export interface DateRange {
  from: string;
  to: string;
}

/** Validate an optional from/to pair; both default to today (WIB). */
export function parseDateRange(
  from: string | undefined,
  to: string | undefined,
  opts: { now?: Date; maxDays?: number } = {},
): DateRange {
  const today = todayBusinessDate(opts.now);
  const f = from ?? to ?? today;
  const t = to ?? from ?? today;
  for (const [field, value] of [
    ["from", f],
    ["to", t],
  ] as const) {
    if (!isValidDate(value)) {
      throw new AppError(422, "VALIDATION_ERROR", "Format tanggal harus YYYY-MM-DD", [
        { field, message: "Format tanggal harus YYYY-MM-DD" },
      ]);
    }
  }
  if (f > t) {
    throw new AppError(422, "INVALID_DATE_RANGE", "Tanggal awal tidak boleh setelah tanggal akhir");
  }
  const max = opts.maxDays ?? MAX_RANGE_DAYS;
  if (daysInclusive(f, t) > max) {
    throw new AppError(422, "DATE_RANGE_TOO_LARGE", `Rentang tanggal maksimal ${max} hari`);
  }
  return { from: f, to: t };
}

/** Preceding period of equal length. */
export function previousPeriod(range: DateRange): DateRange {
  const n = daysInclusive(range.from, range.to);
  const prevTo = addDays(range.from, -1);
  return { from: addDays(prevTo, -(n - 1)), to: prevTo };
}

/** Format an instant as `YYYY-MM-DD HH:mm:ss` in WIB. */
export function formatWib(instant: Date): string {
  return new Date(instant.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 19).replace("T", " ");
}
