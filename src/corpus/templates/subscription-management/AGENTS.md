# AGENTS.md — subscription-management (BLUEPRINT)

This is a **blueprint**, not runnable code. It tells an agent how to build a
self-serve subscription-management app correctly on CloudGrid: a Next.js app
where a signed-in customer sees their current plan, changes/upgrades/downgrades
or cancels it, and manages billing (card, invoices) through the Stripe Billing
Portal — with a Stripe webhook keeping local subscription state in sync, and
Mongo for persistence. Read this whole file, then build the app under
`services/web/` following the structure below. Do not skip the CloudGrid wiring
rules — they are what make it deploy.

Scope note: this is the **manage-what-you-already-have** surface (view plan,
switch plan, update payment method, cancel), not the acquisition funnel. If the
user wants the *sign-up + paywall + gated content* flow, that is the
`membership-site` blueprint; this one owns the ongoing plan/billing lifecycle.
The two share the same Stripe + Mongo wiring.

The proven persistent shape is `app-with-data` (Next.js + Mongo). This blueprint
extends it with Stripe subscriptions + the Billing Portal. Fetch that template
for the Mongo lazy-client and App-Router API pattern:
`grid_get_template("template", "app-with-data")`.

## 1. File tree

Build exactly this layout. **App code MUST live under `services/web/`** — the
service is named `web`, so the CLI looks for `services/web/`. `path: /` in
`cloudgrid.yaml` is the URL mount, NOT the filesystem path. Files at the repo
root fail with `Error: Service directory not found: …/services/web`.

```
cloudgrid.yaml                                 # name + services.web (nextjs) + needs:{database:true} + vault: (Stripe secrets)
services/web/package.json                      # next, react, react-dom, mongodb, stripe (+ auth SDK if used, e.g. @clerk/nextjs)
services/web/middleware.js                     # auth middleware: protects /account/* + the subscription API routes
services/web/lib/db.js                         # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/lib/stripe.js                     # lazy Stripe client from process.env.STRIPE_KEY (never top-level)
services/web/lib/subscription.js               # getSubscription(customerRef): read current plan/status from subscriptions collection
services/web/lib/plans.js                      # plan catalog: { key, name, price, stripePriceId } for each plan (upgrade/downgrade options)
services/web/app/layout.js                     # root layout (+ auth provider wrapper if the SDK needs one)
services/web/app/page.js                       # entry: link to /account (or the plans view for the unsubscribed)
services/web/app/account/page.js               # THE dashboard: current plan, status, renewal date, "Change plan" + "Manage billing" + "Cancel"
services/web/app/account/plans.js              # client component: plan cards + change-plan / cancel buttons calling the API
services/web/app/api/subscription/route.js     # GET current subscription; PATCH to change plan (Stripe subscription update, prorated)
services/web/app/api/subscription/cancel/route.js  # POST: cancel at period end (or resume) via Stripe
services/web/app/api/portal/route.js           # POST: create a Stripe Billing Portal session → return url (card, invoices, receipts)
services/web/app/api/webhook/route.js          # POST: Stripe webhook — upsert subscription state on subscription/invoice events
```

## 2. Mongo collections + fields

The grid provisions Mongo from `needs: { database: true }`. Use two collections:

**`customers`** — links your app's user to their Stripe customer. (If an auth SDK
owns identity you may not need a separate profile store, but you DO need the
user↔`stripeCustomerId` mapping somewhere — keep it here.)
- `_id` (ObjectId)
- `userRef` (string, indexed) — your app's user id (auth provider `sub`, or email)
- `email` (string)
- `stripeCustomerId` (string, indexed) — the Stripe customer this user maps to
- `createdAt` (Date)

**`subscriptions`** — the local mirror of Stripe subscription state. The webhook
writes it; the account dashboard and plan-change API read it. Never trust the
client for plan/status — read this (kept current by the webhook).
- `_id` (ObjectId)
- `userRef` (string, indexed)
- `stripeCustomerId` (string, indexed)
- `stripeSubscriptionId` (string, indexed)
- `planKey` (string) — matches a `key` in `lib/plans.js` (e.g. `"basic"`, `"pro"`)
- `stripePriceId` (string) — the active Stripe price
- `status` (string) — `"active" | "trialing" | "past_due" | "canceled" | "incomplete"`
- `cancelAtPeriodEnd` (boolean) — user asked to cancel but access runs to period end
- `currentPeriodEnd` (Date) — renewal / lapse date shown on the dashboard
- `updatedAt` (Date)

## 3. How CloudGrid injects everything (the wiring that matters)

- **Mongo** — declared by `needs: { database: true }`. The deployer provisions
  shared Mongo and injects the connection string as **`DATABASE_MONGODB_URL`**
  (plus the legacy **`MONGODB_URL`** alias) at runtime and under `grid dev`.
  Read `process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL` **LAZILY,
  inside the getter** in `lib/db.js` — never at module top level, or `next build`
  fails when it imports the module for route analysis before the grid injects
  the var. Never hardcode a connection string. Never set `needs:` and `requires:`
  together — `requires:` is the deprecated v1 alias.
- **Secrets (Stripe) → env vars via the `vault:` block.** In `cloudgrid.yaml`
  the `vault:` block maps each env var to a vault item key:
  ```yaml
  vault:
    STRIPE_KEY: stripe-live-key
    STRIPE_WEBHOOK_SECRET: stripe-webhook-secret
  ```
  Set the vault items ONCE with `grid_set_secret` (or `grid secrets set`), then
  the deployer injects each as the named env var (`process.env.STRIPE_KEY`, etc.)
  at runtime and under `grid dev`. Do NOT commit keys; do NOT set them in
  `services.web.env` (that block is for non-secret config only). Read them lazily
  inside `lib/stripe.js` — same rule as the DB. If you add an auth SDK, add
  `AUTH_PROVIDER_KEY: auth-provider-key` to the vault block too.
- **Public / non-secret config** — the Stripe *publishable* key
  (`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`) and price ids are not secret; put them
  in the non-secret `services.web.env` block (or a build-time env), not the
  vault. An auth SDK's publishable key goes here too.
- **AI (optional)** — if you add AI features (e.g. churn-reason summaries),
  declare `needs: { ai: true }` and call the gateway at
  `process.env.RUNTIME_GATEWAY_URL` via `@cloudgrid-io/runtime`. Not required for this
  blueprint.

## 4. Wiring auth + payments

**Auth (identify the customer).** Every subscription action must be tied to a
known user — otherwise anyone could change anyone's plan.
1. Add an auth SDK to `services/web/package.json` (e.g. `@clerk/nextjs`, or
   Auth0) OR use your own session. Server key from the vault
   (`process.env.AUTH_PROVIDER_KEY`); publishable key from `services.web.env` as
   `NEXT_PUBLIC_...`.
2. `services/web/middleware.js` protects `/account/*` and the
   `/api/subscription*` + `/api/portal` routes — unauthenticated users get
   redirected to sign-in. Resolve the current `userRef` server-side in each API
   route and only ever act on THAT user's `stripeCustomerId`.

**Payments (Stripe subscriptions + Billing Portal).**
1. Add `stripe` to `package.json`. Build a lazy Stripe client in `lib/stripe.js`
   reading `process.env.STRIPE_KEY` inside the getter.
2. **Plan catalog** — `lib/plans.js` is the single source of which plans exist and
   their `stripePriceId`s. The dashboard renders from it; the change-plan API
   validates the requested plan against it (never accept an arbitrary price id
   from the client).
3. **Change plan** — `app/api/subscription/route.js` PATCH: resolve the user's
   `stripeSubscriptionId` from Mongo, look up the target `stripePriceId` from
   `lib/plans.js`, call Stripe `subscriptions.update` swapping the item's price
   with `proration_behavior` set as you want (e.g. `create_prorations`). Do NOT
   write the new plan to Mongo here — let the resulting webhook be the source of
   truth so Stripe and Mongo never diverge.
4. **Cancel / resume** — `app/api/subscription/cancel/route.js` POST: set
   `cancel_at_period_end: true` (or `false` to resume) on the Stripe
   subscription. Again, the webhook reconciles Mongo.
5. **Billing Portal** — `app/api/portal/route.js` POST: create a Stripe Billing
   Portal session (`billingPortal.sessions.create`) for the user's
   `stripeCustomerId` with a `return_url` back to `/account`, and return
   `session.url`. The "Manage billing" button POSTs here and redirects the
   browser to the returned URL — Stripe hosts card updates, invoices, and
   receipts, so you don't rebuild them.
6. **Webhook (source of truth)** — `app/api/webhook/route.js` POST: verify the
   signature with `process.env.STRIPE_WEBHOOK_SECRET` (read the RAW request body
   — do not JSON-parse before verifying). On `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`, and
   `invoice.payment_failed` / `invoice.paid`, upsert the `subscriptions` doc
   keyed by `stripeSubscriptionId` with the new `planKey` / `stripePriceId` /
   `status` / `cancelAtPeriodEnd` / `currentPeriodEnd`. Register this route's
   public URL as the webhook endpoint in the Stripe dashboard after deploy.

**Reading state (the dashboard).**
- `lib/subscription.js` exports `getSubscription(userRef)` → reads the
  `subscriptions` collection and returns the current plan/status/renewal.
- `app/account/page.js` is a server component: resolve the signed-in `userRef`,
  call `getSubscription`, and render the current plan, status, renewal date, and
  the Change-plan / Manage-billing / Cancel actions. Read state server-side from
  Mongo; never derive entitlement purely on the client.

## 5. Deploy steps

1. `grid_login_status` → `grid_login` if needed. Respect the grid picker
   (ask which grid if the user has more than one).
2. `grid_create_project` an app `<name>` — it scaffolds the project folder and
   a `cloudgrid.yaml` with empty `services: {}`. No server entity exists yet —
   the first plug auto-creates it from the manifest (honoring its `name:`) and
   writes `.cloudgrid/link.json`.
3. Write the app under `services/web/` and set `cloudgrid.yaml` to the active
   shape: `name` + `services.web{type: nextjs, path: /}` + `needs:{database:true}`
   + the `vault:` block.
4. Set the secrets: `grid_set_secret` for `stripe-live-key`,
   `stripe-webhook-secret` (and `auth-provider-key` if you use an auth SDK) — the
   vault item keys the `vault:` block maps from. Non-secret config (Stripe
   publishable key, price ids, auth publishable key) → `grid_set_env` /
   `services.web.env`. Do NOT set `DATABASE_MONGODB_URL` yourself — the grid
   injects it.
5. `grid_deploy` to deploy. A runtime deploy is **ASYNC** — the first response
   is `status: building`, not a live URL. Poll `grid_status` (or the returned
   poll_url) until live; surface a liveness signal while it builds, never a bare
   silent wait.
6. Once live, add the `/api/webhook` URL as the Stripe webhook endpoint, copy
   the signing secret into the `stripe-webhook-secret` vault item, and configure
   the Billing Portal in the Stripe dashboard, then re-plug. Return the live app
   URL (not the build/log link).

## 6. Edition note

A subscription-management app is a built + deployed runtime container, so it
requires the **local edition** (Claude Desktop / Claude Code) or the CLI. The
**hosted** edition (Claude Web / hosted MCP) is inline-only and can only publish
static pages — it CANNOT build this app. On hosted, say so plainly and offer a
static pricing/plans page (via `grid_deploy`) instead, then stop the runtime
path.
