# services/refresh — scheduled cron reindex

A `type: cron`, `run: job` Python service that reruns the incremental indexing
pipeline on a schedule (default daily `0 3 * * *`, UTC). It is the scheduled
sibling of the manager-only `POST /backend/admin/refresh` endpoint — both call the
exact same `app.indexing.run_sync`.

## How it works

- `src/main.py` is the batch entry point. CloudGrid runs it to completion once per
  schedule and exits; there is no HTTP server. It calls
  `app.indexing.run_sync(triggered_by="cron")`.
- It connects DIRECTLY to the grid-injected `DATABASE_MONGODB_URL` (from the
  app-level `needs: { database: true }`, inherited by every service including
  cron). It does NOT call the backend over HTTP — there is no injected self-URL or
  documented service-to-service DNS, so a network hop would be fragile.
- Graceful no-op: with no source / embeddings secrets set, `run_sync` records a
  report (`status: skipped`, `source_configured: false`, 0 documents) and returns
  WITHOUT raising. The run exits 0. Only a genuine pipeline error exits non-zero.

## Why the code is vendored (and the drift note)

Each CloudGrid service builds in its OWN isolated container from its own folder, so
a cross-folder import of `services/backend/src/app` does not resolve at build time.
The reuse mechanism is therefore a **vendored copy**: the backend modules that
`run_sync` transitively needs are copied verbatim into `services/refresh/src/app/`:

    config.py  db.py  source.py  embeddings.py  indexing.py  __init__.py

These are exact copies of `services/backend/src/app/*`. **Drift consideration:** if
you change the indexing pipeline, chunking, source adapters, embeddings, or the DB
schema in the backend, re-copy the changed module(s) here so the scheduled run
matches the on-demand endpoint. Keep the two in lockstep. (`answer.py`, `search.py`,
`auth.py`, `main.py` are NOT needed — the cron only indexes, it never serves or
searches — so they are intentionally not vendored.)

## Secrets it uses

Same secrets as the backend, read lazily at run time (never at import):
`SOURCE_TYPE` + its source creds (e.g. `DROPBOX_*` / `LOCAL_SOURCE_PATH` /
`URL_SOURCE_MANIFEST`), and `EMBEDDINGS_API_KEY` (+ `EMBEDDINGS_MODEL`,
`EMBEDDINGS_BASE_URL`). With none set, the run is a clean no-op.
