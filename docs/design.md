# pi-reminders — design

A personal reminder extension for pi. You add a reminder with a date and a message;
pi surfaces it when it comes due and keeps nagging until you act on it.

Status: design draft, not implemented.

## Goals

- Add a reminder from inside pi with a precise date and a message.
- See at a glance what is overdue and what is coming.
- Get told when something comes due, in pi and on the desktop.
- Be told loudly at session start if anything is past due.
- List, select, clear, snooze, delete.

## Non-goals

- Syncing to phone. If pi is closed when something comes due, it surfaces at the
  next session start. That is an accepted tradeoff.
- Project or session scoping. Reminders are personal and global; `cwd` is captured
  as context only, never as a filter.
- Apple Reminders as a backend. Possible one-way mirror later, out of scope for v1.

## Core model

The reminder record in the state file is the single source of truth. Every surface
(statusline, toast, desktop banner, transcript line) is a projection of it, and
every mutation (`clear`, `snooze`, `delete`) acts on the record. Nothing is ever
"dismissed" at the UI layer.

State machine:

```text
pending ──(fireAt reached)──> fired ──┬──> acked      (cleared)
                                      ├──> snoozed ──> pending
                                      └──> deleted
```

Recurring reminders return to `pending` on ack, with `fireAt` recomputed from the
original anchor date. They do not roll while unacked.

### Record

```ts
interface Reminder {
  id: string;              // short hash, e.g. "a3f" — stable, shown in list output
  message: string;
  allDay: boolean;
  dueAt: string;           // ISO 8601, UTC
  recurrence?: "day" | "week" | "month" | "year";  // matches --every <unit>
  createdAt: string;       // ISO, UTC
  cwd: string;             // captured at creation, shown in list
  firedAt?: string;        // set on first fire — the cross-window claim
  snoozedUntil?: string;   // ISO, UTC
  ackedAt?: string;        // set on clear; recurring reminders reset instead
}
```

### Derived times

The reason `allDay` is a flag and not a convention about the time component: for an
all-day item, *when it should nag you* and *when it becomes late* are different
instants. A single timestamp cannot express both.

| | `fireAt` | `overdueAt` |
| --- | --- | --- |
| `allDay: true` | `dueAt` date at 09:00 local (configurable) | `dueAt` date at 23:59 local |
| `allDay: false` | `dueAt` | `dueAt` |

Consequence: "fill in the form on Jan 15" nags on the morning of the 15th and only
counts as overdue on the 16th. It does not pollute the overdue counter all day.

Display follows the same flag: `Jan 15` vs `Jan 15 14:00`.

All timestamps stored UTC, rendered local. Recurrence and the all-day 09:00/23:59
derivation are computed in local time so a DST shift or travel does not slide a
birthday onto the wrong calendar day.

## Configuration

`~/.pi/agent/state/reminders/config.json`, separate from the state file so a
config edit can never corrupt reminder data and vice versa. Missing file means
defaults; unreadable file means defaults plus a one-time warning.

```json
{
  "allDayFireHour": 9,
  "statuslineStyle": "words",
  "statuslinePrefix": "",
  "tickIntervalSeconds": 60,
  "startupReportLimit": 5,
  "desktopNotifications": true
}
```

`allDayFireHour` is local-time, 0-23. Changing it re-derives `fireAt` for every
all-day reminder on the next tick — the value is derived, never persisted on the
record, so there is nothing to migrate.

## Storage and concurrency

Single file: `~/.pi/agent/state/reminders/reminders.json`. Global, not per-project.

Multiple pi windows read and write it concurrently. Two mechanisms, no lockfile:

**Atomic write.** Write to `.tmp-<uuid>` opened `wx`, preserve the target's
permission bits, `rename` over the target. Prevents a reader from seeing a
half-written file. Pattern copied from `pi-hashline-readmap/src/fs-write.ts:52-95`
(which also handles the `nlink > 1` hardlink case by writing in place).

**Compare-and-swap on mutation.** The dangerous window is not the write, it is the
seconds between read and write while the user is typing. CAS collapses it to
microseconds:

```text
read file -> content, hash
mutate in memory
re-read file, re-hash
  unchanged -> atomic write
  changed   -> re-read, re-apply the mutation, retry (max 5, then surface an error)
```

A theoretical race remains between the verify and the rename. For a personal
reminder file written by a handful of windows, that window is microseconds and not
worth a lockfile plus stale-lock recovery on SIGKILL.

Note: `pi-hashline-readmap`'s anchor mechanism does not apply here. It guards the
*agent's* `edit` tool against stale reads; extension runtime writes never pass
through it, and `writeFileAtomically` is not an exported subpath. The code is a
reference to copy, not a dependency.

## Timing

A 60s `setInterval` tick. Every tick recomputes state by comparing **wall clock**
(`Date.now()`) against `fireAt` / `overdueAt` / `snoozedUntil`.

Never rely on elapsed timers: macOS suspends `setTimeout` across sleep, so a timer
armed for 45 minutes before the lid closes does not fire 45 minutes later.
Recomputing from wall clock on every tick, on `session_start`, and on wake is
inherently sleep-safe.

Ticks also re-read the state file, which is what makes cross-window convergence
work: clearing in window A drops out of window B's statusline within 60s.

### Fire-once

`firedAt` is persisted on first fire. Without it the tick re-notifies every 60s
until acked. Re-firing is driven by policy, not by the tick:

- Session start while past due and not snoozed
- Snooze expiry

## Surfaces

Four surfaces, three different timings.

| Surface | Timing | Notes |
| --- | --- | --- |
| Statusline | Tick, immediate | `ctx.ui.setStatus` — safe anytime, never interrupts |
| Desktop banner | Tick, immediate | `cmux notify` subprocess — does not touch pi's screen |
| TUI toast | Tick, immediate | `ctx.ui.notify` — transient overlay |
| Transcript line | Immediate if `ctx.isIdle()`, else queued to turn-end | Appending mid-turn renders in a confusing position |

In the common case (idle, reading something) all four fire together. The turn-end
deferral only applies when the agent happens to be mid-work.

### Statusline

`2/1/4` is compact but cryptic — you have to remember the bucket order to read it.
Default is words, with **empty buckets omitted entirely** rather than shown as
zeros:

```text
⚠️ 2 overdue · 1 today         ← something is late
1 today · 4 this week          ← nothing late, no icon
4 this week                   ← nothing sooner
(hidden)                      ← nothing at all
```

Omitting zeros is most of the clarity win: `0/1/1` never appears, so there is no
ambiguity about whether the last number includes the middle one. Buckets stay
disjoint — `this week` means days 2-7 and excludes what is already counted in
`today`.

No icon in the normal case. The icon appears only when something is late, so its
presence is itself the signal rather than decoration you learn to skim past.

### Colour

`setStatus(key, text)` takes a plain string and has no colour parameter
(`core/extensions/types.d.ts:80`). The other route, `setFooter()`, does give real
theming but replaces the entire footer, which would collide with pi-footer.

Colour therefore comes from the **glyph, not from ANSI**: `⚠️` is `U+26A0` plus
the variation selector `U+FE0F`, which selects emoji presentation and renders as
the yellow triangle from the font. Bare `U+26A0` is the text presentation and
renders monochrome — that is why it looked grey.

Same mechanism as the coloured `⏰` already in the statusline from pi-cron-jobs.
No ANSI passthrough to verify, no theme dependency.

**Verified empirically** with a throwaway probe extension
(`/tmp/reminders-statusline-probe.ts`, `pi -e <path>`): `setStatus` does render
through the custom pi-footer, and `⚠️` shows yellow beside the existing
`⏰ jobs: 3` segment. Both assumptions this section rested on are confirmed.

Note that emoji are double-width; the compact style accounts for that.

### Position in the footer

The extension cannot choose where its segment lands — it only calls
`setStatus("reminders", text)`. Placement is pi-footer's job, and it is fully
controllable: pi-footer has an `external-status` widget type keyed by
`externalStatusKey` (the existing `usage` and `hindsight` segments work this way).

To place reminders on the left, add a widget to `~/.pi/agent/extensions/pi-footer.json`
at the desired position in the `lines` array:

```json
{
  "id": "reminders-status",
  "type": "external-status",
  "enabled": true,
  "options": {
    "raw": true,
    "hideWhenEmpty": true,
    "externalStatusKey": "reminders",
    "fg": "default",
    "bg": "default",
    "bold": false
  }
}
```

Then add `"reminders"` to `extensionStatusRow.hiddenKeys` so it does not *also*
appear in the auto-generated status row underneath. Without that it renders
twice.

`hideWhenEmpty: true` matters here: the segment is empty whenever there is
nothing due, and the design already hides it in that case.

This belongs in the README as a copy-paste snippet, not in the extension —
writing to another extension's config file would be overreach.

### Prefix and style

Both are configurable, because the right label depends on what else is in your
footer — you already run pi-footer, pi-usage, pi-spend and pi-cron-jobs up there.

The rendering is `[⚠️ if overdue] [prefix] [body]`, where an empty prefix is
omitted along with its space:

| `statuslinePrefix` | `statuslineStyle` | Result |
| --- | --- | --- |
| `"Reminders:"` | `compact` | `Reminders: 2/1/4` |
| `"reminders:"` | `words` | `⚠️ reminders: 2 overdue · 1 today` |
| `"rem"` | `compact` | `⚠️ rem 2/1/4` |
| `""` | `words` | `⚠️ 2 overdue · 1 today` |
| `""` | `compact` | `⚠️ 2/1/4` |

The two styles differ in how they treat zeros, and that difference is deliberate:

- **`words`** omits empty buckets entirely. `1 today · 4 this week` when nothing
  is late; the bucket is named, so dropping it loses nothing.
- **`compact`** always shows all three positions, including zeros: `0/1/4`.
  Positional notation only works if the positions are fixed — omitting a zero
  would silently shift the meaning of the remaining numbers.

### Widget — overdue only, single line

A widget in pi is a keyed block of lines an extension owns, rendered directly
above or below the input editor. It updates in place rather than scrolling away
like a message, and persists until cleared:

```ts
setWidget(key, content: string[] | undefined, { placement: "aboveEditor" | "belowEditor" })
setWidget(key, (tui: TUI, theme: Theme) => Component, options)   // second overload
```

One line, below the editor, **rendered only when something is overdue**:

```text
⚠️ 2 overdue · next: call the accountant
```

The multi-line box was rejected after seeing it live: a persistent list is loud
for something usually empty, and a busy week pushes the editor down the screen.
The single line costs one row and only appears when there is something genuinely
late, so its presence is the signal.

Hidden entirely when nothing is overdue — not shown empty, not shown for merely
upcoming reminders. Those live in the statusline, which is already glanceable.

The second overload takes a component factory receiving `Theme`, so the widget
can be properly themed later — unlike the statusline, which is a plain string.
v1 uses the plain `string[]` form.

### Desktop banner

`cmux notify --title "Reminder" --body "<message>"`, optionally with
`--workspace`/`--surface` so clicking the entry in cmux's panel jumps back to the
pi workspace that raised it.

Fallback when `cmux` is not on PATH: OSC 777 to stdout,
`\x1b]777;notify;<title>;<body>\x07`.

Two verified constraints:

- pi core emits no OSC notification sequences of its own. `ctx.ui.notify` draws an
  in-TUI toast and nothing else. The notification has to be sent explicitly.
- `cmux notify` has no `--id` or replace flag. Banner replacement is only reachable
  via raw OSC 99 and is unverified. Not needed: fire-once plus the cross-window
  claim means one banner per fire.

Prefer the CLI over writing raw escapes to `process.stdout` — pi owns the screen,
and a subprocess cannot corrupt the render.

### Cross-window behaviour

All windows show the transcript line and the statusline. Exactly one sends the
desktop banner: the `firedAt` CAS write is the claim, and whichever window lands it
first sends. The others see `firedAt` on their next tick and skip.

Acks are global — clearing anywhere clears everywhere, within one tick.

## Session start

On `session_start`, after recomputing state: if anything is past due and not
snoozed, report loudly, in the same register as a failed job.

Cap at 5 entries plus `...and N more — /reminders`. Twelve past-due items must not
produce twelve lines.

Past-due reminders re-fire at every session start until snoozed, cleared, or
deleted. That is the intended nagging behaviour; snooze is the pressure valve that
keeps it tolerable rather than something you train yourself to ignore.

## Commands and tool

Slash commands (human entrypoint):

| Command | Behaviour |
| --- | --- |
| `/remind <when> [--every <unit>] <message>` | Add. Absolute, relative, or natural language. Echoes back the resolved time. |
| `/reminders` | List, grouped overdue / today / upcoming. Interactive picker with no args. |
| `/reminders clear <id>` | Ack. Recurring reminders roll to the next occurrence. |
| `/reminders snooze <id> <duration>` | Relative (`45m`, `3h`, `2d`) or `--until <date>`. |
| `/reminders delete <id>` | Remove entirely. Confirms. |

Canonical date format: `YYYY-MM-DD` (all-day) or `YYYY-MM-DD HH:MM` (timed). The
presence of a time component is what sets `allDay` — no separate flag to pass.
Relative offsets are always timed. See Relative dates below for the other accepted
forms; whatever you type, the resolved absolute timestamp is echoed back.

### Recurrence

The date is the **first occurrence**; `--every` makes it repeat from there.

```sh
/remind 2026-03-14 --every year  Sarah's birthday
/remind 2026-01-05 09:00 --every week  submit timesheet
/remind 2026-01-31 --every month  reconcile invoices
```

Units: `day`, `week`, `month`, `year`. The agent tool takes the same value as a
`recurrence` field.

Rolling forward is **anchored to the original date, not to when you acked it**.
Ack a birthday three days late and the next occurrence is still March 14, not
March 17. Drift would compound over years otherwise.

Calendar edge cases, specified rather than discovered later:

| Anchor | Rule |
| --- | --- |
| Feb 29, yearly | Feb 28 in non-leap years; returns to Feb 29 on the next leap year |
| Jan 31, monthly | Last day of shorter months (Feb 28/29, Apr 30); never spills into the next month |
| Weekly | Same weekday, DST-safe because derivation is local-time |

**An unacked recurring reminder does not roll.** If you never clear the birthday,
it stays overdue at its original date rather than silently skipping to next year.
One record, one overdue entry — it does not stack N occurrences. Rolling forward
happens on ack, and only on ack.

### Natural language

Agent tool `reminder`, actions `add | list | clear | snooze | delete`. This is the
higher-value path: "remind me to follow up on this next Tuesday" mid-conversation,
without breaking flow. **The model resolves natural language to an absolute
timestamp before calling.** The extension itself never parses relative dates and
never makes an LLM call — it is a pure state machine over absolute times.

### Relative dates and snooze durations

Two accepted forms, used by both `add` and `snooze`:

**Absolute** — `2026-01-20 09:00` or `2026-01-20`. The presence of a time sets
`allDay`.

**Relative offset** — `<N><m|h|d|w>`: `45m`, `3h`, `2d`, `1w`. A single regex,
`^(\d+)([mhdw])$`. Always timed. This covers the common case for both commands —
`/remind 2h take a break` is far nicer than typing a timestamp.

Anything else is **rejected with the two accepted formats**, never guessed at. No
date library: `chrono-node` would be 2.76 MB for ambiguity we do not want
("next week" — next Monday, or seven days out?). Rejecting is honest and cheap.

Whatever is typed, the resolved absolute timestamp is echoed back on success.

Natural language is still fully available — through the agent, not the parser.
"remind me next tuesday at 3 to call Sarah" has the model resolve the date and
call the tool with an absolute timestamp. The tool contract is absolute-only, so
the extension stays a pure state machine with zero dependencies.

Reads are allowed for the agent too, so "what's on my plate" works.

## Edge cases

- **Laptop asleep across `fireAt`** — recompute from wall clock on wake; the
  reminder fires on the next tick, marked late rather than silently skipped.
- **Timezone change while travelling** — UTC storage, local rendering; all-day
  derivation recomputed against the current zone.
- **Recurrence with a missed occurrence** — an unacked recurring reminder stays on
  its original date as a single overdue entry. It never rolls past an unacked
  occurrence, so N missed years produce one record, not N.
- **Clock moved backwards** — `firedAt` already set prevents a double fire.
- **Corrupt or missing state file** — treat as empty, back up the unreadable file
  alongside, warn once. Never crash the session.
- **CAS retry exhaustion** — surface an explicit error. A silently dropped add is
  the one failure mode that destroys trust in the whole thing.

## Implementation order

1. Store: record shape, atomic write, CAS with retry, derived-time computation.
   Unit-testable with no pi dependency.
2. Tick and state machine: fire detection, `firedAt` claim, snooze expiry,
   recurrence roll-forward.
3. Surfaces: statusline, then the overdue-only widget line, then toast, then
   `cmux notify`, then transcript line.
4. Commands and picker.
5. Agent tool.
6. Session-start report.

## Decisions

- **Standalone repo**, not `~/.pi/agent/extensions/`. Loaded via the `packages`
  array in `settings.json`, same as `pi-cron-jobs`. GitHub topics: `ops` + `perso`.
  Note: the npm name `pi-reminders` is already taken by an unrelated Apple
  Reminders extension — publishing needs a different name (`pi-remind`, or scoped
  `@msimon/pi-reminders`).
- **All-day fire hour is configurable**, see Configuration.
- **No date library and no LLM call inside the extension.** Two input forms only:
  absolute timestamps and `<N><m|h|d|w>` offsets. Anything else is rejected with
  the accepted formats. Natural language goes through the agent, which resolves it
  to an absolute timestamp before calling the tool — so the state machine has zero
  dependencies and no network round-trip.
- **Widget is one line, overdue only.** The multi-line box was rejected after
  seeing it live. A single line below the editor, hidden unless something is
  actually late.
- **Statusline prefix and style are both configurable.** Empty prefix by default;
  `words` omits zero buckets, `compact` keeps all three positions.
