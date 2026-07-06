# Template: admin-dashboard (persistent Next.js + Mongo admin panel)

A real, deployable back-office. It manages two generic resources (`users` and
`orders`) in the grid-shared MongoDB, so records survive refresh and are shared
across sessions. Same proven shape as `app-with-data`, adapted to a metrics
header (counts + revenue) over a couple of collections plus a management table
with add/delete.

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
cloudgrid.yaml                          # name + services.web (nextjs) + needs: { database: true }
services/web/package.json               # next, react, react-dom, mongodb driver only
services/web/lib/db.js                  # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/app/layout.js              # root layout + inline CSS
services/web/app/page.js                # server component: reads users + orders, computes metrics
services/web/app/resource-table.js      # generic client table (POST add / DELETE remove), reused per resource
services/web/app/api/users/route.js     # GET / POST / DELETE on the users collection
services/web/app/api/orders/route.js    # GET / POST / DELETE on the orders collection
```

## cloudgrid.yaml

```yaml
name: my-admin
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

## The collections

Two generic resources, each its own Mongo collection and App-Router route:

- `users` — `{ name, email, role, createdAt }` (role: admin / member / viewer).
- `orders` — `{ customer, amount, status, createdAt }` (status: pending / paid /
  shipped).

The page is a server component that reads both, computes a metrics header (user
count, order count, total revenue), and renders a reusable client
`ResourceTable` per resource. Each route does GET (list), POST (add), DELETE
(remove).

## Adapt it

- Rename or replace the `users` / `orders` collections and routes with your own
  resources.
- Add or change fields by editing the `columns` config passed to `ResourceTable`
  in `services/web/app/page.js` and the matching route's document shape.
- Add PATCH (edit) or extra metrics as the panel grows.
- Add `cache: true` to `needs:` only if you actually need Redis.
- Run `grid dev` to test locally, `grid plug` to deploy (async — poll to live).
