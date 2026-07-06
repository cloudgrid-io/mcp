# AGENTS.md — online-store (blueprint)

This is a **blueprint**, not runnable app code. It tells an agent exactly how to
build a working e-commerce store on CloudGrid: a Next.js storefront with a cart,
Stripe checkout, a Stripe webhook that confirms payment, and orders persisted in
the grid-shared Mongo. Read this whole file, then write the files under
`services/web/` following the tree and wiring rules below.

The proven shape to imitate is `app-with-data` (Next.js App Router + `mongodb`
driver, lazy DB getter, app under `services/web/`). This blueprint adds a second
collection (`orders`), Stripe checkout, and a webhook.

## 1. File tree

App code MUST live under `services/web/` — `path: /` in `cloudgrid.yaml` is the
URL mount, NOT the filesystem path. A service named `web` means the CLI looks for
`services/web/`; files at the project root fail with
`Error: Service directory not found: …/services/web`.

```
cloudgrid.yaml                                  # name + services.web (nextjs) + needs:{database:true} + vault:{STRIPE_KEY}
services/web/package.json                       # next, react, react-dom, mongodb, stripe
services/web/lib/db.js                          # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/lib/stripe.js                      # lazy Stripe client from process.env.STRIPE_KEY (injected by the vault: block)
services/web/lib/products.js                    # product catalog source (seed array, or read the products collection)
services/web/app/layout.js                      # root layout + inline CSS
services/web/app/page.js                        # storefront: server component, lists products from Mongo
services/web/app/cart.js                        # "use client" cart UI (localStorage), "Checkout" button
services/web/app/success/page.js                # post-checkout confirmation (reads ?session_id, shows the order)
services/web/app/api/checkout/route.js          # POST: create a Stripe Checkout Session from the cart, return its URL
services/web/app/api/webhook/route.js           # POST: Stripe webhook — verify signature, persist the paid order
services/web/app/api/products/route.js          # GET (list) / POST (add) — optional admin CRUD for the catalog
```

## 2. Mongo collections + fields

The grid provisions one Mongo database (`needs: { database: true }`). Use two
collections:

**`products`**
- `_id`         — ObjectId
- `name`        — string
- `description` — string
- `priceCents`  — integer (store money in the smallest unit — cents — never floats)
- `currency`    — string, e.g. `"usd"`
- `image`       — string URL (optional)
- `active`      — boolean (hide without deleting)

**`orders`**
- `_id`               — ObjectId
- `stripeSessionId`   — string (Checkout Session id; unique — use it for idempotency)
- `items`             — array of `{ productId, name, priceCents, quantity }`
- `amountTotalCents`  — integer (authoritative total from the Stripe event, not the client)
- `currency`          — string
- `email`             — string (customer email from Stripe)
- `status`            — string: `"pending"` → `"paid"` (set to paid ONLY by the webhook)
- `createdAt`         — Date

Never trust prices sent by the browser. The checkout route builds line items from
the server-side `products` catalog; the webhook records the total from the
verified Stripe event.

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
  webhook endpoint. Add it to the vault too and map it in the `vault:` block, e.g.
  `STRIPE_WEBHOOK_SECRET: stripe-webhook-secret`, then verify events with
  `stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET)`.
- **Public base URL:** Stripe Checkout needs absolute `success_url` /`cancel_url`.
  Derive them from the incoming request (`new URL(request.url).origin`) rather than
  hardcoding the live host, so it works in `grid dev` and after `grid plug`.
- **AI (only if you add it):** declare `needs: { ai: true }` and the platform
  injects `AI_GATEWAY_URL`; call it via `@cloudgrid-io/ai`. Not required for a store.

## 4. Wiring payments (Stripe) — and optional auth

**Checkout route (`app/api/checkout/route.js`):**
1. Read the cart (array of `{ productId, quantity }`) from the POST body.
2. Load each product from the server-side `products` collection — never trust the
   client's prices.
3. Build Stripe `line_items` with `price_data` from the DB (`unit_amount:
   priceCents`, `currency`).
4. `stripe.checkout.sessions.create({ mode: "payment", line_items,
   success_url: origin + "/success?session_id={CHECKOUT_SESSION_ID}",
   cancel_url: origin + "/" })`.
5. Return `{ url: session.url }`; the client redirects to it.

**Webhook route (`app/api/webhook/route.js`):**
1. Read the **raw** body (in the App Router: `await request.text()` — do NOT
   `request.json()`; signature verification needs the exact bytes).
2. Verify with `stripe.webhooks.constructEvent(rawBody,
   request.headers.get("stripe-signature"), process.env.STRIPE_WEBHOOK_SECRET)`.
3. On `checkout.session.completed`, upsert the `orders` doc by `stripeSessionId`
   (idempotent — Stripe may retry), set `status: "paid"`, `amountTotalCents =
   event.data.object.amount_total`, and the customer email.
4. Return `200` fast; return `400` if verification fails.
   Register the endpoint URL (`<live-url>/api/webhook`) in the Stripe dashboard and
   copy its `whsec_…` secret into the vault.

**Optional auth (accounts / order history):** add a provider SDK (Clerk, Auth0,
or NextAuth). Put its keys in the vault and map them in the `vault:` block, e.g.
`AUTH_PROVIDER_KEY: clerk-secret-key` (and any publishable key), read them from
`process.env`, and gate the account/order-history pages behind the provider's
middleware. Not required for a basic store; add it only if the user wants logins.

## 5. Deploy steps

1. `grid init` an app `<name>` (creates the entity + `.cloudgrid/link.json`,
   writes a `cloudgrid.yaml` with empty `services: {}`). Run this FIRST — `plug`
   needs a linked directory.
2. Write the app under `services/web/` and set `cloudgrid.yaml` to the shape in
   this template (name + `services.web` nextjs + `needs: { database: true }` +
   the `vault: { STRIPE_KEY: stripe-live-key }` block).
3. `grid secrets set stripe-live-key` (and the webhook secret) so the vault items
   the `vault:` block references exist. Do NOT set `DATABASE_MONGODB_URL` yourself.
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
cannot build this store. If you are on hosted, offer a static storefront preview
instead and stop the runtime path.

## 7. Self-check before you call it done

- App code is under `services/web/`, not the root.
- DB and Stripe clients are read LAZILY inside getters, never at module top level.
- Prices come from the server-side catalog; the webhook records the Stripe total.
- The webhook reads the raw body and verifies the signature.
- `cloudgrid.yaml` active fields are exactly: `name`, `services.web {type:nextjs,
  path:/}`, `needs: { database: true }`, and the `vault:` block for `STRIPE_KEY`.
- No secret or connection string is committed anywhere.
