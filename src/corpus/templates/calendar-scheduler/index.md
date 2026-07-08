# Template: calendar-scheduler (blueprint — persistent Next.js + Mongo)

A **blueprint** for a calendar / scheduling app: events on a calendar, bookable
availability slots, timezones + recurrence, and (once platform issue #1543 ships)
scheduled reminders. It is the persistent Next.js + Mongo runtime shape (same base
as `app-with-data` / `crm`) with a time/availability domain. This template ships
**structure, not app code** — read the structure guide, then build the app
following it.

**This is a blueprint (tier D):** the deliverable is `cloudgrid.yaml` +
`AGENTS.md`. Fetch the bundle, read `AGENTS.md`, then generate the files under
`services/web/` and deploy.

- **Structure guide:** `grid_fetch("template", "calendar-scheduler")` → read
  **`AGENTS.md`** (file tree, Mongo collections, CloudGrid injection table,
  optional auth/payments layers, the cron reminder shape blocked on #1543, deploy
  steps, edition note).

**Key rules (same runtime discipline as `app-with-data`):**

1. **App code MUST live under `services/web/`, not the repo root.** `path: /` in
   `cloudgrid.yaml` is the URL mount, NOT the filesystem path.
2. **Read injected connection strings/keys LAZILY (inside a getter), never at
   module top level** — a top-level read fails `next build`. The grid injects
   `DATABASE_MONGODB_URL` (+ legacy `MONGODB_URL`); optional vault entries inject
   `AUTH_PROVIDER_KEY` / `STRIPE_KEY` / `SENDGRID_API_KEY` when you add them.
3. **Declare the datastore with `needs: { database: true }`** (canonical shape).
   Never author `requires:`, and never set `needs:` and `requires:` together (the
   validator rejects the combination).
4. **Store all times as UTC `Date` in Mongo; convert at the edges.** Keep timezone
   / recurrence / overlap logic in a pure `lib/time.js`.
5. **Reminders want a `type: cron` service — BLOCKED on platform issue #1543.**
   Ship the HTTP app now; add the cron service once #1543 lands (see AGENTS.md §5).

Runtime app → **local edition** only (async build, poll to a live URL).

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields. (The file also carries a COMMENTED cron
# `reminders` service — intended shape, blocked on #1543 — and a commented vault:
# block for optional auth/payments/reminder secrets.)
name: my-calendar
services:
  web:
    type: nextjs
    path: /
needs:
  database: true
```

> **Capability:** `needs: { database: true }` → the deployer provisions Mongo and
> injects `DATABASE_MONGODB_URL` (plus legacy `MONGODB_URL`). Optional `vault:`
> entries map org vault items → env vars (`AUTH_PROVIDER_KEY` for sign-in,
> `STRIPE_KEY` + `STRIPE_WEBHOOK_SECRET` for paid bookings, `SENDGRID_API_KEY` for
> reminder mail) — store real values with `grid secrets set`. The cron `reminders`
> service is documented but not yet deployable (platform issue #1543). See the
> capability-map for the full injection table.

## Structure guide

The real content of this blueprint is **`AGENTS.md`** — fetch the template bundle
and read it. It covers the `services/web/` file tree, the `events` / `availability`
/ `bookings` collections, the CloudGrid injection table (needs + optional vault +
AI gateway), how to wire optional auth (Clerk/Auth0 + `ownerId`) and payments
(Stripe Checkout + signed webhook), the intended cron reminder job shape (blocked
on #1543), and the `grid init → fill → secrets set → grid plug → poll` deploy flow.

## Adapt it

- Single-user calendar? Drop `ownerId` + auth. Multi-user / invites? Add the auth
  layer (`AUTH_PROVIDER_KEY`) and stamp `ownerId` on every write.
- Booking SaaS with deposits? Add the Stripe layer (`STRIPE_KEY` +
  `STRIPE_WEBHOOK_SECRET`) and a signed webhook.
- Pick a date library (luxon / date-fns-tz) for timezone + recurrence math; keep
  it in `lib/time.js`.
- Add `needs: { ai: true }` (injects `AI_GATEWAY_URL`) only for AI features like
  natural-language event entry.
- Reminders: leave the cron `reminders` service commented until #1543 ships; use
  the interim external-scheduler-hits-an-HTTP-route workaround (AGENTS.md §5) if
  you need reminders now.
- Build under `services/web/`, then `grid dev` (local) / `grid plug` (async — poll
  to a live URL).
