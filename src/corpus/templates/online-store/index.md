# Template: online-store (blueprint — Next.js + Mongo + Stripe)

A **blueprint** for a real e-commerce store on CloudGrid: a Next.js storefront +
cart, Stripe Checkout, a signature-verified Stripe webhook, and `products` +
`orders` in the grid-shared Mongo. This is **structure + `cloudgrid.yaml`, not
finished app code** — fetch `AGENTS.md` for the full build guide, then write the
app under `services/web/` and adapt it to the user's store.

**Key rules (same proven shape as `app-with-data`, plus payments):**

1. **App code MUST live under `services/web/`, not the root.** `path: /` in
   `cloudgrid.yaml` is the URL mount, NOT the filesystem path. Files at the root
   fail with `Error: Service directory not found: …/services/web`.
2. **Read the Mongo connection string LAZILY (inside a getter), never at module
   top level.** The grid injects it as `DATABASE_MONGODB_URL` (legacy
   `MONGODB_URL` alias) at dev-time and runtime; a top-level read fails
   `next build`. Never hardcode it; never commit a secret.
3. **Declare the datastore with `needs: { database: true }`** — the canonical
   shape. `requires:` is the deprecated v1 alias; never set `needs:` and
   `requires:` together (the validator rejects it).
4. **The Stripe secret comes from the vault, not code.** The `vault:` block maps
   the vault item `stripe-live-key` → env var `STRIPE_KEY`. Set it with
   `grid secrets set stripe-live-key`; read `process.env.STRIPE_KEY` lazily.
5. **Trust server-side prices only.** Build Stripe line items from the `products`
   collection; the webhook records the authoritative total from the verified
   Stripe event and reads the RAW request body for signature verification.

## File tree

```
cloudgrid.yaml                                  # name + services.web (nextjs) + needs:{database:true} + vault:{STRIPE_KEY}
services/web/package.json                       # next, react, react-dom, mongodb, stripe
services/web/lib/db.js                          # lazy Mongo client (DATABASE_MONGODB_URL / MONGODB_URL)
services/web/lib/stripe.js                      # lazy Stripe client (process.env.STRIPE_KEY)
services/web/lib/products.js                    # product catalog source
services/web/app/layout.js                      # root layout + inline CSS
services/web/app/page.js                        # storefront: lists products from Mongo
services/web/app/cart.js                        # "use client" cart (localStorage) + Checkout button
services/web/app/success/page.js                # post-checkout confirmation
services/web/app/api/checkout/route.js          # POST: create Stripe Checkout Session from the cart
services/web/app/api/webhook/route.js           # POST: verify signature, persist the paid order
services/web/app/api/products/route.js          # GET/POST: optional catalog admin CRUD
```

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: online-store
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

- **`products`** — `name`, `description`, `priceCents` (integer cents),
  `currency`, `image`, `active`.
- **`orders`** — `stripeSessionId` (unique, idempotency key), `items[]`,
  `amountTotalCents`, `currency`, `email`, `status` (`pending` → `paid`, set to
  paid ONLY by the webhook), `createdAt`.

## Build it

Fetch `grid_fetch("template", "online-store")` and read **`AGENTS.md`** — it
has the checkout + webhook wiring, the vault/secret setup, and the deploy steps
(`grid init` → write under `services/web/` → `grid secrets set` → `grid plug`,
async → poll to a live URL → register the webhook endpoint in Stripe). Adapt the
catalog, fields, and UI to the user's store.
