// The `reminder` agent tool — the higher-value path: "remind me to follow up on
// this next Tuesday" mid-conversation, without breaking flow.
//
// The model resolves natural language to an absolute timestamp BEFORE calling.
// This tool never parses relative dates beyond the documented offset form and
// never makes an LLM call, so the extension stays a pure state machine over
// absolute times with zero dependencies and no network round-trip.
//
// Reads are allowed too, so "what's on my plate" works.

import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type AgentToolResult,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
  describeLocalZone,
  formatDue,
  formatReminderLine,
} from "./core/format.ts";
import {
  ACCEPTED_WHEN_FORMATS,
  parseSnoozeTarget,
  parseWhen,
} from "./core/parse.ts";
import { renderList } from "./core/render.ts";
import { mutate } from "./core/store.ts";
import {
  applyClear,
  applyDelete,
  applySnooze,
  type AddInput,
  type IdMutationResult,
} from "./core/tick.ts";
import type { Reminder } from "./core/types.ts";
import type { RemindersRuntime } from "./runtime.ts";

const PARAMS = Type.Object({
  action: Type.Union(
    [
      Type.Literal("add"),
      Type.Literal("list"),
      Type.Literal("clear"),
      Type.Literal("snooze"),
      Type.Literal("delete"),
    ],
    { description: "What to do." },
  ),
  message: Type.Optional(
    Type.String({
      description: "For add: what to remind the user about. Required for add.",
    }),
  ),
  when: Type.Optional(
    Type.String({
      description:
        "For add, one of: a local date `YYYY-MM-DD` (all-day), a local timestamp `YYYY-MM-DD HH:MM` (timed), " +
        "a zoned instant such as `2026-01-20T09:00:00Z` or `2026-01-20T09:00:00+01:00`, or an offset `<N><m|h|d|w>` such as `45m`, `3h`, `2d`, `1w`. " +
        'Resolve natural language ("next Tuesday", "tomorrow morning") to one of those forms before calling. ' +
        "A form without a zone is read as the user's LOCAL wall-clock time; a zoned form is read as that exact instant. " +
        "Prefer passing a zoned instant when you already have one \u2014 do not convert it to local time yourself. " +
        "Passing a date with no time makes it an all-day reminder, which fires in the morning and only counts as overdue the next day.",
    }),
  ),
  recurrence: Type.Optional(
    Type.Union(
      [
        Type.Literal("day"),
        Type.Literal("week"),
        Type.Literal("month"),
        Type.Literal("year"),
      ],
      {
        description:
          "For add: repeat every day/week/month/year. `when` is the first occurrence. Rolling forward is anchored to that date, not to when the user acknowledges it.",
      },
    ),
  ),
  id: Type.Optional(
    Type.String({
      description:
        "For clear/snooze/delete: the short id from `list`. A unique prefix works.",
    }),
  ),
  duration: Type.Optional(
    Type.String({
      description:
        "For snooze: an offset `<N><m|h|d|w>` such as `45m`, `3h`, `2d`, or an absolute `YYYY-MM-DD[ HH:MM]`.",
    }),
  ),
  includeCleared: Type.Optional(
    Type.Boolean({
      description:
        "For list: also show already-cleared reminders. Defaults to false.",
    }),
  ),
});

/** `details` is required on AgentToolResult; this tool has no structured payload. */
function text(body: string): AgentToolResult<undefined> {
  return { content: [{ type: "text", text: body }], details: undefined };
}

/**
 * Thrown for anything the model got wrong or that the store refused.
 *
 * The agent runtime surfaces a thrown error as a tool error (isError=true),
 * which is the supported channel — AgentToolResult has no isError field. The
 * message is the model's only feedback, so it states the accepted formats
 * rather than just saying no.
 */
class ReminderToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReminderToolError";
  }
}

function failure(body: string): never {
  throw new ReminderToolError(body);
}

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

export function registerTool(
  pi: ExtensionAPI,
  runtime: RemindersRuntime,
): void {
  pi.registerTool(
    defineTool({
      name: "reminder",
      label: "Reminder",
      description:
        "Manage the user's personal reminders: add, list, clear, snooze, delete. " +
        "A reminder is stateful and nags until acknowledged, unlike a scheduled task. " +
        "Use this when the user asks to be reminded of something, or asks what they have coming up. " +
        "Resolve natural-language dates before calling. " +
        `The user's machine is in ${describeLocalZone(Date.now())}, so use that when interpreting "tomorrow", "this evening" and similar.`,
      promptSnippet:
        "reminder: add/list/clear/snooze/delete the user's personal reminders",
      parameters: PARAMS,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const now = Date.now();

        try {
          switch (params.action) {
            case "add": {
              if (
                params.message === undefined ||
                params.message.trim() === ""
              ) {
                return failure("`message` is required for action `add`.");
              }
              if (params.when === undefined) {
                return failure(
                  `\`when\` is required for action \`add\`. Expected ${ACCEPTED_WHEN_FORMATS}.`,
                );
              }

              const when = parseWhen(params.when, now);
              if (!when.ok) return failure(when.error);

              const input: AddInput = {
                message: params.message.trim(),
                dueAt: when.value.dueAt,
                allDay: when.value.allDay,
                cwd: ctx.cwd,
              };
              if (params.recurrence !== undefined)
                input.recurrence = params.recurrence;

              const added = await runtime.add(input);
              await runtime.refresh();

              const every =
                added.recurrence === undefined
                  ? ""
                  : `, repeating every ${added.recurrence}`;
              const kind = added.allDay ? "all-day" : "timed";
              // Echo the resolved absolute time back so the model can confirm
              // it to the user in the same turn.
              return text(
                `Added reminder ${added.id}: "${added.message}" — ${kind}, due ${formatDue(added, now)}${every}.`,
              );
            }

            case "list": {
              const { reminders, buckets } = await runtime.snapshot(now);
              const lines = renderList(buckets, runtime.config, now);
              if (params.includeCleared === true) {
                const cleared = reminders.filter(
                  (reminder) => reminder.ackedAt !== undefined,
                );
                if (cleared.length > 0) {
                  lines.push("", `Cleared (${cleared.length}):`);
                  for (const reminder of cleared.slice(-10)) {
                    lines.push(`  ${reminder.id}  ${reminder.message}`);
                  }
                }
              }
              return text(lines.join("\n"));
            }

            case "clear": {
              if (params.id === undefined)
                return failure("`id` is required for action `clear`.");
              const result = await mutate((reminders) =>
                applyClear(reminders, params.id as string, now),
              );
              const problem = explainFailure(result, params.id);
              if (problem !== undefined) return failure(problem);
              await runtime.refresh();

              const reminder = result.reminder as Reminder;
              if (reminder.recurrence === undefined)
                return text(`Cleared ${reminder.id}.`);
              return text(
                `Cleared ${reminder.id}. Next occurrence ${formatDue(reminder, now)} (every ${reminder.recurrence}).`,
              );
            }

            case "snooze": {
              if (params.id === undefined)
                return failure("`id` is required for action `snooze`.");
              if (params.duration === undefined) {
                return failure("`duration` is required for action `snooze`.");
              }
              const target = parseSnoozeTarget(
                params.duration,
                now,
                runtime.config.allDayFireHour,
              );
              if (!target.ok) return failure(target.error);
              if (target.value <= now)
                return failure("That snooze target is in the past.");

              const result = await mutate((reminders) =>
                applySnooze(reminders, params.id as string, target.value),
              );
              const problem = explainFailure(result, params.id);
              if (problem !== undefined) return failure(problem);
              await runtime.refresh();

              const reminder = result.reminder as Reminder;
              return text(
                `Snoozed ${reminder.id} until ${formatReminderLine(reminder, runtime.config, now)}.`,
              );
            }

            case "delete": {
              if (params.id === undefined)
                return failure("`id` is required for action `delete`.");
              const result = await mutate((reminders) =>
                applyDelete(reminders, params.id as string),
              );
              const problem = explainFailure(result, params.id);
              if (problem !== undefined) return failure(problem);
              await runtime.refresh();
              return text(`Deleted ${(result.reminder as Reminder).id}.`);
            }
          }
        } catch (error: unknown) {
          // Surface the failure to the model rather than reporting a success
          // that did not happen. Validation errors already carry their own
          // wording; anything else (a CAS exhaustion, a filesystem fault) gets
          // the extension prefix so its origin is obvious in the transcript.
          if (error instanceof ReminderToolError) throw error;
          throw new ReminderToolError(
            `[reminders] ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    }),
  );
}
