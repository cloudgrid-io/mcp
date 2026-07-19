---
name: billing-dashboard
when: billing dashboard, invoicing and payments dashboard, SaaS billing
needs: database
deploy: runtime
editions: local
kind: blueprint
capabilities_note: persistent + payments — needs a database (Mongo) and Stripe. Runtime app, async build, local edition only. This is a BLUEPRINT — read the template's AGENTS.md for the structure, then build the app. Declare the canonical `needs: { database: true }`; the deployer injects DATABASE_MONGODB_URL (+legacy MONGODB_URL). The Stripe key comes from the vault: block → STRIPE_KEY.
summary: Build a persistent Next.js + Mongo + Stripe SaaS billing dashboard on the grid — customers, invoices, charges, usage metering, a revenue view (MRR/outstanding), /api/checkout Stripe session to collect invoices, and a signature-verified Stripe webhook that marks invoices paid and records charges. This is a BLUEPRINT: edition-gate first, scaffold, fetch the template and read AGENTS.md for the file tree + wiring, put the app under services/web/, wire process.env.DATABASE_MONGODB_URL lazily and STRIPE_KEY from the vault, store money as integer cents, declare needs:{database:true} (not requires:), deploy async, poll to a live URL, register the webhook in Stripe.
---

# Workflow: billing-dashboard

The user wants a **billing / invoicing / payments dashboard** for a SaaS — a place
to track customers, issue and collect invoices, record charges, meter usage, and
see revenue (MRR, outstanding, recent invoices). That is a **runtime app** backed
by the grid's shared Mongo (`customers`, `invoices`, `charges`, `usage_events`)
plus **Stripe** for payments: a `/api/checkout` route that creates a Stripe
Checkout Session to collect an invoice, and a signature-verified webhook that marks
it paid and records the charge. Not a static page — it must remember billing state.

**This is a BLUEPRINT.** The template ships the structure + `cloudgrid.yaml`, not
finished app code. The build shape is proven `app-with-data` (Next.js App Router,
lazy Mongo, app under `services/web/`) plus the billing collections and Stripe
wiring. Be honest that a runtime deploy is async (not instant) and needs the local
edition.

## 1. Edition check FIRST (hard gate)

A persistent billing dashboard is a built + deployed container. It requires the
**local edition** (Claude Desktop / Claude Code) or the CLI.

- **Hosted edition (Claude Web / hosted MCP):** you CANNOT build a runtime app —
  hosted is inline-only and can only publish static pages. Say so plainly, offer a
  **static revenue-view mockup** instead, and STOP the runtime path here.
- **Local edition:** continue.

## 2. Auth + grid

1. Ensure signed in: `grid_login_status`; if not, `grid_login`.
2. A grid is required. Respect the grid picker: if the user has more than one grid,
   ask which to use; do not assume a target.

## 3. Scaffold

`grid_create_project` an app `<name>`. It scaffolds the project folder and writes a `cloudgrid.yaml` with an EMPTY
`services: {}`. No server entity exists yet — the first `grid plug` auto-creates
it from the manifest (honoring its `name:`) and writes `.cloudgrid/link.json`.

## 4. Fetch the blueprint and read AGENTS.md

This is a blueprint — the structure guide is the deliverable, not copy-paste code.

1. `grid_get_template("template", "billing-dashboard")`.
2. **Read `AGENTS.md`** in the fetched template. It has: the file tree (app under
   `services/web/`), the Mongo collections (`customers`, `invoices`, `charges`,
   `usage_events`) and their fields, how the grid injects Mongo
   (`DATABASE_MONGODB_URL`) and the Stripe key (the `vault:` block → `STRIPE_KEY`),
   the checkout + webhook + usage wiring, and the deploy steps. Build the app
   following it.
3. Set `cloudgrid.yaml` to the shape below. **App code MUST live under
   `services/web/`** — `path:` is the URL mount, NOT the filesystem path.
   ```yaml
   name: my-billing
   vault:
     STRIPE_KEY: stripe-live-key
   services:
     web:
       type: nextjs
       path: /
   needs:
     database: true
   ```
   **Declare the datastore with `needs: { database: true }`** — the canonical shape.
   The deployer provisions Mongo and injects `DATABASE_MONGODB_URL` (plus the legacy
   `MONGODB_URL` alias). `requires:` is the deprecated v1 alias; never set `needs:`
   and `requires:` together (the validator rejects it).

## 5. Build the app (following AGENTS.md)

- **Read the DB from `process.env.DATABASE_MONGODB_URL`** (legacy `MONGODB_URL`
  fallback) inside a **lazy getter** — never at module top level, or `next build`
  fails. Never hardcode a connection string.
- **Read the Stripe key from `process.env.STRIPE_KEY`** (injected by the `vault:`
  block) lazily. **Store all money as integer cents.** Compute invoice totals
  server-side from the stored line items — never trust an amount sent by the browser.
- The **webhook** reads the RAW request body (`await request.text()`), verifies the
  Stripe signature, marks the invoice `paid`, and upserts a `charges` doc by the
  Stripe payment id (idempotent) with the authoritative total from the verified event.
- Meter usage via `/api/usage` into `usage_events`; the revenue view aggregates
  `charges` (revenue), `invoices` (outstanding), and `usage_events` per period.
- (Optional) `grid dev` to run locally against the injected Mongo + a Stripe test
  key before deploying.

## 6. Config

- Stripe secrets → the vault: `grid_set_secret` to set `stripe-live-key` (and a
  `stripe-webhook-secret` if you map one). The `vault:` block turns them into env
  vars. Non-secret config → `grid_set_env`.
- Do **NOT** set the DB connection vars yourself (`DATABASE_MONGODB_URL` /
  `MONGODB_URL`) — the grid injects them.

## 7. Deploy (async)

Deploy the folder with `grid_deploy`. A **runtime deploy is ASYNC**: the first
response is `status: "building"`, NOT a live URL yet.
- Poll `grid_status` (or the returned poll_url) until the entity is live.
- Surface a liveness signal while it builds — never a bare silent wait.
- Only once it is live, return the deployed app URL (NOT the build/log link).

## 8. Wire the Stripe webhook + return the live URL

1. Register `<live-url>/api/webhook` as a webhook endpoint in the Stripe dashboard,
   copy its `whsec_…` secret into the vault, and re-`grid_deploy` the SAME entity
   if you changed the `vault:` mapping (same URL).
2. Give the user the live dashboard URL — that is the deliverable. To iterate,
   re-plug the SAME entity so it updates the same URL.

Keep it honest: blueprint (build from AGENTS.md), async build, local-edition only,
Mongo + Stripe credentials injected by the grid / vault.
