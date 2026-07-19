# Template: erp (enterprise resource planning — blueprint)

A **blueprint** (not runnable app code) for a multi-module ERP: inventory +
orders + finance + HR in one Next.js App-Router service, backed by grid-shared
Mongo, with auth/RBAC and Stripe billing. Large and multi-domain — you build the
app from this structure rather than copying files.

**Key rules:**

1. **This is a blueprint — read `AGENTS.md`, then build.** No `page.js` to copy.
   `AGENTS.md` is the structure guide: file tree, per-module Mongo collections,
   and CloudGrid wiring (DB injection, vault secrets, deploy). Build the app
   under `services/web/` following it.
2. **Service code MUST live under `services/web/`, not the repo root.** `path: /`
   in `cloudgrid.yaml` is the URL mount, NOT the filesystem path. Root files fail
   with `Error: Service directory not found: …/services/web`.
3. **Read the DB connection string LAZILY (inside a getter), never at module top
   level.** The grid injects it as `DATABASE_MONGODB_URL` (plus the legacy
   `MONGODB_URL` alias); a top-level read fails `next build`. Never hardcode it.
4. **Declare the datastore with `needs: { database: true }`.** The deployer
   provisions Mongo and injects the connection string. `requires:` is the
   deprecated v1 alias — don't author new yaml with it, and never set `needs:`
   and `requires:` together (the validator rejects the combination).
5. **Auth + Stripe secrets come from the `vault:` block.** It maps org vault
   items → env vars (`AUTH_PROVIDER_KEY`, `STRIPE_KEY`); the app reads
   `process.env.*` at runtime. Never commit a key.

## File tree (build this)

```
cloudgrid.yaml                                 # name + services.web (nextjs) + needs:{database:true} + vault:
services/web/package.json                      # next, react, react-dom, mongodb, auth SDK, stripe
services/web/middleware.js                     # auth gate over (dashboard) + /api
services/web/lib/db.js                          # lazy Mongo client (DATABASE_MONGODB_URL / MONGODB_URL)
services/web/lib/auth.js                         # currentUser() + requireRole()
services/web/lib/stripe.js                       # lazy Stripe client (STRIPE_KEY from vault)
services/web/app/(dashboard)/{inventory,orders,finance,hr}/page.js
services/web/app/api/inventory/route.js          # `items`
services/web/app/api/orders/route.js             # `orders` (decrements stock)
services/web/app/api/finance/invoices/route.js   # `invoices` → Stripe checkout
services/web/app/api/finance/webhook/route.js    # Stripe webhook → mark paid, record payment
services/web/app/api/hr/route.js                 # `employees`
```

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference)
# with EVERY field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: my-erp
vault:
  AUTH_PROVIDER_KEY: auth-provider-secret   # Clerk/Auth0 backend key (RBAC)
  STRIPE_KEY: stripe-live-key               # Stripe secret key (finance module)
services:
  web:
    type: nextjs
    path: /
needs:
  database: true
```

> **Capability:** this template needs `database: true` (Mongo → `DATABASE_MONGODB_URL`
> + legacy `MONGODB_URL`) and a `vault:` block for auth + Stripe secrets. Optional
> `ai: true` adds `RUNTIME_GATEWAY_URL` for forecasting. `requires:` is the deprecated v1
> alias — don't mix it with `needs:`. See the capability-map for the full injection
> table.

## The modules (one Mongo, many collections)

- **items** (inventory): `{ sku, name, qty, reorderLevel, unitCost, updatedAt }`
- **orders**: `{ customer, lines[], status, total, createdAt }` — placing decrements stock
- **invoices** + **payments** (finance): Stripe checkout + webhook flow
- **employees** (hr): `{ name, email, department, title, role, startDate }` — `role` drives RBAC

## Adapt it

- Read `AGENTS.md` for the full structure + wiring, then build under `services/web/`.
- Add or drop modules by repeating the route-group + collection + page pattern.
- Add `ai: true` to `needs:` only if a module needs the AI gateway.
- Run `grid dev` to test locally, `grid plug` to deploy (async — poll to live).
