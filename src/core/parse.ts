// Input parsing. Two accepted forms and nothing else.
//
// No date library and no LLM call: `chrono-node` would be 2.76 MB for ambiguity
// we do not want ("next week" — next Monday, or seven days out?). Natural
// language is the model's job; it resolves to an absolute timestamp before
// calling the tool, so this stays a pure state machine with zero dependencies.
// Anything unrecognised is rejected with the accepted formats, never guessed at.

import { daysInMonth, localNoon } from "./time.ts";
import { RECURRENCE_UNITS, type Recurrence } from "./types.ts";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const ACCEPTED_WHEN_FORMATS =
  "absolute `YYYY-MM-DD` (all-day) or `YYYY-MM-DD HH:MM` (timed), or an offset `<N><m|h|d|w>` such as `45m`, `3h`, `2d`, `1w`";

export const ACCEPTED_DURATION_FORMATS = "an offset `<N><m|h|d|w>` such as `45m`, `3h`, `2d`, `1w`";

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
/** The single relative-offset regex, used by both `add` and `snooze`. */
const OFFSET = /^(\d+)([mhdw])$/;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

const OFFSET_MS: Record<string, number> = {
  m: MINUTE_MS,
  h: HOUR_MS,
  d: DAY_MS,
  w: WEEK_MS,
};

export interface ParsedWhen {
  /** ISO 8601, UTC. */
  dueAt: string;
  /** Set by the *absence* of a time component — never passed explicitly. */
  allDay: boolean;
}

function isRealCalendarDate(year: number, month1: number, day: number): boolean {
  if (month1 < 1 || month1 > 12) return false;
  if (day < 1) return false;
  return day <= daysInMonth(year, month1 - 1);
}

/**
 * Parse a duration offset into milliseconds. Shared by relative `add` and by
 * `snooze`, so `2h` means the same thing in both.
 */
export function parseDuration(input: string): ParseResult<number> {
  const match = OFFSET.exec(input.trim().toLowerCase());
  if (match === null) {
    return { ok: false, error: `Could not read "${input.trim()}". Expected ${ACCEPTED_DURATION_FORMATS}.` };
  }
  const amount = Number.parseInt(match[1] as string, 10);
  if (amount <= 0) {
    return { ok: false, error: "Duration must be greater than zero." };
  }
  const unitMs = OFFSET_MS[match[2] as string] as number;
  return { ok: true, value: amount * unitMs };
}

/**
 * Parse a `<when>` argument into an absolute instant plus the `allDay` flag.
 *
 * Whatever is typed, the caller echoes the resolved absolute timestamp back on
 * success, so a relative offset is never ambiguous after the fact.
 */
export function parseWhen(input: string, now: number): ParseResult<ParsedWhen> {
  const raw = input.trim();
  if (raw === "") {
    return { ok: false, error: `Missing a date. Expected ${ACCEPTED_WHEN_FORMATS}.` };
  }

  const dateOnly = DATE_ONLY.exec(raw);
  if (dateOnly !== null) {
    const year = Number.parseInt(dateOnly[1] as string, 10);
    const month1 = Number.parseInt(dateOnly[2] as string, 10);
    const day = Number.parseInt(dateOnly[3] as string, 10);
    if (!isRealCalendarDate(year, month1, day)) {
      return { ok: false, error: `"${raw}" is not a real calendar date.` };
    }
    // Anchored at local noon so the calendar date survives DST and travel.
    const at = localNoon({ year, month: month1 - 1, day });
    return { ok: true, value: { dueAt: new Date(at).toISOString(), allDay: true } };
  }

  const dateTime = DATE_TIME.exec(raw);
  if (dateTime !== null) {
    const year = Number.parseInt(dateTime[1] as string, 10);
    const month1 = Number.parseInt(dateTime[2] as string, 10);
    const day = Number.parseInt(dateTime[3] as string, 10);
    const hour = Number.parseInt(dateTime[4] as string, 10);
    const minute = Number.parseInt(dateTime[5] as string, 10);
    const second = dateTime[6] === undefined ? 0 : Number.parseInt(dateTime[6], 10);
    if (!isRealCalendarDate(year, month1, day)) {
      return { ok: false, error: `"${raw}" is not a real calendar date.` };
    }
    if (hour > 23 || minute > 59 || second > 59) {
      return { ok: false, error: `"${raw}" is not a real time of day.` };
    }
    const at = new Date(year, month1 - 1, day, hour, minute, second).getTime();
    return { ok: true, value: { dueAt: new Date(at).toISOString(), allDay: false } };
  }

  const offset = parseDuration(raw);
  if (offset.ok) {
    // Relative offsets are always timed.
    return { ok: true, value: { dueAt: new Date(now + offset.value).toISOString(), allDay: false } };
  }

  return { ok: false, error: `Could not read "${raw}". Expected ${ACCEPTED_WHEN_FORMATS}.` };
}

export function parseRecurrence(input: string): ParseResult<Recurrence> {
  const raw = input.trim().toLowerCase();
  const found = RECURRENCE_UNITS.find((unit) => unit === raw);
  if (found === undefined) {
    return { ok: false, error: `Unknown recurrence "${input.trim()}". Expected one of: ${RECURRENCE_UNITS.join(", ")}.` };
  }
  return { ok: true, value: found };
}

/**
 * Resolve a snooze target: either a relative duration from now, or an absolute
 * `--until` date. Absolute all-day input resolves to that date's fire hour
 * rather than to noon, so `--until 2026-01-20` nags on the morning of the 20th.
 */
export function parseSnoozeTarget(
  input: string,
  now: number,
  allDayFireHour: number,
): ParseResult<number> {
  const raw = input.trim();
  const duration = parseDuration(raw);
  if (duration.ok) return { ok: true, value: now + duration.value };

  const when = parseWhen(raw, now);
  if (!when.ok) return { ok: false, error: when.error };

  const due = Date.parse(when.value.dueAt);
  if (!when.value.allDay) return { ok: true, value: due };

  const at = new Date(due);
  return {
    ok: true,
    value: new Date(at.getFullYear(), at.getMonth(), at.getDate(), allDayFireHour, 0).getTime(),
  };
}
