// Slash commands: the human entrypoint.
//
// The picker is built from ctx.ui.select, the same primitive pi-cron-jobs uses
// for its job menu — two sequential selects (pick a reminder, then pick an
// action) rather than a bespoke component, so it works in every UI-capable mode
// without reimplementing keyboard handling.

import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { parseSnoozeArgs } from "./core/args.ts";
import { formatDue, formatReminderLine } from "./core/format.ts";
import { parseSnoozeTarget } from "./core/parse.ts";
import { renderList } from "./core/render.ts";
import { formatLocalDateTime } from "./core/time.ts";
import { mutate } from "./core/store.ts";
import {
  applyClear,
  applyDelete,
  applySnooze,
  type IdMutationResult,
} from "./core/tick.ts";
import type { Reminder } from "./core/types.ts";
import type { RemindersRuntime } from "./runtime.ts";

/** Turn a lookup failure into the same wording everywhere. */
function explainFailure(
  result: IdMutationResult,
  id: string,
): string | undefined {
  if (result.status === "not-found")
    return `No active reminder matching "${id}".`;
  if (result.status === "ambiguous")
    return `"${id}" matches more than one reminder — use more characters.`;
  return undefined;
}

export function registerCommands(
  pi: ExtensionAPI,
  runtime: RemindersRuntime,
): void {
  pi.registerCommand("reminders", {
    description: "List reminders, or: /reminders clear|snooze|delete <id>",
    getArgumentCompletions: (prefix: string) => {
      const subcommands = ["list", "all", "clear", "snooze", "delete"];
      const match = subcommands.filter((name) =>
        name.startsWith(prefix.trim().toLowerCase()),
      );
      return match.map((name) => ({ value: name, label: name }));
    },
    handler: async (
      args: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> => {
      const trimmed = args.trim();
      const [subcommand = "", ...rest] = trimmed.split(/\s+/);
      const remainder = rest.join(" ");

      try {
        switch (subcommand.toLowerCase()) {
          case "":
            await openPicker(ctx, runtime);
            return;
          case "list":
          case "all":
            await printList(ctx, runtime, subcommand.toLowerCase() === "all");
            return;
          case "clear":
          case "done":
            await runClear(ctx, runtime, remainder);
            return;
          case "snooze":
            await runSnooze(ctx, runtime, remainder);
            return;
          case "delete":
          case "rm":
            await runDelete(ctx, runtime, remainder);
            return;
          default:
            ctx.ui.notify(
              `Unknown subcommand "${subcommand}". Use /reminders [list|all|clear <id>|snooze <id> <duration>|delete <id>].`,
              "error",
            );
        }
      } catch (error: unknown) {
        ctx.ui.notify(
          `[reminders] ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
    },
  });
}

async function printList(
  ctx: ExtensionCommandContext,
  runtime: RemindersRuntime,
  includeCleared: boolean,
): Promise<void> {
  const now = Date.now();
  const { reminders, buckets } = await runtime.snapshot(now);
  const lines = renderList(buckets, runtime.config, now);

  if (includeCleared) {
    const cleared = reminders.filter(
      (reminder) => reminder.ackedAt !== undefined,
    );
    if (cleared.length > 0) {
      lines.push("", `Cleared (${cleared.length})`);
      for (const reminder of cleared.slice(-10)) {
        lines.push(`  ${reminder.id}  ${reminder.message}`);
      }
    }
  }

  ctx.ui.notify(lines.join("\n"), "info");
}

async function runClear(
  ctx: ExtensionCommandContext,
  runtime: RemindersRuntime,
  id: string,
): Promise<void> {
  if (id.trim() === "") {
    ctx.ui.notify("Usage: /reminders clear <id>", "error");
    return;
  }
  const now = Date.now();
  const result = await mutate((reminders) => applyClear(reminders, id, now));
  const failure = explainFailure(result, id);
  if (failure !== undefined) {
    ctx.ui.notify(failure, "error");
    return;
  }

  const reminder = result.reminder as Reminder;
  // A recurring reminder is back to pending at its next occurrence, so say so
  // rather than implying it is gone.
  const message =
    reminder.recurrence === undefined
      ? `Cleared ${reminder.id}.`
      : `Cleared ${reminder.id} — next occurrence ${formatDue(reminder, now)}.`;
  ctx.ui.notify(message, "info");
  await runtime.refresh();
}

async function runSnooze(
  ctx: ExtensionCommandContext,
  runtime: RemindersRuntime,
  args: string,
): Promise<void> {
  const parsed = parseSnoozeArgs(args);
  if (!parsed.ok) {
    ctx.ui.notify(parsed.error, "error");
    return;
  }

  const now = Date.now();
  const target = parseSnoozeTarget(
    parsed.value.target,
    now,
    runtime.config.allDayFireHour,
  );
  if (!target.ok) {
    ctx.ui.notify(target.error, "error");
    return;
  }
  if (target.value <= now) {
    ctx.ui.notify("That snooze target is in the past.", "error");
    return;
  }

  await applySnoozeById(ctx, runtime, parsed.value.id, target.value);
}

async function applySnoozeById(
  ctx: ExtensionCommandContext,
  runtime: RemindersRuntime,
  id: string,
  until: number,
): Promise<void> {
  const result = await mutate((reminders) => applySnooze(reminders, id, until));
  const failure = explainFailure(result, id);
  if (failure !== undefined) {
    ctx.ui.notify(failure, "error");
    return;
  }
  const reminder = result.reminder as Reminder;
  ctx.ui.notify(
    `Snoozed ${reminder.id} until ${formatLocalDateTime(until)}.`,
    "info",
  );
  await runtime.refresh();
}

async function runDelete(
  ctx: ExtensionCommandContext,
  runtime: RemindersRuntime,
  id: string,
): Promise<void> {
  if (id.trim() === "") {
    ctx.ui.notify("Usage: /reminders delete <id>", "error");
    return;
  }

  const { reminders } = await runtime.snapshot();
  const target = reminders.find(
    (reminder) => reminder.id === id.trim().toLowerCase(),
  );
  const label = target === undefined ? id : `"${target.message}"`;

  // Delete is the only irreversible operation, so it confirms.
  const confirmed = await ctx.ui.confirm(
    "Delete reminder?",
    `Permanently delete ${label}?`,
  );
  if (!confirmed) return;

  await deleteById(ctx, runtime, id);
}

async function deleteById(
  ctx: ExtensionCommandContext,
  runtime: RemindersRuntime,
  id: string,
): Promise<void> {
  const result = await mutate((reminders) => applyDelete(reminders, id));
  const failure = explainFailure(result, id);
  if (failure !== undefined) {
    ctx.ui.notify(failure, "error");
    return;
  }
  ctx.ui.notify(`Deleted ${(result.reminder as Reminder).id}.`, "info");
  await runtime.refresh();
}

const SNOOZE_CHOICES: [string, string][] = [
  ["Snooze 1 hour", "1h"],
  ["Snooze 3 hours", "3h"],
  ["Snooze until tomorrow", "1d"],
  ["Snooze 1 week", "1w"],
];

/**
 * The interactive picker: choose a reminder, then choose what to do with it.
 *
 * The select labels double as the grouped list, so there is no separate
 * rendering to keep in sync.
 */
async function openPicker(
  ctx: ExtensionCommandContext,
  runtime: RemindersRuntime,
): Promise<void> {
  const now = Date.now();
  const { buckets } = await runtime.snapshot(now);
  const ordered = [
    ...buckets.overdue,
    ...buckets.today,
    ...buckets.week,
    ...buckets.later,
  ];

  if (ordered.length === 0) {
    ctx.ui.notify(
      "No active reminders. Add one with /remind <when> <message>.",
      "info",
    );
    return;
  }

  const labels = ordered.map((reminder) =>
    formatReminderLine(reminder, runtime.config, now),
  );
  const choice = await ctx.ui.select("Reminders:", labels);
  if (choice === undefined) return;

  const reminder = ordered[labels.indexOf(choice)];
  if (reminder === undefined) return;

  const CLEAR = "Clear (mark done)";
  const DELETE = "Delete permanently";
  const actions = [CLEAR, ...SNOOZE_CHOICES.map(([label]) => label), DELETE];

  const action = await ctx.ui.select(`"${reminder.message}"`, actions);
  if (action === undefined) return;

  if (action === CLEAR) {
    await runClear(ctx, runtime, reminder.id);
    return;
  }

  if (action === DELETE) {
    const confirmed = await ctx.ui.confirm(
      "Delete reminder?",
      `Permanently delete "${reminder.message}"?`,
    );
    if (!confirmed) return;
    await deleteById(ctx, runtime, reminder.id);
    return;
  }

  const snooze = SNOOZE_CHOICES.find(([label]) => label === action);
  if (snooze === undefined) return;
  const target = parseSnoozeTarget(
    snooze[1],
    now,
    runtime.config.allDayFireHour,
  );
  if (!target.ok) return;
  await applySnoozeById(ctx, runtime, reminder.id, target.value);
}
