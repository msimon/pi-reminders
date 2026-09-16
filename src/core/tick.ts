// The tick state machine.
//
// pending ──(fireAt reached)──> fired ──┬──> acked      (cleared)
//                                       ├──> snoozed ──> pending
//                                       └──> deleted
//
// Every tick recomputes state by comparing WALL CLOCK (`Date.now()`) against
// stored timestamps. Never elapsed timers: macOS suspends `setTimeout` across
// sleep, so a timer armed for 45 minutes before the lid closes does not fire 45
// minutes later. Recomputing from wall clock on every tick, on `session_start`
// and on wake is inherently sleep-safe — a reminder whose fire time passed
// during sleep fires on the next tick, marked late rather than silently skipped.

import { clearReminder, fireAt, isActive, isOverdue, isSnoozed } from "./derive.ts";
import { generateId } from "./ids.ts";
import type { MutationOutcome } from "./store.ts";
import type { Recurrence, Reminder, RemindersConfig } from "./types.ts";

export interface TickResult {
  /**
   * Records that this window claimed and must now notify about. Empty in every
   * window that lost the `firedAt` race.
   */
  fired: Reminder[];
}

/**
 * Advance every record against the wall clock.
 *
 * `firedAt` does double duty. It is the fire-once guard — without it the 60s
 * tick would re-notify every minute until acked — and it is the cross-window
 * claim: whichever window lands the CAS write sends the desktop banner, and the
 * others see `firedAt` on their next tick and skip.
 *
 * Because the mutation is re-applied against freshly read data on every CAS
 * retry, the losing window's `fired` list comes back empty rather than stale.
 */
export function applyTick(reminders: Reminder[], now: number, config: RemindersConfig): MutationOutcome<TickResult> {
  const nowIso = new Date(now).toISOString();
  const fired: Reminder[] = [];
  let changed = false;

  const next = reminders.map((reminder) => {
    if (!isActive(reminder)) return reminder;

    // Snooze expiry re-fires: the record went back to pending when it was
    // snoozed, so drop the snooze and re-claim the fire.
    if (reminder.snoozedUntil !== undefined && !isSnoozed(reminder, now)) {
      const { snoozedUntil: _snoozedUntil, ...rest } = reminder;
      const refired: Reminder = { ...rest, firedAt: nowIso };
      fired.push(refired);
      changed = true;
      return refired;
    }

    if (isSnoozed(reminder, now)) return reminder;

    // First fire. `firedAt` is persisted, so this is reached exactly once per
    // occurrence even though the tick runs every 60s.
    if (reminder.firedAt === undefined && now >= fireAt(reminder, config)) {
      const claimed: Reminder = { ...reminder, firedAt: nowIso };
      fired.push(claimed);
      changed = true;
      return claimed;
    }

    return reminder;
  });

  return { reminders: next, result: { fired }, changed };
}

export interface AddInput {
  message: string;
  dueAt: string;
  allDay: boolean;
  recurrence?: Recurrence;
  cwd: string;
}

/** Append a new reminder, giving it an id unique within the current file. */
export function applyAdd(
  reminders: Reminder[],
  input: AddInput,
  now: number,
): MutationOutcome<Reminder> {
  const reminder: Reminder = {
    id: generateId(reminders.map((existing) => existing.id)),
    message: input.message,
    allDay: input.allDay,
    dueAt: input.dueAt,
    createdAt: new Date(now).toISOString(),
    cwd: input.cwd,
  };
  if (input.recurrence !== undefined) reminder.recurrence = input.recurrence;

  return { reminders: [...reminders, reminder], result: reminder, changed: true };
}

export type LookupFailure = "not-found" | "ambiguous";

export interface Resolved {
  reminder: Reminder;
  index: number;
}

/**
 * Find one active record by id, accepting a unique prefix so a 3-char id can be
 * shortened further when the file is small.
 */
export function resolveId(reminders: Reminder[], id: string): Resolved | LookupFailure {
  const needle = id.trim().toLowerCase();
  if (needle === "") return "not-found";

  const exact = reminders.findIndex((r) => r.id === needle && isActive(r));
  if (exact !== -1) return { reminder: reminders[exact] as Reminder, index: exact };

  const matches: number[] = [];
  reminders.forEach((reminder, index) => {
    if (isActive(reminder) && reminder.id.startsWith(needle)) matches.push(index);
  });
  if (matches.length === 0) return "not-found";
  if (matches.length > 1) return "ambiguous";
  const index = matches[0] as number;
  return { reminder: reminders[index] as Reminder, index };
}

type MutationStatus = "ok" | LookupFailure;

export interface IdMutationResult {
  status: MutationStatus;
  reminder?: Reminder;
}

function byId(
  reminders: Reminder[],
  id: string,
  transform: (reminder: Reminder) => Reminder | null,
): MutationOutcome<IdMutationResult> {
  const found = resolveId(reminders, id);
  if (found === "not-found" || found === "ambiguous") {
    return { reminders, result: { status: found }, changed: false };
  }

  const replacement = transform(found.reminder);
  const next = [...reminders];
  if (replacement === null) {
    next.splice(found.index, 1);
  } else {
    next[found.index] = replacement;
  }

  return {
    reminders: next,
    result: { status: "ok", reminder: replacement ?? found.reminder },
    changed: true,
  };
}

/** Ack. Recurring records roll to their next occurrence instead of tombstoning. */
export function applyClear(reminders: Reminder[], id: string, now: number): MutationOutcome<IdMutationResult> {
  return byId(reminders, id, (reminder) => clearReminder(reminder, now));
}

/**
 * Snooze until an absolute instant. Clears `firedAt` so the record fires again
 * when the snooze expires.
 */
export function applySnooze(
  reminders: Reminder[],
  id: string,
  until: number,
): MutationOutcome<IdMutationResult> {
  return byId(reminders, id, (reminder) => {
    const { firedAt: _firedAt, ...rest } = reminder;
    return { ...rest, snoozedUntil: new Date(until).toISOString() };
  });
}

/** Remove entirely. The only operation that drops a record from the file. */
export function applyDelete(reminders: Reminder[], id: string): MutationOutcome<IdMutationResult> {
  return byId(reminders, id, () => null);
}

/**
 * Records to shout about at session start: past due and not snoozed.
 *
 * These re-fire at every session start until snoozed, cleared or deleted. That
 * is the intended nagging behaviour; snooze is the pressure valve that keeps it
 * tolerable rather than something you train yourself to ignore.
 */
export function pastDue(reminders: Reminder[], config: RemindersConfig, now: number): Reminder[] {
  return reminders
    .filter((reminder) => isOverdue(reminder, config, now))
    .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
}
