---
version: 0.2.0
name: init
description: |
  Scaffold a new CloudGrid app or agent. Use when the user wants to start a new
  project, set up a new app or agent, or seed a web service
  (node, nextjs, python, or static) before deploying. Wraps grid new.
argument-hint: "[name] [--agent]"
allowed-tools: Bash
---

# CloudGrid Init

Scaffold a new app or agent project and, optionally, seed a web service to
deploy. Wraps `grid new`. Scaffolding is local-only — no server entity exists
until the first `grid plug`, which auto-creates it from `cloudgrid.yaml`. After
this, `cloudgrid:plug` deploys it.

## Step 0 — Bootstrap

1. If `grid` is not on `$PATH`: `npm install -g @cloudgrid-io/cli`
2. If `grid whoami` fails: ask the user to run `grid login`. Wait for
   confirmation.

## UX rules

- Be concise. No raw IDs, no JSON dumps in chat.
- Detect the user's language from their first message and reply in it. Keep
  technical flags in English.
- Pick sane defaults. Ask one thing at a time, only when something is missing.

## What to ask

You need two things: the kind and the name.

- **Kind:** `app` or `agent`. Default to `app` unless the user describes an agent
  (something that acts on its own, calls tools, or runs on a schedule). For an
  agent, pass `--agent` (an app with an `agent:` block is an agent).
- **Name:** a slug, 3 to 40 lowercase letters, numbers, or hyphens. If the user
  gives a title, derive a slug from it. Confirm the slug before running.

Optional, only if the user implies them:

- `--type` to seed a web service: `node`, `nextjs`, `python`, or `static`.
- `--dir <path>` to scaffold somewhere other than the current directory.
- `--needs <list>` to pre-declare resources (e.g. `database,cache`).

## Usage

Scaffold an app in the current directory and seed a static site:

```
grid new my-thing --type static
```

Scaffold an agent:

```
grid new my-helper --agent
```

Scaffold without seeding any files (you will add your own):

```
grid new my-thing
```

## After scaffolding

Tell the user the project is set up and what is next: run `grid plug` to deploy —
the first plug creates the entity from `cloudgrid.yaml` and takes it live. Hand
off to `cloudgrid:plug`.

## References

- [./references/options.md](./references/options.md) — full flag list and the four service types.
