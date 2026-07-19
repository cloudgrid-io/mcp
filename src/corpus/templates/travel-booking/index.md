# Template: travel-booking (BLUEPRINT — Next.js + Mongo flights/hotels portal)

A blueprint for a travel booking portal — search and book flights and hotels, pay
with Stripe, manage trips. Data lives in grid-shared MongoDB so trips and bookings
survive refresh and are shared across sessions — a runtime app, not a static page.
This bundle ships the annotated `cloudgrid.yaml` and the `AGENTS.md` structure
guide, NOT prewritten app code.

**This is a blueprint: structure + cloudgrid.yaml, adapt and build.** Fetch it,
read `AGENTS.md`, then build the app under `services/web/` following the file tree
and data model there. The proven runtime shape is the same as `app-with-data`
(lazy Mongo client under `services/web/`).

**Key rules:**

1. **Service code MUST live under `services/<name>/`, not the repo root.** `path:`
   in `cloudgrid.yaml` is the URL mount, NOT the filesystem path. The service
   named `web` → the CLI looks for `services/web/`. Root files fail with
   `Error: Service directory not found: …/services/web`.
2. **Read injected vars LAZILY (inside getters), never at module top level.** The
   grid injects `DATABASE_MONGODB_URL` (legacy `MONGODB_URL` alias) from
   `needs: { database: true }`, and the `vault:` secrets (`STRIPE_KEY`,
   `STRIPE_WEBHOOK_SECRET`, `AUTH_PROVIDER_KEY`) as env vars. A top-level read
   fails `next build`. Never hardcode a key; never commit a secret.
3. **Declare the datastore with `needs: { database: true }`** — the canonical
   shape. `requires:` is the deprecated v1 alias; don't author new yaml with it,
   and never set `needs:` and `requires:` together (the validator rejects it).
4. **Payment/auth secrets go through the `vault:` block**, resolved to env vars
   at deploy — add the vault items with `grid secrets set` before plug.
5. **The trip-reminder cron service is NOT yet deployable** (platform issue
   #1543). Keep the `reminders:` cron COMMENTED and ship `web` alone; see
   `AGENTS.md` §7.

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields. (A commented `reminders:` cron service
# shows the intended — not-yet-deployable — shape; see AGENTS.md §7.)
name: travel-booking
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

> **Capability:** need is `database: true` — the deployer provisions Mongo and
> injects `DATABASE_MONGODB_URL` (plus the legacy `MONGODB_URL` alias). Secrets
> come from the `vault:` block as env vars. See the capability-map for the full
> injection table.

## AGENTS.md — the structure guide

The heart of this blueprint. Read it before building. It covers:

1. **File tree** — `services/web/{app/, lib/, api routes, package.json}` with a
   search flow, inventory + Stripe + auth libs, and the API routes (flights /
   hotels / bookings / Stripe webhook).
2. **Mongo collections + fields** — `flights`, `hotels`, `bookings`, `trips`,
   plus the guarded-`$inc` overbooking rule that prevents overselling seats/rooms.
3. **CloudGrid injection** — `DATABASE_MONGODB_URL` for Mongo, `vault:` → env vars
   for secrets, `RUNTIME_GATEWAY_URL` for ai.
4. **Auth + payments wiring** — provider SDK from `AUTH_PROVIDER_KEY`; Stripe
   checkout + signature-verified webhook from `STRIPE_KEY` /
   `STRIPE_WEBHOOK_SECRET`.
5. **Deploy steps** — write the files → `grid plug --no-deploy` →
   `grid secrets set` → `grid plug` → poll to live.
6. **Edition note** — runtime app → local edition only (hosted is static-only).
7. **Trip-reminder cron** — intended shape + the platform-issue-#1543 PENDING note
   and stopgap.

## Adapt it

- Rename `flights` / `hotels` / `bookings` collections and fields to your domain
  (cars, tours, activities, packages).
- Swap the auth provider (Clerk / Auth0 / …) and payment flow (or drop Stripe for
  free holds — skip checkout, mark `confirmed`).
- Add `needs: { cache: true }` only if you actually need Redis (e.g. inventory
  hold locks or search caching).
- Wire the trip-reminder cron once platform issue #1543 lands; until then use the
  stopgap in `AGENTS.md` §7.
