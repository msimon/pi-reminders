// Statusline / widget / report rendering, including the zero-handling
// difference between the two statusline styles.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WARNING_GLYPH,
  renderStartupReport,
  renderStatusline,
  renderWidget,
} from "./render.ts";
import { DEFAULT_CONFIG, type Buckets, type Reminder, type RemindersConfig } from "./types.ts";

function local(year: number, month1: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month1 - 1, day, hour, minute).getTime();
}

function reminder(id: string, message: string, dueAt: number): Reminder {
  return {
    id,
    message,
    allDay: false,
    dueAt: new Date(dueAt).toISOString(),
    createdAt: new Date(local(2026, 1, 1)).toISOString(),
    cwd: "/tmp",
  };
}

/** Buckets holding the requested counts; contents only matter where asserted. */
function buckets(overdue: number, today: number, week: number, later = 0): Buckets {
  const fill = (count: number, prefix: string): Reminder[] =>
    Array.from({ length: count }, (_unused, index) =>
      reminder(`${prefix}${index}`, `${prefix} item ${index}`, local(2026, 1, 15, 9, 0)),
    );
  return {
    overdue: fill(overdue, "o"),
    today: fill(today, "t"),
    week: fill(week, "w"),
    later: fill(later, "l"),
  };
}

const WORDS: RemindersConfig = { ...DEFAULT_CONFIG, statuslineStyle: "words" };
const COMPACT: RemindersConfig = { ...DEFAULT_CONFIG, statuslineStyle: "compact" };

describe("renderStatusline — words", () => {
  it("hides the segment entirely when there is nothing at all", () => {
    assert.equal(renderStatusline(buckets(0, 0, 0), WORDS), undefined);
  });

  it("still hides it when only far-future reminders exist", () => {
    assert.equal(renderStatusline(buckets(0, 0, 0, 5), WORDS), undefined);
  });

  it("shows the warning glyph only when something is late", () => {
    assert.equal(renderStatusline(buckets(2, 1, 0), WORDS), `${WARNING_GLYPH} 2 overdue · 1 today`);
    // No icon in the normal case, so its presence is itself the signal.
    assert.equal(renderStatusline(buckets(0, 1, 4), WORDS), "1 today · 4 this week");
  });

  it("omits empty buckets entirely rather than showing zeros", () => {
    assert.equal(renderStatusline(buckets(0, 0, 4), WORDS), "4 this week");
    assert.equal(renderStatusline(buckets(0, 3, 0), WORDS), "3 today");
    assert.equal(renderStatusline(buckets(1, 0, 0), WORDS), `${WARNING_GLYPH} 1 overdue`);
  });

  it("renders all three buckets when all are populated", () => {
    assert.equal(
      renderStatusline(buckets(2, 1, 4), WORDS),
      `${WARNING_GLYPH} 2 overdue · 1 today · 4 this week`,
    );
  });
});

describe("renderStatusline — compact", () => {
  it("keeps all three positions including zeros", () => {
    // Positional notation only works if the positions are fixed.
    assert.equal(renderStatusline(buckets(0, 1, 4), COMPACT), "0/1/4");
    assert.equal(renderStatusline(buckets(2, 1, 4), COMPACT), `${WARNING_GLYPH} 2/1/4`);
  });

  it("is still hidden when everything is zero", () => {
    assert.equal(renderStatusline(buckets(0, 0, 0), COMPACT), undefined);
  });
});

describe("renderStatusline — prefix", () => {
  const cases: [string, RemindersConfig, Buckets, string][] = [
    ["Reminders: 2/1/4", { ...COMPACT, statuslinePrefix: "Reminders:" }, buckets(0, 1, 4), "Reminders: 0/1/4"],
    [
      "words with prefix",
      { ...WORDS, statuslinePrefix: "reminders:" },
      buckets(2, 1, 0),
      `${WARNING_GLYPH} reminders: 2 overdue · 1 today`,
    ],
    ["compact with short prefix", { ...COMPACT, statuslinePrefix: "rem" }, buckets(2, 1, 4), `${WARNING_GLYPH} rem 2/1/4`],
    ["empty prefix words", { ...WORDS, statuslinePrefix: "" }, buckets(2, 1, 0), `${WARNING_GLYPH} 2 overdue · 1 today`],
    ["empty prefix compact", { ...COMPACT, statuslinePrefix: "" }, buckets(2, 1, 4), `${WARNING_GLYPH} 2/1/4`],
  ];

  for (const [name, config, bucketSet, expected] of cases) {
    it(`renders ${name}`, () => {
      assert.equal(renderStatusline(bucketSet, config), expected);
    });
  }

  it("omits an empty prefix along with its space", () => {
    const rendered = renderStatusline(buckets(0, 1, 0), { ...WORDS, statuslinePrefix: "" });
    assert.equal(rendered, "1 today");
    assert.ok(!rendered?.startsWith(" "));
  });
});

describe("renderWidget", () => {
  it("is hidden when nothing is overdue", () => {
    assert.equal(renderWidget(buckets(0, 3, 5)), undefined);
  });

  it("renders exactly one line naming the most overdue item", () => {
    const set = buckets(0, 0, 0);
    set.overdue = [
      reminder("a3f", "call the accountant", local(2026, 1, 10, 9, 0)),
      reminder("b7c", "file the VAT return", local(2026, 1, 12, 9, 0)),
    ];
    const lines = renderWidget(set);
    assert.equal(lines?.length, 1, "one row, never a multi-line box");
    assert.equal(lines?.[0], `${WARNING_GLYPH} 2 overdue · next: call the accountant`);
  });

  it("truncates a long message so the line cannot wrap", () => {
    const set = buckets(0, 0, 0);
    set.overdue = [reminder("a3f", "x".repeat(200), local(2026, 1, 10, 9, 0))];
    const line = renderWidget(set)?.[0] as string;
    assert.ok(line.length < 100, `line was ${line.length} chars`);
    assert.ok(line.endsWith("…"));
  });
});

describe("renderStartupReport", () => {
  const now = local(2026, 1, 20, 10, 0);

  it("says nothing when nothing is past due", () => {
    assert.equal(renderStartupReport([], DEFAULT_CONFIG, now), undefined);
  });

  it("caps the list and counts the remainder", () => {
    const overdue = Array.from({ length: 12 }, (_unused, index) =>
      reminder(`r${index}`, `thing ${index}`, local(2026, 1, 10, 9, 0)),
    );
    const lines = renderStartupReport(overdue, DEFAULT_CONFIG, now) as string[];
    // Header + 5 entries + the "and N more" line: twelve past-due items must
    // not produce twelve lines.
    assert.equal(lines.length, 7);
    assert.match(lines[0] as string, /12 reminders past due/);
    assert.equal(lines.at(-1), "  ...and 7 more — /reminders");
  });

  it("omits the remainder line when everything fits", () => {
    const overdue = [reminder("r0", "thing", local(2026, 1, 10, 9, 0))];
    const lines = renderStartupReport(overdue, DEFAULT_CONFIG, now) as string[];
    assert.equal(lines.length, 2);
    assert.match(lines[0] as string, /1 reminder past due/, "singular");
    assert.ok(!lines.some((line) => line.includes("more")));
  });

  it("respects a configured limit", () => {
    const overdue = Array.from({ length: 4 }, (_unused, index) =>
      reminder(`r${index}`, `thing ${index}`, local(2026, 1, 10, 9, 0)),
    );
    const lines = renderStartupReport(overdue, { ...DEFAULT_CONFIG, startupReportLimit: 2 }, now) as string[];
    assert.equal(lines.length, 4);
    assert.equal(lines.at(-1), "  ...and 2 more — /reminders");
  });
});
