# AGENTS.md — travel-booking (BLUEPRINT)

A structure guide for building a travel booking portal on CloudGrid — search and
book flights and hotels, pay with Stripe, manage trips. This is a **blueprint**,
not runnable app code: it tells you the exact file tree, data model, and
CloudGrid wiring to build so it deploys correctly. Build the app yourself
following this guide — do not expect prewritten routes.

The proven runtime shape is the same as `app-with-data` (Next.js + Mongo under
`services/web/`); this blueprint layers a travel domain (flights, hotels, trips,
bookings), Stripe payments, an auth provider, and a trip-reminder cron on top.

---

## 1. File tree

App code MUST live under `services/<name>/` — `path:` in `cloudgrid.yaml` is the
URL mount, NOT the filesystem path. The service named `web` → the CLI looks for
`services/web/`. Files at the repo root fail with
`Error: Service directory not found: …/services/web`.

```
cloudgrid.yaml                                  # name + services.web (nextjs) + needs:{database:true} + vault:
AGENTS.md                                       # this guide
services/web/package.json                       # next, react, react-dom, mongodb, stripe, auth provider SDK
services/web/lib/db.js                          # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/lib/inventory.js                   # flight/hotel search + seat/room availability check (core logic)
services/web/lib/stripe.js                      # lazy Stripe client from process.env.STRIPE_KEY (vault-injected)
services/web/lib/auth.js                        # auth-provider server helpers (session, current user) from AUTH_PROVIDER_KEY
services/web/app/layout.js                      # root layout + inline CSS
services/web/app/page.js                        # server component: search form (origin/dest, dates, guests)
services/web/app/search/page.js                 # results: matching flights + hotels for the query
services/web/app/trips/page.js                  # "my trips" — the signed-in user's bookings
services/web/app/checkout/[bookingId]/page.js   # review + pay (redirects to Stripe Checkout)
services/web/app/search-form.js                 # client component: query builder → /search
services/web/app/api/flights/route.js           # GET search flights { origin, dest, date, pax }
services/web/app/api/hotels/route.js            # GET search hotels { city, checkIn, checkOut, guests }
services/web/app/api/bookings/route.js          # GET my bookings; POST create (holds inventory, starts Stripe checkout)
services/web/app/api/bookings/[id]/route.js     # GET one; PATCH modify; DELETE cancel
services/web/app/api/webhooks/stripe/route.js   # POST Stripe webhook: on checkout.session.completed → confirm booking
#
# ── CRON (intended shape, NOT yet deployable — see §7 + platform issue #1543) ──
# services/reminders/package.json                # mongodb (+ email/SMS SDK)
# services/reminders/index.js                     # batch job: send trip reminders, sweep abandoned holds
```

---

## 2. MongoDB collections + fields

The grid provisions shared Mongo from `needs: { database: true }`. Suggested
collections (all `_id` is a Mongo ObjectId; store dates as real `Date`s, in UTC):

**`flights`** — bookable flight inventory.
- `carrier` (string) — e.g. "AA"
- `flightNumber` (string)
- `origin` / `destination` (string) — IATA codes, e.g. "SFO" / "JFK"
- `departAt` / `arriveAt` (Date, UTC)
- `priceCents` (number) — fare per seat
- `seatsTotal` / `seatsBooked` (number) — availability = total − booked
- `active` (boolean)

**`hotels`** — bookable hotel inventory.
- `name` (string)
- `city` (string)
- `roomType` (string) — e.g. "standard-king"
- `pricePerNightCents` (number)
- `roomsTotal` (number) — capacity for a given night
- `active` (boolean)

**`bookings`** — a reserved flight or hotel stay. Source of truth for inventory.
- `type` (string) — `flight` | `hotel`
- `itemId` (ObjectId → flights | hotels)
- `customerId` (string) — auth-provider user id, or null for guest
- `customerEmail` (string) — for the reminder + confirmation
- `startAt` / `endAt` (Date, UTC) — departure/arrival, or check-in/check-out
- `quantity` (number) — seats, or room-nights
- `amountCents` (number) — total charged
- `status` (string) — `pending` (inventory held, awaiting payment) → `confirmed`
  (paid) → `cancelled` | `completed`
- `stripeSessionId` (string, nullable) — links to the Checkout session
- `reminderSentAt` (Date, nullable) — set by the reminder cron; prevents dupes
- `createdAt` (Date)

**`trips`** (optional) — groups one customer's bookings into an itinerary.
- `customerId` (string)
- `name` (string) — e.g. "NYC — March"
- `bookingIds` (ObjectId[] → bookings)

**Overbooking guard:** availability for a flight is
`seatsTotal − seatsBooked − (pending holds)`; for a hotel it is `roomsTotal`
minus overlapping `confirmed`/`pending` bookings for each night in
`[checkIn, checkOut)`. Enforce it at write time inside a guarded update — e.g.
`updateOne({ _id, $expr: { $lt: ["$seatsBooked", "$seatsTotal"] } }, { $inc: { seatsBooked: qty } })`
so two concurrent requests cannot oversell the same seats (the loser matches 0
docs → return 409). `inventory.js` runs the search queries and computes remaining
availability.

---

## 3. How CloudGrid injects things

You do NOT provision infra or set connection strings/secrets by hand. Declared in
`cloudgrid.yaml`, the platform injects env vars at `grid dev` and after `grid plug`:

- **Database (`needs: { database: true }`)** → `DATABASE_MONGODB_URL` (plus the
  legacy `MONGODB_URL` alias). Read it **lazily inside a getter**, never at module
  top level — a top-level read fails `next build`, which imports the module for
  route analysis before the grid injects the var:
  ```js
  // services/web/lib/db.js
  const uri = process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL;
  ```
- **Secrets (`vault:` block)** → each mapped item becomes the named env var:
  `STRIPE_KEY`, `STRIPE_WEBHOOK_SECRET`, `AUTH_PROVIDER_KEY`. Add the underlying
  vault items with `grid secrets set <item> <value>` (or the vault UI) BEFORE
  plug, so resolution succeeds. Never hardcode a key; never commit `.env`.
- **AI (`needs: { ai: true }`, if you add it)** → `AI_GATEWAY_URL`, used via
  `@cloudgrid-io/ai`. Optional — e.g. a natural-language "plan my trip" search
  assistant. Not required for a basic portal.

Read every injected var lazily (inside getters), same rule as the DB.

---

## 4. Wiring auth + payments

**Auth (provider SDK — Clerk / Auth0 / similar).** Put the secret key in the
`vault:` block as `AUTH_PROVIDER_KEY` and read it lazily in
`services/web/lib/auth.js`. Use the provider's Next.js middleware/server helpers
to gate: booking creation (attach `customerId`), "my trips", and any admin
inventory management. Public flight/hotel search can stay unauthenticated. Guest
booking is allowed if you capture `customerEmail` and leave `customerId` null.
Store only the provider's user id in Mongo — never mirror passwords.

**Payments (Stripe).** Put the live key in `vault:` as `STRIPE_KEY` and the
webhook signing secret as `STRIPE_WEBHOOK_SECRET`; read both lazily in
`services/web/lib/stripe.js`. Flow:
1. `POST /api/bookings` — validate inventory is still available, insert the
   booking as `status: "pending"` and hold inventory via the guarded `$inc`
   update, then create a Stripe **Checkout Session** for `amountCents`, store
   `stripeSessionId` on the booking, and return the session URL for the client to
   redirect to.
2. `POST /api/webhooks/stripe` — verify the signature with
   `STRIPE_WEBHOOK_SECRET`, and on `checkout.session.completed` flip the matching
   booking to `status: "confirmed"`. This webhook — not the browser redirect — is
   the source of truth for payment. Expire/cancel stale `pending` bookings so held
   inventory is released if checkout is abandoned (a job for the reminder cron, or
   an on-read sweep).

---

## 5. Deploy steps

1. `grid init` — scaffolds the entity + `.cloudgrid/link.json`; writes a
   `cloudgrid.yaml` with an empty `services: {}`. Run this FIRST (plug needs a
   linked directory).
2. Fill it in: build the files under `services/web/` and set `cloudgrid.yaml` to
   this template's shape (`services.web` nextjs + `needs: { database: true }` +
   the `vault:` block).
3. `grid secrets set stripe-live-key <sk_live_…>` and the other vault items
   (`stripe-webhook-secret`, `auth-provider-key`), so the `vault:` mappings
   resolve at deploy.
4. (Optional) `grid dev` — runs Next.js locally with `DATABASE_MONGODB_URL` and
   the vault env vars injected against dev resources. Good for testing the search
   + availability logic before shipping.
5. `grid plug` — builds + deploys. A runtime deploy is **async**: the first
   response is `status: "building"`, not a live URL. Poll `grid status` (or the
   returned poll_url) until live; surface a liveness signal while it builds, never
   a bare silent wait. Return the live app URL only once it is up.
6. Iterate by re-plugging the SAME entity — it updates the same URL.

---

## 6. Edition note

This is a built + deployed container (runtime app), so it requires the **local
edition** (Claude Desktop / Claude Code) or the CLI. The **hosted edition**
(Claude Web / hosted MCP) is inline/static-only and CANNOT build a runtime app —
on hosted, the most you can ship is a static preview page, not the real booking
backend.

---

## 7. Trip-reminder cron — intended shape, NOT yet deployable (platform issue #1543)

The design calls for a scheduled job that sends trip reminders (e.g. check-in /
departure reminders 24h before `startAt`) and sweeps abandoned `pending` bookings
back into inventory.

**Intended shape** (mirrors the commented `reminders:` service in
`cloudgrid.yaml`):
- A second service `services/reminders/` of `type: cron`, `run: job` (batch, no
  HTTP), on a `schedule` like `0 * * * *` (hourly).
- On each run: connect to Mongo via the same `DATABASE_MONGODB_URL`; find
  `confirmed` bookings whose `startAt` is within a reminder window and
  `reminderSentAt` is null; send via an email/SMS provider (key from `vault:`);
  set `reminderSentAt`. Also cancel `pending` bookings older than the hold timeout
  and release their held seats/rooms (`$inc` the inventory back).

**Status: PENDING.** cron-service deploy is currently blocked by **platform issue
#1543** — `grid plug` will reject a `type: cron` service until it lands. Keep the
`reminders:` service COMMENTED in `cloudgrid.yaml` and ship the `web` service
alone for now. Until #1543 is fixed, run reminders as a stopgap: an on-read sweep
inside `GET /api/bookings`, or an external scheduler hitting a protected
`POST /api/cron/reminders` route on the web service. Swap to the real cron service
once the issue is resolved.
