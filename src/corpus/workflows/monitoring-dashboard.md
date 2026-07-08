---
name: monitoring-dashboard
when: monitoring dashboard, service health board, uptime/incident monitor (data-backed) — a persistent app that records health checks per service and shows current status + history. Needs a database → runtime → local edition.
needs: database
deploy: runtime
editions: local
capabilities_note: persistent — needs a database (Mongo). Runtime app, async build, local edition only. Declare the canonical `needs: { database: true }`; the deployer injects DATABASE_MONGODB_URL (+legacy MONGODB_URL).
summary: Build a persistent Next.js + Mongo monitoring dashboard on the grid — a `checks` collection (service, status up/degraded/down, latencyMs, at) with a current-status grid + recent history and a POST-a-check form. Edition-gate first, scaffold, put the app under services/web/, wire process.env.DATABASE_MONGODB_URL (legacy MONGODB_URL fallback) lazily, declare needs:{database:true} (not requires:), deploy async, poll to a live URL.
---

# Workflow: monitoring-dashboard

The user wants a monitoring dashboard / service health board / uptime monitor
that **remembers** its health checks — a board whose data survives refresh and is
shared across sessions. That is a **runtime app** backed by the grid's shared
Mongo, not a static page. It is the same proven shape as `app-with-data`, with a
`checks` domain (`service`, `status` of up/degraded/down, `latencyMs`, `at`), a
current-status grid (latest check per service) and a recent-history table, plus a
form that POSTs a new check.

Follow this recipe. Be honest that a runtime deploy is async (not instant like a
static drop) and that it needs the local edition.

## 1. Edition check FIRST (hard gate)

A persistent app is a built + deployed container. It requires the **local
edition** (Claude Desktop / Claude Code) or the CLI.

- **Hosted edition (Claude Web / hosted MCP):** you CANNOT build a runtime app —
  hosted is inline-only and can only publish static pages. Tell the user
  plainly, offer a **static version** instead, and STOP the runtime path here.
- **Local edition:** continue.

## 2. Auth + grid

1. Ensure signed in: `grid_login_status`; if not, `grid_login`.
2. A grid is required. Respect the grid picker: if the user has more than one
   grid, ask which to use; do not assume a target.

## 3. Scaffold

`grid_init` an app `<name>`. `init` creates the entity + `.cloudgrid/link.json`
and writes a `cloudgrid.yaml` with an EMPTY `services: {}`. `plug` needs a linked
directory, so run `init` FIRST. Then (a) write the app under **`services/web/`**,
and (b) fill `cloudgrid.yaml` to the shape below (`services.web` + `needs:
{ database: true }`).

## 4. Add the datastore + wire Mongo

1. Set `cloudgrid.yaml`. **App code MUST live under `services/<name>/`** —
   `path:` is the URL mount, NOT the filesystem path.
   ```yaml
   name: my-dashboard
   services:
     web:
       type: nextjs
       path: /
   needs:
     database: true
   ```
   **Declare the datastore with `needs: { database: true }`** — the canonical
   shape. The deployer provisions Mongo and injects `DATABASE_MONGODB_URL` (plus
   the legacy `MONGODB_URL` alias). `requires:` is the deprecated v1 alias; don't
   author new yaml with it, and never set `needs:` and `requires:` together (the
   validator rejects it).
2. Fetch the template for the Mongo wiring + CRUD shape:
   `grid_fetch("template", "monitoring-dashboard")`. It is a minimal, real
   Next.js + `mongodb`-driver health board under `services/web/`: a lazy client
   in `services/web/lib/db.js`, an App-Router GET/POST/DELETE route on a `checks`
   collection, a server-component page that derives the status grid, and a client
   component with the record-check form + status grid + history table.
3. Adapt it (rename the collection, change fields, adjust the UI). **Read the DB
   from `process.env.DATABASE_MONGODB_URL`** (legacy `process.env.MONGODB_URL`
   fallback) — the grid injects it at dev-time and runtime.
   - **Put the DB connection behind a lazy getter — never read the connection
     string at module top level, or `next build` fails.**
   - The `checks` route validates `status` against `up`/`degraded`/`down` and
     `latencyMs` as an optional non-negative number; the status grid is the
     latest check per service.

## 5. (Optional) Run locally

Mention that the user can `grid dev` to run locally against the injected Mongo
before deploying. Don't require it.

## 6. Config

- API keys / secrets → `grid_secrets`. Non-secret config → `grid_env`.
- Do **NOT** set the DB connection vars yourself (`DATABASE_MONGODB_URL` or the
  legacy `MONGODB_URL`) — the grid injects them.

## 7. Deploy (async)

Deploy the folder with `grid_plug`. A **runtime deploy is ASYNC**: the first
response is `status: "building"`, NOT a live URL yet.
- Poll `grid_status` (or the returned poll_url) until the entity is live.
- Surface a liveness signal while it builds — never a bare silent wait.
- Only once it is live, return the deployed app URL (NOT the build/log link).

## 8. Return the live URL + iterate

Give the user the live app URL — that is the deliverable. To iterate, re-plug the
SAME entity so it updates the same URL. Keep it honest: async build, local-edition
only, credentials injected by the grid.
