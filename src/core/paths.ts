// Global storage layout. Everything lives under
// ~/.pi/agent/state/reminders/ (overridable via PI_REMINDERS_DIR for tests).
//
// Config is a separate file from state so a hand-edited config can never
// corrupt reminder data, and vice versa.

import os from "node:os";
import path from "node:path";

function root(): string {
  return process.env.PI_REMINDERS_DIR ?? path.join(os.homedir(), ".pi", "agent", "state", "reminders");
}

export function stateFile(): string {
  return path.join(root(), "reminders.json");
}

export function configFile(): string {
  return path.join(root(), "config.json");
}

/** Where an unreadable state file is moved aside so it is never silently lost. */
export function corruptBackupFile(stamp: string): string {
  return path.join(root(), `reminders.corrupt-${stamp}.json`);
}
