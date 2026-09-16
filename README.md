# @msimon/pi-reminders

Personal date-based reminders for the [Pi](https://pi.dev) coding agent.

Add a reminder with a date and a message; Pi shows what is due in the statusline,
tells you loudly at session start if anything is past due, and keeps nagging
until you clear or snooze it.

> **Status: not implemented yet.** The design is settled in
> [`docs/design.md`](docs/design.md); implementation instructions are in
> [`BUILD.md`](BUILD.md).

## Why not a scheduler

A scheduled task fires and is gone. A reminder is stateful: it has to be
acknowledged, and it should keep bothering you until it is. If you want recurring
shell commands or self-waking prompts, use a scheduler instead.

## Planned surfaces

- **Statusline** — counts of overdue / due today / due this week, hidden when
  empty, with a yellow warning glyph when something is late.
- **Widget** — one line below the editor, only when something is overdue.
- **Desktop notification** — via `cmux notify`, falling back to OSC 777.
- **Session start** — a loud past-due report, capped at five entries.

## Planned commands

| Command | Behaviour |
| --- | --- |
| `/remind <when> [--every <unit>] <message>` | Add a reminder |
| `/reminders` | List and pick |
| `/reminders clear <id>` | Acknowledge |
| `/reminders snooze <id> <duration>` | Snooze |
| `/reminders delete <id>` | Remove |

Plus a `reminder` tool so the agent can add reminders mid-conversation.

## License

MIT
