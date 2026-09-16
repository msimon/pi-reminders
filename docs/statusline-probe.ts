import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/**
 * Throwaway probe: renders candidate reminder statusline strings with fake data
 * so we can see how they actually look in the footer before building anything.
 *
 *   pi -e /tmp/reminders-statusline-probe.ts
 *
 * Then:  /rp            cycle to the next candidate
 *        /rp 3          jump to candidate 3
 *        /rp list       print all candidates as plain text
 *        /rp off        clear the segment
 */

interface Candidate {
  label: string;
  text: string;
}

// Fake state: 2 overdue, 1 due today, 4 due in the next 2-7 days.
const CANDIDATES: Candidate[] = [
  { label: "words + emoji warning (proposed default)", text: "⚠️ 2 overdue · 1 today" },
  { label: "words, nothing late", text: "1 today · 4 this week" },
  { label: "words, only upcoming", text: "4 this week" },
  { label: "compact + emoji warning", text: "⚠️ 2·1·4" },
  { label: "compact, nothing late", text: "2·1·4" },
  { label: "original cryptic form", text: "Reminders: 2/1/4" },
  { label: "bare U+26A0, text presentation (the grey one)", text: "⚠ 2 overdue · 1 today" },
  { label: "alarm clock, matches jobs segment", text: "⏰ 2 overdue · 1 today" },
  { label: "red circle", text: "🔴 2 overdue · 1 today" },
  { label: "bell", text: "🔔 2 overdue · 1 today" },
  { label: "labelled, spelled out", text: "⚠️ reminders: 2 overdue · 1 today" },
  { label: "all three buckets, words", text: "⚠️ 2 overdue · 1 today · 4 this week" },
];

const KEY = "reminders-probe";

export default function probe(pi: ExtensionAPI): void {
  let index = 0;

  const show = (ctx: ExtensionContext, i: number, announce = true): void => {
    const candidate = CANDIDATES[i];
    ctx.ui.setStatus(KEY, candidate.text);
    if (announce && ctx.hasUI) {
      ctx.ui.notify(`[${i + 1}/${CANDIDATES.length}] ${candidate.label}`, "info");
    }
  };

  // Show candidate 1 as soon as the session exists, so the segment is visible
  // without having to run anything.
  pi.on("session_start", (_event, ctx: ExtensionContext) => {
    show(ctx, index, false);
  });

  registerWidgetProbe(pi);

  pi.registerCommand("rp", {
    description: "Reminder statusline probe: cycle candidate renderings",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const arg = args.trim().toLowerCase();

      if (arg === "off" || arg === "clear") {
        ctx.ui.setStatus(KEY, undefined);
        ctx.ui.notify("probe cleared", "info");
        return;
      }

      if (arg === "list") {
        const lines = CANDIDATES.map((c, i) => `${String(i + 1).padStart(2)}. ${c.text}    — ${c.label}`);
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      const asNumber = Number.parseInt(arg, 10);
      if (Number.isSafeInteger(asNumber) && asNumber >= 1 && asNumber <= CANDIDATES.length) {
        index = asNumber - 1;
      } else {
        index = (index + 1) % CANDIDATES.length;
      }

      show(ctx, index);
    },
  });
}

// ---------------------------------------------------------------------------
// Widget variants
// ---------------------------------------------------------------------------

interface WidgetVariant {
  label: string;
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

const WIDGET_VARIANTS: WidgetVariant[] = [
  {
    label: "below editor, header + 3 reminders",
    placement: "belowEditor",
    lines: [
      "Reminders",
      "  \u26a0\ufe0f call the accountant       2d overdue",
      "  \u2022 renew the domain           today 17:00",
      "  \u2022 Sarah's birthday           Sat",
    ],
  },
  {
    label: "below editor, no header",
    placement: "belowEditor",
    lines: [
      "\u26a0\ufe0f call the accountant       2d overdue",
      "\u2022 renew the domain           today 17:00",
      "\u2022 Sarah's birthday           Sat",
    ],
  },
  {
    label: "below editor, overdue only (1 line)",
    placement: "belowEditor",
    lines: ["\u26a0\ufe0f call the accountant       2d overdue"],
  },
  {
    label: "below editor, single summary line",
    placement: "belowEditor",
    lines: ["\u26a0\ufe0f 2 overdue \u00b7 next: call the accountant"],
  },
  {
    label: "ABOVE editor, header + 3 reminders",
    placement: "aboveEditor",
    lines: [
      "Reminders",
      "  \u26a0\ufe0f call the accountant       2d overdue",
      "  \u2022 renew the domain           today 17:00",
      "  \u2022 Sarah's birthday           Sat",
    ],
  },
  {
    label: "ABOVE editor, single summary line",
    placement: "aboveEditor",
    lines: ["\u26a0\ufe0f 2 overdue \u00b7 next: call the accountant"],
  },
  {
    label: "below editor, busy day (6 reminders)",
    placement: "belowEditor",
    lines: [
      "Reminders",
      "  \u26a0\ufe0f call the accountant       2d overdue",
      "  \u26a0\ufe0f file the VAT return       1d overdue",
      "  \u2022 renew the domain           today 17:00",
      "  \u2022 standup notes              tomorrow 09:00",
      "  \u2022 Sarah's birthday           Sat",
      "  \u2022 quarterly review           next Thu",
    ],
  },
];

const WIDGET_KEY = "reminders-probe-widget";

export function registerWidgetProbe(pi: ExtensionAPI): void {
  let widgetIndex = -1; // -1 = hidden

  pi.registerCommand("rw", {
    description: "Reminder widget probe: cycle widget renderings",
    handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
      const arg = args.trim().toLowerCase();

      if (arg === "off" || arg === "clear") {
        ctx.ui.setWidget(WIDGET_KEY, undefined);
        widgetIndex = -1;
        ctx.ui.notify("widget cleared", "info");
        return;
      }

      if (arg === "list") {
        const lines = WIDGET_VARIANTS.map(
          (v, i) => `${String(i + 1).padStart(2)}. [${v.placement}] ${v.lines.length} line(s) \u2014 ${v.label}`,
        );
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      const asNumber = Number.parseInt(arg, 10);
      if (Number.isSafeInteger(asNumber) && asNumber >= 1 && asNumber <= WIDGET_VARIANTS.length) {
        widgetIndex = asNumber - 1;
      } else {
        widgetIndex = (widgetIndex + 1) % WIDGET_VARIANTS.length;
      }

      const variant = WIDGET_VARIANTS[widgetIndex];
      // Clear first: placement is set at creation, so switching placement needs a
      // fresh widget rather than an in-place update.
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      ctx.ui.setWidget(WIDGET_KEY, variant.lines, { placement: variant.placement });
      ctx.ui.notify(
        `[${widgetIndex + 1}/${WIDGET_VARIANTS.length}] ${variant.label}`,
        "info",
      );
    },
  });
}