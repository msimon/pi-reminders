// Table-driven parsing tests, including the rejection cases — rejecting is the
// documented behaviour, not a fallback, so it needs the same coverage.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseDuration, parseRecurrence, parseSnoozeTarget, parseWhen } from "./parse.ts";

const NOW = new Date(2026, 0, 15, 12, 0, 0).getTime();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

describe("parseDuration", () => {
  const accepted: [string, number][] = [
    ["45m", 45 * MINUTE],
    ["3h", 3 * HOUR],
    ["2d", 2 * DAY],
    ["1w", WEEK],
    ["  90m  ", 90 * MINUTE],
    ["3H", 3 * HOUR],
    ["999d", 999 * DAY],
  ];

  for (const [input, expected] of accepted) {
    it(`accepts ${JSON.stringify(input)}`, () => {
      const result = parseDuration(input);
      assert.equal(result.ok, true);
      assert.equal(result.ok && result.value, expected);
    });
  }

  const rejected = [
    "",
    "0m",
    "m",
    "5",
    "5x",
    "-3h",
    "1.5h",
    "2 d",
    "tomorrow",
    "next week",
    "1y",
    "30s",
    "1h30m",
  ];

  for (const input of rejected) {
    it(`rejects ${JSON.stringify(input)}`, () => {
      const result = parseDuration(input);
      assert.equal(result.ok, false);
      assert.ok(!result.ok && result.error.length > 0, "explains itself");
    });
  }
});

describe("parseWhen", () => {
  it("treats a bare date as all-day, anchored at local noon", () => {
    const result = parseWhen("2026-01-20", NOW);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.allDay, true);
    const at = new Date(Date.parse(result.value.dueAt));
    assert.equal(at.getFullYear(), 2026);
    assert.equal(at.getMonth() + 1, 1);
    assert.equal(at.getDate(), 20);
    assert.equal(at.getHours(), 12, "local noon anchor");
  });

  it("treats a date with a time as timed", () => {
    const result = parseWhen("2026-01-20 09:30", NOW);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.allDay, false);
    const at = new Date(Date.parse(result.value.dueAt));
    assert.equal(at.getHours(), 9);
    assert.equal(at.getMinutes(), 30);
  });

  it("accepts the ISO T separator and optional seconds", () => {
    for (const input of ["2026-01-20T09:30", "2026-01-20 09:30:15"]) {
      const result = parseWhen(input, NOW);
      assert.equal(result.ok, true, input);
      assert.equal(result.ok && result.value.allDay, false);
    }
  });

  it("treats a relative offset as timed", () => {
    const result = parseWhen("2h", NOW);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.allDay, false);
    assert.equal(Date.parse(result.value.dueAt), NOW + 2 * HOUR);
  });

  it("rejects impossible calendar dates", () => {
    for (const input of ["2026-02-30", "2026-13-01", "2026-00-10", "2025-02-29"]) {
      const result = parseWhen(input, NOW);
      assert.equal(result.ok, false, input);
    }
  });

  it("accepts Feb 29 in a leap year", () => {
    assert.equal(parseWhen("2028-02-29", NOW).ok, true);
  });

  it("rejects impossible times of day", () => {
    for (const input of ["2026-01-20 24:00", "2026-01-20 12:60"]) {
      assert.equal(parseWhen(input, NOW).ok, false, input);
    }
  });

  it("rejects natural language and lists the accepted formats", () => {
    for (const input of ["next tuesday", "tomorrow at 3", "in two hours", ""]) {
      const result = parseWhen(input, NOW);
      assert.equal(result.ok, false, input);
      if (result.ok) continue;
      assert.match(result.error, /YYYY-MM-DD/, "names the absolute format");
      assert.match(result.error, /m\|h\|d\|w/, "names the offset format");
    }
  });

  it("accepts a Z-suffixed instant as the exact instant", () => {
    // A zoned timestamp is unambiguous, so it is honoured rather than rejected.
    // Accepting it removes the need for the caller to do timezone arithmetic,
    // which is where an off-by-an-hour error would otherwise creep in silently.
    const result = parseWhen("2026-01-20T09:30:00Z", NOW);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.allDay, false);
    assert.equal(result.value.dueAt, "2026-01-20T09:30:00.000Z");
  });

  it("honours an explicit UTC offset", () => {
    // 09:30+01:00 is 08:30Z, regardless of the machine's own zone.
    const result = parseWhen("2026-01-20T09:30:00+01:00", NOW);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value.dueAt, "2026-01-20T08:30:00.000Z");
  });

  it("accepts an offset without a colon and a negative offset", () => {
    // `+0100` is valid ISO 8601 but not guaranteed by Date.parse, so it is
    // normalized before parsing.
    const cases: [string, string][] = [
      ["2026-01-20T09:30:00+0100", "2026-01-20T08:30:00.000Z"],
      ["2026-01-20T09:30:00-05:00", "2026-01-20T14:30:00.000Z"],
    ];
    for (const [input, expected] of cases) {
      const result = parseWhen(input, NOW);
      assert.equal(result.ok, true, input);
      if (!result.ok) continue;
      assert.equal(result.value.dueAt, expected, input);
    }
  });

  it("accepts a zoned instant with fractional seconds and no seconds", () => {
    assert.equal(parseWhen("2026-01-20T09:30:00.123Z", NOW).ok, true);
    assert.equal(parseWhen("2026-01-20T09:30Z", NOW).ok, true);
  });

  it("keeps a zoned instant distinct from the same wall-clock local time", () => {
    // In July, Europe/London is BST (+01:00), so 09:30Z is 10:30 local. The two
    // forms must not collapse onto the same instant.
    const zonedResult = parseWhen("2026-07-20T09:30:00Z", NOW);
    const localResult = parseWhen("2026-07-20 09:30", NOW);
    assert.equal(zonedResult.ok && localResult.ok, true);
    if (!zonedResult.ok || !localResult.ok) return;
    assert.notEqual(zonedResult.value.dueAt, localResult.value.dueAt);
    assert.equal(zonedResult.value.dueAt, "2026-07-20T09:30:00.000Z");
    assert.equal(localResult.value.dueAt, "2026-07-20T08:30:00.000Z");
  });

  it("still rejects a malformed zone", () => {
    for (const input of ["2026-01-20T09:30:00+25:00", "2026-01-20T09:30:00QQ"]) {
      assert.equal(parseWhen(input, NOW).ok, false, input);
    }
  });

  it("never treats a zoned instant as all-day", () => {
    const result = parseWhen("2026-01-20T00:00:00Z", NOW);
    assert.equal(result.ok && result.value.allDay, false);
  });
});

describe("parseRecurrence", () => {
  it("accepts the four units, case-insensitively", () => {
    for (const input of ["day", "week", "MONTH", " year "]) {
      assert.equal(parseRecurrence(input).ok, true, input);
    }
  });

  it("rejects anything else and lists the units", () => {
    const result = parseRecurrence("fortnight");
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.error.includes("day, week, month, year"));
  });
});

describe("parseSnoozeTarget", () => {
  it("resolves a relative duration from now", () => {
    const result = parseSnoozeTarget("45m", NOW, 9);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value, NOW + 45 * MINUTE);
  });

  it("resolves an absolute date to that day's fire hour", () => {
    const result = parseSnoozeTarget("2026-01-20", NOW, 9);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const at = new Date(result.value);
    assert.equal(at.getDate(), 20);
    assert.equal(at.getHours(), 9, "morning of the 20th, not noon");
  });

  it("resolves an absolute timestamp exactly", () => {
    const result = parseSnoozeTarget("2026-01-20 16:45", NOW, 9);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const at = new Date(result.value);
    assert.equal(at.getHours(), 16);
    assert.equal(at.getMinutes(), 45);
  });

  it("rejects junk", () => {
    assert.equal(parseSnoozeTarget("a while", NOW, 9).ok, false);
  });
});
