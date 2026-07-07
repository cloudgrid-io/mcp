---
name: semantic-search
when: "search over my documents / PDFs / notes / knowledge base, semantic search, document search, find across my files, searchable archive. Needs a database → runtime → local edition."
needs: database
deploy: runtime
editions: local
capabilities_note: "Document search — needs a database (Mongo) for the documents + chunks collections. Two services: a React (Vite) static frontend at / and a FastAPI backend at /backend. Hybrid search = Mongo $text (lexical) + in-app NumPy cosine over chunk embedding arrays (semantic) + metadata filters, blended to the document level. Runtime app, async build, local edition only. Declare needs:{database:true}. NO needs:vector — pgvector runtime role-grant is blocked (#1545), so embeddings live in the Mongo chunks collection and are cosine-ranked in-app. Two refresh paths: the manager 'Refresh now' endpoint AND a scheduled Python type:cron job (services/refresh, daily 03:00 UTC) that vendors the backend app/ modules and reuses indexing.run_sync — both degrade gracefully. Health is green with no secrets; startup ensure_indexes() so $text never 500s on an empty catalog. Pluggable source (dropbox|local|url) + embeddings (OpenAI-compatible) each behind one config point, all secrets from env."
summary: "Build a document-search app on the grid — index a folder of PDFs/DOCX/TXT/MD, then search by keyword + meaning + metadata, with a grounded answer mode and manager admin. React static frontend at / + FastAPI backend at /backend, backed by grid-shared Mongo. Edition-gate first, scaffold, put the code under services/web/ + services/backend/, declare needs:{database:true} (NO vector #1545), wire the web+backend+refresh services, set the embeddings + source + manager secrets, deploy async, poll to a live URL, then Refresh now (or wait for the daily cron) to index."
recipe: "edition-gate -> auth+grid -> gridctl_init -> fetch template + read AGENTS.md -> put code under services/web + services/backend, set cloudgrid.yaml active fields -> grid secrets set (embeddings + source + MANAGER_PASSWORD_HASH) -> optional grid dev -> grid plug (async, poll) -> Refresh now to index -> return live URL"
---

# Workflow: semantic-search

The user wants to **search over their own documents** — a searchable archive of
PDFs / DOCX / notes / a knowledge base, by keyword *and* by meaning, not just a
static page. That is a **persistent runtime app**: a React (Vite) static frontend
at `/` and a FastAPI backend at `/backend`, backed by the grid-shared Mongo. The
backend indexes a document source into `documents` + `chunks` collections and
serves **hybrid search** — Mongo `$text` (lexical) + in-app NumPy cosine over the
chunk embedding arrays (semantic) + metadata filters, blended and aggregated to
the document level with a best-passage highlight.

This template ships **real, runnable code** — fetch it, read `AGENTS.md`, adapt
the metadata naming to the user's domain, wire secrets, deploy. Be honest that a
runtime deploy is async and needs the local edition.

## 1. Edition check FIRST (hard gate)

A document-search app is a built + deployed multi-service container. It requires
the **local edition** (Claude Desktop / Claude Code) or the CLI.

- **Hosted edition (Claude Web / hosted MCP):** you CANNOT build a runtime app —
  hosted is inline-only and can only publish static pages. Say so plainly, offer a
  static explainer page instead, and STOP the runtime path here.
- **Local edition:** continue.

## 2. Auth + grid

1. Ensure signed in: `gridctl_login_status`; if not, `gridctl_login`.
2. A grid is required. Respect the grid picker: if the user has more than one
   grid, ask which to use; do not assume a target.

## 3. Scaffold

`gridctl_init` an app `<name>` FIRST — it creates the entity +
`.cloudgrid/link.json` and a starter `cloudgrid.yaml` with empty `services: {}`
(`plug` needs a linked directory).

## 4. Fetch the template and READ AGENTS.md

`gridctl_fetch("template", "semantic-search")`. Read **`AGENTS.md`** before
writing anything — it defines the file tree, the `documents` + `chunks`
collections + fields, the Mongo injection, the pluggable source adapter, the
embeddings config point, the secrets, the deploy flow, and the four baked-in
learnings you must NOT regress (health-without-secrets, startup index, `$text`
guard, no `needs: vector`).

## 5. Put the code under services/ and fill cloudgrid.yaml

**Every service's code MUST live under `services/<name>/`** — `path:` is the URL
mount, NOT the filesystem path (`web` → `services/web/`, `backend` →
`services/backend/`). Set `cloudgrid.yaml` to the template's active fields:

```yaml
name: my-search
services:
  web:
    type: static
    path: /
    build:
      command: npm run build
      output: dist
    node_version: "22"
  backend:
    type: python
    path: /backend
  refresh:                 # scheduled reindex — Python cron, batch job
    type: cron
    schedule: "0 3 * * *"  # daily 03:00
    timezone: UTC
    run: job
needs:
  database: true
```

**Declare `needs: { database: true }`** — the deployer provisions Mongo and
injects `DATABASE_MONGODB_URL` (+ legacy `MONGODB_URL`), read lazily in
`app/db.py`. `requires:` is the deprecated v1 alias; never author it and never set
`needs:` and `requires:` together (the validator rejects the combination).

**NO `needs: vector`** — the pgvector runtime role-grant is blocked on platform
issue **#1545**, so this template stores embeddings in the Mongo `chunks`
collection (a float array) and cosine-ranks in-app. **The refresh cron IS active**
— a Python `type: cron`, `run: job` service (`services/refresh/`) reindexes daily
at 03:00 UTC, and the manager "Refresh now" endpoint indexes on demand. Both call
the same `indexing.run_sync`. Because each service builds in an isolated container,
the cron **vendors** the backend `app/` modules it needs into
`services/refresh/src/app/` (keep the copies in sync — see AGENTS.md §8).

## 6. Configure the source + embeddings (one config point each)

- **Source** — `SOURCE_TYPE` selects the adapter (`dropbox` default | `local` |
  `url`). Set it plus that adapter's secrets:
  - dropbox: `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`,
    optional `DROPBOX_FOLDER_PATH`.
  - local: `LOCAL_SOURCE_PATH` (or add `needs: { disk: true }` → `DISK_PATH`).
  - url: `URL_SOURCE_MANIFEST` (newline/comma-separated URLs).
- **Embeddings** — `EMBEDDINGS_API_KEY` (OpenAI by default;
  `EMBEDDINGS_BASE_URL` / `EMBEDDINGS_MODEL` to point elsewhere).
- **Manager** — `MANAGER_PASSWORD_HASH` = sha256 hex of the manager password.

Store all of these with `grid secrets set KEY=VALUE` (never commit them; the app
reads them lazily inside functions, never at import). Non-secret public config →
`gridctl_env`. Do NOT set `DATABASE_MONGODB_URL` yourself — the grid injects it.

The app starts and passes `GET /backend/health` with **none** of these set;
search/indexing degrade to a clear "not indexed / missing secret" state.

## 7. (Optional) Run locally

Mention the user can `grid dev` to run locally against the injected dev Mongo
before deploying. Don't require it.

## 8. Deploy (async)

Deploy the folder with `gridctl_plug`. A **runtime deploy is ASYNC**: the first
response is `status: "building"`, NOT a live URL yet.
- Poll `gridctl_status` (or the returned poll_url) until the entity is live.
- Surface a liveness signal while it builds — never a bare silent wait.
- Only once it is live, return the deployed app URL (NOT the build/log link).

## 9. Index + iterate

Sign in as manager and hit **"Refresh now"** (Settings) to index the source into
Mongo immediately, then search — or let the daily `refresh` cron do it on schedule.
Give the user the live app URL — the deliverable. To iterate, re-plug the SAME
entity so it updates the same URL.

Keep it honest: this ships real code you adapt, the build is async and
local-edition only, Mongo is injected by `needs`, embeddings live in Mongo (no
pgvector until #1545), and refresh runs both on demand (endpoint) and on a schedule
(the `refresh` cron).
