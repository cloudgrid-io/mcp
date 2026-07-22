---
name: booking-system
when: booking system, reservations, appointment booking, scheduling — a persistent app where users reserve time slots / appointments that survive refresh and are shared across sessions. Needs a database → runtime → local edition.
needs: database
deploy: runtime
editions: local
kind: blueprint
capabilities_note: "persistent — needs a database (Mongo). Runtime app, async build, local edition only. BLUEPRINT — ships structure + cloudgrid.yaml, not app code; read AGENTS.md and build. Declare the canonical `needs: { database: true }`; the deployer injects DATABASE_MONGODB_URL (+legacy MONGODB_URL). Payment/auth secrets via the `vault:` block → env vars. Reminder cron is NOT yet deployable (platform issue #1543)."
summary: "Build a persistent Next.js + Mongo appointment / reservation booking system on the grid — `services`, `availabilityRules`, `bookings` collections with slot-availability logic, Stripe checkout, an auth provider, and a (pending) reminder cron. This is a BLUEPRINT: fetch it, read AGENTS.md for the file tree + data model + CloudGrid wiring, then build the app under services/web/. Edition-gate first, scaffold, declare needs:{database:true} (not requires:), map secrets via vault:, deploy async, poll to a live URL."
---

# Workflow: booking-system

The user wants a booking / reservations / appointment-scheduling app that
**remembers** its bookings — reservations that survive refresh and are shared
across sessions. That is a **runtime app** backed by the grid's shared Mongo, not
a static page. The proven runtime shape is the same as `app-with-data` (Next.js +
lazy Mongo client under `services/web/`), with a booking domain (bookable
`services`, `availabilityRules`, and `bookings` with slot-overlap protection),
Stripe checkout for paid appointments, an auth provider for accounts, and a
scheduled reminder job.

**This is a BLUEPRINT.** It does NOT ship prewritten app code — it ships the
annotated `cloudgrid.yaml` and an `AGENTS.md` structure guide (file tree, Mongo
data model, and CloudGrid wiring). Fetch it, **read `AGENTS.md`**, then build the
app under `services/web/` following it.

Follow this recipe. Be honest that a runtime deploy is async (not instant like a
static drop), that it needs the local edition, and that the reminder **cron
service is not yet deployable** (platform issue #1543).

## 1. Edition check FIRST (hard gate)

A persistent app is a built + deployed container. It requires the **local
edition** (Claude Desktop / Claude Code) or the CLI.

- **Hosted edition (Claude Web / hosted MCP):** you CANNOT build a runtime app —
  hosted is inline-only and can only publish static pages. Tell the user plainly,
  offer a **static preview** instead, and STOP the runtime path here.
- **Local edition:** continue.

## 2. Auth + grid

1. Ensure signed in: `grid_login_status`; if not, `grid_login`.
2. A grid is required. Respect the grid picker: if the user has more than one
   grid, ask which to use; do not assume a target.

## 3. Read the blueprint, then scaffold

1. Fetch the blueprint: `grid_get_template("template", "booking-system")`. **Read its
   `AGENTS.md`** — it is the structure guide (file tree under `services/web/`, the
   `services` / `availabilityRules` / `bookings` collections + the double-booking
   guard, how CloudGrid injects the DB and vault secrets, how to wire Stripe +
   auth, and the reminder-cron design).
2. `grid_create_project` an app `<name>`. It scaffolds the project folder and
   writes a `cloudgrid.yaml` with an EMPTY `services: {}`. No server entity
   exists yet — the first `grid plug` auto-creates it from the manifest
   (honoring its `name:`) and writes `.cloudgrid/link.json`.

## 4. Build the app + set cloudgrid.yaml

1. Build the files under **`services/web/`** per the AGENTS.md file tree. **App
   code MUST live under `services/<name>/`** — `path:` is the URL mount, NOT the
   filesystem path.
2. Set `cloudgrid.yaml` to the blueprint shape:
   ```yaml
   name: my-booking
   vault:
     STRIPE_KEY: stripe-live-key
     STRIPE_WEBHOOK_SECRET: stripe-webhook-secret
     AUTH_PROVIDER_KEY: auth-provider-key
   services:
     web:
       type: nextjs
       path: /
   needs:
     database: true
   ```
   **Declare the datastore with `needs: { database: true }`** — the canonical
   shape. The deployer provisions Mongo and injects `DATABASE_MONGODB_URL` (plus
   the legacy `MONGODB_URL` alias). `requires:` is the deprecated v1 alias; don't
   author new yaml with it, and never set `needs:` and `requires:` together (the
   validator rejects it).
3. **Read every injected var lazily** (inside a getter), never at module top level
   — `process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL`, and the vault
   secrets (`STRIPE_KEY`, etc.) the same way. A top-level read fails `next build`.
4. **Keep the reminder cron COMMENTED.** cron deploy is PENDING platform issue
   #1543 — `plug` rejects a `type: cron` service. Ship `web` alone; use the
   stopgap in AGENTS.md §7 for reminders until #1543 lands.

## 5. Config (secrets)

- Payment/auth secrets → add the vault items with `grid_set_secret` (e.g.
  `stripe-live-key`, `stripe-webhook-secret`, `auth-provider-key`) BEFORE plug so
  the `vault:` mappings resolve. Non-secret config → `grid_set_env`.
- Do **NOT** set the DB connection vars yourself (`DATABASE_MONGODB_URL` / legacy
  `MONGODB_URL`) — the grid injects them.

## 6. (Optional) Run locally

Mention that the user can `grid dev` to run locally against the injected Mongo +
vault env vars before deploying. Good for testing slot/availability logic. Don't
require it.

## 7. Deploy (async)

Deploy the folder with `grid_plug`. A **runtime deploy is ASYNC**: the first
response is `status: "building"`, NOT a live URL yet.
- Poll `grid_status` (or the returned poll_url) until the entity is live.
- Surface a liveness signal while it builds — never a bare silent wait.
- Only once it is live, return the deployed app URL (NOT the build/log link).

## 8. Return the live URL + iterate

Give the user the live app URL — that is the deliverable. To iterate, re-plug the
SAME entity so it updates the same URL. Keep it honest: async build, local-edition
only, credentials injected by the grid, and the reminder cron pending #1543.
