// Derived times, recurrence maths and bucket disjointness.
//
// These run with a pinned TZ (see the npm test script) so local-time assertions
// are stable, and they deliberately straddle DST boundaries and leap years —
// the two places this logic can silently go wrong.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bucketOf,
  clearReminder,
  computeBuckets,
  effectiveAt,
  fireAt,
  isOverdue,
  isSnoozed,
  nextOccurrence,
  nthOccurrence,
  overdueAt,
} from "./derive.ts";
import { DEFAULT_CONFIG, type Recurrence, type Reminder, type RemindersConfig } from "./types.ts";

const CONFIG: RemindersConfig = { ...DEFAULT_CONFIG };

/** Local-time instant, so tests read the way the user thinks about dates. */
function local(
  year: number,
  month1: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  return new Date(year, month1 - 1, day, hour, minute, second).getTime();
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

/** All-day records are stored anchored at local noon on the due date. */
function allDay(year: number, month1: number, day: number, overrides: Partial<Reminder> = {}): Reminder {
  return reminder({
    allDay: true,
    dueAt: new Date(local(year, month1, day, 12, 0)).toISOString(),
    ...overrides,
  });
}

describe("derived times", () => {
  it("fires a timed reminder at its exact instant", () => {
    const r = reminder({ dueAt: new Date(local(2026, 1, 15, 14, 30)).toISOString() });
    assert.equal(fireAt(r, CONFIG), local(2026, 1, 15, 14, 30));
    assert.equal(overdueAt(r, CONFIG), local(2026, 1, 15, 14, 30));
  });

  it("splits fire and overdue for an all-day reminder", () => {
    const r = allDay(2026, 1, 15);
    // Nags on the morning of the 15th...
    assert.equal(fireAt(r, CONFIG), local(2026, 1, 15, 9, 0));
    // ...but only counts as late at the end of that day.
    assert.equal(overdueAt(r, CONFIG), local(2026, 1, 15, 23, 59));
  });

  it("re-derives the all-day fire hour from config without touching the record", () => {
    const r = allDay(2026, 1, 15);
    const evening: RemindersConfig = { ...CONFIG, allDayFireHour: 18 };
    assert.equal(fireAt(r, evening), local(2026, 1, 15, 18, 0));
    // The record itself is unchanged, so there is nothing to migrate.
    assert.equal(r.dueAt, new Date(local(2026, 1, 15, 12, 0)).toISOString());
  });

  it("does not count an all-day reminder as overdue during its own day", () => {
    const r = allDay(2026, 1, 15);
    // 10:00 on the due date: already nagging, not yet late.
    assert.equal(isOverdue(r, CONFIG, local(2026, 1, 15, 10, 0)), false);
    // Next morning: late.
    assert.equal(isOverdue(r, CONFIG, local(2026, 1, 16, 0, 1)), true);
  });

  it("keeps the all-day calendar date across a DST boundary", () => {
    // London clocks go forward 2026-03-29. A record created before it must
    // still read as March 29 afterwards, which is why storage is anchored at
    // local noon: midnight would slide the date under the offset change.
    const r = allDay(2026, 3, 29);
    assert.equal(new Date(Date.parse(r.dueAt)).getDate(), 29);
    assert.equal(fireAt(r, CONFIG), local(2026, 3, 29, 9, 0));
  });

  it("keeps the all-day calendar date when the clocks go back", () => {
    // The autumn transition, 2026-10-25, shifts the offset the other way.
    const r = allDay(2026, 10, 25);
    assert.equal(new Date(Date.parse(r.dueAt)).getDate(), 25);
    assert.equal(fireAt(r, CONFIG), local(2026, 10, 25, 9, 0));
    assert.equal(overdueAt(r, CONFIG), local(2026, 10, 25, 23, 59));
  });

  it("treats a snoozed reminder as neither overdue nor firing", () => {
    const now = local(2026, 1, 20, 10, 0);
    const r = reminder({
      dueAt: new Date(local(2026, 1, 15, 14, 0)).toISOString(),
      snoozedUntil: new Date(local(2026, 1, 20, 15, 0)).toISOString(),
    });
    assert.equal(isSnoozed(r, now), true);
    assert.equal(isOverdue(r, CONFIG, now), false);
    // Snooze is what it will do next, so that is its effective time.
    assert.equal(effectiveAt(r, CONFIG, now), local(2026, 1, 20, 15, 0));
  });

  it("stops treating a reminder as snoozed once the snooze expires", () => {
    const now = local(2026, 1, 20, 16, 0);
    const r = reminder({
      dueAt: new Date(local(2026, 1, 15, 14, 0)).toISOString(),
      snoozedUntil: new Date(local(2026, 1, 20, 15, 0)).toISOString(),
    });
    assert.equal(isSnoozed(r, now), false);
    assert.equal(isOverdue(r, CONFIG, now), true);
  });

  it("never reports a cleared reminder as overdue", () => {
    const r = reminder({ ackedAt: new Date(local(2026, 1, 16)).toISOString() });
    assert.equal(isOverdue(r, CONFIG, local(2027, 1, 1)), false);
  });
});

describe("recurrence", () => {
  const anchorOf = (r: Reminder): number => Date.parse(r.dueAt);

  it("keeps the weekday and wall-clock time across a DST shift", () => {
    // 2026-03-22 is a Sunday; London clocks go forward on Sunday 2026-03-29,
    // so this step crosses the transition.
    const anchor = local(2026, 3, 22, 9, 0);
    const next = nthOccurrence(anchor, "week", 1);
    const at = new Date(next);
    assert.equal(at.getDay(), new Date(anchor).getDay(), "same weekday");
    assert.equal(at.getHours(), 9, "same wall-clock hour");
    assert.equal(at.getDate(), 29);
  });

  it("clamps Jan 31 monthly to the last day of shorter months", () => {
    const anchor = local(2026, 1, 31, 9, 0);
    const days = [1, 2, 3, 4].map((n) => {
      const at = new Date(nthOccurrence(anchor, "month", n));
      return [at.getMonth() + 1, at.getDate()];
    });
    // Feb 28 (2026 is not a leap year), Mar 31, Apr 30, May 31 — and never a
    // spill into the following month.
    assert.deepEqual(days, [
      [2, 28],
      [3, 31],
      [4, 30],
      [5, 31],
    ]);
  });

  it("clamps Jan 31 monthly into a leap February", () => {
    const anchor = local(2024, 1, 31, 9, 0);
    const at = new Date(nthOccurrence(anchor, "month", 1));
    assert.equal(at.getMonth() + 1, 2);
    assert.equal(at.getDate(), 29);
  });

  it("returns Feb 29 yearly to Feb 29 on the next leap year", () => {
    const anchor = local(2024, 2, 29, 9, 0);
    const years = [1, 2, 3, 4].map((n) => {
      const at = new Date(nthOccurrence(anchor, "year", n));
      return [at.getFullYear(), at.getMonth() + 1, at.getDate()];
    });
    assert.deepEqual(years, [
      [2025, 2, 28],
      [2026, 2, 28],
      [2027, 2, 28],
      [2028, 2, 29],
    ]);
  });

  it("anchors the next occurrence to the original date, not the ack", () => {
    // Birthday on Mar 14, acked three days late. Next is Mar 14, not Mar 17.
    const r = reminder({
      allDay: true,
      dueAt: new Date(local(2026, 3, 14, 12, 0)).toISOString(),
      recurrence: "year",
    });
    const rolled = clearReminder(r, local(2026, 3, 17, 10, 0));
    const at = new Date(Date.parse(rolled.dueAt));
    assert.equal(at.getFullYear(), 2027);
    assert.equal(at.getMonth() + 1, 3);
    assert.equal(at.getDate(), 14);
  });

  it("skips past many missed occurrences without accumulating drift", () => {
    // Never acked for three years, then cleared: lands on the anchor's day.
    const anchor = local(2020, 3, 14, 12, 0);
    const next = nextOccurrence(anchor, "year", local(2026, 6, 1));
    const at = new Date(next);
    assert.equal(at.getFullYear(), 2027);
    assert.equal(at.getMonth() + 1, 3);
    assert.equal(at.getDate(), 14);
  });

  it("returns a recurring reminder to pending on clear", () => {
    const r = reminder({
      recurrence: "week",
      firedAt: new Date(local(2026, 1, 15, 14, 0)).toISOString(),
      snoozedUntil: new Date(local(2026, 1, 15, 15, 0)).toISOString(),
    });
    const rolled = clearReminder(r, local(2026, 1, 15, 16, 0));
    assert.equal(rolled.firedAt, undefined);
    assert.equal(rolled.snoozedUntil, undefined);
    assert.equal(rolled.ackedAt, undefined);
    assert.ok(anchorOf(rolled) > anchorOf(r), "rolled forward");
  });

  it("tombstones a non-recurring reminder on clear", () => {
    const now = local(2026, 1, 16, 9, 0);
    const cleared = clearReminder(reminder(), now);
    assert.equal(cleared.ackedAt, new Date(now).toISOString());
    assert.equal(cleared.dueAt, reminder().dueAt, "due date untouched");
  });

  it("rolls forward strictly into the future", () => {
    const units: Recurrence[] = ["day", "week", "month", "year"];
    const now = local(2026, 6, 15, 12, 0);
    for (const unit of units) {
      const r = reminder({ dueAt: new Date(local(2026, 1, 1, 9, 0)).toISOString(), recurrence: unit });
      const rolled = clearReminder(r, now);
      assert.ok(Date.parse(rolled.dueAt) > now, `${unit} rolled past now`);
    }
  });
});

describe("buckets", () => {
  const now = local(2026, 1, 15, 12, 0);

  it("keeps today and this week disjoint", () => {
    const reminders = [
      reminder({ id: "od1", dueAt: new Date(local(2026, 1, 10, 9, 0)).toISOString() }),
      reminder({ id: "od2", dueAt: new Date(local(2026, 1, 14, 9, 0)).toISOString() }),
      reminder({ id: "tod", dueAt: new Date(local(2026, 1, 15, 18, 0)).toISOString() }),
      reminder({ id: "wk1", dueAt: new Date(local(2026, 1, 16, 9, 0)).toISOString() }),
      reminder({ id: "wk2", dueAt: new Date(local(2026, 1, 21, 9, 0)).toISOString() }),
      reminder({ id: "far", dueAt: new Date(local(2026, 2, 1, 9, 0)).toISOString() }),
    ];

    const buckets = computeBuckets(reminders, CONFIG, now);
    assert.deepEqual(buckets.overdue.map((r) => r.id), ["od1", "od2"]);
    assert.deepEqual(buckets.today.map((r) => r.id), ["tod"]);
    assert.deepEqual(buckets.week.map((r) => r.id), ["wk1", "wk2"]);
    assert.deepEqual(buckets.later.map((r) => r.id), ["far"]);

    // Disjointness: every active record lands in exactly one bucket.
    const total =
      buckets.overdue.length + buckets.today.length + buckets.week.length + buckets.later.length;
    assert.equal(total, reminders.length);
  });

  it("counts day 7 as this week and day 8 as later", () => {
    const day7 = reminder({ dueAt: new Date(local(2026, 1, 21, 9, 0)).toISOString() });
    const day8 = reminder({ dueAt: new Date(local(2026, 1, 22, 9, 0)).toISOString() });
    assert.equal(bucketOf(day7, CONFIG, now), "week");
    assert.equal(bucketOf(day8, CONFIG, now), "later");
  });

  it("buckets an all-day reminder due today as today, not overdue", () => {
    // Fire hour already passed, end of day has not.
    assert.equal(bucketOf(allDay(2026, 1, 15), CONFIG, now), "today");
  });

  it("buckets a snoozed overdue reminder by its snooze target", () => {
    const r = reminder({
      dueAt: new Date(local(2026, 1, 10, 9, 0)).toISOString(),
      snoozedUntil: new Date(local(2026, 1, 17, 9, 0)).toISOString(),
    });
    assert.equal(bucketOf(r, CONFIG, now), "week");
  });

  it("excludes cleared reminders entirely", () => {
    const reminders = [
      reminder({ id: "act", dueAt: new Date(local(2026, 1, 10, 9, 0)).toISOString() }),
      reminder({
        id: "ack",
        dueAt: new Date(local(2026, 1, 10, 9, 0)).toISOString(),
        ackedAt: new Date(local(2026, 1, 11)).toISOString(),
      }),
    ];
    const buckets = computeBuckets(reminders, CONFIG, now);
    assert.deepEqual(buckets.overdue.map((r) => r.id), ["act"]);
  });
});
