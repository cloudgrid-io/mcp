# api-service template — REST/JSON API on Node + Mongo

A minimal but real, deployable backend API. It is a plain Node `http` service
(no web UI, no framework) that serves a small REST resource (`/items`) backed by
the grid-shared MongoDB, so data survives refresh and is shared across sessions.
This is the plain-service sibling of `app-with-data` — reach for it when the user
wants a backend/API, not a full web app.

## How the grid gives you a database

You do **not** provision a database or set a connection string. In
`cloudgrid.yaml` you declare `needs: { database: true }`, and the grid:

- provisions shared Mongo for the service, and
- injects the connection string as the **`DATABASE_MONGODB_URL`** environment
  variable (plus the legacy `MONGODB_URL` alias) — at dev-time (`grid dev`) and
  at runtime (after `grid plug`).

The service reads it via `process.env.DATABASE_MONGODB_URL` (with a legacy
`process.env.MONGODB_URL` fallback) inside `getDb` — **lazily, never at module
top level.** A top-level read throws at node startup, before the grid injects
the var, and crashes the service. Never hardcode a connection string; never
commit a secret.

> **Declare `needs: { database: true }` (the canonical shape).** The deployer
> provisions Mongo and injects `DATABASE_MONGODB_URL` (plus the legacy
> `MONGODB_URL` alias). `requires:` is the deprecated v1 alias — don't author new
> yaml with it, and never set `needs:` and `requires:` together (the validator
> rejects the combination).

## Service layout

Service code lives under **`services/api/`**, not the template root. `path:` in
`cloudgrid.yaml` is the URL mount, not the filesystem path — the service named
`api` means the CLI looks for `services/api/`. Files at the root fail with
`Error: Service directory not found: …/services/api`.

The server listens on `process.env.PORT || 8080` — the grid injects `PORT`; the
`8080` default is for local runs.

## Run locally

```bash
cd services/api && npm install && cd -
grid dev          # runs the service with DATABASE_MONGODB_URL injected against dev Mongo
```

Then hit it:

```bash
curl -s localhost:8080/items
curl -s -XPOST localhost:8080/items -H 'content-type: application/json' -d '{"text":"hello"}'
```

## Deploy

```bash
grid plug         # builds + deploys the folder (async — poll status until live)
```

A runtime deploy is asynchronous: `plug` returns `status: building`; poll status
until the service is live, then use the returned live URL. Re-plug the same
entity to update the same URL.

## File tree

```
cloudgrid.yaml                 # name + services.api (node) + needs: { database: true }
services/api/package.json      # type: module, main src/index.js, mongodb driver only
services/api/src/index.js      # Node http server on PORT||8080; /items GET/POST/DELETE on Mongo
```

## Endpoints

| Method | Path              | Description                          |
|--------|-------------------|--------------------------------------|
| GET    | `/`               | service banner + endpoint list       |
| GET    | `/items`          | list items, newest first             |
| POST   | `/items`          | create an item; body `{ "text": … }` |
| DELETE | `/items?id=<id>`  | remove an item by id                 |

## Adapt it

- Rename the `items` collection and change the document fields to your resource.
- Add more routes/resources as the API grows.
- Return clear JSON errors (`{ "error": … }`) with the right status codes.
- Add more `needs:` (e.g. `cache: true`) only if you actually use them.
