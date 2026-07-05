# app-with-data template — persistent Next.js + Mongo app

A minimal but real, deployable to-do app. Data lives in the grid-shared MongoDB,
so it survives refresh and is shared across users/sessions — unlike a static
page whose state is in memory only.

## How the grid gives you a database

You do **not** provision a database or set a connection string. In
`cloudgrid.yaml` you declare `requires: [mongodb]`, and the grid:

- provisions shared Mongo for the app, and
- injects the connection string as the **`MONGODB_URL`** environment variable —
  at dev-time (`grid dev`) and at runtime (after `grid plug`).

The app reads it via `process.env.MONGODB_URL` in `services/web/lib/db.js` —
**lazily, inside the `getDb` getter, never at module top level** (a top-level
read fails `next build`, which imports the module for route analysis before the
grid injects the var). Never hardcode a connection string; never commit a
secret. (If you also declare `redis: private`, the grid injects `REDIS_URL` the
same way.)

> **Use `requires:` (NOT `needs:`).** The CLI warns `requires:` is deprecated,
> but the deployer currently only injects `MONGODB_URL` from `requires:` —
> migrating to `needs:` builds fine but injects NO DB connection (every request
> 500s). Keep `requires:` until CloudGrid's deployer honors `needs:`.

## Service layout

App code lives under **`services/web/`**, not the template root. `path:` in
`cloudgrid.yaml` is the URL mount, not the filesystem path — the service named
`web` means the CLI looks for `services/web/`. Files at the root fail with
`Error: Service directory not found: …/services/web`.

## Run locally

```bash
npm install
grid dev          # runs Next.js with MONGODB_URL injected against dev Mongo
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
cloudgrid.yaml                        # name + services.web (nextjs) + requires: [mongodb]
services/web/package.json             # next, react, react-dom, mongodb driver only
services/web/lib/db.js                # lazy Mongo client from process.env.MONGODB_URL
services/web/app/layout.js            # root layout + inline CSS
services/web/app/page.js              # server component: reads todos from Mongo
services/web/app/todo-form.js         # client form: POST/DELETE via the API
services/web/app/api/todos/route.js   # GET (list) / POST (add) / DELETE (remove)
```

## Adapt it

- Rename the `todos` collection in `services/web/app/api/todos/route.js` and
  `services/web/app/page.js` (e.g. `submissions`, `tasks`, `entries`).
- Change the document fields (add owners, timestamps, statuses).
- Add more routes/collections as the app grows.
- Add `redis: private` to `requires` only if you actually need Redis.
