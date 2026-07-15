---
name: subscription-management
when: "subscription management, manage subscriptions, self-serve plans/billing"
needs: database
deploy: runtime
editions: local
kind: blueprint
capabilities_note: "persistent — needs a database (Mongo) plus Stripe subscription secrets. Runtime app, async build, local edition only. Declare needs { database: true } (deployer injects DATABASE_MONGODB_URL / legacy MONGODB_URL) and a vault block mapping STRIPE_KEY / STRIPE_WEBHOOK_SECRET to env vars. This is a BLUEPRINT — read AGENTS.md for the structure, then build."
summary: "Build a self-serve subscription-management app on the grid — a Next.js app where a signed-in customer views their current plan, changes/upgrades/downgrades or cancels it, and manages billing via the Stripe Billing Portal, with a Stripe webhook syncing local state and grid-shared Mongo (customers + subscriptions collections). This is a BLUEPRINT: fetch the template, read AGENTS.md for the file tree + CloudGrid wiring (needs database true, vault for Stripe secrets), build the app under services/web/, deploy async, poll to a live URL."
---

# Workflow: subscription-management

The user wants self-serve subscription management: a signed-in customer sees
their current plan, upgrades/downgrades or cancels it, and manages billing (card,
invoices, receipts) — with the app's state staying in sync with Stripe. That is a
**persistent runtime app** — a Next.js app backed by the grid's shared Mongo,
with Stripe subscription updates, the Stripe Billing Portal, and a webhook that
keeps local subscription state authoritative.

This is the **manage-what-you-already-have** surface. If the user actually wants
the sign-up + paywall + gated-content acquisition flow, that is the
`membership-site` workflow instead — the two share the same Stripe + Mongo wiring.

This is a **blueprint**, not a fill-in template. There is no finished app to
copy — there is a `cloudgrid.yaml` and a structure guide (`AGENTS.md`). Read the
guide, then build the app following it. Be honest that a runtime deploy is async
(not instant like a static drop) and that it needs the local edition.

## 1. Edition check FIRST (hard gate)

A subscription-management app is a built + deployed container. It requires the
**local edition** (Claude Desktop / Claude Code) or the CLI.

- **Hosted edition (Claude Web / hosted MCP):** you CANNOT build a runtime app —
  hosted is inline-only and can only publish static pages. Tell the user
  plainly, offer a **static pricing/plans page** instead, and STOP the runtime
  path here.
- **Local edition:** continue.

## 2. Auth + grid

1. Ensure signed in: `grid_login_status`; if not, `grid_login`.
2. A grid is required. Respect the grid picker: if the user has more than one
   grid, ask which to use; do not assume a target.

## 3. Read the blueprint

Fetch the template and read its structure guide — this is the core of the
workflow:

- `grid_fetch("template", "subscription-management")` — the `cloudgrid.yaml` +
  **`AGENTS.md`**. AGENTS.md has the file tree, the Mongo collections
  (`customers`, `subscriptions`), the CloudGrid injection table, and the Stripe
  change-plan / cancel / billing-portal / webhook wiring. **Read it fully before
  building.**
- `grid_fetch("template", "app-with-data")` — the proven Next.js + Mongo
  shape this blueprint extends (lazy db client in `lib/db.js`, App-Router
  GET/POST route). Imitate its wiring.

## 4. Scaffold

`grid_init` an app `<name>`. `init` creates the entity + `.cloudgrid/link.json`
and writes a `cloudgrid.yaml` with an EMPTY `services: {}`. `plug` needs a linked
directory, so run `init` FIRST. Then write the app under **`services/web/`** and
set `cloudgrid.yaml` to the active shape below.

## 5. Build the app following AGENTS.md

Build the file tree from AGENTS.md under `services/web/`: the lazy Mongo client,
the lazy Stripe client, the plan catalog (`lib/plans.js`), the auth middleware,
the subscription (change-plan) + cancel + billing-portal + webhook API routes,
and the `/account` dashboard. Adapt the plans and document fields to the user.
Key non-negotiables:

- **App code under `services/web/`** — `path:` is the URL mount, NOT the
  filesystem path. Root files fail with `Service directory not found`.
- **Read the DB LAZILY** from `process.env.DATABASE_MONGODB_URL` (legacy
  `process.env.MONGODB_URL` fallback) inside the getter — never at module top
  level, or `next build` fails.
- **Read secrets LAZILY** too — `process.env.STRIPE_KEY`,
  `STRIPE_WEBHOOK_SECRET` — inside getters, never top-level.
- **The webhook is the source of truth.** The change-plan and cancel APIs call
  Stripe; do NOT write plan/status to Mongo there — let `/api/webhook` reconcile
  the `subscriptions` collection so Stripe and Mongo never diverge. Read
  plan/status server-side from Mongo; validate requested plans against
  `lib/plans.js` (never accept an arbitrary price id from the client).
- **Tie every action to the signed-in user** — resolve `userRef` server-side and
  only ever act on that user's `stripeCustomerId`.

`cloudgrid.yaml` active shape:

```yaml
name: my-subscription-management
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

**Declare the datastore with `needs: { database: true }`** — the canonical
shape. `requires:` is the deprecated v1 alias; don't author new yaml with it, and
never set `needs:` and `requires:` together (the validator rejects it).

## 6. Config / secrets

- Stripe secrets → `grid_secrets` (set the vault items `stripe-live-key` and
  `stripe-webhook-secret` that the `vault:` block maps from). The deployer
  injects each as its env var at runtime and under `grid dev`. Add
  `auth-provider-key` too if you use an auth SDK.
- Non-secret config (Stripe publishable key `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`,
  price ids, auth publishable key) → `grid_env` / `services.web.env`.
- Do **NOT** set the DB connection vars yourself (`DATABASE_MONGODB_URL` / legacy
  `MONGODB_URL`) — the grid injects them.

## 7. (Optional) Run locally

Mention that the user can `grid dev` to run locally against the injected Mongo
and vault secrets before deploying. Don't require it.

## 8. Deploy (async)

Deploy the folder with `grid_deploy`. A **runtime deploy is ASYNC**: the first
response is `status: "building"`, NOT a live URL yet.
- Poll `grid_status` (or the returned poll_url) until the entity is live.
- Surface a liveness signal while it builds — never a bare silent wait.
- Once live, register the `/api/webhook` URL as the Stripe webhook endpoint,
  copy the signing secret into the `stripe-webhook-secret` vault item, configure
  the Billing Portal in the Stripe dashboard, and re-plug. Return the deployed
  app URL (NOT the build/log link).

## 9. Return the live URL + iterate

Give the user the live app URL — that is the deliverable. To iterate, re-plug the
SAME entity so it updates the same URL. Keep it honest: async build, local-edition
only, DB injected by the grid, secrets injected from the vault.
