---
version: 0.2.0
name: brain
description: |
  Refresh a CloudGrid entity's Grid Brain metadata. Use when the user wants to
  re-classify an entity, regenerate its description, tags, or diagram, or update
  how it appears in discovery after a change. Wraps grid brain refresh.
argument-hint: "[name]"
allowed-tools: Bash
---

# CloudGrid Brain

Re-run the Grid Brain hooks for an entity to re-classify its description, tags, and
diagram. Use this after a change so discovery reflects the current state. Wraps
`grid brain refresh`.

## Step 0 — Bootstrap

1. If `cloudgrid` is not on `$PATH`: `npm install -g @cloudgrid-io/cli`
2. If `grid whoami` fails: ask the user to run `grid login`. Wait for
   confirmation.

## UX rules

- Be concise. Report what changed, not the full hook trace.
- Detect the user's language from their first message and reply in it. Keep
  technical flags in English.

## How to run it

```
grid brain refresh my-thing --wait
```

`--wait` polls until the refresh finishes, up to about 60 seconds. Without it, the
refresh runs in the background and the command returns right away. Use `--wait`
when the user wants to see the result now.

Other flags:

- `--org <slug>` — target an entity in another org.
- `--json` — machine-readable output.

## Reading the output

The refresh reports each hook: classify (description and tags), identification, and
the diagram. Summarize the outcome in one line, for example "Re-classified with 3
tags." Suggest `grid status <name>` if the user wants the full updated entity.
