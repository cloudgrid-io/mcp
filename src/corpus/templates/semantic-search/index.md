# Template: semantic-search (CloudGrid-native document search)

A deployable, domain-agnostic **document search** app — index a folder of
documents (PDF/DOCX/TXT/MD), then search by keyword, by meaning, and by metadata,
with a grounded answer mode and a manager admin. Two services: a React (Vite)
static frontend at `/` and a FastAPI backend at `/backend`, backed by
grid-shared Mongo. This template ships **real, runnable code** — read `AGENTS.md`,
adapt the naming/metadata to your domain, then deploy.

**Hybrid search** = Mongo `$text` (lexical) + in-app NumPy cosine over chunk
embeddings (semantic) + metadata filters, blended and aggregated to the document
level with a best-passage highlight.

**Key rules (proven by a live build — do not regress these):**

1. **Every service's code lives under `services/<name>/`.** `path:` in
   `cloudgrid.yaml` is the URL mount, NOT the filesystem path. The `web` service
   → `services/web/`; the `backend` service → `services/backend/`.
2. **Read the Mongo URL LAZILY** — `os.environ.get("DATABASE_MONGODB_URL") or
   os.environ.get("MONGODB_URL")` inside `get_client()`, never at import time.
3. **Health is green with NO secrets set.** No secret is read at import time;
   every secret is gated inside a function. `GET /backend/health` needs only Mongo.
4. **`@app.on_event("startup")` calls `db.ensure_indexes()`** so the chunks
   `$text` index exists at boot — `$text` returns `[]` on an empty catalog rather
   than raising `IndexNotFound` (a 500). The `$text` query is also guarded in
   `except OperationFailure` as belt-and-suspenders.
5. **No `needs: vector`** — the need is available now (#1545 shipped, verified
   live 2026-07-16), but this
   template stores embeddings in the Mongo `chunks` collection (a float array)
   and cosine-ranks in-app; declare `vector: pgvector` only if you also switch
   the code to pgvector. **The refresh cron IS active** — a Python `type: cron`,
   `run: job` service (`services/refresh/`) reindexes daily at 03:00 UTC, and the
   manager "Refresh now" endpoint reindexes on demand; both call the same
   `indexing.run_sync` (the cron vendors the backend `app/` modules — see AGENTS.md §8).

## File tree

```
cloudgrid.yaml                                 # name + services(web static+build, backend python, refresh cron) + needs:{database:true}
services/web/                                  # React + Vite static frontend (LTR, neutral)
  package.json  vite.config.js  index.html
  src/main.jsx  App.jsx  api.js  styles.css
  src/components/SearchView.jsx ManagerLogin.jsx Settings.jsx Dashboard.jsx
services/backend/                              # FastAPI backend, mounted at /backend
  requirements.txt
  src/main.py                                  # uvicorn entry (reads PORT; no secret at import)
  src/app/
    main.py                                    # routes + startup ensure_indexes()
    config.py                                  # lazy secret gating (SOURCE_TYPE, EMBEDDINGS_*, ...)
    db.py                                       # lazy Mongo; ensure_indexes(); collections documents+chunks
    search.py                                   # hybrid: $text + cosine + metadata, blended to doc level
    indexing.py                                 # discover -> extract -> chunk -> embed -> store (incremental)
    source.py                                   # pluggable adapter: dropbox | local | url
    embeddings.py                               # one config point (OpenAI-compatible)
    answer.py                                   # grounded answer + citations (extractive fallback)
    auth.py                                     # manager session auth (MANAGER_PASSWORD_HASH)
services/refresh/                              # type: cron, run: job — scheduled reindex (daily 03:00 UTC)
  requirements.txt  README.md
  src/main.py                                  # calls app.indexing.run_sync(triggered_by="cron")
  src/app/                                     # VENDORED copies: config db source embeddings indexing __init__
```

## cloudgrid.yaml (active fields)

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference)
# with EVERY field present as a comment; only the fields below are uncommented.
name: semantic-search
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
  refresh:
    type: cron
    schedule: "0 3 * * *"
    timezone: UTC
    run: job
needs:
  database: true
```

> **Capability:** the need is `database: true` — the deployer provisions Mongo and
> injects `DATABASE_MONGODB_URL` (+ legacy `MONGODB_URL`). NO `needs: vector`
> (available, #1545 shipped — this template uses Mongo embeddings). Three
> services: `web` (static), `backend` (python), `refresh` (cron).
> `requires:` is the deprecated v1 alias — don't mix it with `needs:`.

## Configure + deploy

1. `grid plug --no-deploy` — registers the entity from `cloudgrid.yaml` (honors
   its `name:`) and writes `.cloudgrid/link.json`, without building yet.
2. `grid secrets set EMBEDDINGS_API_KEY=sk-…` plus the source secrets
   (`SOURCE_TYPE` + Dropbox/local/url config) and `MANAGER_PASSWORD_HASH`
   (sha256 hex of the manager password). See `AGENTS.md`.
3. (Optional) `grid dev` to run locally against the injected dev Mongo.
4. `grid plug` to deploy — a runtime deploy is **async**: poll status until live,
   then sign in as manager and hit "Refresh now" to index the source.

## Adapt it

- Rename the `collection` / `date` metadata to your domain in
  `services/backend/src/app/indexing.py` (`_parse_metadata`).
- Add a source adapter: subclass `Source` in `source.py`, return it from
  `get_source()`, gate its secrets in `config.py`.
- Point embeddings at any OpenAI-compatible provider via `EMBEDDINGS_BASE_URL`.
