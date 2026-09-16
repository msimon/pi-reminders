// Storage: atomicity, compare-and-swap under a simulated concurrent write, and
// corrupt-file recovery.
//
// Each test gets its own PI_REMINDERS_DIR, which is why paths.ts exposes
// functions rather than module-level constants.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { writeFileAtomically } from "./fs-write.ts";
import { stateFile } from "./paths.ts";
import { CasError, mutate, readState, writeAll } from "./store.ts";
import type { Reminder } from "./types.ts";

let dir: string;
let previousDir: string | undefined;

beforeEach(async () => {
  previousDir = process.env.PI_REMINDERS_DIR;
  dir = await mkdtemp(join(tmpdir(), "pi-reminders-test-"));
  process.env.PI_REMINDERS_DIR = dir;
});

afterEach(() => {
  if (previousDir === undefined) {
    delete process.env.PI_REMINDERS_DIR;
  } else {
    process.env.PI_REMINDERS_DIR = previousDir;
  }
});

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: "aaa",
    message: "test",
    allDay: false,
    dueAt: "2026-01-15T14:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp",
    ...overrides,
  };
}

async function tempFiles(): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((name) => name.startsWith(".tmp-"));
}

/**
 * Stand in for another pi window landing a write inside our read-modify window.
 * Synchronous on purpose: an un-awaited async write would not be guaranteed to
 * have hit the disk before the CAS verify re-reads, making the test racy.
 */
function concurrentWrite(reminders: Reminder[]): void {
  writeFileSync(stateFile(), `${JSON.stringify({ version: 1, reminders }, null, 2)}\n`, "utf-8");
}

describe("readState", () => {
  it("treats a missing file as empty without creating it", async () => {
    const loaded = await readState();
    assert.deepEqual(loaded.reminders, []);
    assert.equal(loaded.raw, null);
    assert.equal(loaded.recovered, false);
    assert.deepEqual(await readdir(dir), [], "nothing written just by reading");
  });

  it("round-trips written records", async () => {
    await writeAll([reminder({ id: "a3f", message: "call the accountant" })]);
    const loaded = await readState();
    assert.equal(loaded.reminders.length, 1);
    assert.equal(loaded.reminders[0]?.message, "call the accountant");
  });

  it("recovers from a corrupt file by moving it aside", async () => {
    await writeFile(stateFile(), "{ this is not json", "utf-8");
    const loaded = await readState();
    assert.deepEqual(loaded.reminders, []);
    assert.equal(loaded.recovered, true, "signals the one-time warning");

    const entries = await readdir(dir);
    assert.ok(
      entries.some((name) => name.startsWith("reminders.corrupt-")),
      "unreadable data is preserved, not discarded",
    );
    assert.ok(!entries.includes("reminders.json"), "bad file no longer in the way");
  });

  it("drops records missing the fields every projection needs", async () => {
    await writeFile(
      stateFile(),
      JSON.stringify({
        version: 1,
        reminders: [
          reminder({ id: "ok1" }),
          { id: "no-due", message: "x" },
          { id: "bad-due", message: "x", dueAt: "not a date" },
          { message: "no id", dueAt: "2026-01-15T14:00:00.000Z" },
          "nonsense",
        ],
      }),
      "utf-8",
    );
    const loaded = await readState();
    assert.deepEqual(loaded.reminders.map((r) => r.id), ["ok1"]);
  });

  it("ignores garbage in optional fields rather than deriving from NaN", async () => {
    await writeFile(
      stateFile(),
      JSON.stringify({
        version: 1,
        reminders: [
          { ...reminder({ id: "bad" }), firedAt: "whenever", snoozedUntil: 42, recurrence: "fortnight" },
        ],
      }),
      "utf-8",
    );
    const loaded = await readState();
    const r = loaded.reminders[0];
    assert.equal(r?.firedAt, undefined);
    assert.equal(r?.snoozedUntil, undefined);
    assert.equal(r?.recurrence, undefined);
  });

  it("tolerates a bare array if the envelope is hand-edited away", async () => {
    await writeFile(stateFile(), JSON.stringify([reminder({ id: "b2c" })]), "utf-8");
    const loaded = await readState();
    assert.deepEqual(loaded.reminders.map((r) => r.id), ["b2c"]);
  });
});

describe("atomic write", () => {
  it("leaves no orphan temp file on success", async () => {
    await writeFileAtomically(stateFile(), "{}\n");
    assert.deepEqual(await tempFiles(), []);
  });

  it("leaves no orphan temp file when the rename target is unusable", async () => {
    // A directory cannot be replaced by a rename of a file, so this fails at
    // the last step — after the temp has been written.
    const target = join(dir, "occupied");
    await writeFileAtomically(join(target, "inner"), "x");
    await assert.rejects(writeFileAtomically(target, "boom"));
    assert.deepEqual(await tempFiles(), [], "cleanup ran");
  });

  it("preserves the target's permission bits across an overwrite", async () => {
    const { chmod, stat } = await import("node:fs/promises");
    await writeFileAtomically(stateFile(), "first");
    await chmod(stateFile(), 0o640);
    await writeFileAtomically(stateFile(), "second");
    const stats = await stat(stateFile());
    assert.equal(stats.mode & 0o777, 0o640);
    assert.equal(await readFile(stateFile(), "utf-8"), "second");
  });
});

describe("compare-and-swap", () => {
  it("applies a mutation and persists it", async () => {
    await writeAll([reminder({ id: "aaa" })]);
    const added = await mutate((reminders) => ({
      reminders: [...reminders, reminder({ id: "bbb" })],
      result: "done",
      changed: true,
    }));
    assert.equal(added, "done");
    const loaded = await readState();
    assert.deepEqual(loaded.reminders.map((r) => r.id), ["aaa", "bbb"]);
  });

  it("skips the write entirely when nothing changed", async () => {
    await writeAll([reminder()]);
    const before = await readFile(stateFile(), "utf-8");
    await mutate((reminders) => ({ reminders, result: null, changed: false }));
    // Byte-identical: an idle tick must not churn the file every 60s.
    assert.equal(await readFile(stateFile(), "utf-8"), before);
  });

  it("re-applies the mutation against fresh data after a concurrent write", async () => {
    await writeAll([reminder({ id: "aaa" })]);

    let attempts = 0;
    const result = await mutate((reminders) => {
      attempts += 1;
      if (attempts === 1) {
        // The next CAS check sees a different hash and retries.
        concurrentWrite([reminder({ id: "aaa" }), reminder({ id: "other" })]);
      }
      return {
        reminders: [...reminders, reminder({ id: "mine" })],
        result: reminders.length,
        changed: true,
      };
    });

    assert.ok(attempts >= 2, `retried (attempts=${attempts})`);
    const loaded = await readState();
    const ids = loaded.reminders.map((r) => r.id);
    assert.ok(ids.includes("other"), "concurrent write survived");
    assert.ok(ids.includes("mine"), "our write survived");
    assert.equal(result, 2, "mutation saw the fresh list, not the stale one");
  });

  it("surfaces an explicit error rather than dropping a change silently", async () => {
    await writeAll([reminder({ id: "aaa" })]);

    // A writer that always wins: every CAS verify finds a different hash.
    let counter = 0;
    await assert.rejects(
      mutate((reminders) => {
        counter += 1;
        concurrentWrite([reminder({ id: `churn-${counter}` })]);
        return { reminders: [...reminders, reminder({ id: "mine" })], result: null, changed: true };
      }),
      (error: unknown) => {
        assert.ok(error instanceof CasError, `expected CasError, got ${String(error)}`);
        assert.match((error as CasError).message, /giving up rather than dropping/);
        return true;
      },
    );
  });

  it("does not clobber a concurrent write when it wins the race", async () => {
    await writeAll([reminder({ id: "aaa" })]);
    // Two sequential mutations must both be present afterwards.
    await mutate((reminders) => ({
      reminders: [...reminders, reminder({ id: "one" })],
      result: null,
      changed: true,
    }));
    await mutate((reminders) => ({
      reminders: [...reminders, reminder({ id: "two" })],
      result: null,
      changed: true,
    }));
    const loaded = await readState();
    assert.deepEqual(loaded.reminders.map((r) => r.id), ["aaa", "one", "two"]);
  });

  it("lands every mutation when they are issued concurrently in-process", async () => {
    // Regression: Pi runs tool calls in parallel by default, so two `reminder`
    // add calls hit mutate() concurrently. CAS alone did not cover this --
    // mutateOnce awaits between its verify and its write, and both callers
    // verified the same hash then both wrote, so the second silently clobbered
    // the first. Observed live as an add that reported success and vanished.
    const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
    await Promise.all(
      names.map((name) =>
        mutate((reminders) => ({
          reminders: [...reminders, reminder({ id: name })],
          result: null,
          changed: true,
        })),
      ),
    );

    const loaded = await readState();
    assert.deepEqual(
      loaded.reminders.map((r) => r.id).sort(),
      [...names].sort(),
      "no mutation was lost",
    );
  });

  it("keeps serving queued mutations after one of them throws", async () => {
    // The queue must not be poisoned by a failure, or one bad mutation would
    // silently stall every reminder written afterwards.
    const boom = mutate(() => {
      throw new Error("boom");
    });
    await assert.rejects(boom, /boom/);

    await mutate((reminders) => ({
      reminders: [...reminders, reminder({ id: "after" })],
      result: null,
      changed: true,
    }));

    const loaded = await readState();
    assert.deepEqual(loaded.reminders.map((r) => r.id), ["after"]);
  });
});
