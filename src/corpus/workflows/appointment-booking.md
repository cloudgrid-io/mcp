---
name: appointment-booking
when: "appointment booking, clinic/salon booking, appointment scheduler"
needs: database
deploy: runtime
editions: local
kind: blueprint
capabilities_note: "persistent — needs a database (Mongo) plus auth and optional Stripe deposit secrets. Runtime app, async build, local edition only. Declare needs { database: true } (deployer injects DATABASE_MONGODB_URL / legacy MONGODB_URL) and a vault block mapping AUTH_PROVIDER_KEY (and optionally STRIPE_KEY / STRIPE_WEBHOOK_SECRET) to env vars. This is a BLUEPRINT — read AGENTS.md for the structure, then build. A reminder cron service is designed but cron deploy is PENDING platform issue #1543 (not yet deployable)."
summary: "Build an appointment / clinic / salon booking app on the grid — a Next.js app where a business defines providers and bookable services, publishes availability, and clients book an open slot, with auth so a provider owns their calendar, optional Stripe deposits, and grid-shared Mongo (providers, services, availability, appointments). This is a BLUEPRINT: fetch the template, read AGENTS.md for the file tree + slot/anti-double-booking rules + CloudGrid wiring (needs database true, vault for auth/Stripe secrets), build the app under services/web/, deploy async, poll to a live URL. Scheduled reminders are designed but PENDING platform issue #1543."
---

# Workflow: appointment-booking

The user wants an appointment scheduler — a clinic/salon/consultant booking app:
a business defines providers and bookable services, publishes availability, and
clients book an open time slot that no one else can take. That is a **persistent
runtime app** — a Next.js app backed by the grid's shared Mongo, with auth so a
provider owns their calendar and optional Stripe deposits.

This is a **blueprint**, not a fill-in template. There is no finished app to
copy — there is a `cloudgrid.yaml` and a structure guide (`AGENTS.md`). Read the
guide, then build the app following it. Be honest that a runtime deploy is async
(not instant like a static drop) and that it needs the local edition.

## 1. Edition check FIRST (hard gate)

A booking app is a built + deployed container. It requires the **local edition**
(Claude Desktop / Claude Code) or the CLI.

- **Hosted edition (Claude Web / hosted MCP):** you CANNOT build a runtime app —
  hosted is inline-only and can only publish static pages. Tell the user plainly,
  offer a static "book us" landing page instead, and STOP the runtime path here.
- **Local edition:** continue.

## 2. Auth + grid

1. Ensure signed in: `grid_login_status`; if not, `grid_login`.
2. A grid is required. Respect the grid picker: if the user has more than one
   grid, ask which to use; do not assume a target.

## 3. Read the blueprint

Fetch the template and read its structure guide — this is the core of the
workflow:

- `grid_get_template("template", "appointment-booking")` — the `cloudgrid.yaml` +
  **`AGENTS.md`**. AGENTS.md has the file tree, the Mongo collections
  (`providers`, `services`, `availability`, `appointments`), the slot-computation
  and anti-double-booking rules, the CloudGrid injection table, and the auth +
  Stripe wiring. **Read it fully before building.**
- `grid_get_template("template", "app-with-data")` — the proven Next.js + Mongo
  shape this blueprint extends (lazy db client in `lib/db.js`, App-Router
  GET/POST route). Imitate its wiring.

## 4. Scaffold

`grid_create_project` an app `<name>`. `init` creates the entity + `.cloudgrid/link.json`
and writes a `cloudgrid.yaml` with an EMPTY `services: {}`. `plug` needs a linked
directory, so run `init` FIRST. Then write the app under **`services/web/`** and
set `cloudgrid.yaml` to the active shape below.

## 5. Build the app following AGENTS.md

Build the file tree from AGENTS.md under `services/web/`: the lazy Mongo client,
the slot-computation helper, the auth middleware, the providers/services/
availability/appointments API routes, the public booking pages, the gated
provider dashboard, and (optionally) the Stripe deposit checkout + webhook. Adapt
the providers, services, and availability rules to the user. Key non-negotiables:

- **App code under `services/web/`** — `path:` is the URL mount, NOT the
  filesystem path. Root files fail with `Service directory not found`.
- **Read the DB LAZILY** from `process.env.DATABASE_MONGODB_URL` (legacy
  `process.env.MONGODB_URL` fallback) inside the getter — never at module top
  level, or `next build` fails.
- **Read secrets LAZILY** too — `process.env.AUTH_PROVIDER_KEY`,
  `STRIPE_KEY`, `STRIPE_WEBHOOK_SECRET` — inside getters, never top-level.
- **No double-booking.** `appointments` is the source of truth for "taken".
  Compute open slots as availability minus booked, re-check availability at write
  time (never trust the client's slot), and guard the insert with a partial
  unique index on `{ providerId, startAt }` for active statuses.

`cloudgrid.yaml` active shape:

```yaml
name: my-appointment-booking
services:
  web:
    type: nextjs
    path: /
needs:
  database: true
vault:
  AUTH_PROVIDER_KEY: auth-provider-key
  STRIPE_KEY: stripe-live-key                  # only if taking deposits
  STRIPE_WEBHOOK_SECRET: stripe-webhook-secret # only if taking deposits
```

**Declare the datastore with `needs: { database: true }`** — the canonical
shape. `requires:` is the deprecated v1 alias; don't author new yaml with it, and
never set `needs:` and `requires:` together (the validator rejects it).

## 6. Config / secrets

- Auth + Stripe secrets → `grid_set_secret` (set the vault items `auth-provider-key`,
  and if taking deposits `stripe-live-key`, `stripe-webhook-secret`, that the
  `vault:` block maps from). The deployer injects each as its env var at runtime
  and under `grid dev`.
- Non-secret config (auth publishable key `NEXT_PUBLIC_...`, Stripe price ids) →
  `grid_set_env` / `services.web.env`.
- Do **NOT** set the DB connection vars yourself (`DATABASE_MONGODB_URL` / legacy
  `MONGODB_URL`) — the grid injects them.

## 7. (Optional) Run locally

Mention that the user can `grid dev` to run locally against the injected Mongo
and vault secrets before deploying. Don't require it.

## 8. Reminders (cron) — PENDING platform issue #1543

The design wants a scheduled reminder job (notify clients ~24h before their
appointment, stamp `reminderSentAt` so each is reminded once). AGENTS.md § 7
documents the intended `reminders` cron service shape. **Cron deploy is a PENDING
platform issue (#1543) and is NOT yet deployable** — keep that service COMMENTED
in `cloudgrid.yaml`. Ship the booking app without automated reminders (or trigger
them manually / from an external scheduler) and tell the user plainly; do not
claim reminders are live.

## 9. Deploy (async)

Deploy the folder with `grid_deploy`. A **runtime deploy is ASYNC**: the first
response is `status: "building"`, NOT a live URL yet.
- Poll `grid_status` (or the returned poll_url) until the entity is live.
- Surface a liveness signal while it builds — never a bare silent wait.
- If taking deposits, once live register the `/api/webhook` URL as the Stripe
  webhook endpoint, copy the signing secret into the `stripe-webhook-secret`
  vault item, and re-plug. Return the deployed app URL (NOT the build/log link).

## 10. Return the live URL + iterate

Give the user the live app URL — that is the deliverable. To iterate, re-plug the
SAME entity so it updates the same URL. Keep it honest: async build, local-edition
only, DB injected by the grid, secrets injected from the vault, and reminders
pending cron (#1543).
