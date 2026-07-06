# crm template — persistent Next.js + Mongo contact manager

A real, deployable CRM. Contacts live in the grid-shared MongoDB, so they survive
refresh and are shared across users/sessions. Same proven shape as
`app-with-data`, adapted to a `contacts` domain (name, email, company, stage,
note) with a table view and per-row stage changes.

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
cloudgrid.yaml                            # name + services.web (nextjs) + needs: { database: true }
services/web/package.json                 # next, react, react-dom, mongodb driver only
services/web/lib/db.js                    # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/app/layout.js                # root layout + inline CSS
services/web/app/page.js                  # server component: reads contacts from Mongo
services/web/app/contact-manager.js       # client table: POST / PATCH (stage) / DELETE via the API
services/web/app/api/contacts/route.js    # GET (list) / POST (add) / PATCH (stage) / DELETE (remove)
```

## Adapt it

- Rename the `contacts` collection in `services/web/app/api/contacts/route.js`
  and `services/web/app/page.js` (e.g. `deals`, `companies`).
- Change the document fields (stages, owners, timestamps, deal values).
- Add more routes/collections as the CRM grows (companies, deals, activities).
- Add `cache: true` to `needs:` only if you actually need Redis.
