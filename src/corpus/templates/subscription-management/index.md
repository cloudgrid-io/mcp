# Template: subscription-management (BLUEPRINT — Next.js + Stripe + Mongo)

A self-serve subscription-management app. **Blueprint, not finished code**: it
ships the `cloudgrid.yaml` and a structure guide (`AGENTS.md`) so an agent can
build it correctly on CloudGrid — a Next.js app where a signed-in customer views
their current plan, changes/upgrades/downgrades or cancels it, and manages
billing through the Stripe Billing Portal, with a Stripe webhook syncing local
state and grid-shared Mongo. Read `AGENTS.md`, build the app under
`services/web/`, adapt plans/fields, then deploy (async — poll to a live URL).
Local edition only.

This is the **manage-what-you-already-have** surface (view / switch plan, update
payment method, cancel). For the sign-up + paywall + gated-content acquisition
flow, use the `membership-site` blueprint — the two share the same Stripe + Mongo
wiring.

**Fetch the bundle:**
- `gridctl_fetch("template", "subscription-management")` — this blueprint (`cloudgrid.yaml` + `AGENTS.md`).
- `gridctl_fetch("template", "app-with-data")` — the proven Next.js + Mongo shape to extend (lazy db client, App-Router API).

**Key rules:**

1. **Blueprint — read `AGENTS.md` first.** It has the file tree, Mongo
   collections (`customers`, `subscriptions`), CloudGrid injection table, and the
   Stripe change-plan / cancel / billing-portal / webhook wiring. Build following
   it; do not invent structure.
2. **App code MUST live under `services/web/`.** `path: /` is the URL mount, NOT
   the filesystem path. Root files fail with `Service directory not found`.
3. **Mongo via `needs:{database:true}`** → the grid injects
   `DATABASE_MONGODB_URL` (legacy `MONGODB_URL` fallback). Read it LAZILY inside
   the getter, never at module top level (top-level read fails `next build`).
4. **Secrets via the `vault:` block** → env vars. `STRIPE_KEY` and
   `STRIPE_WEBHOOK_SECRET` map to vault items; set them with `gridctl_secrets`,
   and the deployer injects them at runtime. Read lazily; do not commit keys or
   put secrets in `services.web.env` (publishable key + price ids go there).
5. **The webhook is the source of truth.** Change-plan / cancel APIs call Stripe;
   the `/api/webhook` route reconciles the `subscriptions` collection so Stripe
   and Mongo never diverge. Read plan/status server-side from Mongo, never trust
   the client. Validate requested plans against `lib/plans.js`.
6. **Never set `needs:` and `requires:` together** — `requires:` is the
   deprecated v1 alias.

## cloudgrid.yaml (active fields)

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: subscription-management
services:
  web:
    type: nextjs
    path: /
needs:
  database: true
vault:
  STRIPE_KEY: stripe-live-key
  STRIPE_WEBHOOK_SECRET: stripe-webhook-secret
```

> **Capability:** `needs: { database: true }` → the deployer provisions Mongo and
> injects `DATABASE_MONGODB_URL` (+ legacy `MONGODB_URL`). The `vault:` block maps
> Stripe secrets to env vars — the CloudGrid-correct way to inject credentials.
> `requires:` is the deprecated v1 alias; don't mix it with `needs:`. See the
> capability-map for the full injection table.

## Deploy (async, local edition)

`gridctl_init` first (creates the entity + link.json), write the app under
`services/web/`, set the vault secrets with `gridctl_secrets`, `gridctl_plug`
(async — poll `gridctl_status` to a live URL), then register the `/api/webhook`
URL in Stripe, configure the Billing Portal, and re-plug. Re-plug the same entity
to update the same URL.
