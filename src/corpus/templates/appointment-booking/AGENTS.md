# AGENTS.md — appointment-booking (BLUEPRINT)

This is a **blueprint**, not runnable code. It tells an agent how to build an
appointment / clinic / salon booking app correctly on CloudGrid: a Next.js app
where a business defines providers and services, publishes bookable time slots,
and clients book an appointment against an available slot — with auth so a
provider owns their calendar, optional Stripe deposits, and grid-shared Mongo
for persistence. Read this whole file, then build the app under `services/web/`
following the structure below. Do not skip the CloudGrid wiring rules — they are
what make it deploy.

The proven persistent shape is `app-with-data` (Next.js + Mongo). This blueprint
extends it with auth, availability/slot logic, and optional Stripe deposits.
Fetch that template for the Mongo lazy-client and App-Router API pattern:
`grid_fetch("template", "app-with-data")`.

## 1. File tree

Build exactly this layout. **App code MUST live under `services/web/`** — the
service is named `web`, so the CLI looks for `services/web/`. `path: /` in
`cloudgrid.yaml` is the URL mount, NOT the filesystem path. Files at the repo
root fail with `Error: Service directory not found: …/services/web`.

```
cloudgrid.yaml                                 # name + services.web (nextjs) + needs:{database:true} + vault: (auth + optional Stripe)
services/web/package.json                      # next, react, react-dom, mongodb, + auth SDK (e.g. @clerk/nextjs); stripe only if deposits
services/web/middleware.js                     # auth middleware: protects /dashboard/* + provider APIs — anon → sign-in
services/web/lib/db.js                         # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/lib/stripe.js                     # (optional) lazy Stripe client from process.env.STRIPE_KEY (never top-level)
services/web/lib/slots.js                      # availability math: expand a provider's rules into concrete open slots, minus booked
services/web/app/layout.js                     # root layout (+ auth provider wrapper if the SDK needs one)
services/web/app/page.js                       # public: list providers/services to book
services/web/app/book/[providerId]/page.js     # public: pick a service + an open slot for one provider
services/web/app/dashboard/layout.js           # gate: server-side require signed-in provider; redirect anon → sign-in
services/web/app/dashboard/page.js             # provider view: their services, availability rules, upcoming appointments
services/web/app/api/providers/route.js        # GET list providers (public) / POST create provider (auth: owner)
services/web/app/api/services/route.js         # GET services for a provider / POST create a bookable service (auth)
services/web/app/api/availability/route.js     # GET open slots for provider+date (computed) / POST set availability rules (auth)
services/web/app/api/appointments/route.js     # POST book a slot (public/client) / GET a provider's appointments (auth)
services/web/app/api/appointments/[id]/route.js# PATCH reschedule/cancel / DELETE (auth or booking token)
services/web/app/api/checkout/route.js         # (optional) POST: Stripe Checkout for a booking deposit → return url
services/web/app/api/webhook/route.js          # (optional) POST: Stripe webhook — mark appointment deposit paid
services/reminders/                            # (INTENDED cron job — PENDING #1543, see §7) reminder sender; not deployable yet
```

## 2. Mongo collections + fields

The grid provisions Mongo from `needs: { database: true }`. Use four core
collections. Booking correctness lives here — a slot is bookable only if no
active `appointments` doc already occupies that provider + start time.

**`providers`** — a bookable person/resource (doctor, stylist, room).
- `_id` (ObjectId)
- `ownerId` (string, indexed) — the auth provider's user id (Clerk/Auth0 `sub`) that owns this calendar
- `name` (string), `bio` (string), `timezone` (string, e.g. `"America/New_York"`)
- `createdAt` (Date)

**`services`** — a bookable offering (a "30-min consult", "haircut").
- `_id` (ObjectId)
- `providerId` (ObjectId, indexed)
- `name` (string), `durationMinutes` (number), `priceCents` (number, 0 = free)
- `depositCents` (number, 0 = no deposit) — drives the optional Stripe flow
- `active` (boolean)

**`availability`** — a provider's recurring open hours (the rules slots expand from).
- `_id` (ObjectId)
- `providerId` (ObjectId, indexed)
- `weekday` (number 0–6) — or store explicit date ranges if you prefer one-off availability
- `startMinute` (number, minutes past midnight in the provider's tz), `endMinute` (number)
- `slotMinutes` (number) — granularity to chop the window into

**`appointments`** — a booked slot. This is the source of truth for "taken".
- `_id` (ObjectId)
- `providerId` (ObjectId, indexed), `serviceId` (ObjectId)
- `startAt` (Date, UTC, indexed), `endAt` (Date, UTC)
- `clientName` (string), `clientEmail` (string), `clientPhone` (string)
- `status` (string) — `"pending" | "confirmed" | "cancelled" | "completed"`
- `depositStatus` (string) — `"none" | "required" | "paid"` (drives Stripe gating)
- `stripeSessionId` (string, optional), `reminderSentAt` (Date, optional — the cron sets this)
- `createdAt` (Date)

**Prevent double-booking.** Put a unique index on
`appointments { providerId, startAt }` for `status ∈ {pending, confirmed}` (a
partial unique index) and insert the booking inside a guarded write — so two
clients racing for the same slot cannot both win.

## 3. How CloudGrid injects everything (the wiring that matters)

- **Mongo** — declared by `needs: { database: true }`. The deployer provisions
  shared Mongo and injects the connection string as **`DATABASE_MONGODB_URL`**
  (plus the legacy **`MONGODB_URL`** alias) at runtime and under `grid dev`.
  Read `process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL` **LAZILY,
  inside the getter** in `lib/db.js` — never at module top level, or `next build`
  fails when it imports the module for route analysis before the grid injects
  the var. Never hardcode a connection string. Never set `needs:` and `requires:`
  together — `requires:` is the deprecated v1 alias.
- **Secrets (auth + optional Stripe) → env vars via the `vault:` block.** In
  `cloudgrid.yaml` the `vault:` block maps each env var to a vault item key:
  ```yaml
  vault:
    AUTH_PROVIDER_KEY: auth-provider-key
    STRIPE_KEY: stripe-live-key                  # only if you take deposits
    STRIPE_WEBHOOK_SECRET: stripe-webhook-secret # only if you take deposits
  ```
  Set the vault items ONCE with `grid_secrets` (or `grid secrets set`), then
  the deployer injects each as the named env var (`process.env.AUTH_PROVIDER_KEY`,
  `process.env.STRIPE_KEY`, …) at runtime and under `grid dev`. Do NOT commit
  keys; do NOT set secrets in `services.web.env` (that block is for non-secret
  config only). Read them LAZILY inside `lib/stripe.js` and the auth setup — same
  rule as the DB.
- **Public auth keys** — SDKs like Clerk also need a *publishable* key on the
  client (`NEXT_PUBLIC_...`). Publishable keys are not secret; put them in the
  non-secret `services.web.env` block (or as a build-time env), NOT the vault.
- **AI (optional)** — if you add AI features (e.g. natural-language "book me next
  Tuesday afternoon"), declare `needs: { ai: true }` and call the gateway at
  `process.env.AI_GATEWAY_URL` via `@cloudgrid-io/ai`. Not required for this
  blueprint.

## 4. Wiring auth + payments

**Auth (provider SDK, e.g. Clerk or Auth0).** Auth is for the *business side* —
providers sign in to manage their calendar and see their appointments. Clients
booking a public slot need not sign in (identify them by `clientEmail`), unless
you want client accounts.
1. Add the SDK to `services/web/package.json` (e.g. `@clerk/nextjs`).
2. Server key from the vault (`process.env.AUTH_PROVIDER_KEY`); publishable key
   from `services.web.env` as `NEXT_PUBLIC_...`.
3. Wrap the app in the provider in `app/layout.js`.
4. `services/web/middleware.js` protects `/dashboard/*` and the write/owner
   endpoints (`POST /api/providers`, `/api/services`, `/api/availability`,
   `GET /api/appointments`). The public booking routes (`GET /api/providers`,
   `GET /api/availability`, `POST /api/appointments`) stay open. Every provider
   API must scope its query by the signed-in `ownerId` — never trust a
   `providerId` from the body for owner actions without checking ownership.

**Slot computation (`lib/slots.js`).** This is the heart of correctness:
1. For a provider + date, load their `availability` rules for that weekday and
   the provider's `timezone`; chop each open window into `slotMinutes` candidate
   starts, in the provider's local time, converted to UTC.
2. Load `appointments` for that provider on that date with
   `status ∈ {pending, confirmed}`; subtract any candidate whose `[startAt,endAt)`
   overlaps a booked one (respect each service's `durationMinutes`).
3. Return the remaining open slots. `GET /api/availability` returns these;
   `POST /api/appointments` re-checks availability at write time (never trust the
   client's slot) and inserts under the partial unique index from §2.

**Payments (optional Stripe deposit).** Only if a service has `depositCents > 0`.
1. Add `stripe` to `package.json`. Build a lazy Stripe client in `lib/stripe.js`
   reading `process.env.STRIPE_KEY` inside the getter.
2. **Checkout** — on booking a deposit-required service, `app/api/checkout/route.js`
   (POST) creates a Stripe Checkout Session (`mode: "payment"`, amount =
   `depositCents`), stashes the `appointmentId` in `metadata`, sets `success_url`
   /`cancel_url`, returns `session.url`; the booking is written `status: "pending"`,
   `depositStatus: "required"`, and the client is redirected to pay.
3. **Webhook** — `app/api/webhook/route.js` (POST) verifies the signature with
   `process.env.STRIPE_WEBHOOK_SECRET` (read the RAW request body — do not
   JSON-parse before verifying). On `checkout.session.completed`, set the
   appointment `depositStatus: "paid"`, `status: "confirmed"`. Register this
   route's public URL as the webhook endpoint in the Stripe dashboard after
   deploy. If a service has no deposit, book straight to `status: "confirmed"`.

## 5. Deploy steps

1. `grid_login_status` → `grid_login` if needed. Respect the grid picker
   (ask which grid if the user has more than one).
2. `grid_init` an app `<name>` FIRST — it creates the entity, writes
   `.cloudgrid/link.json`, and a `cloudgrid.yaml` with empty `services: {}`.
   `plug` needs a linked directory.
3. Write the app under `services/web/` and set `cloudgrid.yaml` to the active
   shape: `name` + `services.web{type: nextjs, path: /}` + `needs:{database:true}`
   + the `vault:` block. (Leave the `reminders` cron service COMMENTED — see §7.)
4. Set the secrets: `grid_secrets` for `auth-provider-key` (and, if taking
   deposits, `stripe-live-key`, `stripe-webhook-secret` — the vault item keys the
   `vault:` block maps from). Non-secret config (auth publishable key, price ids)
   → `grid_env` / `services.web.env`. Do NOT set `DATABASE_MONGODB_URL`
   yourself — the grid injects it.
5. `grid_plug` to deploy. A runtime deploy is **ASYNC** — the first response
   is `status: building`, not a live URL. Poll `grid_status` (or the returned
   poll_url) until live; surface a liveness signal while it builds, never a bare
   silent wait.
6. If taking deposits, once live add the `/api/webhook` URL as the Stripe webhook
   endpoint, copy the signing secret into the `stripe-webhook-secret` vault item,
   then re-plug. Return the live app URL (not the build/log link).

## 6. Edition note

An appointment-booking app is a built + deployed runtime container, so it
requires the **local edition** (Claude Desktop / Claude Code) or the CLI. The
**hosted** edition (Claude Web / hosted MCP) is inline-only and can only publish
static pages — it CANNOT build this app. On hosted, say so plainly and offer a
static "book us" landing page (via `grid_plug`) instead, then stop the runtime
path.

## 7. Reminders (cron — PENDING platform issue #1543)

The design wants a **scheduled reminder job**: on a fixed interval, find
appointments entering the reminder window (e.g. starting in ~24h) that have not
had a reminder sent, notify the client (email/SMS via a provider key from the
vault), and stamp `reminderSentAt` so each appointment is reminded once.

The **intended** cron service shape (already present, COMMENTED, in
`cloudgrid.yaml`):

```yaml
services:
  reminders:
    type: cron
    schedule: "*/15 * * * *"   # every 15 min
    timezone: UTC
    run: job                    # runs services/reminders/ as a one-shot job per tick
```

The cron job would live under `services/reminders/` (its own entry that opens the
same Mongo via the injected `DATABASE_MONGODB_URL`, queries due appointments,
sends, and stamps `reminderSentAt`). It inherits the app-level `needs: database`
and can read a notification provider key from the `vault:` block.

**IMPORTANT: cron deploy is currently a PENDING platform issue (#1543) and is NOT
yet deployable.** Keep the `reminders` service COMMENTED in `cloudgrid.yaml` —
uncommenting it today will not deploy. Until cron ships, either (a) ship the
booking app without reminders, or (b) trigger reminders manually / from an
external scheduler hitting an authenticated `/api/appointments` reminder
endpoint. Document this limitation to the user; do not claim reminders are live.
