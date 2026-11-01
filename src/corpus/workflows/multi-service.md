---
name: multi-service
when: frontend plus a separate backend/API, two languages in one app (e.g. React + Python, HTML + Node), a UI with a worker or scheduled job, "separate frontend and backend", microservices-ish asks — any request where the parts run as separate services
needs: database
deploy: runtime
editions: all
capabilities_note: persistent — needs a database (Mongo). Runtime app, async build, any edition (hosted: artifact_files inline; local: a folder). Two or more services declared in cloudgrid.yaml, each under services/<name>/.
summary: Build a multi-service app on the grid — a static or built frontend at / plus a Node/Python API backend at /api, sharing grid-managed Mongo. Scaffold, put each service under services/<name>/, wire process.env.DATABASE_MONGODB_URL lazily, declare needs:{database:true}, deploy async, poll to a live URL.
---

# Workflow: multi-service

The user wants an app with **separate frontend and backend services** — a static
or built UI at one path and an API at another, or two different languages, or a
UI plus a worker/cron. That is a multi-service app: more than one entry under
`services:` in `cloudgrid.yaml`, each with its own directory under
`services/<name>/`.

Follow this recipe. One service is the default; do not split without a reason.
Split when the user describes parts that run separately: a React frontend with a
Python API, a static page with a Node backend, a web app with a scheduled job.

## 1. Edition check FIRST (pick the plug path)

A persistent app is a built + deployed container: an async build, not an
instant static drop. It works on every edition; what differs is how the files
reach the grid.

- **Hosted edition (Claude Web / hosted MCP):** write the files in the
  conversation and pass them inline to `grid_plug` as `artifact_files` (one
  entry per file, with the manifest as `cloudgrid_yaml`), then poll
  `grid_check_deploy`. A few text files plug fine; a framework build with a
  lockfile or binary assets is more reliable from the CLI
  (`npx -y @cloudgrid-io/cli@latest plug`), so say so rather than dropping
  files silently. Where this recipe says "scaffold with `grid new`" or "deploy
  the folder", do the same work inline: write the same files and plug them.
- **Local edition:** continue — scaffold, write the folder, and plug it with
  `path`.
## 2. Auth + grid

1. Ensure signed in: `grid_login_status`; if not, `grid_login`.
2. A grid is required. Respect the grid picker if the user has more than one.

## 3. Scaffold

`grid new`. It scaffolds the project folder with an empty
`services: {}`. Then:

1. Fill in `cloudgrid.yaml` with the services the app needs.
2. Write each service's code under `services/<name>/`.

## 4. Declare services + infrastructure

Set `cloudgrid.yaml` to declare all services and app-level `needs:`.

Fetch the template for the multi-service shape:
`grid_get_template("template", "multi-service")`. It is a minimal but real
static-frontend + Node-API + Mongo "notes" app, proven by a live deploy. Read
its `index.md` for the key rules, then adapt.

The canonical two-service shape:

```yaml
name: my-app
services:
  web:
    type: static       # or nextjs, node, python
    path: /
    depends_on: [api]
  api:
    type: node          # or python
    path: /api
needs:
  database: true
```

Key wiring rules (from the template's `index.md`):

- **Service code lives under `services/<name>/`.** `path:` is the URL mount, not
  the filesystem path. `web` code goes in `services/web/`; `api` code goes in
  `services/api/`.
- **The platform forwards requests with the path prefix INTACT.** A browser
  fetch to `/api/items` arrives at the `api` service as `/api/items`, not
  `/items`. Set up Express/Fastify/Flask routes with the `/api` prefix.
- **The frontend fetches from `/api/...`** — no hostname, no port, just the
  absolute path. The platform routes by prefix.
- **Read the DB connection string LAZILY** — inside a getter, never at module
  top level. The grid injects `DATABASE_MONGODB_URL` (plus the legacy
  `MONGODB_URL` alias).
- **`depends_on: [api]`** on the web service ensures the API is ready before the
  frontend starts serving.

## 5. Build the services

- **Frontend (`web`):** plain HTML + JS for a no-build static service, or a Vite/
  React app with a `build:` step. Fetches the API at `/api/...`.
- **Backend (`api`):** listens on `process.env.PORT` (default 8080). Reads Mongo
  from `process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL` lazily.
  Routes include the `/api` prefix (e.g. `app.get("/api/items", ...)`).

For a three-service layout (frontend + backend + cron), see the
`semantic-search` template.

## 6. (Optional) Run locally

`grid dev` runs all services against the injected Mongo and real grid resources.

## 7. Deploy (async)

Deploy the folder with `grid_plug`. A runtime deploy is ASYNC: poll
`grid_check_deploy` until the entity is live. Only then return the deployed URL.

## 8. Return the live URL + iterate

Give the user the live app URL. To iterate, re-plug the same entity so it
updates the same URL.
