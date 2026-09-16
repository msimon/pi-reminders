// Derived state. Nothing here is persisted on the record — every value is
// recomputed from `dueAt` plus the current config and the current wall clock,
// so changing `allDayFireHour` or crossing a timezone needs no migration.

import {
  addLocalDays,
  addLocalMonths,
  addLocalYears,
  atLocalTime,
  calendarDayDiff,
  localDateOf,
} from "./time.ts";
import type {
  Bucket,
  Buckets,
  Recurrence,
  Reminder,
  RemindersConfig,
} from "./types.ts";

/** Local-time hour/minute at which an all-day reminder becomes late. */
const ALL_DAY_OVERDUE_HOUR = 23;
const ALL_DAY_OVERDUE_MINUTE = 59;

/**
 * When the reminder should nag you.
 *
 * All-day reminders fire at `allDayFireHour` local on their due date; timed
 * reminders fire at their exact instant. These are two different instants for
 * an all-day item, which is why `allDay` is a flag and not a time convention.
 */
export function fireAt(reminder: Reminder, config: RemindersConfig): number {
  const due = Date.parse(reminder.dueAt);
  if (!reminder.allDay) return due;
  return atLocalTime(localDateOf(due), config.allDayFireHour, 0);
}

/**
 * When the reminder becomes late.
 *
 * For an all-day item this is the end of its due date, so "fill in the form on
 * Jan 15" nags on the morning of the 15th but does not pollute the overdue
 * counter for the rest of that day.
 */
export function overdueAt(
  reminder: Reminder,
  _config: RemindersConfig,
): number {
  const due = Date.parse(reminder.dueAt);
  if (!reminder.allDay) return due;
  return atLocalTime(
    localDateOf(due),
    ALL_DAY_OVERDUE_HOUR,
    ALL_DAY_OVERDUE_MINUTE,
  );
}

/** Not yet cleared. Acked non-recurring records are kept as history. */
export function isActive(reminder: Reminder): boolean {
  return reminder.ackedAt === undefined;
}

/** Snoozed into the future — suppressed from firing, nagging and the overdue count. */
export function isSnoozed(reminder: Reminder, now: number): boolean {
  return (
    reminder.snoozedUntil !== undefined &&
    Date.parse(reminder.snoozedUntil) > now
  );
}

/**
 * The instant this reminder will next ask for attention: the snooze target
 * while snoozed, otherwise its fire time.
 */
export function effectiveAt(
  reminder: Reminder,
  config: RemindersConfig,
  now: number,
): number {
  if (isSnoozed(reminder, now))
    return Date.parse(reminder.snoozedUntil as string);
  return fireAt(reminder, config);
}

/** Late and not snoozed. Snooze is the pressure valve, so it clears overdue too. */
export function isOverdue(
  reminder: Reminder,
  config: RemindersConfig,
  now: number,
): boolean {
  if (!isActive(reminder)) return false;
  if (isSnoozed(reminder, now)) return false;
  return now >= overdueAt(reminder, config);
}

/**
 * Which disjoint statusline bucket a reminder falls in.
 *
 * `today` is the current local calendar day; `week` is days 2-7, i.e. the next
 * six calendar days, and explicitly excludes what `today` already counts.
 */
export function bucketOf(
  reminder: Reminder,
  config: RemindersConfig,
  now: number,
): Bucket {
  if (isOverdue(reminder, config, now)) return "overdue";
  const days = calendarDayDiff(effectiveAt(reminder, config, now), now);
  if (days <= 0) return "today";
  if (days <= 6) return "week";
  return "later";
}

/** Bucket every active reminder, each list sorted soonest-first. */
export function computeBuckets(
  reminders: Reminder[],
  config: RemindersConfig,
  now: number,
): Buckets {
  const buckets: Buckets = { overdue: [], today: [], week: [], later: [] };
  for (const reminder of reminders) {
    if (!isActive(reminder)) continue;
    buckets[bucketOf(reminder, config, now)].push(reminder);
  }
  const bySoonest = (a: Reminder, b: Reminder): number =>
    effectiveAt(a, config, now) - effectiveAt(b, config, now);
  buckets.overdue.sort(bySoonest);
  buckets.today.sort(bySoonest);
  buckets.week.sort(bySoonest);
  buckets.later.sort(bySoonest);
  return buckets;
}

/**
 * The nth occurrence of a recurring reminder, counted from its original anchor.
 *
 * Always measured from the anchor rather than from occurrence n-1, so month and
 * year steps re-clamp the anchor's day every time instead of drifting: Jan 31
 * monthly yields Feb 28, Mar 31, Apr 30, and Feb 29 yearly returns to Feb 29 on
 * the next leap year.
 */
export function nthOccurrence(
  anchor: number,
  unit: Recurrence,
  n: number,
): number {
  switch (unit) {
    case "day":
      return addLocalDays(anchor, n);
    case "week":
      return addLocalDays(anchor, n * 7);
    case "month":
      return addLocalMonths(anchor, n);
    case "year":
      return addLocalYears(anchor, n);
  }
}

/** Guard against a pathological anchor spinning the search forever. */
const MAX_OCCURRENCE_STEPS = 200_000;

/**
 * The first occurrence strictly after `after`, anchored to the original date.
 *
 * Ack a birthday three days late and the next occurrence is still March 14, not
 * March 17. A reminder left unacked for years still lands on its anchor's
 * calendar alignment rather than accumulating drift.
 */
export function nextOccurrence(
  anchor: number,
  unit: Recurrence,
  after: number,
): number {
  for (let n = 1; n <= MAX_OCCURRENCE_STEPS; n++) {
    const at = nthOccurrence(anchor, unit, n);
    if (at > after) return at;
  }
  // Unreachable for any real anchor; keep the record moving rather than throw.
  return nthOccurrence(after, unit, 1);
}

/**
 * Clear a reminder.
 *
 * Non-recurring records keep an `ackedAt` tombstone. Recurring records return
 * to pending at their next occurrence instead — rolling forward happens on ack,
 * and only on ack, so an unacked recurring reminder stays overdue at its
 * original date as a single record instead of stacking N missed occurrences.
 */
export function clearReminder(reminder: Reminder, now: number): Reminder {
  if (reminder.recurrence === undefined) {
    return { ...reminder, ackedAt: new Date(now).toISOString() };
  }

  const next = nextOccurrence(
    Date.parse(reminder.dueAt),
    reminder.recurrence,
    now,
  );
  // Back to pending: drop the fire claim, the snooze and any ack. Omitted by
  // destructuring rather than set to undefined, which exactOptionalPropertyTypes
  // rejects for an optional property.
  const {
    firedAt: _firedAt,
    snoozedUntil: _snoozedUntil,
    ackedAt: _ackedAt,
    ...pending
  } = reminder;
  return { ...pending, dueAt: new Date(next).toISOString() };
}
