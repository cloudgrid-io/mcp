---
name: marketplace
when: "marketplace, multi-vendor platform, two-sided marketplace"
needs: database
deploy: runtime
editions: local
kind: blueprint
capabilities_note: "persistent — needs a database (Mongo) and payment/auth secrets. Runtime app, async build, local edition only. Declare the canonical needs:{database:true}; the deployer injects DATABASE_MONGODB_URL (+legacy MONGODB_URL). Map Stripe + auth secrets with a vault: block (STRIPE_KEY / STRIPE_WEBHOOK_SECRET / AUTH_PROVIDER_KEY) and grid secrets set the values."
summary: "A BLUEPRINT for a two-sided / multi-vendor marketplace — vendors, listings, orders, seller auth with roles, Stripe Connect payouts, and commission logic on persistent Next.js + Mongo. This is not fill-in-the-blanks app code; it ships structure + cloudgrid.yaml. Fetch the template, read AGENTS.md for the file tree / collections / CloudGrid wiring (needs + vault), then BUILD the app under services/web/ following it, and deploy async to a live URL (local edition only)."
---

# Workflow: marketplace

The user wants a two-sided / multi-vendor marketplace — many vendors listing
products, buyers ordering, the platform taking a commission and paying sellers
out. That is a **persistent runtime app** (Next.js + the grid's shared Mongo) with
three layered concerns: **seller auth with roles**, **Stripe Connect payouts**,
and **commission logic**. It is the `app-with-data` shape plus auth + payments.

**This is a BLUEPRINT.** Unlike a fill-in-the-blanks template, it ships
*structure* — a `cloudgrid.yaml` and an `AGENTS.md` structure guide — not finished
app code. The recipe is: fetch it, **read `AGENTS.md`**, then **build** the app
following it. Be honest that a runtime deploy is async and needs the local edition.

## 1. Edition check FIRST (hard gate)

A marketplace is a built + deployed container (Next.js + Mongo + Stripe). It
requires the **local edition** (Claude Desktop / Claude Code) or the CLI.

- **Hosted edition (Claude Web / hosted MCP):** you CANNOT build a runtime app —
  hosted is inline-only and can only publish static pages. Tell the user plainly,
  offer a **static storefront mockup** instead, and STOP the runtime path here.
- **Local edition:** continue.

## 2. Auth + grid

1. Ensure signed in: `grid_login_status`; if not, `grid_login`.
2. A grid is required. Respect the grid picker: if the user has more than one
   grid, ask which to use; do not assume a target.

## 3. Fetch the blueprint and READ AGENTS.md

`grid_get_template("template", "marketplace")`. The deliverable is the **`AGENTS.md`
structure guide** — read it before writing anything. It defines:
- the `services/web/` file tree (pages, API routes, `lib/`),
- the Mongo collections (`vendors`, `listings`, `orders`) + fields,
- the CloudGrid injection table (needs + vault + AI gateway),
- how to wire auth (Clerk/Auth0 + a `role` claim) and payments (Stripe Connect
  onboarding, Checkout with `application_fee` + `transfer_data.destination`, and a
  signature-verified webhook),
- the deploy flow.

There is no app code to copy — you generate it from the guide.

## 4. Scaffold + fill cloudgrid.yaml

`grid_create_project` an app `<name>` FIRST (creates the entity + `.cloudgrid/link.json`
and a starter `cloudgrid.yaml` with empty `services:{}`; `plug` needs a linked
directory). Then put the app under **`services/web/`** and set `cloudgrid.yaml` to
the blueprint's active fields:

```yaml
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

**App code MUST live under `services/<name>/`** — `path:` is the URL mount, NOT
the filesystem path. **Declare `needs: { database: true }`** (canonical) — the
deployer provisions Mongo and injects `DATABASE_MONGODB_URL` (+ legacy
`MONGODB_URL`). `requires:` is the deprecated v1 alias; never author it and never
set `needs:` and `requires:` together (the validator rejects the combination).

## 5. Build the app following AGENTS.md

Generate the files under `services/web/` per the guide:
- **Lazy getters** for injected values — read `process.env.DATABASE_MONGODB_URL`
  (legacy `MONGODB_URL` fallback) and `process.env.STRIPE_KEY` **inside** a getter,
  never at module top level (a top-level read fails `next build`).
- Auth SDK (Clerk/Auth0) in `lib/auth.js` from `AUTH_PROVIDER_KEY`; role-gate the
  seller dashboard + seller API routes in `middleware.js`.
- Stripe Connect: onboarding account links, Checkout with the platform fee routed
  via `application_fee_amount` + `transfer_data.destination`, and a webhook that
  verifies the signature with `STRIPE_WEBHOOK_SECRET` before marking orders paid.
- Commission as a pure function (`lib/commission.js`); store money as integer cents.

## 6. Config / secrets

- Map secrets in the `vault:` block (done above), then **store the values**:
  `grid secrets set stripe-live-key sk_live_…`,
  `grid secrets set stripe-webhook-secret whsec_…`,
  `grid secrets set auth-provider-key …`. Non-secret public config → `grid_set_env`.
- Do **NOT** set the DB connection vars yourself (`DATABASE_MONGODB_URL` / legacy
  `MONGODB_URL`) — the grid injects them.

## 7. (Optional) Run locally

Mention the user can `grid dev` to run locally against the injected dev Mongo +
secrets before deploying. Don't require it.

## 8. Deploy (async)

Deploy the folder with `grid_deploy`. A **runtime deploy is ASYNC**: the first
response is `status: "building"`, NOT a live URL yet.
- Poll `grid_status` (or the returned poll_url) until the entity is live.
- Surface a liveness signal while it builds — never a bare silent wait.
- Only once it is live, return the deployed app URL (NOT the build/log link).

## 9. Return the live URL + iterate

Give the user the live app URL — the deliverable. Point the Stripe webhook
endpoint at `<live-url>/api/webhooks/stripe`. To iterate, re-plug the SAME entity
so it updates the same URL. Keep it honest: this is a blueprint you built from,
the build is async, it is local-edition only, and credentials are injected by the
grid (Mongo via `needs`, Stripe/auth via `vault` + `grid secrets set`).
