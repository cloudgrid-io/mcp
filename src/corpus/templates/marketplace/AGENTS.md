# AGENTS.md — marketplace blueprint (structure guide)

This is a **blueprint**, not a runnable app. It ships a `cloudgrid.yaml` and this
guide so an agent can *build* a two-sided marketplace correctly on CloudGrid.
There is no app code to copy — read this, generate the files, then deploy.

A marketplace is a persistent Next.js + Mongo runtime app (same base shape as
`app-with-data` / `crm`) with three extra concerns layered on: **seller auth
with roles**, **Stripe Connect payouts**, and **commission logic**. All three are
wired through CloudGrid's injection mechanisms (needs / vault), never hardcoded.

---

## 1. File tree

App code MUST live under `services/web/` — `path: /` in `cloudgrid.yaml` is the
URL mount, NOT the filesystem path. Files at the repo root fail with
`Error: Service directory not found: …/services/web`.

```
cloudgrid.yaml                              # name + services.web(nextjs,/) + needs:{database:true} + vault (Stripe + auth)
services/web/
  package.json                              # next, react, react-dom, mongodb, stripe, + auth SDK (@clerk/nextjs or @auth0/nextjs-auth0)
  middleware.js                             # auth middleware: protect /dashboard + /api/seller/* ; attach role
  lib/
    db.js                                   # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback) — see rule below
    auth.js                                 # provider SDK init; getCurrentUser(); requireRole('seller'|'admin')
    stripe.js                               # lazy Stripe client from process.env.STRIPE_KEY (from vault)
    commission.js                           # pure fn: splitOrder(amount) -> { platformFee, sellerPayout } (e.g. 10% take rate)
  app/
    layout.js                              # root layout + auth provider wrapper
    page.js                                 # public storefront: listing grid across all vendors
    listings/[id]/page.js                  # public listing detail + "Buy" (starts Checkout)
    dashboard/page.js                       # seller dashboard (role-gated): my listings + payout status
    dashboard/listings/new/page.js         # seller: create/edit a listing
    api/
      vendors/route.js                     # GET list vendors / POST become-a-seller (creates Connect account link)
      listings/route.js                    # GET (public list) / POST (seller create) / PATCH / DELETE (owner only)
      orders/route.js                      # GET my orders / POST create order -> Stripe Checkout session
      checkout/route.js                    # POST -> Stripe Checkout session with application_fee + transfer_data.destination
      webhooks/stripe/route.js             # POST Stripe webhook: verify signature, mark order paid, record payout
      connect/route.js                     # POST -> Stripe Connect onboarding/account link for a seller
```

Keep it minimal and real; grow routes/collections as needed. Reuse the
`app-with-data` App-Router GET/POST/PATCH/DELETE route shape for the CRUD parts.

---

## 2. Mongo collections + fields

The grid provisions one MongoDB database (`needs: { database: true }`). Suggested
collections (`_id` is the Mongo ObjectId on every doc):

**`vendors`** — a seller account
- `userId` (string, from auth provider — the owner)
- `displayName` (string)
- `stripeAccountId` (string — the Stripe Connect `acct_…`, set after onboarding)
- `payoutsEnabled` (bool — mirror of Connect `charges_enabled`/`payouts_enabled`)
- `createdAt` (Date)

**`listings`** — a product/service offered by a vendor
- `vendorId` (ObjectId ref → vendors, OR the vendor's `userId`)
- `title` (string), `description` (string)
- `priceCents` (number — store money as integer cents, never floats)
- `currency` (string, e.g. `"usd"`)
- `status` (string: `draft` | `active` | `sold`)
- `createdAt` (Date)

**`orders`** — a buyer purchasing a listing
- `listingId` (ObjectId ref → listings)
- `vendorId` (ObjectId ref → vendors)
- `buyerUserId` (string, from auth provider)
- `amountCents` (number), `platformFeeCents` (number), `sellerPayoutCents` (number)
- `status` (string: `pending` | `paid` | `refunded`)
- `stripeCheckoutSessionId` (string), `stripePaymentIntentId` (string)
- `createdAt` (Date)

Roles are carried by the auth provider (a `role` claim/metadata:
`buyer` | `seller` | `admin`), NOT a separate collection — read it via the SDK.

---

## 3. How CloudGrid injects things

You never provision infra or set connection strings by hand. Declared inputs are
injected as env vars at `grid dev` (local) and at runtime (after `grid plug`):

| What | Declared in cloudgrid.yaml | Injected env var(s) | Read in code |
|------|----------------------------|---------------------|--------------|
| MongoDB | `needs: { database: true }` | `DATABASE_MONGODB_URL` (+ legacy `MONGODB_URL`) | `lib/db.js` |
| Stripe secret key | `vault: { STRIPE_KEY: stripe-live-key }` | `STRIPE_KEY` | `lib/stripe.js` |
| Stripe webhook secret | `vault: { STRIPE_WEBHOOK_SECRET: stripe-webhook-secret }` | `STRIPE_WEBHOOK_SECRET` | `api/webhooks/stripe/route.js` |
| Auth provider server key | `vault: { AUTH_PROVIDER_KEY: auth-provider-key }` | `AUTH_PROVIDER_KEY` | `lib/auth.js` |
| AI (optional) | `needs: { ai: true }` | `RUNTIME_GATEWAY_URL` | via `@cloudgrid-io/runtime` |

The `vault:` block only **maps** an org vault item key → an env var name. You must
store the real value once with `grid secrets set <vault-item-key> <value>` (e.g.
`grid secrets set stripe-live-key sk_live_…`). Never commit a secret; never
hardcode a connection string.

**DB read rule (critical):** read the Mongo URL LAZILY inside a getter, never at
module top level — a top-level `const uri = process.env.DATABASE_MONGODB_URL`
fails `next build` (the module is imported for route analysis before the grid
injects the var). Same pattern for the Stripe client in `lib/stripe.js`.

```js
// lib/db.js — same proven shape as app-with-data
import { MongoClient } from "mongodb";
export async function getDb() {
  const uri = process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL;
  if (!uri) throw new Error("DATABASE_MONGODB_URL not set — run via `grid dev` / `grid plug`.");
  globalThis.__mongo ??= new MongoClient(uri).connect();
  return (await globalThis.__mongo).db();
}
```

```js
// lib/stripe.js — lazy, reads the vault-injected STRIPE_KEY
import Stripe from "stripe";
export function stripe() {
  const key = process.env.STRIPE_KEY;
  if (!key) throw new Error("STRIPE_KEY not set — map it in cloudgrid.yaml `vault:` and `grid secrets set`.");
  globalThis.__stripe ??= new Stripe(key, { apiVersion: "2024-06-20" });
  return globalThis.__stripe;
}
```

---

## 4. Wiring auth (roles) + payments (Stripe Connect)

### Seller auth with roles
- Pick a provider SDK: **Clerk** (`@clerk/nextjs`) or **Auth0**
  (`@auth0/nextjs-auth0`). Add it to `package.json`.
- Initialize it in `lib/auth.js` using `process.env.AUTH_PROVIDER_KEY` (from the
  vault block). Some providers also need a public key — set non-secret public
  values via `grid env` (they are not secrets), secrets via `grid secrets set`.
- Store a `role` (`buyer` | `seller` | `admin`) in the provider's user
  metadata/claims. Expose `getCurrentUser()` and `requireRole(role)` helpers.
- In `middleware.js`, protect `/dashboard/**` and `/api/seller/**` (and any
  seller-only route): redirect anonymous users to sign-in, and 403 users whose
  role is not `seller`/`admin`.

### Stripe Connect payouts + commission
- **Onboarding:** `POST /api/connect` creates a Stripe Connect *Express* account
  for the seller (`stripe().accounts.create({ type: 'express' })`), stores
  `stripeAccountId` on the `vendors` doc, and returns an `accountLinks.create`
  onboarding URL. Refresh `payoutsEnabled` from the account's
  `charges_enabled`/`payouts_enabled`.
- **Checkout with commission:** `POST /api/checkout` creates a Checkout Session
  for the listing where the platform takes a fee and the rest routes to the
  seller's connected account:
  ```js
  const { platformFeeCents } = splitOrder(amountCents); // lib/commission.js, e.g. 10% take rate
  await stripe().checkout.sessions.create({
    mode: "payment",
    line_items: [{ price_data: { currency, product_data: { name: listing.title },
      unit_amount: amountCents }, quantity: 1 }],
    payment_intent_data: {
      application_fee_amount: platformFeeCents,
      transfer_data: { destination: vendor.stripeAccountId },
    },
    success_url, cancel_url,
  });
  ```
  Create the `orders` doc as `pending` here with the split amounts.
- **Webhook:** `POST /api/webhooks/stripe` verifies the signature with
  `stripe().webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET)`
  and on `checkout.session.completed` marks the matching order `paid` and records
  the payout. Read the RAW request body (do not JSON-parse before verifying).
- **Commission is a pure function** in `lib/commission.js` — keep the take-rate in
  one place so it is testable and auditable:
  `splitOrder(amountCents) => { platformFeeCents, sellerPayoutCents }`.

---

## 5. Deploy steps

Runtime app → **local edition** only (Claude Desktop / Claude Code / CLI); the
hosted edition cannot build a runtime container.

1. Put the app under `services/web/` and set `cloudgrid.yaml` to this
   blueprint's active fields (`services.web` nextjs `/`, `needs:{database:true}`,
   the `vault:` block).
2. `grid plug --no-deploy` — registers the entity from the manifest (honors its
   `name:`) and writes `.cloudgrid/link.json`, without building yet (the
   `grid_create_project` MCP tool does the same).
3. Store the secrets the vault block maps:
   `grid secrets set stripe-live-key sk_live_…`,
   `grid secrets set stripe-webhook-secret whsec_…`,
   `grid secrets set auth-provider-key …`. Non-secret public config → `grid env`.
4. (Optional) `grid dev` to run locally against the injected dev Mongo + secrets.
5. `grid plug` to deploy. A runtime deploy is **ASYNC** — the first response is
   `status: building`, not a live URL. Poll `grid status` (surface a liveness
   signal, never a bare wait) until Ready.
6. Once live, return the app URL. Point the Stripe webhook endpoint at
   `<live-url>/api/webhooks/stripe`. Re-plug the same entity to update the same URL.

---

## 6. Edition note

Because this is a built + deployed container (Next.js + Mongo + Stripe), it
requires the **local edition** (Claude Desktop / Claude Code) or the CLI. The
hosted edition (Claude Web / hosted MCP) is inline-only and can only publish
static pages — offer a static storefront mockup there, but the real marketplace
must be built and plugged from the local edition.
