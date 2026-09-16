// The four surfaces. All of them are projections of the state file — nothing
// here holds reminder state, and nothing here mutates a record.
//
// | Surface         | Timing                                      |
// | --------------- | ------------------------------------------- |
// | Statusline      | Tick, immediate — never interrupts          |
// | Desktop banner  | Tick, immediate — subprocess, off-screen    |
// | TUI toast       | Tick, immediate — transient overlay         |
// | Transcript line | Immediate if ctx.isIdle(), else at turn end |

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { renderStatusline, renderWidget } from "../core/render.ts";
import type { Buckets, RemindersConfig } from "../core/types.ts";

const STATUS_KEY = "reminders";
const WIDGET_KEY = "reminders";
const TRANSCRIPT_TYPE = "reminders-fired";

interface TranscriptData {
  lines: string[];
}

/**
 * Register the transcript renderer.
 *
 * Custom *entries* rather than custom messages: the transcript is append-only
 * and must not be re-sent to the LLM on every subsequent turn. Nothing is ever
 * "dismissed" from it.
 */
export function registerTranscriptRenderer(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<TranscriptData>(
    TRANSCRIPT_TYPE,
    (entry, _options, theme) => {
      const lines = entry.data?.lines ?? [];
      return new Text(
        lines.map((line) => theme.fg("warning", line)).join("\n"),
        0,
        0,
      );
    },
  );
}

/**
 * Drives the statusline and the widget from a bucket snapshot.
 *
 * Both are keyed and idempotent, so this can be called on every tick; it skips
 * the call when the rendered value has not changed, which keeps the footer from
 * being invalidated once a minute for no reason.
 */
export class GlanceSurfaces {
  #lastStatus: string | undefined;
  #lastWidget: string | undefined;
  #widgetShown = false;

  update(
    ctx: ExtensionContext,
    buckets: Buckets,
    config: RemindersConfig,
  ): void {
    if (!ctx.hasUI) return;

    const status = renderStatusline(buckets, config);
    if (status !== this.#lastStatus) {
      ctx.ui.setStatus(STATUS_KEY, status);
      this.#lastStatus = status;
    }

    const widget = renderWidget(buckets);
    const key = widget?.join("\n");
    if (key !== this.#lastWidget) {
      if (widget === undefined) {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        this.#widgetShown = false;
      } else {
        // Placement is fixed at creation, so it is set once and then updated in
        // place. Only a placement change would need clear-then-set.
        ctx.ui.setWidget(WIDGET_KEY, widget, { placement: "belowEditor" });
        this.#widgetShown = true;
      }
      this.#lastWidget = key;
    }
  }

  /** Drop both surfaces on shutdown so a stale count cannot outlive the session. */
  clear(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    if (this.#widgetShown) ctx.ui.setWidget(WIDGET_KEY, undefined);
    this.#lastStatus = undefined;
    this.#lastWidget = undefined;
    this.#widgetShown = false;
  }
}

/**
 * Appends a transcript block, deferring to turn end when the agent is mid-work.
 *
 * Appending mid-turn renders in a confusing position, so anything raised while
 * the agent is streaming is queued and flushed on `turn_end` / `agent_settled`.
 */
export class TranscriptQueue {
  readonly #pending: string[][] = [];

  constructor(private readonly pi: ExtensionAPI) {}

  push(ctx: ExtensionContext, lines: string[]): void {
    if (lines.length === 0) return;
    if (ctx.isIdle()) {
      this.#append(lines);
      return;
    }
    this.#pending.push(lines);
  }

  /** Flush anything queued while the agent was busy. */
  flush(): void {
    if (this.#pending.length === 0) return;
    const queued = this.#pending.splice(0, this.#pending.length);
    for (const lines of queued) this.#append(lines);
  }

  #append(lines: string[]): void {
    try {
      this.pi.appendEntry<TranscriptData>(TRANSCRIPT_TYPE, { lines });
    } catch {
      // A transcript line is the least important surface; never let it break
      // the tick.
    }
  }
}
