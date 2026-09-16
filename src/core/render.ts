// Pure rendering of the glanceable surfaces. Kept out of the Pi layer so the
// string logic is testable and the surfaces stay thin.

import { formatReminderLine, truncate } from "./format.ts";
import type { Buckets, Reminder, RemindersConfig } from "./types.ts";

/**
 * The warning glyph is `U+26A0` plus the variation selector `U+FE0F`, which
 * selects emoji presentation so the font renders it as a yellow triangle.
 *
 * Colour comes from the glyph, not from ANSI: `setStatus(key, text)` takes a
 * plain string and has no colour parameter, and `setFooter()` would replace the
 * whole footer and collide with pi-footer. Bare `U+26A0` is the text
 * presentation and renders monochrome grey — that distinction is load-bearing.
 */
export const WARNING_GLYPH = "\u26a0\ufe0f";

function withPrefix(config: RemindersConfig, overdue: boolean, body: string): string {
  // Rendering is `[⚠️ if overdue] [prefix] [body]`, where an empty prefix is
  // omitted along with its space.
  const parts = [overdue ? WARNING_GLYPH : "", config.statuslinePrefix.trim(), body];
  return parts.filter((part) => part !== "").join(" ");
}

/**
 * The statusline segment, or undefined when there is nothing at all to show.
 *
 * No icon in the normal case: the icon appears only when something is late, so
 * its presence is itself the signal rather than decoration you learn to skim.
 */
export function renderStatusline(buckets: Buckets, config: RemindersConfig): string | undefined {
  const overdue = buckets.overdue.length;
  const today = buckets.today.length;
  const week = buckets.week.length;
  if (overdue === 0 && today === 0 && week === 0) return undefined;

  if (config.statuslineStyle === "compact") {
    // Positional notation only works if the positions are fixed, so compact
    // always shows all three including zeros.
    return withPrefix(config, overdue > 0, `${overdue}/${today}/${week}`);
  }

  // `words` omits empty buckets entirely. `0/1/1` never appears, so there is no
  // ambiguity about whether the last number includes the middle one.
  const body = [
    overdue > 0 ? `${overdue} overdue` : "",
    today > 0 ? `${today} today` : "",
    week > 0 ? `${week} this week` : "",
  ]
    .filter((part) => part !== "")
    .join(" · ");

  return withPrefix(config, overdue > 0, body);
}

const WIDGET_MESSAGE_MAX = 48;

/**
 * The widget: one line, below the editor, rendered only when something is
 * overdue.
 *
 * The multi-line box was rejected after seeing it live — a persistent list is
 * loud for something usually empty, and a busy week pushes the editor down the
 * screen. Hidden entirely when nothing is overdue, so its presence is the
 * signal. Merely upcoming reminders live in the statusline.
 */
export function renderWidget(buckets: Buckets): string[] | undefined {
  const overdue = buckets.overdue;
  if (overdue.length === 0) return undefined;
  // Sorted soonest-first, so [0] is the one that has been late the longest.
  const next = overdue[0] as Reminder;
  const message = truncate(next.message, WIDGET_MESSAGE_MAX);
  return [`${WARNING_GLYPH} ${overdue.length} overdue · next: ${message}`];
}

/** Grouped `overdue / today / upcoming` list body for `/reminders list`. */
export function renderList(buckets: Buckets, config: RemindersConfig, now: number): string[] {
  const lines: string[] = [];
  const section = (title: string, reminders: Reminder[]): void => {
    if (reminders.length === 0) return;
    if (lines.length > 0) lines.push("");
    lines.push(title);
    for (const reminder of reminders) {
      lines.push(`  ${formatReminderLine(reminder, config, now)}`);
    }
  };

  section("Overdue", buckets.overdue);
  section("Today", buckets.today);
  section("This week", buckets.week);
  section("Later", buckets.later);

  if (lines.length === 0) return ["No active reminders."];
  return lines;
}

/**
 * The session-start report: loud, in the same register as a failed job.
 *
 * Capped, because twelve past-due items must not produce twelve lines.
 */
export function renderStartupReport(
  overdue: Reminder[],
  config: RemindersConfig,
  now: number,
): string[] | undefined {
  if (overdue.length === 0) return undefined;

  const shown = overdue.slice(0, config.startupReportLimit);
  const lines = [
    `${WARNING_GLYPH} ${overdue.length} reminder${overdue.length === 1 ? "" : "s"} past due:`,
    ...shown.map((reminder) => `  ${formatReminderLine(reminder, config, now)}`),
  ];

  const remaining = overdue.length - shown.length;
  if (remaining > 0) lines.push(`  ...and ${remaining} more — /reminders`);
  return lines;
}
