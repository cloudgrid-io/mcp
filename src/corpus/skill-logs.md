---
version: 0.2.0
name: logs
description: |
  Tail logs for a CloudGrid entity. Use when the user wants to see logs, watch
  output, follow a running app, debug a deploy, or check why something is failing.
  Wraps grid logs.
argument-hint: "[name]"
allowed-tools: Bash
---

# CloudGrid Logs

Stream or tail logs from an entity's pods. Wraps `grid logs`.

## Step 0 — Bootstrap

1. If `cloudgrid` is not on `$PATH`: `npm install -g @cloudgrid-io/cli`
2. If `grid whoami` fails: ask the user to run `grid login`. Wait for
   confirmation.

## UX rules

- Be concise. Show the relevant lines, not the whole buffer.
- Detect the user's language from their first message and reply in it. Keep
  technical flags and log output in their original form.

## How to run it

Tail the recent logs for an entity by name:

```
grid logs my-thing
```

With no name, it uses the entity linked to the current directory.

Useful flags:

- `--tail <n>` — number of recent lines. Default 100.
- `--since <duration>` — only logs newer than this, for example `5m`, `1h`, `2d`.
- `--follow` — stream continuously.

Use `--follow` only when the user asks to watch live. It does not return on its
own, so do not use it for a one-time check. For a quick look, use `--tail` or
`--since` instead.

## Reading the output

If the user is debugging, summarize what the logs show: the error, the failing
request, or that the service is healthy. Quote the key lines. Do not paste pages
of output into chat.
