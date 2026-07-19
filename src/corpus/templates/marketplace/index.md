# Template: marketplace (blueprint — persistent Next.js + Mongo + Stripe Connect)

A **blueprint** for a two-sided / multi-vendor marketplace: vendors, listings,
orders, seller auth with roles, Stripe Connect payouts, and commission logic. It
is the persistent Next.js + Mongo runtime shape (same base as `app-with-data` /
`crm`) with auth + payments layered on. This template ships **structure, not app
code** — read the structure guide, then build the app following it.

**This is a blueprint (tier C):** the deliverable is `cloudgrid.yaml` +
`AGENTS.md`. Fetch the bundle, read `AGENTS.md`, then generate the files under
`services/web/` and deploy.

- **Structure guide:** `grid_get_template("template", "marketplace")` → read
  **`AGENTS.md`** (file tree, Mongo collections, CloudGrid injection table, auth +
  Stripe Connect wiring, deploy steps, edition note).

**Key rules (same runtime discipline as `app-with-data`):**

1. **App code MUST live under `services/web/`, not the repo root.** `path: /` in
   `cloudgrid.yaml` is the URL mount, NOT the filesystem path.
2. **Read injected connection strings/keys LAZILY (inside a getter), never at
   module top level** — a top-level read fails `next build`. The grid injects
   `DATABASE_MONGODB_URL` (+ legacy `MONGODB_URL`); vault injects `STRIPE_KEY`,
   `STRIPE_WEBHOOK_SECRET`, `AUTH_PROVIDER_KEY`.
3. **Declare the datastore with `needs: { database: true }`** (canonical shape),
   and map secrets with the `vault:` block. Never author `requires:`, and never
   set `needs:` and `requires:` together (the validator rejects the combination).
4. **Store money as integer cents; keep the commission take-rate as a pure
   function** (`lib/commission.js`) so the platform-fee/seller-payout split is
   testable.

Runtime app → **local edition** only (async build, poll to a live URL).

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: my-marketplace
services:
  web:
    type: nextjs
    path: /
needs:
  database: true
vault:
  STRIPE_KEY: stripe-live-key
  STRIPE_WEBHOOK_SECRET: stripe-webhook-secret
  AUTH_PROVIDER_KEY: auth-provider-key
```

> **Capability:** `needs: { database: true }` → the deployer provisions Mongo and
> injects `DATABASE_MONGODB_URL` (plus legacy `MONGODB_URL`). The `vault:` block
> maps org vault items → env vars (`STRIPE_KEY` for Stripe Connect payouts +
> Checkout, `STRIPE_WEBHOOK_SECRET` for webhook verification, `AUTH_PROVIDER_KEY`
> for the seller-auth SDK) — store the real values with `grid secrets set`. See
> the capability-map for the full injection table.

## Structure guide

The real content of this blueprint is **`AGENTS.md`** — fetch the template bundle
and read it. It covers the `services/web/` file tree, the `vendors` / `listings` /
`orders` collections, the CloudGrid injection table (needs + vault + AI gateway),
how to wire auth (Clerk/Auth0 + roles) and payments (Stripe Connect onboarding,
Checkout with `application_fee` + `transfer_data.destination`, and the signed
webhook), and the `write files → grid plug --no-deploy → secrets set → grid plug
→ poll` deploy flow.

## Adapt it

- Choose your auth provider SDK (Clerk or Auth0) and set the `role` claim.
- Set your commission take-rate in `lib/commission.js`.
- Add `needs: { ai: true }` (injects `AI_GATEWAY_URL`) only if you add AI features
  like listing generation or search.
- Build under `services/web/`, then `grid dev` (local) / `grid plug` (async — poll
  to a live URL). Point the Stripe webhook at `<live-url>/api/webhooks/stripe`.
