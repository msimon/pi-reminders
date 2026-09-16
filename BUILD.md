# Build instructions

You are implementing `@msimon/pi-reminders`, a Pi coding-agent extension.

**Read `docs/design.md` first and in full.** It is the specification and it is
settled — every decision in it was argued through and several were reversed after
testing against the real UI. Do not redesign.

If this file and the design doc disagree, follow the design doc so you are not
blocked — but report the disagreement rather than resolving it silently. A
conflict means one of the two is wrong and needs fixing at the source.

## What this is

A personal reminder extension. The user adds a reminder with a date and a
message, and Pi surfaces it when due and keeps nagging until it is cleared.

Not a scheduler, not a job runner. The user already has `pi-cron-jobs` for that
and explicitly rejected a scheduler-shaped solution. The distinguishing property
is that a reminder is **stateful and must be acknowledged**; a scheduled task
fires and is gone.

## Non-negotiables

These are the load-bearing decisions. Breaking one silently breaks the product.

1. **The state file is the only source of truth.** Statusline, widget, toast,
   desktop banner and transcript line are all projections of it. `clear`,
   `snooze` and `delete` mutate the record, never a UI surface. The transcript is
   append-only — nothing is ever "dismissed" from it.
2. **Wall-clock recomputation, never elapsed timers.** macOS suspends
   `setTimeout` across sleep. Every tick, every `session_start`, and every wake
   recomputes state by comparing `Date.now()` against stored timestamps. A
   `setTimeout(45 * 60 * 1000)` armed before the lid closes will not fire 45
   minutes later, and this is the single most likely way to ship something that
   looks right and silently loses reminders.
3. **Atomic write plus compare-and-swap.** Multiple Pi windows share one file.
   Write to a temp file opened `wx`, preserve permission bits, `rename` over the
   target. Mutations re-read and re-hash before writing, retrying up to 5 times.
   No lockfile. See the design doc's Storage section, and copy the pattern from
   `pi-hashline-readmap/src/fs-write.ts:52-95` (reference only — it is not an
   exported subpath, so do not import it).
4. **Fire-once via `firedAt`.** Without it the 60s tick re-notifies every minute.
   `firedAt` is also the cross-window claim: exactly one window sends the desktop
   banner, the rest skip it on their next tick.
5. **No date library, no LLM call inside the extension.** Two input forms:
   absolute (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM`) and offsets (`^(\d+)([mhdw])$`).
   Anything else is rejected with the accepted formats. Natural language is the
   model's job — it resolves before calling the tool.
6. **`allDay` is a flag, not a time convention.** All-day reminders have a
   different fire time and overdue time (09:00 vs 23:59 by default). Collapsing
   them to one timestamp breaks the overdue counter. The design doc explains why
   both `00:00` and `23:59` fail.
7. **Recurrence anchors to the original date, not the ack.** And an unacked
   recurring reminder does not roll — it stays overdue at its original date as a
   single record.

## Implementation order

Build in this order. Each step should be working and committed before the next.

1. **Store** — record shape, atomic write, CAS with retry, derived
   `fireAt`/`overdueAt`, recurrence roll-forward maths, the duration regex.
   Pure functions plus filesystem. **No Pi imports at all in this layer**, so it
   is unit-testable with `node --test` standalone. This is the step where
   correctness matters most; spend the effort here.
2. **Tick and state machine** — 60s interval, fire detection, `firedAt` claim,
   snooze expiry, bucket computation (overdue / today / days 2-7, disjoint).
   `today` runs to local midnight tonight — not a rolling 24h window, so
   something due at 23:30 tonight is `today` and 00:30 tomorrow is not.
3. **Surfaces** — statusline first, then the overdue-only widget line, then the
   TUI toast, then `cmux notify`, then the transcript line.
4. **Commands** — `/remind`, `/reminders` and its subcommands, interactive picker.
5. **Agent tool** — `reminder` with `add | list | clear | snooze | delete`.
6. **Session-start report** — past-due, capped at 5 plus "and N more".

## Verified facts — do not re-derive these

These were established empirically during design. Trust them.

- `ctx.ui.setStatus(key, text)` takes a **plain string**, no colour parameter
  (`core/extensions/types.d.ts:80`). It does render through the user's custom
  pi-footer.
- Colour in the statusline comes from the **glyph, not ANSI**. `⚠️` is `U+26A0`
  + `U+FE0F`; the variation selector selects emoji presentation and renders
  yellow. Bare `U+26A0` renders monochrome grey. Confirmed on the user's setup.
- `ctx.ui.setWidget(key, string[] | undefined, { placement })` — placement is
  fixed at creation. Switching placement requires clear-then-set.
- `cmux notify --title --subtitle --body` exists and works; there is **no `--id`
  or replace flag**. Prefer the CLI over writing raw OSC to `process.stdout`,
  because Pi owns the screen. Fall back to OSC 777 only when `cmux` is absent.
- Pi core emits no OSC notification sequences of its own.
- `ctx.isIdle()` selects whether the transcript line is delivered immediately or
  queued to turn-end.

`docs/statusline-probe.ts` is the throwaway extension used to validate the
statusline and widget renderings (`pi -e docs/statusline-probe.ts`, then `/rp`
and `/rw`). Keep it as a reference for how surfaces are driven; it is not part of
the shipped extension and is excluded from `files` in package.json.

## Testing expectations

- The store layer gets real unit tests: derived times across DST and leap years,
  Feb 29 and Jan 31 recurrence, CAS retry under a simulated concurrent write,
  atomic write leaving no orphan temp on failure, corrupt-file recovery.
- Duration and date parsing get table-driven tests including rejection cases.
- Bucket computation gets tests, particularly the disjointness of `today` and
  `this week`.
- Do not write tests that assert on Pi UI internals. Surfaces are thin by design;
  keep the logic in the testable layer.

## Style

- TypeScript, ESM, `node --experimental-strip-types` compatible. No build step —
  Pi loads `.ts` directly.
- Match the conventions in the user's other extensions (`pi-cron-jobs`,
  `pi-context-loadout`) where they apply.
- Zero runtime dependencies. Pi packages are peer dependencies and optional.
- Small modules, named exports, no default-export grab bags except the extension
  entry point itself.

## Open items for the implementer

These were deliberately left to implementation:

- Short-hash ID generation: pick something stable and collision-resistant enough
  for a personal file, and make it readable (3-4 hex chars is the intent).
- The interactive picker's exact UI. `ctx.ui` capabilities determine what is
  possible; check what other extensions do before inventing.
- Whether config is watched for changes or read once per session. Read-once is
  acceptable for v1; note it in the README either way.

## Definition of done

- All six steps implemented and committed separately.
- `npm test` passes and covers the store layer meaningfully.
- README documents install, commands, config keys, and the pi-footer placement
  snippet (see the design doc's statusline section — the user wants the segment
  positioned on the left, which is done via an `external-status` widget with
  `externalStatusKey: "reminders"` plus adding that key to
  `extensionStatusRow.hiddenKeys`).
- The extension loads cleanly with `pi -e src/index.ts` and does nothing
  surprising when the state file does not yet exist.
