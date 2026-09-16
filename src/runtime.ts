// The tick loop and the shared session runtime.
//
// One interval per session, recomputing from wall clock. The interval is only a
// scheduler — it never carries state, and its cadence has no bearing on
// correctness, so a tick that is late (or skipped entirely across a sleep) just
// means the next one does the work.
//
// Ticks also re-read the state file, which is what makes cross-window
// convergence work: clearing in window A drops out of window B's statusline
// within one tick.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readConfig } from "./core/config.ts";
import { computeBuckets } from "./core/derive.ts";
import { formatDue } from "./core/format.ts";
import { renderStartupReport } from "./core/render.ts";
import { mutate, readState } from "./core/store.ts";
import { applyAdd, applyTick, pastDue, type AddInput } from "./core/tick.ts";
import { DEFAULT_CONFIG, type Buckets, type Reminder, type RemindersConfig } from "./core/types.ts";
import { GlanceSurfaces, TranscriptQueue } from "./surfaces/index.ts";
import { sendBanner } from "./surfaces/notify.ts";

export class RemindersRuntime {
  readonly #pi: ExtensionAPI;
  readonly #glance = new GlanceSurfaces();
  readonly #transcript: TranscriptQueue;

  #config: RemindersConfig = { ...DEFAULT_CONFIG };
  #timer: ReturnType<typeof setInterval> | undefined;
  #ctx: ExtensionContext | undefined;
  #warnedCorrupt = false;
  #configWarning: string | undefined;
  /** Guards against a slow tick overlapping the next interval fire. */
  #ticking = false;

  constructor(pi: ExtensionAPI) {
    this.#pi = pi;
    this.#transcript = new TranscriptQueue(pi);
  }

  get config(): RemindersConfig {
    return this.#config;
  }

  /**
   * Config is read once per session. Re-reading it every tick would mean a
   * filesystem hit a minute for a file that changes approximately never; a
   * restart picks up an edit.
   */
  async start(ctx: ExtensionContext): Promise<void> {
    this.#ctx = ctx;

    const loaded = await readConfig();
    this.#config = loaded.config;
    this.#configWarning = loaded.warning;
    if (loaded.warning !== undefined && ctx.hasUI) {
      ctx.ui.notify(`[reminders] ${loaded.warning}`, "warning");
    }

    await this.tick();
    await this.reportPastDue(ctx);

    this.#timer ??= setInterval(() => {
      void this.tick();
    }, this.#config.tickIntervalSeconds * 1000);
    // Never hold the process open for a reminder.
    this.#timer.unref?.();
  }

  stop(ctx: ExtensionContext | undefined): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    const target = ctx ?? this.#ctx;
    if (target !== undefined) this.#glance.clear(target);
    this.#ctx = undefined;
  }

  /** Flush transcript lines that were raised while the agent was streaming. */
  flushTranscript(): void {
    this.#transcript.flush();
  }

  /**
   * One pass of the state machine.
   *
   * Recomputes everything from `Date.now()`, claims any newly fired records,
   * then repaints. Fires are notified only by the window that won the claim.
   */
  async tick(): Promise<void> {
    const ctx = this.#ctx;
    if (ctx === undefined) return;
    if (this.#ticking) return;
    this.#ticking = true;

    try {
      const now = Date.now();
      const fired = await mutate((reminders) => applyTick(reminders, now, this.#config));
      const { reminders } = await readState();
      const buckets = computeBuckets(reminders, this.#config, now);

      this.#glance.update(ctx, buckets, this.#config);
      if (fired.fired.length > 0) await this.#announce(ctx, fired.fired);
    } catch (error: unknown) {
      this.#reportError(ctx, error);
    } finally {
      this.#ticking = false;
    }
  }

  /**
   * Add a reminder under CAS.
   *
   * Throws on retry exhaustion rather than reporting success: a silently
   * dropped add is the one failure mode that destroys trust in the whole thing.
   */
  async add(input: AddInput): Promise<Reminder> {
    const now = Date.now();
    return mutate((reminders) => applyAdd(reminders, input, now));
  }
  /** Current buckets without mutating anything. Used by the commands. */
  async snapshot(now = Date.now()): Promise<{ reminders: Reminder[]; buckets: Buckets }> {
    const loaded = await readState();
    if (loaded.recovered && !this.#warnedCorrupt) {
      this.#warnedCorrupt = true;
      this.#ctx?.ui.notify(
        "[reminders] reminders.json was unreadable and has been moved aside; starting from empty.",
        "warning",
      );
    }
    return { reminders: loaded.reminders, buckets: computeBuckets(loaded.reminders, this.#config, now) };
  }

  /** Repaint the glanceable surfaces without running the state machine. */
  async refresh(): Promise<void> {
    const ctx = this.#ctx;
    if (ctx === undefined) return;
    try {
      const { buckets } = await this.snapshot();
      this.#glance.update(ctx, buckets, this.#config);
    } catch (error: unknown) {
      this.#reportError(ctx, error);
    }
  }

  /**
   * Session-start report: loud, capped, and re-emitted at every session start
   * until the reminder is snoozed, cleared or deleted.
   */
  async reportPastDue(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) return;
    try {
      const now = Date.now();
      const { reminders } = await readState();
      const overdue = pastDue(reminders, this.#config, now);
      const lines = renderStartupReport(overdue, this.#config, now);
      if (lines === undefined) return;

      ctx.ui.notify(lines.join("\n"), "warning");
      this.#transcript.push(ctx, lines);
    } catch (error: unknown) {
      this.#reportError(ctx, error);
    }
  }

  /** Toast + desktop banner + transcript for records this window just claimed. */
  async #announce(ctx: ExtensionContext, fired: Reminder[]): Promise<void> {
    const now = Date.now();
    const lines = fired.map((r) => `⏰ ${r.message} — due ${formatDue(r, now)}`);

    if (ctx.hasUI) {
      ctx.ui.notify(lines.join("\n"), "warning");
      this.#transcript.push(ctx, lines);
    }

    if (!this.#config.desktopNotifications) return;
    for (const reminder of fired) {
      await sendBanner(this.#pi, {
        title: "Reminder",
        subtitle: formatDue(reminder, now),
        body: reminder.message,
      });
    }
  }

  #reportError(ctx: ExtensionContext, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    // A dropped add is the failure mode that destroys trust, so surface it
    // rather than letting the tick swallow it.
    if (ctx.hasUI) ctx.ui.notify(`[reminders] ${message}`, "error");
    else process.stderr.write(`[reminders] ${message}\n`);
  }

  get configWarning(): string | undefined {
    return this.#configWarning;
  }
}
