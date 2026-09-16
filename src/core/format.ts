// Human-readable renderings of a record. Display follows the `allDay` flag:
// `Jan 15` for all-day, `Jan 15 14:00` for timed.

import { effectiveAt, fireAt, overdueAt } from "./derive.ts";
import { calendarDayDiff, formatLocalDateTime } from "./time.ts";
import type { Reminder, RemindersConfig } from "./types.ts";

const MONTHS = [
 "Jan",
 "Feb",
 "Mar",
 "Apr",
 "May",
 "Jun",
 "Jul",
 "Aug",
 "Sep",
 "Oct",
 "Nov",
 "Dec",
];

const PAD = (n: number): string => String(n).padStart(2, "0");

/** `Jan 15` or `Jan 15 14:00`, local time, with the year only when it differs. */
export function formatDue(reminder: Reminder, now: number): string {
 const at = new Date(Date.parse(reminder.dueAt));
 const month = MONTHS[at.getMonth()] as string;
 const sameYear = at.getFullYear() === new Date(now).getFullYear();
 const year = sameYear ? "" : ` ${at.getFullYear()}`;
 const date = `${month} ${at.getDate()}${year}`;
 if (reminder.allDay) return date;
 return `${date} ${PAD(at.getHours())}:${PAD(at.getMinutes())}`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** Coarse "how late" / "how soon" label, e.g. `2d overdue`, `in 3h`, `now`. */
function formatRelative(target: number, now: number): string {
 const deltaMs = target - now;
 const absMs = Math.abs(deltaMs);
 if (absMs < MINUTE_MS) return "now";

 let magnitude: string;
 if (absMs < HOUR_MS) {
  magnitude = `${Math.round(absMs / MINUTE_MS)}m`;
 } else if (absMs < 24 * HOUR_MS) {
  magnitude = `${Math.round(absMs / HOUR_MS)}h`;
 } else {
  magnitude = `${Math.abs(calendarDayDiff(target, now))}d`;
 }

 return deltaMs < 0 ? `${magnitude} overdue` : `in ${magnitude}`;
}

/**
 * Describe the machine's local zone and clock.
 *
 * Handed to the model in the tool description so it never has to guess the
 * offset when resolving "tomorrow morning" or converting a UTC instant. The
 * offset is sampled once, when the tool is registered, so it is labelled as
 * such: a session that runs across a DST boundary will show the pre-change
 * offset until the next start.
 */
export function describeLocalZone(now: number): string {
 const at = new Date(now);
 const offsetMinutes = -at.getTimezoneOffset();
 const sign = offsetMinutes < 0 ? "-" : "+";
 const absolute = Math.abs(offsetMinutes);
 const offset = `${sign}${PAD(Math.floor(absolute / 60))}:${PAD(absolute % 60)}`;
 let zoneName: string;
 try {
  zoneName = Intl.DateTimeFormat().resolvedOptions().timeZone;
 } catch {
  zoneName = "unknown";
 }
 return `${zoneName} (UTC${offset}), local time ${formatLocalDateTime(at)}, as of session start`;
}

/** Truncate on a whole character boundary so a widget line cannot wrap. */
export function truncate(text: string, max: number): string {
 const chars = [...text];
 if (chars.length <= max) return text;
 return `${chars.slice(0, Math.max(1, max - 1)).join("")}…`;
}

/**
 * One-line list entry: `a3f  ⚠️ call the accountant   Jan 12 (2d overdue)`.
 * Snoozed records show their snooze target rather than their original time,
 * because that is when they will actually come back.
 */
export function formatReminderLine(
 reminder: Reminder,
 config: RemindersConfig,
 now: number,
): string {
 const late =
  now >= overdueAt(reminder, config) && reminder.snoozedUntil === undefined;
 const marker = late ? "⚠️ " : "";
 const recurring =
  reminder.recurrence === undefined ? "" : ` (every ${reminder.recurrence})`;

 const snoozed =
  reminder.snoozedUntil !== undefined &&
  Date.parse(reminder.snoozedUntil) > now;
 let timing: string;
 if (snoozed) {
  timing = `snoozed ${formatRelative(effectiveAt(reminder, config, now), now)}`;
 } else {
  const reference = late
   ? overdueAt(reminder, config)
   : fireAt(reminder, config);
  timing = `${formatDue(reminder, now)} (${formatRelative(reference, now)})`;
 }

 return `${reminder.id}  ${marker}${reminder.message}${recurring} — ${timing}`;
}
