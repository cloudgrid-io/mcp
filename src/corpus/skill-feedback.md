---
version: 0.2.0
name: feedback
description: |
  Read the CloudGrid feedback feed. Use when the user wants to see feedback, check
  what people said, review reactions, or read recent feedback events for their org.
  Wraps grid feedback list.
argument-hint: "[--since 7d]"
allowed-tools: Bash
---

# CloudGrid Feedback

List recent feedback events for the active org. Wraps `grid feedback list`.

## Step 0 — Bootstrap

1. If `cloudgrid` is not on `$PATH`: `npm install -g @cloudgrid-io/cli`
2. If `grid whoami` fails: ask the user to run `grid login`. Wait for
   confirmation.

## UX rules

- Be concise. Summarize the feed; do not paste every event verbatim.
- Detect the user's language from their first message and reply in it. Keep
  technical flags in English.

## How to run it

```
grid feedback list
```

The feed is scoped to the active org. It is not filtered by entity. Useful flags:

- `--since <duration>` — only events newer than this, for example `24h`, `7d`.
- `--limit <n>` — number of events. Default 50, max 200.
- `--org <slug>` — read another org's feed (where you have access).

## Reading the output

Each event has a time, an id, an org, and a message. Group or summarize by theme
when there are many. Surface the ones that look like bugs or blockers first.

## Note: reading vs sending

This skill reads the feed. `grid feedback "<message>"` does the opposite: it
sends feedback to the CloudGrid team. Do not send feedback unless the user clearly
asks to report something.
