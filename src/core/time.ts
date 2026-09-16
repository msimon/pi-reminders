// Local-time arithmetic helpers.
//
// Everything here goes through the Date constructor's local-components form
// (`new Date(y, m, d, h, min)`) rather than epoch-millisecond arithmetic. That
// is what makes the derivations DST-safe: adding 7 "days" to a weekly reminder
// has to land on the same weekday at the same wall-clock time even when a DST
// boundary made one of those days 23 or 25 hours long.

export interface LocalDate {
  year: number;
  month: number; // 0-11, matching Date
  day: number;
}

export function localDateOf(at: Date | number): LocalDate {
  const d = at instanceof Date ? at : new Date(at);
  return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
}

/** Days in a month. `month` is 0-11. Handles February in leap years. */
export function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month is the last day of this one.
  return new Date(year, month + 1, 0).getDate();
}

/** Build a local-time instant from an explicit date and wall-clock time. */
export function atLocalTime(date: LocalDate, hour: number, minute: number, second = 0, ms = 0): number {
  return new Date(date.year, date.month, date.day, hour, minute, second, ms).getTime();
}

/** Local 12:00 on a calendar date — the storage anchor for all-day reminders. */
export function localNoon(date: LocalDate): number {
  return atLocalTime(date, 12, 0);
}

/** Midnight at the start of the local day containing `at`. */
export function startOfLocalDay(at: Date | number): number {
  return atLocalTime(localDateOf(at), 0, 0);
}

/**
 * Whole local calendar days from `from` to `to`. Same day is 0, tomorrow is 1,
 * yesterday is -1. Computed by differencing day-start instants and rounding, so
 * a 23h or 25h DST day still counts as exactly one day.
 */
export function calendarDayDiff(to: Date | number, from: Date | number): number {
  const DAY_MS = 86_400_000;
  return Math.round((startOfLocalDay(to) - startOfLocalDay(from)) / DAY_MS);
}

/**
 * Add whole local days, preserving wall-clock time across DST boundaries.
 * `new Date(y, m, d + n, ...)` normalizes month/year overflow for us.
 */
export function addLocalDays(at: Date | number, days: number): number {
  const d = at instanceof Date ? at : new Date(at);
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + days,
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds(),
  ).getTime();
}

/**
 * Add whole months, clamping the day to the target month's length.
 *
 * The day is always taken from the *anchor*, never from the previous step, so
 * Jan 31 monthly gives Feb 28, Mar 31, Apr 30 — it never drifts down to the
 * 28th permanently, and never spills into the following month.
 */
export function addLocalMonths(at: Date | number, months: number): number {
  const d = at instanceof Date ? at : new Date(at);
  const targetMonthIndex = d.getMonth() + months;
  const year = d.getFullYear() + Math.floor(targetMonthIndex / 12);
  const month = ((targetMonthIndex % 12) + 12) % 12;
  const day = Math.min(d.getDate(), daysInMonth(year, month));
  return new Date(
    year,
    month,
    day,
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds(),
  ).getTime();
}

/**
 * Add whole years, clamping the day to the target month's length.
 * Feb 29 yearly gives Feb 28 in non-leap years and returns to Feb 29 on the
 * next leap year, because the anchor day (29) is re-clamped every time rather
 * than being overwritten.
 */
export function addLocalYears(at: Date | number, years: number): number {
  return addLocalMonths(at, years * 12);
}

const PAD = (n: number): string => String(n).padStart(2, "0");

/** `YYYY-MM-DD HH:MM` in local time. */
export function formatLocalDateTime(at: Date | number): string {
  const d = at instanceof Date ? at : new Date(at);
  return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())} ${PAD(d.getHours())}:${PAD(d.getMinutes())}`;
}

/** `YYYY-MM-DD` in local time. */
export function formatLocalDate(at: Date | number): string {
  const d = at instanceof Date ? at : new Date(at);
  return `${d.getFullYear()}-${PAD(d.getMonth() + 1)}-${PAD(d.getDate())}`;
}
