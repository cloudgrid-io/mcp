---
version: 0.2.0
name: init
description: |
  Scaffold a new CloudGrid app or agent. Use when the user wants to start a new
  project, create a new entity, set up a new app or agent, or seed a web service
  (node, nextjs, python, or static) before deploying. Wraps cloudgrid init.
argument-hint: "[app|agent] [name]"
allowed-tools: Bash
---

# CloudGrid Init

Register a new app or agent in the active org and, optionally, seed a web service
to deploy. Wraps `cloudgrid init`. After this, `cloudgrid:plug` deploys it.

## Step 0 — Bootstrap

1. If `cloudgrid` is not on `$PATH`: `npm install -g @cloudgrid-io/cli`
2. If `cloudgrid whoami` fails: ask the user to run `cloudgrid login`. Wait for
   confirmation.

## UX rules

- Be concise. No raw IDs, no JSON dumps in chat.
- Detect the user's language from their first message and reply in it. Keep
  technical flags in English.
- Pick sane defaults. Ask one thing at a time, only when something is missing.

## What to ask

You need two things: the kind and the name.

- **Kind:** `app` or `agent`. Default to `app` unless the user describes an agent
  (something that acts on its own, calls tools, or runs on a schedule).
- **Name:** a slug, 3 to 40 lowercase letters, numbers, or hyphens. If the user
  gives a title, derive a slug from it. Confirm the slug before running.

Optional, only if the user implies them:

- `--type` to seed a web service: `node`, `nextjs`, `python`, or `static`.
- `--dir` to scaffold somewhere other than `./<name>`.
- `--description` for a one-line description.

## Usage

Register an app and seed a static site:

```
cloudgrid init app my-thing --type static
```

Register an agent:

```
cloudgrid init agent my-helper
```

Register without seeding any files (you will add your own):

```
cloudgrid init app my-thing
```

## After init

Tell the user the entity is registered and what is next: `cd` into the directory
(if seeded) and run `cloudgrid plug` to deploy. Hand off to `cloudgrid:plug`.

## References

- [./references/options.md](./references/options.md) — full flag list and the four service types.
