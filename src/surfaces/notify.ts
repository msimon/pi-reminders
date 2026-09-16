// Desktop banner.
//
// Prefer the `cmux notify` CLI over writing raw escapes to process.stdout: pi
// owns the screen, and a subprocess cannot corrupt the render. OSC 777 is the
// fallback for when cmux is not on PATH.
//
// pi core emits no OSC notification sequences of its own, and `ctx.ui.notify`
// draws an in-TUI toast and nothing else, so the banner has to be sent
// explicitly. `cmux notify` has no `--id` or replace flag, but fire-once plus
// the cross-window claim means one banner per fire, so replacement is not
// needed.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface Banner {
  title: string;
  subtitle?: string;
  body: string;
}

/** Cached so a missing cmux costs one failed spawn per session, not one per fire. */
let cmuxAvailable: boolean | undefined;

function osc777(banner: Banner): void {
  // \x1b]777;notify;<title>;<body>\x07
  const title = banner.subtitle === undefined ? banner.title : `${banner.title} — ${banner.subtitle}`;
  process.stdout.write(`\x1b]777;notify;${title};${banner.body}\x07`);
}

/**
 * Send one desktop banner. Never throws: a failed notification must not take
 * down the tick that produced it.
 */
export async function sendBanner(pi: ExtensionAPI, banner: Banner): Promise<void> {
  if (cmuxAvailable !== false) {
    const args = ["notify", "--title", banner.title, "--body", banner.body];
    if (banner.subtitle !== undefined) args.push("--subtitle", banner.subtitle);

    try {
      const result = await pi.exec("cmux", args, { timeout: 5000 });
      if (result.code === 0) {
        cmuxAvailable = true;
        return;
      }
      // Present but unhappy (e.g. no workspace to target). Fall through to OSC
      // rather than silently dropping the notification.
      cmuxAvailable = true;
    } catch {
      // Not on PATH, or not spawnable.
      cmuxAvailable = false;
    }
  }

  try {
    osc777(banner);
  } catch {
    // Nothing more to try; the statusline and toast still carry the signal.
  }
}
