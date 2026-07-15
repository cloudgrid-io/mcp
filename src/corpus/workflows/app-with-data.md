---
name: app-with-data
when: to-do, task list, notes app, guestbook, CRUD app, form that SAVES/STORES submissions, anything that SAVES or PERSISTS data or shares state across users/sessions, sign-in/accounts, a backend/API/database — e.g. a to-do list, a CRUD dashboard, a form that stores entries, a guestbook. Needs a database → runtime → local edition.
needs: database
deploy: runtime
editions: local
capabilities_note: persistent — needs a database (Mongo). Runtime app, async build, local edition only. Declare the canonical `needs: { database: true }`; the deployer injects DATABASE_MONGODB_URL (+legacy MONGODB_URL).
summary: Build a real persistent Next.js + Mongo runtime app on the grid — edition-gate first, scaffold, put the app under services/web/, wire process.env.DATABASE_MONGODB_URL (legacy MONGODB_URL fallback) lazily, declare needs:{database:true} (not requires:), deploy async, poll to a live URL.
---

# Workflow: app-with-data

The user wants an app that actually **remembers** things — a to-do list that
survives a refresh, a form whose submissions are stored, a dashboard whose data
sticks, anything with accounts or shared state. That is NOT a static page: it is
a **runtime app** backed by the grid's shared Mongo (and optionally Redis). A
static template keeps state only in memory and loses it on refresh.

Follow this recipe. Be honest that a runtime deploy is async (not instant like a
static drop) and that it needs the local edition.

## 1. Edition check FIRST (hard gate)

A persistent app is a built + deployed container. It requires the **local
edition** (Claude Desktop / Claude Code) or the CLI, because the grid must run
the CLI and folder-plug your project.

- **Hosted edition (Claude Web / hosted MCP):** you CANNOT build a runtime app —
  hosted is inline-only and can only publish static pages. Tell the user
  plainly: "A persistent app needs the local edition (Claude Desktop/Code) or
  the CloudGrid CLI; the hosted edition can only publish static pages." Then
  offer to build a **static version** instead (an in-memory / localStorage
  to-do page via the `web-app` workflow) and STOP the runtime path here.
- **Local edition:** continue.

## 2. Auth + grid

Persistent apps are owned entities.
1. Ensure signed in: `grid_login_status`; if not, `grid_login`.
2. A grid is required. Respect the grid picker: if the user has more than one
   grid, ask which to use (per the existing `resolveGridOrAsk` behavior); do not
   assume a target.

## 3. Scaffold

`grid_init` an app `<name>` (the default `--type` is fine). `init` creates
the entity + `.cloudgrid/link.json` and writes a `cloudgrid.yaml` with an EMPTY
`services: {}`. `plug` needs a linked directory, so run `init` FIRST.

You then do two things: (a) write the app under **`services/web/`**, and (b) fill
in `cloudgrid.yaml` to the shape below (`services.web` + `needs: { database: true }`).

## 4. Add the datastore + wire Mongo

1. Set `cloudgrid.yaml` to declare the `web` service and the store it needs.
   **App code MUST live under `services/<name>/`** — `path:` is the URL mount,
   NOT the filesystem path. A service named `web` → the CLI looks for
   `services/web/`; app files at the repo root fail with
   `Error: Service directory not found: …/services/web`.
   ```yaml
   name: my-app
   services:
     web:
       type: nextjs
       path: /
   needs:
     database: true
     # cache: true      # OPTIONAL — add only if the app needs Redis
   ```
   **Declare the datastore with `needs: { database: true }`** — this is the
   canonical shape. The deployer provisions Mongo and injects
   `DATABASE_MONGODB_URL` (plus the legacy `MONGODB_URL` alias) at dev-time and
   runtime. `requires:` is the deprecated v1 alias; don't author new yaml with it,
   and never set `needs:` and `requires:` together (the validator rejects it).
2. Fetch the template for the Mongo wiring + CRUD shape:
   `grid_fetch("template", "app-with-data")`. It is a minimal, real
   Next.js + `mongodb`-driver to-do app under `services/web/`: a lazy client in
   `services/web/lib/db.js`, an App-Router GET/POST/DELETE route on a `todos`
   collection, and a page.
3. Adapt it to the user's app (rename the collection, change the fields, adjust
   the UI). **Read the database from `process.env.DATABASE_MONGODB_URL`** (falling
   back to the legacy `process.env.MONGODB_URL`) — the grid injects those env vars
   at dev-time and runtime. Never hardcode a connection string; never commit a
   secret.
   - **Put the DB connection behind a lazy getter — never read the connection
     string at module top level, or `next build` fails** (the module is imported
     for route analysis before the grid injects the var).
   - (Optional) fetch `grid_fetch("example", "app-with-data")` for a slightly
     richer filled reference to imitate.

## 5. (Optional) Run locally

Mention that the user can `grid dev` to run locally against the injected Mongo
and sanity-check before deploying. Don't require it.

## 6. Config

- API keys / secrets → `grid_secrets`.
- Non-secret config → `grid_env`.
- Do **NOT** set the DB/cache connection vars yourself (`DATABASE_MONGODB_URL`,
  `CACHE_REDIS_URL`, or their legacy `MONGODB_URL` / `REDIS_URL` aliases) — the
  grid injects them.

## 7. Deploy (async)

Deploy the folder with `grid_deploy`. A **runtime deploy is ASYNC**: the first
response is `status: "building"` with a `poll_url` / entity, NOT a live URL yet.
- Poll `grid_status` (or the returned poll_url) until the entity is live.
- Surface a liveness signal while it builds — keep the user informed, never a
  bare silent wait.
- Only once it is live, return the deployed URL (the app URL, NOT the build/log
  link).

## 8. Return the live URL + iterate

Give the user the live app URL — that is the deliverable. To iterate, re-plug
the SAME entity (`target_entity_id`) so it updates the same URL. Runtime re-plug
uses the CLI path (`grid plug` in the linked folder), per the plug
description.

Keep it honest: async build, local-edition only, credentials injected by the
grid.
