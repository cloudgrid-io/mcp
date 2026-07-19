# AGENTS.md — erp blueprint (structure guide)

This is a **blueprint**, not runnable app code. It is large and multi-module:
inventory + orders + finance + HR, plus auth/RBAC. Do NOT expect a `page.js` to
copy — read this guide, then **build** the app under `services/web/` following
the tree, the collections, and the CloudGrid wiring below. It is one Next.js
service (App Router) that hosts every module as its own API-route group and UI
section, backed by the grid-shared Mongo. Keep it a single `web` service unless
a module genuinely needs to scale independently (only then split into a second
service and wire it with `calls:` / `callers:`).

## 1. File tree (build this under `services/web/`)

Service code MUST live under `services/web/` — `path: /` in `cloudgrid.yaml` is
the URL mount, NOT the filesystem path. Files at the repo root fail with
`Error: Service directory not found: …/services/web`.

```
cloudgrid.yaml                                 # name + services.web (nextjs) + needs:{database:true} + vault:
services/web/package.json                      # next, react, react-dom, mongodb, + auth SDK (@clerk/nextjs) + stripe
services/web/middleware.js                     # auth gate (Clerk/Auth0) — protects all /(dashboard) + /api routes
services/web/lib/db.js                          # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/lib/auth.js                         # session + role helpers: currentUser(), requireRole('finance'|'hr'|...)
services/web/lib/stripe.js                       # lazy Stripe client from process.env.STRIPE_KEY (vault-injected)
services/web/app/layout.js                       # root layout + nav across modules
services/web/app/(dashboard)/page.js             # home / KPIs (server component)
services/web/app/(dashboard)/inventory/page.js   # inventory UI (items, stock)
services/web/app/(dashboard)/orders/page.js      # orders UI (order + line items)
services/web/app/(dashboard)/finance/page.js     # finance UI (invoices, payments)
services/web/app/(dashboard)/hr/page.js          # HR UI (employees, departments)
services/web/app/api/inventory/route.js          # GET/POST/PATCH/DELETE on `items`
services/web/app/api/orders/route.js             # GET/POST/PATCH on `orders` (decrements stock)
services/web/app/api/finance/invoices/route.js   # GET/POST on `invoices`; POST → Stripe checkout
services/web/app/api/finance/webhook/route.js    # Stripe webhook → mark invoice paid, record payment
services/web/app/api/hr/route.js                 # GET/POST/PATCH/DELETE on `employees`
```

Each module = one API-route group + one collection + one UI page. Add modules by
repeating the pattern; do not cram unrelated domains into one route file.

## 2. Mongo collections (one Mongo, many collections)

The grid provisions ONE Mongo database (from `needs: { database: true }`). Model
each module as a collection in that same DB — no per-module database.

- **items** (inventory): `{ sku, name, qty, reorderLevel, unitCost, updatedAt }`
- **orders**: `{ customer, lines: [{ sku, qty, unitPrice }], status: 'draft'|'placed'|'fulfilled', total, createdAt }` — placing an order decrements matching `items.qty`.
- **invoices** (finance): `{ orderId, amount, currency, status: 'open'|'paid', stripeSessionId, createdAt, paidAt }`
- **payments** (finance): `{ invoiceId, amount, stripePaymentIntent, receivedAt }`
- **employees** (hr): `{ name, email, department, title, role, startDate }` where `role` is the RBAC role (`admin`|`finance`|`hr`|`ops`).

Add indexes as the data grows (e.g. `items.sku` unique, `orders.status`).

## 3. How CloudGrid injects things (do NOT set these by hand)

- **Database (Mongo):** declared as `needs: { database: true }`. The deployer
  provisions Mongo and injects the connection string as `DATABASE_MONGODB_URL`
  (plus the legacy `MONGODB_URL` alias) at `grid dev` time and at runtime. Read
  `process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL` **lazily inside a
  getter** (`lib/db.js`), never at module top level — a top-level read fails
  `next build` because Next imports the module for route analysis before the grid
  injects the var. Never hardcode a connection string.
- **Secrets (auth + Stripe):** the `vault:` block in `cloudgrid.yaml` maps org
  vault items → env vars. `AUTH_PROVIDER_KEY: auth-provider-secret` and
  `STRIPE_KEY: stripe-live-key` become `process.env.AUTH_PROVIDER_KEY` and
  `process.env.STRIPE_KEY` at runtime. Put the real values in the org vault; the
  yaml only names the mapping. (One-off non-vault secrets can also go via
  `grid secrets set`; non-secret config via `grid env`.) Never commit a key.
- **AI (optional):** if a module uses AI (e.g. demand forecasting), add
  `ai: true` under `needs:` — the grid injects `AI_GATEWAY_URL`, called via
  `@cloudgrid-io/ai`. Not enabled by default in this blueprint.

## 4. Wiring auth + RBAC and payments

**Auth / RBAC (provider SDK, keys from vault):**
- Use a hosted provider SDK — Clerk (`@clerk/nextjs`) or Auth0. The backend API
  key comes from `process.env.AUTH_PROVIDER_KEY` (vault-injected); publishable
  front-end keys go via `grid env`.
- `services/web/middleware.js` gates the `(dashboard)` group and all `/api`
  routes — unauthenticated requests redirect to sign-in.
- `lib/auth.js` exposes `currentUser()` and `requireRole(role)`. Store each
  user's role on the `employees` document (or provider metadata) and enforce per
  module: finance routes require `finance`|`admin`, HR routes require `hr`|`admin`.

**Payments (Stripe, finance module):**
- `lib/stripe.js` builds a lazy Stripe client from `process.env.STRIPE_KEY`
  (vault-injected) — same lazy-getter rule as the DB.
- `POST /api/finance/invoices` creates the invoice doc and a Stripe Checkout
  Session; store `stripeSessionId` on the invoice.
- `POST /api/finance/webhook` verifies the Stripe signature, then on
  `checkout.session.completed` marks the invoice `paid` and inserts a `payments`
  record. Register this route's public URL as the webhook endpoint in Stripe.

## 5. Deploy (runtime, async)

1. Set `cloudgrid.yaml` to this blueprint's shape (services.web nextjs + path:/,
   `needs: { database: true }`, and the `vault:` mappings), and build the app under
   `services/web/`.
2. `grid plug --no-deploy` — registers the entity from the manifest (honors its
   `name:`) and writes `.cloudgrid/link.json`, without building yet.
3. Put real secret values in the org vault so the `vault:` mappings resolve; set
   any publishable/front-end config via `grid env`.
4. `grid plug` to deploy. A runtime deploy is **async** — the first response is
   `status: building`, not a live URL. Poll `grid status` (or the returned
   poll_url) until live; surface a liveness signal while it builds; then return
   the live app URL (not the build/log link). Re-plug the SAME entity to update
   the same URL.
5. Optionally `grid dev` first to run locally against the injected dev Mongo.

## 6. Edition note

A runtime app is a built + deployed container, so it requires the **local
edition** (Claude Code / Claude Desktop) or the CLI. The hosted edition (Claude
Web / hosted MCP) is inline-only and can only publish static pages — it cannot
build this ERP. Edition-gate before starting the runtime path.
