# Template: appointment-booking (BLUEPRINT — Next.js + auth + Mongo, optional Stripe)

An appointment / clinic / salon booking app. **Blueprint, not finished code**:
it ships the `cloudgrid.yaml` and a structure guide (`AGENTS.md`) so an agent can
build it correctly on CloudGrid — a Next.js app where a business defines
providers and bookable services, publishes availability, and clients book an open
slot, with auth so a provider owns their calendar, optional Stripe deposits, and
grid-shared Mongo. Read `AGENTS.md`, build the app under `services/web/`, adapt
the providers/services/slot rules, then deploy (async — poll to a live URL).
Local edition only.

**Fetch the bundle:**
- `gridctl_fetch("template", "appointment-booking")` — this blueprint (`cloudgrid.yaml` + `AGENTS.md`).
- `gridctl_fetch("template", "app-with-data")` — the proven Next.js + Mongo shape to extend (lazy db client, App-Router API).

**Key rules:**

1. **Blueprint — read `AGENTS.md` first.** It has the file tree, the Mongo
   collections (`providers`, `services`, `availability`, `appointments`), the
   slot-computation + anti-double-booking rules, the CloudGrid injection table,
   and the auth + Stripe wiring. Build following it; do not invent structure.
2. **App code MUST live under `services/web/`.** `path: /` is the URL mount, NOT
   the filesystem path. Root files fail with `Service directory not found`.
3. **Mongo via `needs:{database:true}`** → the grid injects
   `DATABASE_MONGODB_URL` (legacy `MONGODB_URL` fallback). Read it LAZILY inside
   the getter, never at module top level (top-level read fails `next build`).
4. **Secrets via the `vault:` block** → env vars. `AUTH_PROVIDER_KEY` (and, for
   deposits, `STRIPE_KEY` / `STRIPE_WEBHOOK_SECRET`) map to vault items; set them
   with `gridctl_secrets`, and the deployer injects them at runtime. Read lazily;
   do not commit keys or put secrets in `services.web.env`.
5. **No double-booking.** `appointments` is the source of truth for "taken";
   compute open slots as availability minus booked, re-check at write time, and
   guard the insert with a partial unique index on `{ providerId, startAt }`.
6. **Never set `needs:` and `requires:` together** — `requires:` is the
   deprecated v1 alias.
7. **Reminders (cron) are designed but PENDING platform issue #1543** — keep the
   `reminders` cron service COMMENTED in `cloudgrid.yaml`; it is not yet
   deployable. See AGENTS.md § 7.

## cloudgrid.yaml (active fields)

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: appointment-booking
services:
  web:
    type: nextjs
    path: /
needs:
  database: true
vault:
  AUTH_PROVIDER_KEY: auth-provider-key
  STRIPE_KEY: stripe-live-key
  STRIPE_WEBHOOK_SECRET: stripe-webhook-secret
```

> **Capability:** `needs: { database: true }` → the deployer provisions Mongo and
> injects `DATABASE_MONGODB_URL` (+ legacy `MONGODB_URL`). The `vault:` block maps
> auth/Stripe secrets to env vars — the CloudGrid-correct way to inject
> credentials. `requires:` is the deprecated v1 alias; don't mix it with `needs:`.
> A `reminders` cron service is designed (commented) but cron deploy is PENDING
> #1543. See the capability-map for the full injection table.

## Deploy (async, local edition)

`gridctl_init` first (creates the entity + link.json), write the app under
`services/web/`, set the vault secrets with `gridctl_secrets`, `gridctl_plug`
(async — poll `gridctl_status` to a live URL). If taking deposits, register the
`/api/webhook` URL in Stripe and re-plug. Re-plug the same entity to update the
same URL.
