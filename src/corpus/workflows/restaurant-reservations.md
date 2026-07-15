---
name: restaurant-reservations
when: "restaurant website with reservations, table booking, restaurant site — a public Next.js site with menu content and a persistent reservations/table-booking collection backed by Mongo. Runtime app → local edition. This is a BLUEPRINT: read AGENTS.md for the structure, then build the app."
needs: database
deploy: runtime
editions: local
kind: blueprint
capabilities_note: "persistent — needs a database (Mongo). Runtime app, async build, local edition only. Declare the canonical `needs: { database: true }`; the deployer injects DATABASE_MONGODB_URL (+legacy MONGODB_URL). Third-party secrets (Stripe deposit, email) go through the `vault:` block. A confirmation-reminder cron service is DESIGNED but NOT deployable yet (platform issue #1543)."
summary: "BLUEPRINT for a restaurant website with online reservations — a public Next.js + Mongo site (menu content + a reservations / table-booking collection) on the grid. It is structure + cloudgrid.yaml, not runnable code: fetch the template, READ AGENTS.md for the file tree, the menu/reservations/tables collections, and the CloudGrid wiring (DATABASE_MONGODB_URL injection, vault: for Stripe/email secrets, optional auth, deploy/poll), then build the app under services/web/ following it. needs:{database:true} (not requires:). Async runtime deploy, local edition only. Cron reminders are designed but PENDING #1543."
---

# Workflow: restaurant-reservations

The user wants a **restaurant website with online reservations** — a public site
with menu content and a booking form (optionally table booking) whose
reservations **persist** and are shared across sessions. That is a **runtime app**
backed by the grid's shared Mongo, not a static page.

**This is a BLUEPRINT.** The template does NOT contain app code — it ships a
`cloudgrid.yaml` and an `AGENTS.md` structure guide. The recipe is: fetch it,
**read `AGENTS.md`**, then build the app under `services/web/` following that
structure (the proven `app-with-data` shape, with a `reservations` domain).

Be honest that a runtime deploy is async (not instant like a static drop), that
it needs the local edition, and that the confirmation-reminder **cron** service
is designed but **not yet deployable** (platform issue #1543).

## 1. Edition check FIRST (hard gate)

A persistent app is a built + deployed container. It requires the **local
edition** (Claude Desktop / Claude Code) or the CLI.

- **Hosted edition (Claude Web / hosted MCP):** you CANNOT build a runtime app —
  hosted is inline-only and can only publish static pages. Tell the user plainly,
  offer a **static menu page** (no bookings) instead, and STOP the runtime path.
- **Local edition:** continue.

## 2. Auth + grid

1. Ensure signed in: `grid_login_status`; if not, `grid_login`.
2. A grid is required. Respect the grid picker: if the user has more than one
   grid, ask which to use; do not assume a target.

## 3. Fetch the blueprint and READ AGENTS.md

`grid_fetch("template", "restaurant-reservations")`. This is a **blueprint**,
so the deliverable is `cloudgrid.yaml` + `AGENTS.md`, not app code.

**Read `AGENTS.md` before building.** It defines:
- the file tree (`services/web/{app/, lib/, api routes, package.json}`, optional
  Stripe checkout + webhook routes, optional staff auth, a `services/reminder/`
  cron job),
- the Mongo collections + fields (`menu`, `reservations`, `tables`),
- how CloudGrid injects the DB (`DATABASE_MONGODB_URL` / legacy `MONGODB_URL`) and
  vault secrets, how to wire Stripe/auth, deploy steps, and the cron shape.

## 4. Scaffold + fill

1. `grid_init` an app `<name>` — creates the entity + `.cloudgrid/link.json`
   and a `cloudgrid.yaml` with an EMPTY `services: {}`. Run `init` FIRST (plug
   needs a linked directory).
2. Write the app under **`services/web/`** (`path:` is the URL mount, NOT the
   filesystem path), following `AGENTS.md`.
3. Set `cloudgrid.yaml` to the blueprint's active fields:
   ```yaml
   name: my-restaurant
   vault:
     STRIPE_KEY: stripe-live-key      # only if taking a deposit
     SENDGRID_API_KEY: sendgrid-key   # confirmation / reminder email
   services:
     web:
       type: nextjs
       path: /
   needs:
     database: true
   ```
   Declare `needs: { database: true }` (canonical) — the deployer provisions Mongo
   and injects `DATABASE_MONGODB_URL` (+ legacy `MONGODB_URL`). `requires:` is the
   deprecated v1 alias; never author it and never set `needs:` and `requires:`
   together (the validator rejects the combination).
4. **Read the DB from `process.env.DATABASE_MONGODB_URL`** (legacy `MONGODB_URL`
   fallback) behind a **lazy getter** — never at module top level, or `next build`
   fails. Third-party keys come from the vault-injected env vars
   (`process.env.STRIPE_KEY`, `process.env.SENDGRID_API_KEY`).

## 5. Config / secrets

- Secret values (Stripe, SendGrid, auth) → `grid_secrets` (the `vault:` block
  maps them to env vars). Non-secret config (publishable keys, flags) →
  `grid_env`.
- Do **NOT** set the DB vars yourself (`DATABASE_MONGODB_URL` / `MONGODB_URL`) —
  the grid injects them.

## 6. (Optional) Run locally

`grid dev` runs Next.js with `DATABASE_MONGODB_URL` and vault vars injected
against dev Mongo. Seed the `menu` collection, test a booking. Don't require it.

## 7. Deploy (async)

Deploy `services/web/` with `grid_deploy`. A **runtime deploy is ASYNC**: the
first response is `status: building`, NOT a live URL.
- Poll `grid_status` (or the returned poll URL) until live.
- Surface a liveness signal while it builds — never a bare silent wait.
- Only once live, return the deployed app URL (NOT the build/log link).
- If Stripe deposits are on, register the live `/api/webhooks/stripe` URL in the
  Stripe dashboard.

## 8. Cron reminders — PENDING #1543

The design includes a daily cron job that emails reminders to next-day bookings
(a `reminder:` cron service reading the same injected `DATABASE_MONGODB_URL` +
`SENDGRID_API_KEY`). **Cron deploy is not yet available (platform issue #1543)** —
keep the `reminder:` cron block **commented** in `cloudgrid.yaml`; an active cron
service will be rejected at plug until #1543 lands. Build the rest now; enable
cron once it ships. See `AGENTS.md` §7 for the intended shape and interim
workaround.

## 9. Return the live URL + iterate

Give the user the live app URL — that is the deliverable. To iterate, re-plug the
SAME entity so it updates the same URL. Keep it honest: blueprint you built out,
async build, local-edition only, DB + secrets injected by the grid, cron pending.
