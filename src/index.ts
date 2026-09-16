// @msimon/pi-reminders — personal date-based reminders for pi.
//
// A reminder is stateful and must be acknowledged; a scheduled task fires and
// is gone. That distinction is the whole point of this extension, and the
// reason it is not shaped like a scheduler.
//
// The state file is the only source of truth. Every surface is a projection of
// it, and every mutation acts on a record.

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.ts";
import { RemindersRuntime } from "./runtime.ts";
import { registerTranscriptRenderer } from "./surfaces/index.ts";
import { registerTool } from "./tool.ts";

export default function reminders(pi: ExtensionAPI): void {
  const runtime = new RemindersRuntime(pi);

  registerTranscriptRenderer(pi);
  registerCommands(pi, runtime);
  registerTool(pi, runtime);

  // Recompute on every session start: this is what surfaces a reminder that
  // came due while pi was closed, and what re-nags about anything past due.
  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    await runtime.start(ctx);
  });

  // Anything raised mid-turn was queued rather than appended, because appending
  // mid-turn renders in a confusing position. Flush it once the turn lands.
  pi.on("turn_end", () => {
    runtime.flushTranscript();
  });
  pi.on("agent_settled", () => {
    runtime.flushTranscript();
  });

  pi.on("session_shutdown", (_event, ctx: ExtensionContext) => {
    runtime.stop(ctx);
  });
}
