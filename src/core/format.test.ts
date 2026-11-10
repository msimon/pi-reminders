// Picker rows: time first, then id, then the message, on one line.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatPickerLine } from "./format.ts";
import { DEFAULT_CONFIG, type Reminder } from "./types.ts";

const local = (y: number, m: number, d: number, h = 0, min = 0): number =>
  new Date(y, m - 1, d, h, min).getTime();

function reminder(
  message: string,
  dueAt: number,
  extra: Partial<Reminder> = {},
): Reminder {
  return {
    id: "cfa",
    message,
    allDay: false,
    dueAt: new Date(dueAt).toISOString(),
    createdAt: new Date(local(2026, 1, 1)).toISOString(),
    cwd: "/tmp",
    ...extra,
  };
}

describe("formatPickerLine", () => {
  const now = local(2026, 11, 10, 12, 0);

  it("puts the time first, then the id, then the message", () => {
    const line = formatPickerLine(
      reminder("call the accountant", local(2026, 11, 11, 11, 0)),
      DEFAULT_CONFIG,
      now,
      200,
    );
    assert.equal(line, "Nov 11 11:00 (in 23h)  cfa  call the accountant");
  });

  it("collapses a multi-line message and cuts the row to the width", () => {
    const long = "line one\nline two " + "x".repeat(200);
    const line = formatPickerLine(
      reminder(long, local(2026, 11, 11, 11, 0)),
      DEFAULT_CONFIG,
      now,
      60,
    );
    assert.equal([...line].length, 60);
    assert.ok(!line.includes("\n"));
    assert.ok(line.startsWith("Nov 11 11:00 (in 23h)  cfa  line one line two"));
    assert.ok(line.endsWith("…"));
  });

  it("pads the time so ids line up, and marks recurring reminders", () => {
    const line = formatPickerLine(
      reminder("standup", local(2026, 11, 11, 11, 0), { recurrence: "week" }),
      DEFAULT_CONFIG,
      now,
      200,
      30,
    );
    assert.equal(line, `${"Nov 11 11:00 (in 23h)".padEnd(30)}  cfa  ↻ standup`);
  });
});
