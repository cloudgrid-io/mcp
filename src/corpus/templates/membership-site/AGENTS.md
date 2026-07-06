# AGENTS.md — membership-site (BLUEPRINT)

This is a **blueprint**, not runnable code. It tells an agent how to build a
paid membership site correctly on CloudGrid: a Next.js app with auth, Stripe
subscription checkout, gated content routes that check membership status, and
Mongo for persistence. Read this whole file, then build the app under
`services/web/` following the structure below. Do not skip the CloudGrid wiring
rules — they are what make it deploy.

The proven persistent shape is `app-with-data` (Next.js + Mongo). This blueprint
extends it with auth + Stripe. Fetch that template for the Mongo lazy-client and
App-Router API pattern: `gridctl_fetch("template", "app-with-data")`.

## 1. File tree

Build exactly this layout. **App code MUST live under `services/web/`** — the
service is named `web`, so the CLI looks for `services/web/`. `path: /` in
`cloudgrid.yaml` is the URL mount, NOT the filesystem path. Files at the repo
root fail with `Error: Service directory not found: …/services/web`.

```
cloudgrid.yaml                                 # name + services.web (nextjs) + needs:{database:true} + vault: (Stripe/auth secrets)
services/web/package.json                      # next, react, react-dom, mongodb, stripe, + auth SDK (e.g. @clerk/nextjs)
services/web/middleware.js                     # auth middleware: protects /members/* — redirects anon to sign-in
services/web/lib/db.js                         # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/lib/stripe.js                     # lazy Stripe client from process.env.STRIPE_KEY (never top-level)
services/web/lib/membership.js                 # getMembership(userId): read status from the memberships collection
services/web/app/layout.js                     # root layout (+ auth provider wrapper if the SDK needs one)
services/web/app/page.js                       # public marketing / paywall landing page + "Subscribe" CTA
services/web/app/members/layout.js             # gate: server-side check membership status; redirect non-members to /pricing
services/web/app/members/page.js               # gated subscriber content (only active members reach it)
services/web/app/pricing/page.js               # plans + "Subscribe" button → POST /api/checkout
services/web/app/api/checkout/route.js         # POST: create a Stripe Checkout Session (mode: subscription) → return url
services/web/app/api/webhook/route.js          # POST: Stripe webhook — upsert membership status on subscription events
services/web/app/api/me/route.js               # GET: current user's membership status (for client components)
```

## 2. Mongo collections + fields

The grid provisions Mongo from `needs: { database: true }`. Use two collections:

**`users`** — mirror of the auth provider's user (only if you store profile data
locally; many auth SDKs own the identity, so this may be optional).
- `_id` (ObjectId)
- `authId` (string) — the auth provider's user id (Clerk/Auth0 `sub`)
- `email` (string)
- `createdAt` (Date)

**`memberships`** — the source of truth for who is a paying member. Gating reads
this, and the Stripe webhook writes it.
- `_id` (ObjectId)
- `authId` (string, indexed) — links to the signed-in user
- `stripeCustomerId` (string)
- `stripeSubscriptionId` (string)
- `plan` (string) — e.g. `"monthly"`, `"annual"`
- `status` (string) — `"active" | "trialing" | "past_due" | "canceled"`
- `currentPeriodEnd` (Date) — when access lapses if not renewed
- `updatedAt` (Date)

A user is a member when a `memberships` doc for their `authId` has
`status ∈ {active, trialing}` and `currentPeriodEnd` is in the future.

## 3. How CloudGrid injects everything (the wiring that matters)

- **Mongo** — declared by `needs: { database: true }`. The deployer provisions
  shared Mongo and injects the connection string as **`DATABASE_MONGODB_URL`**
  (plus the legacy **`MONGODB_URL`** alias) at runtime and under `grid dev`.
  Read `process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL` **LAZILY,
  inside the getter** in `lib/db.js` — never at module top level, or `next build`
  fails when it imports the module for route analysis before the grid injects
  the var. Never hardcode a connection string. Never set `needs:` and `requires:`
  together — `requires:` is the deprecated v1 alias.
- **Secrets (Stripe + auth) → env vars via the `vault:` block.** In
  `cloudgrid.yaml` the `vault:` block maps each env var to a vault item key:
  ```yaml
  vault:
    STRIPE_KEY: stripe-live-key
    STRIPE_WEBHOOK_SECRET: stripe-webhook-secret
    AUTH_PROVIDER_KEY: auth-provider-key
  ```
  Set the vault items ONCE with `gridctl_secrets` (or `grid secrets set`), then
  the deployer injects each as the named env var (`process.env.STRIPE_KEY`, etc.)
  at runtime and under `grid dev`. Do NOT commit keys; do NOT set them in
  `services.web.env` (that block is for non-secret config only). Read them
  lazily inside `lib/stripe.js` and the auth setup — same rule as the DB.
- **Public auth keys** — SDKs like Clerk also need a *publishable* key on the
  client (`NEXT_PUBLIC_...`). Publishable keys are not secret; put them in the
  non-secret `services.web.env` block (or as a build-time env) rather than the
  vault.
- **AI (optional)** — if you add AI features, declare `needs: { ai: true }` and
  call the gateway at `process.env.AI_GATEWAY_URL` via `@cloudgrid-io/ai`. Not
  required for this blueprint.

## 4. Wiring auth + payments

**Auth (provider SDK, e.g. Clerk or Auth0).**
1. Add the SDK to `services/web/package.json` (e.g. `@clerk/nextjs`).
2. Server key from the vault (`process.env.AUTH_PROVIDER_KEY`); publishable key
   from `services.web.env` as `NEXT_PUBLIC_...`.
3. Wrap the app in the provider in `app/layout.js`.
4. `services/web/middleware.js` protects `/members/*` (and `/api/checkout`) —
   the SDK's middleware redirects unauthenticated users to sign-in. Auth answers
   "who are you"; it does NOT answer "have you paid" — that is the membership
   check below.

**Payments (Stripe subscriptions).**
1. Add `stripe` to `package.json`. Build a lazy Stripe client in `lib/stripe.js`
   reading `process.env.STRIPE_KEY` inside the getter.
2. **Checkout** — `app/api/checkout/route.js` (POST): require an authenticated
   user (from the auth SDK), create a Stripe Checkout Session with
   `mode: "subscription"` and your price id, set `success_url` /`cancel_url`,
   stash `authId` in the session `metadata`, return `session.url`. The pricing
   page's Subscribe button POSTs here and redirects the browser to the returned
   URL.
3. **Webhook** — `app/api/webhook/route.js` (POST): the source of truth for
   membership. Verify the signature with `process.env.STRIPE_WEBHOOK_SECRET`
   (read the RAW request body — do not JSON-parse before verifying). On
   `checkout.session.completed`, `customer.subscription.updated`, and
   `customer.subscription.deleted`, upsert the `memberships` doc keyed by
   `authId` with the new `status` / `currentPeriodEnd`. Register this route's
   public URL as the webhook endpoint in the Stripe dashboard after deploy.

**Gating (the membership check).**
- `lib/membership.js` exports `getMembership(authId)` → reads the `memberships`
  collection and returns whether the user is active.
- `app/members/layout.js` is a server component: get the signed-in `authId`,
  call `getMembership`, and if not active `redirect("/pricing")`. Every route
  under `/members/*` is gated by this layout — content only renders for paying
  members. Do the check server-side; never gate purely on the client.

## 5. Deploy steps

1. `gridctl_login_status` → `gridctl_login` if needed. Respect the grid picker
   (ask which grid if the user has more than one).
2. `gridctl_init` an app `<name>` FIRST — it creates the entity, writes
   `.cloudgrid/link.json`, and a `cloudgrid.yaml` with empty `services: {}`.
   `plug` needs a linked directory.
3. Write the app under `services/web/` and set `cloudgrid.yaml` to the active
   shape: `name` + `services.web{type: nextjs, path: /}` + `needs:{database:true}`
   + the `vault:` block.
4. Set the secrets: `gridctl_secrets` for `stripe-live-key`,
   `stripe-webhook-secret`, `auth-provider-key` (the vault item keys the
   `vault:` block maps from). Non-secret config (publishable auth key, price id)
   → `gridctl_env` / `services.web.env`. Do NOT set `DATABASE_MONGODB_URL`
   yourself — the grid injects it.
5. `gridctl_plug` to deploy. A runtime deploy is **ASYNC** — the first response
   is `status: building`, not a live URL. Poll `gridctl_status` (or the returned
   poll_url) until live; surface a liveness signal while it builds, never a bare
   silent wait.
6. Once live, add the `/api/webhook` URL as the Stripe webhook endpoint and copy
   the signing secret into the `stripe-webhook-secret` vault item, then re-plug.
   Return the live app URL (not the build/log link).

## 6. Edition note

A membership site is a built + deployed runtime container, so it requires the
**local edition** (Claude Desktop / Claude Code) or the CLI. The **hosted**
edition (Claude Web / hosted MCP) is inline-only and can only publish static
pages — it CANNOT build this app. On hosted, say so plainly and offer a static
paywall-landing page (via `gridctl_drop`) instead, then stop the runtime path.
