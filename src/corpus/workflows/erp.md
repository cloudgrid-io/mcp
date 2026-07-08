---
name: erp
when: ERP, enterprise resource planning, integrated business system — a large, persistent multi-module app (inventory + orders + finance + HR) with auth/RBAC, backed by a database → runtime → local edition.
needs: database
deploy: runtime
editions: local
kind: blueprint
capabilities_note: persistent + large/multi-module — needs a database (Mongo) plus a provider SDK auth (Clerk/Auth0) and Stripe billing, with keys from the vault. Runtime app, async build, local edition only. Declare `needs: { database: true }` (deployer injects DATABASE_MONGODB_URL / legacy MONGODB_URL) and a `vault:` block for auth + Stripe keys. This is a BLUEPRINT — no app code ships; read AGENTS.md for the structure, then build.
summary: Build a persistent Next.js + Mongo ERP on the grid — inventory + orders + finance + HR modules in one App-Router service, with auth/RBAC (Clerk/Auth0, keys from vault:) and Stripe billing (STRIPE_KEY from vault:). Collections: items, orders, invoices, payments, employees. This is a BLUEPRINT: fetch it, read AGENTS.md for the file tree + CloudGrid wiring (DATABASE_MONGODB_URL, vault keys, deploy), then build the app under services/web/. Edition-gate first, scaffold, declare needs:{database:true} + vault: auth/Stripe keys (never requires:), deploy async, poll to a live URL.
---

# Workflow: erp

The user wants an ERP / integrated business system — inventory, orders, finance,
and HR in one place, with authentication and role-based access (RBAC). Every
module's records must **remember** across refresh and be shared across users, so
this is a **large, persistent runtime app** backed by the grid's shared Mongo,
with a provider SDK for auth and Stripe for the finance module — not a static
page.

This is a **blueprint**, and it is large and multi-module. No app code ships.
Fetch the template, **read its `AGENTS.md` for the structure** (file tree, the
per-module Mongo collections — `items` / `orders` / `invoices` / `payments` /
`employees` — CloudGrid wiring for DB + vault-backed auth and Stripe keys, and
the deploy flow), then build the app following it.

Follow this recipe. Be honest that this is a big build, that a runtime deploy is
async (not instant like a static drop), and that it needs the local edition.

## 1. Edition check FIRST (hard gate)

A persistent, auth-gated multi-module app is a built + deployed container. It
requires the **local edition** (Claude Desktop / Claude Code) or the CLI.

- **Hosted edition (Claude Web / hosted MCP):** you CANNOT build a runtime app —
  hosted is inline-only and can only publish static pages. Tell the user plainly,
  offer a **static mock** of one screen instead, and STOP the runtime path here.
- **Local edition:** continue.

## 2. Auth + grid

1. Ensure signed in: `grid_login_status`; if not, `grid_login`.
2. A grid is required. Respect the grid picker: if the user has more than one
   grid, ask which to use; do not assume a target.

## 3. Fetch the blueprint + read AGENTS.md

`grid_fetch("template", "erp")`. It returns `cloudgrid.yaml`, `AGENTS.md` (the
structure guide), and the README — **no app code**. Read `AGENTS.md` end to end
before writing anything: it defines the `services/web/` file tree, the Mongo
collections + fields per module, how CloudGrid injects the DB and the
vault-backed auth + Stripe keys, how to wire auth/RBAC and the Stripe
checkout/webhook flow, and the deploy steps. Because this is large, agree with
the user on which modules to build first (e.g. inventory + orders) rather than
all four at once.

## 4. Scaffold

`grid_init` an app `<name>`. `init` creates the entity + `.cloudgrid/link.json`
and writes a `cloudgrid.yaml` with an EMPTY `services: {}`. `plug` needs a linked
directory, so run `init` FIRST. Then (a) build the app under **`services/web/`**
following `AGENTS.md`, and (b) fill `cloudgrid.yaml` to the shape below.

## 5. Build the app + set cloudgrid.yaml

1. Build the Next.js App-Router app under `services/web/` per `AGENTS.md` — one
   `web` service hosting each module as its own API-route group + UI page
   (`inventory`, `orders`, `finance`, `hr`), the collections, auth middleware,
   `lib/db.js` (lazy Mongo), `lib/auth.js` (session + `requireRole`), and
   `lib/stripe.js` (lazy Stripe). **App code MUST live under `services/<name>/`**
   — `path:` is the URL mount, NOT the filesystem path.
2. Set `cloudgrid.yaml` to the active shape:
   ```yaml
   name: my-erp
   vault:
     AUTH_PROVIDER_KEY: auth-provider-secret   # Clerk/Auth0 backend key (RBAC)
     STRIPE_KEY: stripe-live-key               # Stripe secret key (finance module)
   services:
     web:
       type: nextjs
       path: /
   needs:
     database: true
   ```
   **Declare the datastore with `needs: { database: true }`** — the canonical
   shape. The deployer provisions ONE Mongo (model each module as a collection in
   it) and injects `DATABASE_MONGODB_URL` (plus the legacy `MONGODB_URL` alias).
   Read it **lazily inside a getter**, never at module top level (a top-level read
   fails `next build`). `requires:` is the deprecated v1 alias; don't author new
   yaml with it, and never set `needs:` and `requires:` together (the validator
   rejects it).
3. **Auth + Stripe keys come from the `vault:` block, not committed env files.**
   The `vault:` map injects `AUTH_PROVIDER_KEY` and `STRIPE_KEY` as env vars at
   build + runtime. (Add `ai: true` to `needs:` only if a module — e.g. demand
   forecasting — actually uses the AI gateway.)

## 6. Config

- Create the vault items the `vault:` block references (the auth provider's
  backend key and the Stripe secret key) — `grid_secrets` / vault UI. Never
  commit them. Publishable/front-end auth keys → `grid_env`.
- Register the deployed `/api/finance/webhook` URL as the Stripe webhook endpoint
  once the app is live.
- Do **NOT** set the DB connection vars yourself (`DATABASE_MONGODB_URL` or the
  legacy `MONGODB_URL`) — the grid injects them.

## 7. (Optional) Run locally

Mention that the user can `grid dev` to run locally against the injected Mongo +
vault env vars before deploying. Don't require it.

## 8. Deploy (async)

Deploy the folder with `grid_plug`. A **runtime deploy is ASYNC**: the first
response is `status: "building"`, NOT a live URL yet.
- Poll `grid_status` (or the returned poll_url) until the entity is live.
- Surface a liveness signal while it builds — never a bare silent wait.
- Only once it is live, return the deployed app URL (NOT the build/log link).

## 9. Return the live URL + iterate

Give the user the live app URL — that is the deliverable. To iterate (add the
remaining modules, refine RBAC, wire more of finance), re-plug the SAME entity so
it updates the same URL. Keep it honest: large build, async deploy, local-edition
only, DB + auth + Stripe credentials injected by the grid / vault.
