# AGENTS.md — billing-dashboard (blueprint)

This is a **blueprint**, not runnable app code. It tells an agent exactly how to
build a working SaaS billing dashboard on CloudGrid: a Next.js app that shows
customers, invoices, and charges, meters usage, renders a revenue view, and wires
**Stripe** for real payments (checkout + a signature-verified webhook). Data lives
in the grid-shared Mongo. Read this whole file, then write the files under
`services/web/` following the tree and wiring rules below.

The proven shape to imitate is `app-with-data` (Next.js App Router + `mongodb`
driver, lazy DB getter, app under `services/web/`). This blueprint adds the
billing collections, a Stripe client, checkout + webhook + usage-sync routes, and
a revenue dashboard view.

## 1. File tree

App code MUST live under `services/web/` — `path: /` in `cloudgrid.yaml` is the
URL mount, NOT the filesystem path. A service named `web` means the CLI looks for
`services/web/`; files at the project root fail with
`Error: Service directory not found: …/services/web`.

```
cloudgrid.yaml                                  # name + services.web (nextjs) + needs:{database:true} + vault:{STRIPE_KEY}
services/web/package.json                       # next, react, react-dom, mongodb, stripe
services/web/lib/db.js                           # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/lib/stripe.js                       # lazy Stripe client from process.env.STRIPE_KEY (injected by the vault: block)
services/web/lib/money.js                        # money helpers (all amounts are integer cents; format for display only)
services/web/app/layout.js                       # root layout + inline CSS (dashboard chrome / nav)
services/web/app/page.js                         # revenue overview: MRR, outstanding, recent invoices (server component)
services/web/app/customers/page.js               # customers list (server component, reads the customers collection)
services/web/app/customers/[id]/page.js          # customer detail: their invoices, charges, usage
services/web/app/invoices/page.js                # invoices list + status filter
services/web/app/invoices/invoice-actions.js     # "use client": create invoice, send/collect via Stripe Checkout
services/web/app/api/customers/route.js          # GET (list) / POST (create) — mirror to a Stripe Customer
services/web/app/api/invoices/route.js           # GET (list) / POST (create draft invoice with line items)
services/web/app/api/checkout/route.js           # POST: create a Stripe Checkout Session to collect an invoice
services/web/app/api/usage/route.js              # POST: record a metered-usage event for a customer/meter
services/web/app/api/webhook/route.js            # POST: Stripe webhook — verify signature, mark invoices paid, record charges
```

## 2. Mongo collections + fields

The grid provisions one Mongo database (`needs: { database: true }`). Store **all
money as integer cents** — never floats. Suggested collections:

**`customers`**
- `_id`               — ObjectId
- `name`              — string
- `email`             — string (unique per org)
- `stripeCustomerId`  — string (the `cus_…` id from Stripe; link, don't duplicate)
- `plan`              — string (e.g. `"free"`, `"pro"`, `"enterprise"`) — optional
- `createdAt`         — Date

**`invoices`**
- `_id`               — ObjectId
- `customerId`        — ObjectId ref → `customers`
- `number`            — string (human invoice number, e.g. `"INV-1042"`)
- `lineItems`         — array of `{ description, quantity, unitAmountCents }`
- `amountDueCents`    — integer (sum of line items; authoritative on the server)
- `currency`          — string, e.g. `"usd"`
- `status`            — string: `"draft"` → `"open"` → `"paid"` / `"void"` (set to
                        `paid` ONLY by the webhook)
- `stripeSessionId`   — string (Checkout Session id used to collect it; idempotency key)
- `dueDate`           — Date
- `createdAt`         — Date

**`charges`**
- `_id`               — ObjectId
- `customerId`        — ObjectId ref → `customers`
- `invoiceId`         — ObjectId ref → `invoices` (nullable for one-off charges)
- `amountCents`       — integer (authoritative total from the verified Stripe event)
- `currency`          — string
- `stripePaymentId`   — string (`pi_…` / `ch_…`; unique — idempotency)
- `status`            — string: `"succeeded"` / `"refunded"`
- `createdAt`         — Date

**`usage_events`** (metering → revenue)
- `_id`               — ObjectId
- `customerId`        — ObjectId ref → `customers`
- `meter`             — string (e.g. `"api_calls"`, `"seats"`, `"gb_egress"`)
- `quantity`          — number
- `ts`                — Date (event time; aggregate per billing period)

Derive the revenue view by aggregating: **MRR / period revenue** from `charges`
with `status: "succeeded"`, **outstanding** from `invoices` with `status: "open"`,
and **usage** rolled up from `usage_events` per `customerId` + `meter` for the
current period. Never trust amounts sent by the browser — the checkout route
builds line items from the server-side `invoices` doc, and the webhook records the
total from the verified Stripe event.

## 3. How CloudGrid injects things (do NOT hardcode any of this)

- **Mongo:** declare `needs: { database: true }`. The platform provisions Mongo
  and injects the connection string as **`DATABASE_MONGODB_URL`** (plus the legacy
  **`MONGODB_URL`** alias) at dev-time (`grid dev`) and at runtime (after
  `grid plug`). Read it as `process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL`
  **lazily inside a getter**, never at module top level — a top-level read fails
  `next build`, which imports the module for route analysis before the grid injects
  the var. Never hardcode a connection string; never commit a secret.
- **Stripe secret:** put it in the vault, not in code. The `vault:` block in
  `cloudgrid.yaml` maps the vault item `stripe-live-key` to the env var
  **`STRIPE_KEY`**. Set the vault item once with `grid secrets set stripe-live-key`
  (paste the `sk_live_…` / `sk_test_…` key); the platform injects it as
  `process.env.STRIPE_KEY`. Read it lazily in `services/web/lib/stripe.js`.
- **Stripe webhook signing secret:** the `whsec_…` value Stripe gives you for the
  webhook endpoint. Add it to the vault and map it in the `vault:` block, e.g.
  `STRIPE_WEBHOOK_SECRET: stripe-webhook-secret`, then verify events with
  `stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET)`.
- **Public base URL:** Stripe Checkout needs absolute `success_url` / `cancel_url`.
  Derive them from the incoming request (`new URL(request.url).origin`) rather than
  hardcoding the live host, so it works in `grid dev` and after `grid plug`.
- **Secrets via vault → env vars, non-secret config via env:** any provider key
  (Stripe, an auth provider, an email sender) goes in the vault and is mapped in
  `vault:`; non-secret flags (log level, default currency) can be plain
  `services.web.env` entries or `grid env`.
- **AI (only if you add it, e.g. an AI usage-forecast):** declare
  `needs: { ai: true }` and the platform injects **`AI_GATEWAY_URL`**; call it via
  `@cloudgrid-io/ai`. Not required for a billing dashboard.

## 4. Wiring payments (Stripe) — and optional auth

**Create-invoice + checkout (`app/api/invoices/route.js`, `app/api/checkout/route.js`):**
1. Create a `draft` invoice server-side from `lineItems`; compute
   `amountDueCents` as the sum of `quantity * unitAmountCents` — never trust a
   total sent by the browser.
2. To collect it, `POST /api/checkout` with the `invoiceId`. Load the invoice from
   Mongo, build Stripe `line_items` with `price_data` from the stored line items
   (`unit_amount: unitAmountCents`, `currency`).
3. `stripe.checkout.sessions.create({ mode: "payment", customer: <stripeCustomerId>,
   line_items, metadata: { invoiceId }, success_url: origin +
   "/invoices?paid={CHECKOUT_SESSION_ID}", cancel_url: origin + "/invoices" })`.
4. Save `stripeSessionId` on the invoice, set `status: "open"`, return
   `{ url: session.url }`; the client redirects to it.

**Webhook (`app/api/webhook/route.js`):**
1. Read the **raw** body — in the App Router use `await request.text()`, do NOT
   `request.json()`; signature verification needs the exact bytes.
2. Verify with `stripe.webhooks.constructEvent(rawBody,
   request.headers.get("stripe-signature"), process.env.STRIPE_WEBHOOK_SECRET)`.
3. On `checkout.session.completed`: find the invoice by `metadata.invoiceId` (or
   `stripeSessionId`), set `status: "paid"`, and insert a `charges` doc with the
   authoritative `amountCents = event.data.object.amount_total` and the payment id
   — upsert by `stripePaymentId` so retries are idempotent.
4. On `charge.refunded`: mark the matching `charges` doc `refunded`.
5. Return `200` fast; return `400` if verification fails. Register the endpoint URL
   (`<live-url>/api/webhook`) in the Stripe dashboard and copy its `whsec_…` secret
   into the vault.

**Usage metering (`app/api/usage/route.js`):** `POST { customerId, meter, quantity }`
inserts a `usage_events` doc. Aggregate per period for the revenue view (and, if you
use Stripe metered prices, forward the quantity with
`stripe.billing.meterEvents.create(...)`).

**Optional auth (protect the dashboard / per-customer portal):** add a provider SDK
(Clerk, Auth0, or NextAuth). Put its keys in the vault and map them in the `vault:`
block, e.g. `AUTH_PROVIDER_KEY: clerk-secret-key` (plus any publishable key), read
them from `process.env`, and gate the dashboard pages behind the provider's
middleware. A billing dashboard is internal/admin, so add auth before exposing it
publicly.

## 5. Deploy steps

1. Write the app under `services/web/` and set `cloudgrid.yaml` to the shape in this
   template (name + `services.web` nextjs + `needs: { database: true }` + the
   `vault: { STRIPE_KEY: stripe-live-key }` block).
2. `grid plug --no-deploy` — registers the entity from the manifest (honors its
   `name:`) and writes `.cloudgrid/link.json`, without building yet.
3. `grid secrets set stripe-live-key` (and `stripe-webhook-secret` once you map it)
   so the vault items the `vault:` block references exist. Do NOT set
   `DATABASE_MONGODB_URL` yourself — the grid injects it.
4. (Optional) `grid dev` to run locally against the injected Mongo + your Stripe
   test key before deploying.
5. `grid plug` to build + deploy. A runtime deploy is **async**: `plug` returns
   `status: building`. Poll `grid status` until the entity is live; surface a
   liveness signal, never a bare silent wait. Only then return the live app URL.
6. Register `<live-url>/api/webhook` in the Stripe dashboard, copy its `whsec_…`
   into the vault, and re-`grid plug` the SAME entity (same URL) if you changed the
   `vault:` mapping.

## 6. Edition note

This is a **runtime app** (a built + deployed container), so it needs the **local
edition** (Claude Desktop / Claude Code) or the CloudGrid CLI. The hosted edition
(Claude Web / hosted MCP) is inline-only and can publish only static pages — it
cannot build this dashboard. If you are on hosted, offer a static revenue-view
mockup instead and stop the runtime path.

## 7. Self-check before you call it done

- App code is under `services/web/`, not the root.
- DB and Stripe clients are read LAZILY inside getters, never at module top level.
- All money is stored as integer cents; the revenue view aggregates from `charges`
  / `invoices` / `usage_events` server-side.
- Invoice totals are computed server-side; the webhook records the Stripe total and
  reads the RAW request body to verify the signature.
- `cloudgrid.yaml` active fields are exactly: `name`, `services.web {type:nextjs,
  path:/}`, `needs: { database: true }`, and the `vault:` block for `STRIPE_KEY`.
- No secret or connection string is committed anywhere.
