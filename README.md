# @msimon/pi-reminders

Personal date-based reminders for the [Pi](https://pi.dev) coding agent.

Add a reminder with a date and a message; Pi shows what is due in the statusline,
tells you loudly at session start if anything is past due, and keeps nagging
until you clear or snooze it.

## Why not a scheduler

A scheduled task fires and is gone. A reminder is **stateful**: it has to be
acknowledged, and it should keep bothering you until it is. If you want recurring
shell commands or self-waking prompts, use a scheduler (`pi-cron-jobs`) instead.

## Install

Add to the `packages` array in `~/.pi/agent/settings.json`:

```json
{
  "packages": ["@msimon/pi-reminders"]
}
```

Or run it straight from a clone:

```sh
pi -e /path/to/pi-reminders/src/index.ts
```

No build step — Pi loads the TypeScript directly. Zero runtime dependencies.

## Commands

| Command | Behaviour |
| --- | --- |
| `/remind <when> [--every <unit>] <message>` | Add. Echoes back the resolved time. |
| `/reminders` | Interactive picker: choose a reminder, then clear / snooze / delete. |
| `/reminders list` | Grouped list: overdue, today, this week, later. |
| `/reminders all` | As above, plus recently cleared. |
| `/reminders clear <id>` | Acknowledge. Recurring reminders roll to the next occurrence. |
| `/reminders snooze <id> <duration>` | Snooze. Also `--until <date>`. |
| `/reminders delete <id>` | Remove entirely. Confirms first. |

Ids are short hex (`a3f`). Any unique prefix works, so `/reminders clear a` is
usually enough.

### Date formats

Two accepted forms, and anything else is rejected with these listed:

- **Absolute** — `2026-01-20` (all-day) or `2026-01-20 09:00` (timed). The
  presence of a time component is what sets all-day; there is no flag to pass.
- **Relative offset** — `<N><m|h|d|w>`: `45m`, `3h`, `2d`, `1w`. Always timed.

There is deliberately no date library. `chrono-node` would be 2.76 MB for
ambiguity nobody wants — is "next week" next Monday, or seven days out? Natural
language goes through the agent instead (see below), which resolves it to an
absolute timestamp before calling. Whatever you type, the resolved time is
echoed back.

```sh
/remind 2h take a break
/remind 2026-01-20 09:00 send the invoice
/remind 2026-03-14 --every year Sarah's birthday
/remind 2026-01-31 --every month reconcile invoices
```

### Recurrence

`--every day|week|month|year`. The date is the **first** occurrence.

Rolling forward is anchored to the original date, not to when you acknowledged
it — ack a birthday three days late and the next occurrence is still March 14,
not March 17. Drift would compound over years otherwise.

| Anchor | Rule |
| --- | --- |
| Feb 29, yearly | Feb 28 in non-leap years; returns to Feb 29 on the next leap year |
| Jan 31, monthly | Last day of shorter months (Feb 28/29, Apr 30); never spills into the next month |
| Weekly | Same weekday at the same wall-clock time, across DST |

An unacked recurring reminder **does not roll**. If you never clear the
birthday, it stays overdue at its original date as a single record rather than
silently skipping to next year. Rolling happens on ack, and only on ack.

## Natural language, via the agent

The extension also registers a `reminder` tool (`add | list | clear | snooze |
delete`), which is the higher-value path: "remind me to follow up on this next
Tuesday" mid-conversation, without breaking flow. The model resolves the date to
an absolute local timestamp and calls the tool. Reads work too, so "what's on my
plate?" does the right thing.

## Surfaces

| Surface | When |
| --- | --- |
| Statusline | Every tick. Hidden when nothing is due. |
| Widget | One line below the editor, **only** when something is overdue. |
| TUI toast | When a reminder fires. |
| Desktop banner | When a reminder fires, via `cmux notify` (falls back to OSC 777). |
| Transcript line | When a reminder fires; deferred to turn end if the agent is mid-work. |

The statusline omits empty buckets rather than showing zeros, and the warning
glyph appears only when something is actually late, so its presence is itself
the signal:

```text
⚠️ 2 overdue · 1 today         ← something is late
1 today · 4 this week          ← nothing late, no icon
4 this week                    ← nothing sooner
(hidden)                       ← nothing at all
```

Buckets are disjoint: `today` runs to local midnight tonight, and `this week`
means days 2-7 and excludes what `today` already counts.

### Statusline placement in pi-footer

The extension only calls `setStatus("reminders", text)`; where that lands is
pi-footer's job. To position it on the left, add a widget to
`~/.pi/agent/extensions/pi-footer.json` at the desired point in the `lines`
array:

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

Then add `"reminders"` to `extensionStatusRow.hiddenKeys`, or it renders twice —
once in your chosen position and once in the auto-generated status row
underneath. `hideWhenEmpty` matters because the segment is empty whenever
nothing is due.

## Configuration

`~/.pi/agent/state/reminders/config.json`. Missing file means defaults; an
invalid value falls back to its default rather than failing the session.

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

| Key | Default | Meaning |
| --- | --- | --- |
| `allDayFireHour` | `9` | Local hour (0-23) at which all-day reminders nag. |
| `statuslineStyle` | `"words"` | `words` omits empty buckets; `compact` shows all three positions (`0/1/4`). |
| `statuslinePrefix` | `""` | Label before the counts, e.g. `"reminders:"`. Empty omits it and its space. |
| `tickIntervalSeconds` | `60` | Recompute cadence. Minimum 5. |
| `startupReportLimit` | `5` | Max past-due entries listed at session start. |
| `desktopNotifications` | `true` | Send `cmux notify` banners. |

**Config is read once per session.** Editing it takes effect on the next Pi
start. `allDayFireHour` is applied to derived state rather than stored on
records, so changing it re-derives every all-day reminder with nothing to
migrate.

## How it behaves

- **All-day vs timed.** An all-day reminder nags in the morning and only counts
  as overdue the next day, so "fill in the form on Jan 15" does not pollute the
  overdue counter all day on the 15th.
- **Laptop asleep across a due time.** State is recomputed from the wall clock
  on every tick and at session start, never from elapsed timers, so the reminder
  fires on the next tick marked late rather than being silently skipped.
- **Pi closed when something came due.** It surfaces at the next session start.
  There is no phone sync; that is an accepted tradeoff.
- **Multiple Pi windows.** All windows show the statusline and transcript line;
  exactly one sends the desktop banner. Acks are global — clearing in one window
  drops out of the others within a tick.
- **Past-due nagging.** Past-due reminders re-report at every session start
  until cleared, snoozed or deleted. Snooze is the pressure valve.
- **Corrupt state file.** Moved aside with a warning and treated as empty;
  never crashes the session.

## Storage

`~/.pi/agent/state/reminders/reminders.json` — global, not per-project. `cwd` is
captured on each record as context, never as a filter.

Writes are atomic (temp file + rename) and mutations use compare-and-swap with
retry, so concurrent windows cannot corrupt the file or silently lose a write.
There is no lockfile. If CAS retries are exhausted you get an explicit error
rather than a dropped reminder.

Cleared one-off reminders are kept as history (visible via `/reminders all`) and
are not pruned. `delete` is the only operation that removes a record.

Set `PI_REMINDERS_DIR` to relocate both files; the test suite uses it.

## Development

```sh
npm install
npm test          # node --test, TZ-pinned to Europe/London
npm run typecheck
```

`src/core/` has no Pi imports at all, so the whole state layer — derived times,
recurrence, buckets, parsing, storage — is unit-testable standalone. Tests cover
DST and leap-year derivation, Feb 29 and Jan 31 recurrence, bucket disjointness,
CAS retry under a simulated concurrent write, and corrupt-file recovery.

`docs/design.md` is the specification. `docs/statusline-probe.ts` is the
throwaway extension used to validate the statusline and widget renderings; it is
not part of the shipped package.

## License

MIT
