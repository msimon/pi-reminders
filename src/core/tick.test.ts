// The tick state machine: fire-once, the cross-window claim, snooze expiry,
// and the id-based mutations.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyAdd,
  applyClear,
  applyDelete,
  applySnooze,
  applyTick,
  pastDue,
  resolveId,
} from "./tick.ts";
import { DEFAULT_CONFIG, type Reminder, type RemindersConfig } from "./types.ts";

const CONFIG: RemindersConfig = { ...DEFAULT_CONFIG };

function local(year: number, month1: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month1 - 1, day, hour, minute).getTime();
}

function reminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: "aaa",
    message: "test",
    allDay: false,
    dueAt: new Date(local(2026, 1, 15, 14, 0)).toISOString(),
    createdAt: new Date(local(2026, 1, 1)).toISOString(),
    cwd: "/tmp",
    ...overrides,
  };
}

describe("applyTick", () => {
  it("does nothing before the fire time", () => {
    const outcome = applyTick([reminder()], local(2026, 1, 15, 13, 0), CONFIG);
    assert.equal(outcome.changed, false, "no write, so no file churn");
    assert.deepEqual(outcome.result.fired, []);
  });

  it("fires once and claims the record", () => {
    const now = local(2026, 1, 15, 14, 0);
    const outcome = applyTick([reminder()], now, CONFIG);
    assert.equal(outcome.changed, true);
    assert.deepEqual(outcome.result.fired.map((r) => r.id), ["aaa"]);
    assert.equal(outcome.reminders[0]?.firedAt, new Date(now).toISOString());
  });

  it("does not re-fire on subsequent ticks", () => {
    const first = applyTick([reminder()], local(2026, 1, 15, 14, 0), CONFIG);
    // Without firedAt, the 60s tick would re-notify every minute until acked.
    for (const minutes of [1, 2, 60, 6000]) {
      const later = applyTick(first.reminders, local(2026, 1, 15, 14, 0) + minutes * 60_000, CONFIG);
      assert.equal(later.changed, false, `+${minutes}m`);
      assert.deepEqual(later.result.fired, []);
    }
  });

  it("fires a reminder whose time passed while the machine was asleep", () => {
    // Wall-clock recomputation: the tick that runs on wake still fires it,
    // marked late rather than silently skipped.
    const outcome = applyTick([reminder()], local(2026, 1, 18, 9, 0), CONFIG);
    assert.deepEqual(outcome.result.fired.map((r) => r.id), ["aaa"]);
  });

  it("gives the losing window an empty fire list", () => {
    // A window that re-runs against a file where firedAt is already set — which
    // is exactly what a CAS retry does — must not send a second banner.
    const claimed = reminder({ firedAt: new Date(local(2026, 1, 15, 14, 0)).toISOString() });
    const outcome = applyTick([claimed], local(2026, 1, 15, 14, 1), CONFIG);
    assert.equal(outcome.changed, false);
    assert.deepEqual(outcome.result.fired, []);
  });

  it("does not fire while snoozed", () => {
    const r = reminder({
      firedAt: new Date(local(2026, 1, 15, 14, 0)).toISOString(),
      snoozedUntil: new Date(local(2026, 1, 15, 16, 0)).toISOString(),
    });
    const outcome = applyTick([r], local(2026, 1, 15, 15, 0), CONFIG);
    assert.equal(outcome.changed, false);
    assert.deepEqual(outcome.result.fired, []);
  });

  it("re-fires on snooze expiry and drops the snooze", () => {
    const r = reminder({
      firedAt: new Date(local(2026, 1, 15, 14, 0)).toISOString(),
      snoozedUntil: new Date(local(2026, 1, 15, 16, 0)).toISOString(),
    });
    const now = local(2026, 1, 15, 16, 1);
    const outcome = applyTick([r], now, CONFIG);
    assert.equal(outcome.changed, true);
    assert.deepEqual(outcome.result.fired.map((r2) => r2.id), ["aaa"]);
    assert.equal(outcome.reminders[0]?.snoozedUntil, undefined);
    assert.equal(outcome.reminders[0]?.firedAt, new Date(now).toISOString());
  });

  it("ignores cleared records", () => {
    const r = reminder({ ackedAt: new Date(local(2026, 1, 15, 15, 0)).toISOString() });
    const outcome = applyTick([r], local(2027, 1, 1), CONFIG);
    assert.equal(outcome.changed, false);
  });

  it("fires an all-day reminder at the configured hour, not at midnight", () => {
    const r = reminder({ allDay: true, dueAt: new Date(local(2026, 1, 15, 12, 0)).toISOString() });
    assert.deepEqual(applyTick([r], local(2026, 1, 15, 8, 59), CONFIG).result.fired, []);
    assert.equal(applyTick([r], local(2026, 1, 15, 9, 0), CONFIG).result.fired.length, 1);
  });
});

describe("applyAdd", () => {
  it("assigns an id unique within the file", () => {
    const existing = [reminder({ id: "aaa" }), reminder({ id: "bbb" })];
    const outcome = applyAdd(
      existing,
      { message: "new", dueAt: new Date(local(2026, 2, 1)).toISOString(), allDay: true, cwd: "/x" },
      local(2026, 1, 15),
    );
    assert.equal(outcome.reminders.length, 3);
    const added = outcome.result;
    assert.ok(!["aaa", "bbb"].includes(added.id));
    assert.equal(added.allDay, true);
    assert.equal(added.recurrence, undefined);
  });

  it("stores the recurrence when given", () => {
    const outcome = applyAdd(
      [],
      {
        message: "birthday",
        dueAt: new Date(local(2026, 3, 14, 12, 0)).toISOString(),
        allDay: true,
        recurrence: "year",
        cwd: "/x",
      },
      local(2026, 1, 15),
    );
    assert.equal(outcome.result.recurrence, "year");
  });
});

describe("resolveId", () => {
  const reminders = [reminder({ id: "a3f" }), reminder({ id: "b7c" }), reminder({ id: "b90" })];

  it("finds an exact match", () => {
    const found = resolveId(reminders, "a3f");
    assert.notEqual(found, "not-found");
    assert.equal(typeof found === "object" && found.reminder.id, "a3f");
  });

  it("accepts a unique prefix", () => {
    const found = resolveId(reminders, "a");
    assert.equal(typeof found === "object" && found.reminder.id, "a3f");
  });

  it("reports an ambiguous prefix rather than guessing", () => {
    assert.equal(resolveId(reminders, "b"), "ambiguous");
  });

  it("reports a miss", () => {
    assert.equal(resolveId(reminders, "zzz"), "not-found");
    assert.equal(resolveId(reminders, ""), "not-found");
  });

  it("ignores cleared records", () => {
    const acked = [reminder({ id: "a3f", ackedAt: new Date(local(2026, 1, 16)).toISOString() })];
    assert.equal(resolveId(acked, "a3f"), "not-found");
  });
});

describe("id mutations", () => {
  it("clears a one-off record in place", () => {
    const outcome = applyClear([reminder({ id: "a3f" })], "a3f", local(2026, 1, 16, 9, 0));
    assert.equal(outcome.result.status, "ok");
    assert.equal(outcome.reminders.length, 1, "kept as history, not removed");
    assert.ok(outcome.reminders[0]?.ackedAt !== undefined);
  });

  it("rolls a recurring record forward on clear", () => {
    const r = reminder({
      id: "a3f",
      allDay: true,
      dueAt: new Date(local(2026, 3, 14, 12, 0)).toISOString(),
      recurrence: "year",
    });
    const outcome = applyClear([r], "a3f", local(2026, 3, 17, 9, 0));
    const rolled = outcome.reminders[0];
    assert.equal(rolled?.ackedAt, undefined, "back to pending");
    assert.equal(new Date(Date.parse(rolled?.dueAt as string)).getFullYear(), 2027);
  });

  it("snoozes and clears the fire claim so it fires again later", () => {
    const r = reminder({ id: "a3f", firedAt: new Date(local(2026, 1, 15, 14, 0)).toISOString() });
    const until = local(2026, 1, 15, 16, 0);
    const outcome = applySnooze([r], "a3f", until);
    assert.equal(outcome.result.status, "ok");
    assert.equal(outcome.reminders[0]?.firedAt, undefined);
    assert.equal(outcome.reminders[0]?.snoozedUntil, new Date(until).toISOString());
  });

  it("deletes a record entirely", () => {
    const outcome = applyDelete([reminder({ id: "a3f" }), reminder({ id: "b7c" })], "a3f");
    assert.equal(outcome.result.status, "ok");
    assert.deepEqual(outcome.reminders.map((r) => r.id), ["b7c"]);
  });

  it("reports a miss without changing anything", () => {
    for (const apply of [
      () => applyClear([reminder({ id: "a3f" })], "zzz", 0),
      () => applySnooze([reminder({ id: "a3f" })], "zzz", 0),
      () => applyDelete([reminder({ id: "a3f" })], "zzz"),
    ]) {
      const outcome = apply();
      assert.equal(outcome.result.status, "not-found");
      assert.equal(outcome.changed, false);
    }
  });
});

describe("pastDue", () => {
  const now = local(2026, 1, 20, 10, 0);

  it("reports overdue records oldest first", () => {
    const reminders = [
      reminder({ id: "new", dueAt: new Date(local(2026, 1, 19, 9, 0)).toISOString() }),
      reminder({ id: "old", dueAt: new Date(local(2026, 1, 10, 9, 0)).toISOString() }),
    ];
    assert.deepEqual(pastDue(reminders, CONFIG, now).map((r) => r.id), ["old", "new"]);
  });

  it("excludes snoozed and cleared records", () => {
    const reminders = [
      reminder({
        id: "snz",
        dueAt: new Date(local(2026, 1, 10, 9, 0)).toISOString(),
        snoozedUntil: new Date(local(2026, 1, 21, 9, 0)).toISOString(),
      }),
      reminder({
        id: "ack",
        dueAt: new Date(local(2026, 1, 10, 9, 0)).toISOString(),
        ackedAt: new Date(local(2026, 1, 11)).toISOString(),
      }),
    ];
    assert.deepEqual(pastDue(reminders, CONFIG, now), []);
  });

  it("excludes an all-day reminder due today", () => {
    const today = reminder({ allDay: true, dueAt: new Date(local(2026, 1, 20, 12, 0)).toISOString() });
    assert.deepEqual(pastDue([today], CONFIG, now), []);
  });
});
