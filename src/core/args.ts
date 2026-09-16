// Slash-command argument parsing. Pure, so the shapes are testable without a
// running pi.

import { type ParseResult, parseRecurrence } from "./parse.ts";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const TIME_ONLY = /^\d{1,2}:\d{2}(?::\d{2})?$/;

interface FlagScan {
  /** Positional tokens, with recognised flags and their values removed. */
  rest: string[];
  values: Map<string, string>;
  error?: string;
}

/**
 * Pull `--flag value` pairs out of a token list, wherever they appear.
 *
 * The design puts `--every` between the date and the message, but accepting it
 * anywhere costs nothing and avoids a confusing rejection.
 */
function scanFlags(tokens: string[], names: readonly string[]): FlagScan {
  const rest: string[] = [];
  const values = new Map<string, string>();

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] as string;
    const name = token.startsWith("--")
      ? token.slice(2).toLowerCase()
      : undefined;
    if (name === undefined || !names.includes(name)) {
      rest.push(token);
      continue;
    }
    const value = tokens[index + 1];
    if (value === undefined) {
      return { rest, values, error: `\`--${name}\` needs a value.` };
    }
    values.set(name, value);
    index += 1;
  }

  return { rest, values };
}

export interface SnoozeArgs {
  id: string;
  /** Either a duration offset or an absolute date; both resolve via parseSnoozeTarget. */
  target: string;
}

/** Split `<id> <duration>` or `<id> --until <date>`. */
export function parseSnoozeArgs(input: string): ParseResult<SnoozeArgs> {
  const tokens = input
    .trim()
    .split(/\s+/)
    .filter((token) => token !== "");
  const scan = scanFlags(tokens, ["until"]);
  if (scan.error !== undefined) return { ok: false, error: scan.error };

  const id = scan.rest[0];
  if (id === undefined) {
    return {
      ok: false,
      error: "Usage: /reminders snooze <id> <duration>  |  --until <date>",
    };
  }

  const until = scan.values.get("until");
  if (until !== undefined) {
    // `--until 2026-01-20 09:00` arrives as two tokens; re-join a trailing time.
    const trailing = scan.rest[1];
    const target =
      DATE_ONLY.test(until) &&
      trailing !== undefined &&
      TIME_ONLY.test(trailing)
        ? `${until} ${trailing}`
        : until;
    return { ok: true, value: { id, target } };
  }

  const duration = scan.rest.slice(1).join(" ").trim();
  if (duration === "") {
    return {
      ok: false,
      error:
        "Snooze needs a duration, e.g. `45m`, `3h`, `2d`, or `--until 2026-01-20`.",
    };
  }

  return { ok: true, value: { id, target: duration } };
}
