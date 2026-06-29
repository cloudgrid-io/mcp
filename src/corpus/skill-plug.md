---
version: 0.2.0
name: plug
description: |
  Deploy a directory or URL to CloudGrid. Use when the user wants to ship, deploy,
  publish, or go live with the current project, or turn a URL into a hosted entity.
  Live in about 30 seconds. Wraps cloudgrid plug.
argument-hint: "[path-or-url]"
allowed-tools: Bash
---

# CloudGrid Plug

Build and deploy a directory, a path, or a URL. Prints the live URL when it is
done. This is the center of the build-and-ship loop. Wraps `cloudgrid plug`.

## Step 0 — Bootstrap

1. If `cloudgrid` is not on `$PATH`: `npm install -g @cloudgrid-io/cli`
2. If `cloudgrid whoami` fails: ask the user to run `cloudgrid login`. Wait for
   confirmation.

## UX rules

- Be concise. No raw IDs, no JSON dumps in chat.
- Detect the user's language from their first message and reply in it. Keep
  technical flags in English.
- The deploy streams build progress. Let it run. Do not interrupt it.

## How to run it

Most of the time, run it from the project directory with no arguments:

```
cloudgrid plug
```

It uses the entity linked to the directory, builds, deploys, and prints the URL.
A first deploy usually takes about 30 seconds; larger builds take longer.

Other shapes:

- **A specific path:** `cloudgrid plug ./site`
- **A URL as an inspiration:** `cloudgrid plug https://example.com`
- **Bind to an existing entity first:** `cloudgrid plug --existing <entity-id>`

If this is the user's first deploy in the org, the CLI may ask which org to use.
Pass `--org <slug>` to skip that prompt.

## After plug

Print the live URL plainly. Then offer the next steps: `cloudgrid:logs` to watch
it, or `cloudgrid:share` to make it reachable by others.

## References

- [./references/options.md](./references/options.md) — flags, URL inspirations, and first-deploy behavior.
