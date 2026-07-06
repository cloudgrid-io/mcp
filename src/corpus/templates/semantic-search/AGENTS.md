# AGENTS.md — semantic-search template (CloudGrid wiring guide)

This template is a **runnable app**, not a blueprint — it ships real FastAPI +
React code. Read this guide, adapt the naming/metadata to the user's domain, wire
the secrets, and deploy. The four "baked-in learnings" (health-without-secrets,
startup index, `$text` guard, no vector/no cron) are already in the code — do not
regress them.

---

## 1. File tree

Every service's code lives under `services/<name>/` — `path:` in `cloudgrid.yaml`
is the URL mount, NOT the filesystem path. Files at the repo root fail with
`Error: Service directory not found: …/services/<name>`.

```
cloudgrid.yaml                          # name + services(web,backend) + needs:{database:true}
services/web/                           # React + Vite static frontend, served at /
  package.json  vite.config.js  index.html
  src/main.jsx  App.jsx  api.js  styles.css
  src/components/SearchView.jsx ManagerLogin.jsx Settings.jsx Dashboard.jsx
services/backend/                       # FastAPI, mounted at /backend
  requirements.txt
  src/main.py                           # uvicorn app.main:app (reads PORT)
  src/app/
    main.py       config.py   db.py      search.py   indexing.py
    source.py     embeddings.py  answer.py  auth.py
```

---

## 2. Mongo collections + fields

The grid provisions one MongoDB database (`needs: { database: true }`). Two
primary collections (`_id` is the Mongo ObjectId on every doc):

**`documents`** — one row per source document
- `title` (string), `collection` (string, free-form grouping tag, nullable),
  `date` (ISO date string, nullable) — the metadata filters.
- `source_filename` (string, unique), `source_rev` (string — content hash / rev
  for incremental sync), `file_path` (string, source-internal, never exposed).
- `has_media` (bool), `word_count` (int), `indexed_at` (Date).

**`chunks`** — one embeddable passage per document (the retrieval unit)
- `document_id` (ObjectId → documents), `chunk_index` (int),
- `content` (string — indexed by the `$text` index, returned as the passage),
- `embedding` (float[] — the semantic vector; `null` if embeddings unconfigured).

Support collections: `settings` (feature flags, synonyms, `catalog.last_refresh`),
`usage_events`, `index_reports`, `sessions`.

**Adapt the metadata to the domain:** rename/extend `collection` and `date` in
`indexing.py::_parse_metadata`, and mirror the field names in `search.py`,
`main.py`, and the web `SearchView`.

---

## 3. How CloudGrid injects the datastore

You never provision infra or set a connection string by hand. `needs:{database:
true}` provisions Mongo and injects it as an env var at `grid dev` (local) and at
runtime (after `grid plug`):

| What | Declared in cloudgrid.yaml | Injected env var(s) | Read in code |
|------|----------------------------|---------------------|--------------|
| MongoDB | `needs: { database: true }` | `DATABASE_MONGODB_URL` (+ legacy `MONGODB_URL`) | `app/db.py::get_client` (lazy) |

Read it LAZILY — `os.environ.get("DATABASE_MONGODB_URL") or
os.environ.get("MONGODB_URL")` inside `get_client()`, never at module top level.
`requires:` is the deprecated v1 alias; never author it and never set `needs:` and
`requires:` together (the validator rejects the combination).

**No `needs: vector`.** The ideal embedding store is pgvector
(`needs: { vector: pgvector }` → `VECTOR_PGVECTOR_URL`), but the runtime
role-grant is **blocked on platform issue #1545**. Until it lands, embeddings live
in the Mongo `chunks.embedding` float array and are cosine-ranked in-app
(`search.py::_cosine`). When #1545 ships, move the vectors to pgvector and replace
the in-app cosine block with an `ORDER BY embedding <=> $q LIMIT k` query — the
rest of the pipeline is unchanged.

---

## 4. Pluggable document source (SOURCE_TYPE)

The source is where raw documents live, not the query DB. `SOURCE_TYPE` selects
the adapter in `app/source.py`; all creds are gated in `app/config.py` and read
lazily:

- **`dropbox`** (default) — read-only, offline refresh-token flow. Secrets:
  `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`, `DROPBOX_REFRESH_TOKEN`,
  `DROPBOX_FOLDER_PATH` (optional).
- **`local`** — a directory on the container filesystem. Set `LOCAL_SOURCE_PATH`
  (or add `needs: { disk: true }` and it defaults to the injected `DISK_PATH`).
- **`url`** — a manifest of document URLs. Set `URL_SOURCE_MANIFEST` to a
  newline- or comma-separated list.

**Add your own adapter:** subclass `Source` (implement `list_files()` returning
`SourceFile[]` and `download(path) -> bytes`), gate its config in
`config.py::source_configured`, and return it from `get_source()`. Text
extraction for txt/md/pdf/docx is shared in `source.extract_text`.

---

## 5. Embeddings (one config point)

`app/embeddings.py` is the single provider seam — OpenAI-compatible by default.
Secrets/config (all gated, read lazily):

- `EMBEDDINGS_API_KEY` — the key (semantic search + generated answers degrade
  gracefully to lexical/extractive when unset).
- `EMBEDDINGS_MODEL` (default `text-embedding-3-small`) — changing it changes
  vector dimensions and requires a full reindex.
- `EMBEDDINGS_BASE_URL` (default `https://api.openai.com/v1`) — point at any
  OpenAI-compatible endpoint.
- `ANSWER_MODEL` (default `gpt-4o-mini`) — the grounded-answer chat model.

---

## 6. Secrets via `grid secrets set`

Store secrets with the CLI; never commit them, never read them at import time:

```bash
grid secrets set EMBEDDINGS_API_KEY=sk-...
grid secrets set SOURCE_TYPE=dropbox
grid secrets set DROPBOX_APP_KEY=... DROPBOX_APP_SECRET=... DROPBOX_REFRESH_TOKEN=...
grid secrets set MANAGER_PASSWORD_HASH=$(printf '%s' 'your-password' | shasum -a 256 | cut -d' ' -f1)
```

`MANAGER_PASSWORD_HASH` is the sha256 hex of the manager password, compared
server-side in `auth.py`. The in-app "Change password" screen returns a new hash
to store the same way. Non-secret public config can also go via `grid env`.

---

## 7. The baked-in learnings (do NOT regress)

1. **Startup index.** `main.py` has `@app.on_event("startup")` →
   `db.ensure_indexes()`, which creates the chunks `$text` index (plus the
   documents metadata indexes) at boot. Without it, `$text` raises
   `IndexNotFound` (a 500) on an empty catalog. `ensure_indexes()` is safe to call
   repeatedly and never blocks startup if Mongo is briefly unavailable.
2. **`$text` guard.** The lexical query in `search.py` is wrapped in
   `except OperationFailure` so a missing index degrades to "lexical contributes
   nothing", never a 500 — belt-and-suspenders on top of the startup index.
3. **Health without secrets.** No secret is read at import time; every secret is
   gated inside a function (`config.py`). `GET /backend/health` needs only Mongo.
   Search/indexing degrade gracefully (empty results + a clear note) when the
   source or embeddings are unconfigured. `GET /backend/status` reports capability
   **booleans** (`source_configured`, `embeddings_configured`, …), never secret
   values.
4. **No `needs: vector` / no active cron.** `needs:` is `database` only (#1545).
   The cron refresh service is commented out (#1585) — see §8.

---

## 8. Refresh: manager endpoint now, cron later

The supported refresh path today is the manager-only endpoint
`POST /backend/admin/refresh` (wired to the "Refresh now" button in Settings). It
runs the same incremental sync pipeline (`indexing.run_sync`) a cron would.

A scheduled `type: cron` refresh service is a **follow-up**: a Python cron entity
is currently blocked on **platform issue #1585**. The `cloudgrid.yaml` keeps a
`refresh:` cron service commented out with a `services/refresh` source pointing at
the same `indexing.run_sync`. When #1585 lands, uncomment it (`schedule`,
`timezone`, `run: job`) and add a thin `services/refresh/src/main.py` that calls
`app.indexing.run_sync(triggered_by="cron")`.

---

## 9. Deploy + edition note

This is a built + deployed multi-service app → the **local edition** (Claude
Desktop / Claude Code) or the CLI; the hosted edition cannot build a runtime
container.

1. `grid init semantic-search` — creates the entity + `.cloudgrid/link.json`.
2. Put the code under `services/web/` and `services/backend/`; set `cloudgrid.yaml`
   to the active fields (web static+build, backend python, `needs:{database:true}`).
3. `grid secrets set …` for embeddings + source + `MANAGER_PASSWORD_HASH` (§6).
4. (Optional) `grid dev` to run locally against injected dev Mongo.
5. **Build the frontend first:** `(cd services/web && npm install && npm run build)`.
   CloudGrid validates that a `type: static` service carrying a `build:` block
   already has `services/web/dist/index.html` on disk at plug time — plug fails
   validation otherwise.
6. `grid plug` — a runtime deploy is **ASYNC**: the first response is
   `status: building`, not a live URL. Poll `grid status` (surface a liveness
   signal, never a bare wait) until Ready.
7. Sign in as manager, hit "Refresh now" to index the source, then search.
   Re-plug the same entity to update the same URL.
