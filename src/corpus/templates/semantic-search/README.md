# semantic-search template — CloudGrid-native document search

A deployable, domain-agnostic **document search** app: index a folder of
documents (PDF / DOCX / TXT / MD), then search them by keyword, by meaning, and
by metadata — with a grounded answer mode and a manager admin. Data lives in the
grid-shared MongoDB, so the catalog survives refresh and is shared across users.

**Hybrid search** = Mongo `$text` (lexical) + in-app NumPy cosine over chunk
embeddings (semantic) + metadata filters (date / collection), blended and
aggregated to the document level with a best-passage highlight.

## Services

| Service | Type | Path | Entry |
|---|---|---|---|
| `web` | `static` (React, Vite) | `/` | build → `dist` |
| `backend` | `python` (FastAPI) | `/backend` | `services/backend/src/main.py` |

`needs: { database: true }` → CloudGrid injects `DATABASE_MONGODB_URL` (fallback
`MONGODB_URL`). **No `needs: vector`** — the need is available now (#1545
shipped, verified live 2026-07-16), but this template stores embeddings in the
Mongo `chunks` collection and cosine-ranks in-app; declare `vector: pgvector`
only if you also switch the code to pgvector. Refresh runs two ways: the manager "Refresh now" endpoint
(on demand) and an active Python `type: cron` job (`services/refresh/`, daily 03:00
UTC) — both call the same `indexing.run_sync` (see AGENTS.md §8).

## Pluggable document source

`SOURCE_TYPE` selects the adapter, all credentials from env secrets:

- `dropbox` (default) — read-only Dropbox via the offline refresh-token flow.
- `local` — a directory on the container filesystem (`LOCAL_SOURCE_PATH`, or a
  `needs: disk` mount at `DISK_PATH`).
- `url` — a manifest of document URLs (`URL_SOURCE_MANIFEST`).

Add your own by subclassing `Source` in
`services/backend/src/app/source.py` and returning it from `get_source()`.

## Embeddings

Behind one config point (`services/backend/src/app/embeddings.py`), OpenAI by
default. `EMBEDDINGS_API_KEY` from env; `EMBEDDINGS_MODEL` / `EMBEDDINGS_BASE_URL`
to point at any OpenAI-compatible provider.

## Secrets (set with `grid secrets set KEY=VALUE`)

`EMBEDDINGS_API_KEY`, `SOURCE_TYPE`, and the source's own secrets
(`DROPBOX_APP_KEY` / `DROPBOX_APP_SECRET` / `DROPBOX_REFRESH_TOKEN` /
`DROPBOX_FOLDER_PATH`, or `LOCAL_SOURCE_PATH`, or `URL_SOURCE_MANIFEST`), and
`MANAGER_PASSWORD_HASH` (sha256 hex of the manager password).

The app starts and passes `GET /backend/health` with **none** of these set —
search / indexing degrade to a clear "not indexed / missing secret" state.

## Health without secrets (baked-in)

- `@app.on_event("startup")` calls `db.ensure_indexes()` so the chunks `$text`
  index exists at boot — `$text` returns `[]` on an empty catalog, never a 500.
- The `$text` query is additionally guarded in `except OperationFailure`.
- No secret is read at import time; every secret is gated inside a function.
- `/backend/status` reports capability booleans, never secret values.

## Deploy (manager does this)

```bash
grid plug --no-deploy       # registers the entity from cloudgrid.yaml + writes .cloudgrid/link.json
grid secrets set EMBEDDINGS_API_KEY=sk-...   # + source secrets + MANAGER_PASSWORD_HASH

# Build the static frontend BEFORE plug — CloudGrid validates that a
# type:static service with a build: block already has services/web/dist/index.html.
(cd services/web && npm install && npm run build)

grid plug                    # async build + deploy; poll to a live URL
```

See `AGENTS.md` for the full wiring guide.
