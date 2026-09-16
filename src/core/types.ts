// Record shape and config shape. No Pi imports anywhere in src/core — this
// layer is pure functions plus filesystem so it stays unit-testable with
// `node --test` standalone.

/** Recurrence units. Matches `--every <unit>` and the tool's `recurrence` field. */
export type Recurrence = "day" | "week" | "month" | "year";

export const RECURRENCE_UNITS: readonly Recurrence[] = ["day", "week", "month", "year"];

export interface Reminder {
  /** Short hash, e.g. "a3f" — stable for the life of the record, shown in list output. */
  id: string;
  message: string;
  allDay: boolean;
  /**
   * ISO 8601, UTC.
   *
   * For `allDay: true` this instant is anchored at 12:00 *local* on the due
   * calendar date, not midnight. The record only ever exposes the calendar
   * date (`fireAt`/`overdueAt`/display all re-derive from local components),
   * and noon keeps that date stable across DST shifts and ±12h of travel.
   * Midnight would slide a birthday onto the wrong day in either direction.
   */
  dueAt: string;
  recurrence?: Recurrence;
  createdAt: string;
  /** Captured at creation for context only — never used as a filter. */
  cwd: string;
  /** Set on first fire. Also the cross-window claim for the desktop banner. */
  firedAt?: string;
  snoozedUntil?: string;
  /** Set on clear. Recurring reminders roll their `dueAt` forward instead. */
  ackedAt?: string;
}

export const STATE_VERSION = 1;

export interface ReminderState {
  version: number;
  reminders: Reminder[];
}

export type StatuslineStyle = "words" | "compact";

export interface RemindersConfig {
  /** Local-time hour, 0-23, at which all-day reminders fire. */
  allDayFireHour: number;
  statuslineStyle: StatuslineStyle;
  statuslinePrefix: string;
  tickIntervalSeconds: number;
  startupReportLimit: number;
  desktopNotifications: boolean;
}

export const DEFAULT_CONFIG: RemindersConfig = {
  allDayFireHour: 9,
  statuslineStyle: "words",
  statuslinePrefix: "",
  tickIntervalSeconds: 60,
  startupReportLimit: 5,
  desktopNotifications: true,
};

/** Disjoint statusline buckets. `later` is tracked but not rendered. */
export type Bucket = "overdue" | "today" | "week" | "later";

export interface Buckets {
  overdue: Reminder[];
  today: Reminder[];
  week: Reminder[];
  later: Reminder[];
}
