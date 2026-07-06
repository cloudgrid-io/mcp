# Template: crm (persistent Next.js + Mongo contact manager)

A real, deployable CRM. Contacts live in the grid-shared MongoDB, so they survive
refresh and are shared across sessions. Same proven shape as `app-with-data`,
adapted to a `contacts` domain (name, email, company, stage, note) with a table
view and per-row stage changes.

**Key rules (all proven by the app-with-data end-to-end deploy):**

1. **Service code MUST live under `services/<name>/`, not the repo/template
   root.** `path:` in `cloudgrid.yaml` is the URL mount, NOT the filesystem path.
   The service named `web` → the CLI looks for `services/web/`. App files at the
   root fail with `Error: Service directory not found: …/services/web`.
2. **Read the DB connection string LAZILY (inside the getter), never at module
   top level.** The grid injects it as `DATABASE_MONGODB_URL` (plus the legacy
   `MONGODB_URL` alias) at dev-time and runtime; the app reads
   `process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL` inside `getDb`.
   A top-level read fails `next build`. Never hardcode a connection string; never
   commit a secret.
3. **Declare the datastore with `needs: { database: true }`.** The deployer
   provisions Mongo and injects the connection string. `requires:` is the
   deprecated v1 alias; don't author new yaml with it, and never set `needs:` and
   `requires:` together (the validator rejects the combination).

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

## cloudgrid.yaml

```yaml
name: my-crm
services:
  web:
    type: nextjs
    path: /
needs:
  database: true
```

> **Capability:** this template's need is `database: true`. The deployer
> provisions Mongo and injects `DATABASE_MONGODB_URL` (plus the legacy
> `MONGODB_URL` alias). `requires:` is the deprecated v1 alias — don't mix it with
> `needs:` (the validator rejects the combination). See the capability-map for
> the full injection table.

## The contacts collection

Documents: `{ name, email, company, stage, note, createdAt }` where `stage` is
one of `lead` / `qualified` / `customer`. The API route on `contacts` does GET
(list), POST (add), PATCH (change stage), DELETE (remove); the page is a server
component that reads the collection and hands it to a client table.

## Adapt it

- Rename the `contacts` collection to your data (`deals`, `companies`).
- Change the document fields; add owners, timestamps, deal values.
- Add more routes/collections as the CRM grows.
- Add `cache: true` to `needs:` only if you actually need Redis.
- Run `grid dev` to test locally, `grid plug` to deploy (async — poll to live).
