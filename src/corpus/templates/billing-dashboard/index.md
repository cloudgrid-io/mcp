# Template: billing-dashboard (blueprint — Next.js + Mongo + Stripe)

A **blueprint** for a real SaaS billing dashboard on CloudGrid: a Next.js app with
`customers`, `invoices`, `charges`, and `usage_events` in the grid-shared Mongo,
usage metering, a revenue view (MRR / outstanding / recent invoices), Stripe
Checkout to collect invoices, and a signature-verified Stripe webhook. This is
**structure + `cloudgrid.yaml`, not finished app code** — fetch `AGENTS.md` for the
full build guide, then write the app under `services/web/` and adapt it to the
user's billing model.

**Key rules (same proven shape as `app-with-data`, plus payments):**

1. **App code MUST live under `services/web/`, not the root.** `path: /` in
   `cloudgrid.yaml` is the URL mount, NOT the filesystem path. Files at the root
   fail with `Error: Service directory not found: …/services/web`.
2. **Read the Mongo connection string LAZILY (inside a getter), never at module
   top level.** The grid injects it as `DATABASE_MONGODB_URL` (legacy `MONGODB_URL`
   alias) at dev-time and runtime; a top-level read fails `next build`. Never
   hardcode it; never commit a secret.
3. **Declare the datastore with `needs: { database: true }`** — the canonical
   shape. `requires:` is the deprecated v1 alias; never set `needs:` and `requires:`
   together (the validator rejects it).
4. **The Stripe secret comes from the vault, not code.** The `vault:` block maps the
   vault item `stripe-live-key` → env var `STRIPE_KEY`. Set it with
   `grid secrets set stripe-live-key`; read `process.env.STRIPE_KEY` lazily.
5. **Store money as integer cents and trust server-side amounts only.** Compute
   invoice totals server-side; the webhook records the authoritative total from the
   verified Stripe event and reads the RAW request body for signature verification.

## File tree

```
cloudgrid.yaml                                  # name + services.web (nextjs) + needs:{database:true} + vault:{STRIPE_KEY}
services/web/package.json                       # next, react, react-dom, mongodb, stripe
services/web/lib/db.js                          # lazy Mongo client (DATABASE_MONGODB_URL / MONGODB_URL)
services/web/lib/stripe.js                      # lazy Stripe client (process.env.STRIPE_KEY)
services/web/lib/money.js                       # money helpers (integer cents)
services/web/app/page.js                        # revenue overview (MRR / outstanding / recent invoices)
services/web/app/customers/page.js              # customers list + [id] detail
services/web/app/invoices/page.js               # invoices list + status filter
services/web/app/api/customers/route.js         # GET/POST customers (mirror to Stripe Customer)
services/web/app/api/invoices/route.js          # GET/POST invoices (draft with line items)
services/web/app/api/checkout/route.js          # POST: Stripe Checkout Session to collect an invoice
services/web/app/api/usage/route.js             # POST: record a metered-usage event
services/web/app/api/webhook/route.js           # POST: verify signature, mark invoices paid, record charges
```

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: billing-dashboard
vault:
  STRIPE_KEY: stripe-live-key
services:
  web:
    type: nextjs
    path: /
needs:
  database: true
```

> **Capability:** `needs: { database: true }` → the deployer provisions Mongo and
> injects `DATABASE_MONGODB_URL` (+ legacy `MONGODB_URL`). The `vault:` block maps
> the org vault item `stripe-live-key` to `STRIPE_KEY` at runtime. See the
> capability-map for the full injection table.

## Mongo collections

- **`customers`** — `name`, `email`, `stripeCustomerId` (`cus_…`), `plan`, `createdAt`.
- **`invoices`** — `customerId`, `number`, `lineItems[]`, `amountDueCents` (integer
  cents), `currency`, `status` (`draft` → `open` → `paid`/`void`, set to `paid` ONLY
  by the webhook), `stripeSessionId`, `dueDate`, `createdAt`.
- **`charges`** — `customerId`, `invoiceId`, `amountCents`, `currency`,
  `stripePaymentId` (unique, idempotency), `status` (`succeeded`/`refunded`), `createdAt`.
- **`usage_events`** — `customerId`, `meter`, `quantity`, `ts` (aggregate per period
  for the revenue view).

## Build it

Fetch `grid_get_template("template", "billing-dashboard")` and read **`AGENTS.md`** — it
has the checkout + webhook + usage wiring, the vault/secret setup, and the deploy
steps (write under `services/web/` → `grid plug --no-deploy` → `grid secrets set` →
`grid plug`, async → poll to a live URL → register the webhook endpoint in Stripe).
Adapt the
collections, fields, and UI to the user's billing model.
