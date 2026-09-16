// The state file is the only source of truth. Statusline, widget, toast,
// desktop banner and transcript line are all projections of it, and every
// mutation acts on the record rather than on a UI surface.
//
// Multiple pi windows read and write this file concurrently. Two mechanisms, no
// lockfile:
//
//   Atomic write      — see fs-write.ts. A reader never sees a partial file.
//   Compare-and-swap  — the dangerous window is not the write, it is the seconds
//                       between read and write while the user is typing. CAS
//                       collapses it to microseconds.
//
// A theoretical race remains between the verify and the rename. For a personal
// file written by a handful of windows that window is microseconds, and not
// worth a lockfile plus stale-lock recovery on SIGKILL.

import { createHash } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { writeFileAtomically } from "./fs-write.ts";
import { corruptBackupFile, stateFile } from "./paths.ts";
import {
  RECURRENCE_UNITS,
  STATE_VERSION,
  type Recurrence,
  type Reminder,
  type ReminderState,
} from "./types.ts";

const MAX_CAS_ATTEMPTS = 5;

/** Hash of the exact bytes on disk. Empty string means "file absent". */
function hashOf(raw: string | null): string {
  if (raw === null) return "";
  return createHash("sha256").update(raw).digest("hex");
}

export interface LoadedState {
  reminders: Reminder[];
  /** Raw bytes as read, for the CAS comparison. */
  raw: string | null;
  hash: string;
  /** True when the file existed but could not be parsed. */
  recovered: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalIsoString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (Number.isNaN(Date.parse(value))) return undefined;
  return value;
}

function optionalRecurrence(value: unknown): Recurrence | undefined {
  return RECURRENCE_UNITS.find((unit) => unit === value);
}

/**
 * Keep only records that have the fields every projection depends on, and
 * rebuild each one field by field.
 *
 * The file is hand-editable, so a record is reconstructed rather than cast:
 * garbage in an optional field would otherwise reach the derivations as a NaN
 * timestamp and quietly mis-bucket or mis-fire the reminder.
 */
function sanitize(input: unknown): Reminder[] {
  if (!Array.isArray(input)) return [];
  const out: Reminder[] = [];
  for (const candidate of input) {
    if (!isRecord(candidate)) continue;
    const { id, message, dueAt, allDay, createdAt, cwd } = candidate;
    if (typeof id !== "string" || id === "") continue;
    if (typeof message !== "string") continue;
    if (typeof dueAt !== "string" || Number.isNaN(Date.parse(dueAt))) continue;

    const reminder: Reminder = {
      id,
      message,
      dueAt,
      allDay: allDay === true,
      createdAt: optionalIsoString(createdAt) ?? dueAt,
      cwd: typeof cwd === "string" ? cwd : "",
    };

    const recurrence = optionalRecurrence(candidate.recurrence);
    if (recurrence !== undefined) reminder.recurrence = recurrence;
    const firedAt = optionalIsoString(candidate.firedAt);
    if (firedAt !== undefined) reminder.firedAt = firedAt;
    const snoozedUntil = optionalIsoString(candidate.snoozedUntil);
    if (snoozedUntil !== undefined) reminder.snoozedUntil = snoozedUntil;
    const ackedAt = optionalIsoString(candidate.ackedAt);
    if (ackedAt !== undefined) reminder.ackedAt = ackedAt;

    out.push(reminder);
  }
  return out;
}

function parseState(raw: string): Reminder[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  // Tolerate a bare array in case the envelope is ever hand-edited away.
  if (Array.isArray(parsed)) return sanitize(parsed);
  if (isRecord(parsed)) return sanitize(parsed.reminders);
  return null;
}

function serialize(reminders: Reminder[]): string {
  const state: ReminderState = { version: STATE_VERSION, reminders };
  return `${JSON.stringify(state, null, 2)}\n`;
}

/**
 * Read the state file.
 *
 * A missing file is an empty list. A corrupt file is moved aside and also
 * treated as empty — never crash the session, and never silently discard data
 * the user might want back.
 */
export async function readState(): Promise<LoadedState> {
  const path = stateFile();
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { reminders: [], raw: null, hash: "", recovered: false };
    }
    throw error;
  }

  const reminders = parseState(raw);
  if (reminders === null) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await rename(path, corruptBackupFile(stamp)).catch(() => {});
    return { reminders: [], raw: null, hash: "", recovered: true };
  }

  return { reminders, raw, hash: hashOf(raw), recovered: false };
}

export class CasError extends Error {
  constructor(attempts: number) {
    super(
      `reminders.json changed under us ${attempts} times in a row; giving up rather than dropping the change silently.`,
    );
    this.name = "CasError";
  }
}

export interface MutationOutcome<T> {
  reminders: Reminder[];
  result: T;
  /** False skips the write entirely, so an idle tick does not churn the file. */
  changed: boolean;
}

export type Mutation<T> = (reminders: Reminder[]) => MutationOutcome<T>;

/**
 * Apply a mutation under compare-and-swap.
 *
 *   read file -> content, hash
 *   mutate in memory
 *   re-read file, re-hash
 *     unchanged -> atomic write
 *     changed   -> re-read, re-apply the mutation, retry
 *
 * The mutation is re-applied against fresh data on every retry, which is what
 * makes the `firedAt` claim work across windows: the window that loses the race
 * re-runs against a file that already has `firedAt` set and drops that record
 * from its own fire list.
 *
 * Exhausting the retries surfaces an explicit error. A silently dropped add is
 * the one failure mode that destroys trust in the whole thing.
 */
async function mutateOnce<T>(mutation: Mutation<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_CAS_ATTEMPTS; attempt++) {
    const loaded = await readState();
    const outcome = mutation(loaded.reminders);
    if (!outcome.changed) return outcome.result;

    // Re-read and re-hash immediately before writing to collapse the
    // read-modify-write window to microseconds.
    let current: LoadedState;
    try {
      current = await readState();
    } catch (error: unknown) {
      lastError = error;
      continue;
    }

    if (current.hash !== loaded.hash) continue;

    try {
      await writeFileAtomically(stateFile(), serialize(outcome.reminders));
      return outcome.result;
    } catch (error: unknown) {
      lastError = error;
    }
  }

  if (lastError !== undefined) throw lastError;
  throw new CasError(MAX_CAS_ATTEMPTS);
}

/**
 * Serializes every mutation in THIS process onto one chain.
 *
 * CAS alone is not enough here. `mutateOnce` awaits between its verify and its
 * write, and an await boundary lets another task in the same process run in
 * that gap: two concurrent callers both verify against the same hash, then both
 * write, and the second silently clobbers the first. That is not the
 * cross-process race the design accepts as a microsecond window — the event
 * loop makes it likely rather than theoretical, and it reproduces immediately
 * with parallel `reminder` tool calls, which Pi runs concurrently by default.
 *
 * Chaining costs nothing (mutations are sub-millisecond file writes) and leaves
 * CAS responsible for exactly what it is good at: the genuinely cross-process
 * case of another pi window writing between our read and our write.
 */
let mutationQueue: Promise<unknown> = Promise.resolve();

export async function mutate<T>(mutation: Mutation<T>): Promise<T> {
  // settle() rather than .then() so one caller's rejection cannot cancel the
  // mutations queued behind it.
  const settle = (): Promise<T> => mutateOnce(mutation);
  const run = mutationQueue.then(settle, settle);
  mutationQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Overwrite the whole list. Used by tests and by an explicit repair path. */
export async function writeAll(reminders: Reminder[]): Promise<void> {
  await writeFileAtomically(stateFile(), serialize(reminders));
}
