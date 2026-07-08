---
name: api-service
when: REST API, backend for X, API endpoint(s), CRUD API, JSON API, webhook receiver, a backend/service that stores data and isn't a full web UI. Needs a database → runtime → local edition.
needs: database
deploy: runtime
editions: local
capabilities_note: persistent backend service — needs a database (Mongo). A plain Node HTTP service (type: node), not a web UI. Runtime app, async build, local edition only. Declare the canonical `needs: { database: true }`; the deployer injects DATABASE_MONGODB_URL (+legacy MONGODB_URL).
summary: Build a real REST/JSON API on the grid — a Node HTTP service backed by grid-shared Mongo. Edition-gate first, scaffold, put the service under services/api/, read process.env.DATABASE_MONGODB_URL (legacy MONGODB_URL fallback) lazily, declare needs:{database:true} (not requires:), deploy async, poll to a live URL.
---

# Workflow: api-service

The user wants a **backend API**, not a full web UI — a REST/JSON service with
endpoints, a resource it stores and returns (a `/items` CRUD API, a webhook
receiver, a small backend for another app). It **saves data**, so it is a
**runtime app** backed by the grid's shared Mongo. This is the plain-service
sibling of `app-with-data`: no Next.js, no pages — just a Node HTTP server
speaking JSON.

Follow this recipe. Be honest that a runtime deploy is async (not instant like a
static drop) and that it needs the local edition.

## 1. Edition check FIRST (hard gate)

An API service is a built + deployed container. It requires the **local
edition** (Claude Desktop / Claude Code) or the CLI, because the grid must run
the CLI and folder-plug your project.

- **Hosted edition (Claude Web / hosted MCP):** you CANNOT build a runtime
  service — hosted is inline-only and can only publish static pages. Tell the
  user plainly: "An API service needs the local edition (Claude Desktop/Code) or
  the CloudGrid CLI; the hosted edition can only publish static pages." STOP the
  runtime path here (there is no useful static fallback for a backend API).
- **Local edition:** continue.

## 2. Auth + grid

Persistent services are owned entities.
1. Ensure signed in: `grid_login_status`; if not, `grid_login`.
2. A grid is required. Respect the grid picker: if the user has more than one
   grid, ask which to use; do not assume a target.

## 3. Scaffold

`grid_init` an app `<name>`. `init` creates the entity + `.cloudgrid/link.json`
and writes a `cloudgrid.yaml` with an EMPTY `services: {}`. `plug` needs a linked
directory, so run `init` FIRST.

You then do two things: (a) write the service under **`services/api/`**, and (b)
fill in `cloudgrid.yaml` to the shape below (`services.api` type `node` + `needs:
{ database: true }`).

## 4. Add the datastore + wire Mongo

1. Set `cloudgrid.yaml` to declare the `api` service and the store it needs.
   **Service code MUST live under `services/<name>/`** — `path:` is the URL
   mount, NOT the filesystem path. A service named `api` → the CLI looks for
   `services/api/`; files at the repo root fail with
   `Error: Service directory not found: …/services/api`.
   ```yaml
   name: my-api
   services:
     api:
       type: node
       path: /
   needs:
     database: true
   ```
   **Declare the datastore with `needs: { database: true }`** — this is the
   canonical shape. The deployer provisions Mongo and injects
   `DATABASE_MONGODB_URL` (plus the legacy `MONGODB_URL` alias) at dev-time and
   runtime. `requires:` is the deprecated v1 alias; don't author new yaml with
   it, and never set `needs:` and `requires:` together (the validator rejects it).
2. Fetch the template for the server + Mongo shape:
   `grid_fetch("template", "api-service")`. It is a minimal Node `http`
   server under `services/api/`: it listens on `process.env.PORT || 8080` and
   serves a small REST resource (`/items` GET list / POST create / DELETE by id)
   backed by Mongo.
3. Adapt it to the user's API (rename the resource, change the fields, add
   routes). **Read the database from `process.env.DATABASE_MONGODB_URL`** (falling
   back to the legacy `process.env.MONGODB_URL`) — the grid injects those env
   vars at dev-time and runtime. Never hardcode a connection string; never commit
   a secret.
   - **Read the connection string LAZILY inside the request handler / a getter —
     never at module top level, or node startup crashes** before the grid has
     injected the var.
   - Return clear JSON errors (`{ "error": "…" }`) with the right status codes.
   - (Optional) fetch `grid_fetch("example", "api-service")` for a slightly
     richer filled reference to imitate.

## 5. (Optional) Run locally

Mention that the user can `grid dev` to run locally against the injected Mongo
and hit the endpoints before deploying. Don't require it.

## 6. Config

- API keys / secrets → `grid_secrets`.
- Non-secret config → `grid_env`.
- Do **NOT** set the DB connection vars yourself (`DATABASE_MONGODB_URL`, or the
  legacy `MONGODB_URL` alias) — the grid injects them.

## 7. Deploy (async)

Deploy the folder with `grid_plug`. A **runtime deploy is ASYNC**: the first
response is `status: "building"` with a `poll_url` / entity, NOT a live URL yet.
- Poll `grid_status` (or the returned poll_url) until the entity is live.
- Surface a liveness signal while it builds — never a bare silent wait.
- Only once it is live, return the deployed URL (the API base URL, NOT the
  build/log link).

## 8. Return the live URL + iterate

Give the user the live API URL — that is the deliverable. Point out the endpoints
(e.g. `GET /items`, `POST /items`). To iterate, re-plug the SAME entity
(`target_entity_id`) so it updates the same URL.

Keep it honest: async build, local-edition only, credentials injected by the grid.
