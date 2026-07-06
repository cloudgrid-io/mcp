# monitoring-dashboard template — service health board (Next.js + Mongo)

A real, deployable monitoring dashboard: a status grid of your services plus a
recent-history table, all backed by grid-shared MongoDB. A **check** is a health
sample — `{ service, status (up/degraded/down), latencyMs, at }`. You POST checks
and the board derives the current status (latest check per service) and shows the
rolling history. Data survives refresh and is shared across users/sessions —
unlike a static page whose state is in memory only.

## How the grid gives you a database

You do **not** provision a database or set a connection string. In
`cloudgrid.yaml` you declare `needs: { database: true }`, and the grid:

- provisions shared Mongo for the app, and
- injects the connection string as the **`DATABASE_MONGODB_URL`** environment
  variable (plus the legacy `MONGODB_URL` alias) — at dev-time (`grid dev`) and
  at runtime (after `grid plug`).

The app reads it via `process.env.DATABASE_MONGODB_URL` (with a legacy
`process.env.MONGODB_URL` fallback) in `services/web/lib/db.js` — **lazily,
inside the `getDb` getter, never at module top level** (a top-level read fails
`next build`, which imports the module for route analysis before the grid injects
the var). Never hardcode a connection string; never commit a secret.

> **Declare `needs: { database: true }` (the canonical shape).** The deployer
> provisions Mongo and injects `DATABASE_MONGODB_URL` (plus the legacy
> `MONGODB_URL` alias). `requires:` is the deprecated v1 alias — don't author new
> yaml with it, and never set `needs:` and `requires:` together (the validator
> rejects the combination).

## Service layout

App code lives under **`services/web/`**, not the template root. `path:` in
`cloudgrid.yaml` is the URL mount, not the filesystem path — the service named
`web` means the CLI looks for `services/web/`. Files at the root fail with
`Error: Service directory not found: …/services/web`.

## The domain

- Collection: **`checks`**. Document: `{ service, status, latencyMs, at }`.
- `status` is one of `up`, `degraded`, `down` (validated server-side).
- `latencyMs` is an optional non-negative number.
- `at` is a server-set `Date`.
- **Status grid** = the latest check per service (derived on the server, and
  recomputed on the client after each POST).
- **History** = the most recent 200 checks, newest first.

## Run locally

```bash
npm install
grid dev          # runs Next.js with DATABASE_MONGODB_URL injected against dev Mongo
```

## Deploy

```bash
grid plug         # builds + deploys the folder (async — poll status until live)
```

A runtime deploy is asynchronous: `plug` returns `status: building`; poll status
until the app is live, then use the returned live URL. Re-plug the same entity
to update the same URL.

## File tree

```
cloudgrid.yaml                          # name + services.web (nextjs) + needs: { database: true }
services/web/package.json               # next, react, react-dom, mongodb driver only
services/web/lib/db.js                  # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/app/layout.js              # root layout + inline CSS
services/web/app/page.js                # server component: reads checks, derives status grid
services/web/app/check-form.js          # client form + status grid + history table
services/web/app/api/checks/route.js    # GET (list) / POST (record) / DELETE (remove)
```

## Adapt it

- Rename the `checks` collection in `services/web/app/api/checks/route.js` and
  `services/web/app/page.js` (e.g. `pings`, `incidents`, `samples`).
- Change the document fields (add `region`, `endpoint`, `httpStatus`).
- Add an uptime percentage or a sparkline from the history.
- Add `cache: true` to `needs:` only if you actually need Redis.
