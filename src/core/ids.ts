// Short, readable, stable record ids.
//
// Random rather than content-derived: hashing the message would collide on two
// reminders that say the same thing, and the id has to survive a message edit.
// 3 hex chars (4096 values) is plenty for a personal file and stays easy to
// type; the width grows only if that space is genuinely exhausted.

import { randomBytes } from "node:crypto";

const BASE_LENGTH = 3;
const MAX_LENGTH = 8;
const ATTEMPTS_PER_LENGTH = 32;

function randomId(length: number): string {
  return randomBytes(Math.ceil(length / 2))
    .toString("hex")
    .slice(0, length);
}

/**
 * A short hex id not present in `taken`.
 *
 * Widens by a character whenever a length is saturated, so this terminates even
 * if someone accumulates thousands of reminders.
 */
export function generateId(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let length = BASE_LENGTH; length <= MAX_LENGTH; length++) {
    for (let attempt = 0; attempt < ATTEMPTS_PER_LENGTH; attempt++) {
      const candidate = randomId(length);
      if (!used.has(candidate)) return candidate;
    }
  }
  // Pathological: fall back to a value that cannot collide with a short id.
  return randomId(MAX_LENGTH + 4);
}
