# AGENTS.md — calendar-scheduler blueprint (structure guide)

This is a **blueprint**, not a runnable app. It ships a `cloudgrid.yaml` and this
guide so an agent can *build* a calendar / scheduling app correctly on CloudGrid.
There is no app code to copy — read this, generate the files, then deploy.

A calendar scheduler is a persistent Next.js + Mongo runtime app (same base shape
as `app-with-data` / `crm`) whose domain is **events and availability**: users
create events on a calendar, define bookable time slots, and (optionally) let
others book them. Its distinguishing concern is **time** — timezones, recurrence,
overlap detection, and **scheduled reminders**. Reminders want a `cron` service;
that shape is documented in §5, but cron deploy is **BLOCKED on platform issue
#1543** — build the HTTP app now, add cron once #1543 ships.

---

## 1. File tree

App code MUST live under `services/web/` — `path: /` in `cloudgrid.yaml` is the
URL mount, NOT the filesystem path. Files at the repo root fail with
`Error: Service directory not found: …/services/web`.

```
cloudgrid.yaml                              # name + services.web(nextjs,/) + needs:{database:true} (+ optional vault, + optional cron — see §5)
services/web/
  package.json                              # next, react, react-dom, mongodb  (+ optional: auth SDK, stripe, a date lib like luxon/date-fns-tz)
  lib/
    db.js                                   # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback) — see §3 rule
    time.js                                 # pure time helpers: toUTC/fromUTC, expandRecurrence(), slotsForDay(), overlaps(a,b)
    auth.js                                 # (optional) provider SDK init from AUTH_PROVIDER_KEY; getCurrentUser()
  app/
    layout.js                               # root layout + inline CSS (+ auth provider wrapper if used)
    page.js                                 # server component: month/week calendar grid, reads events from Mongo
    events/[id]/page.js                     # event detail / edit
    book/[slug]/page.js                     # (optional) public booking page for a shareable availability link
    api/
      events/route.js                       # GET (range query ?from&to) / POST (create) — App-Router CRUD
      events/[id]/route.js                  # GET one / PATCH (reschedule/edit) / DELETE
      availability/route.js                 # GET open slots for a day/range (derives from availability - bookings)
      bookings/route.js                     # (optional) POST to book a slot -> creates an event, guards double-booking
  middleware.js                             # (optional) gate /events/** + write APIs behind auth
services/reminders/                         # (optional, BLOCKED #1543) cron job: scan due reminders, send mail/SMS — see §5
  job.js
  package.json
```

Keep it minimal and real; grow routes/collections as needed. Reuse the
`app-with-data` App-Router GET/POST/PATCH/DELETE route shape for the CRUD parts.
Store all times as **UTC `Date`** in Mongo; convert at the edges in `lib/time.js`.

---

## 2. Mongo collections + fields

The grid provisions one MongoDB database (`needs: { database: true }`). Suggested
collections (`_id` is the Mongo ObjectId on every doc):

**`events`** — a scheduled item on the calendar
- `ownerId` (string, from auth provider — omit if single-user/no auth)
- `title` (string), `description` (string)
- `startAt` (Date, UTC), `endAt` (Date, UTC)
- `timezone` (string, IANA e.g. `"America/New_York"` — the zone the user entered it in)
- `allDay` (bool)
- `recurrence` (string | null — an RRULE, e.g. `"FREQ=WEEKLY;BYDAY=MO,WE"`; expand at read time in `lib/time.js`, do not store every instance)
- `attendees` (array of `{ email, status: "invited"|"accepted"|"declined" }`)
- `reminderMinutes` (number | null — minutes-before to notify; drives the cron job)
- `reminderSentAt` (Date | null — set by the reminder job to avoid double-send)
- `createdAt` (Date)

**`availability`** — recurring bookable windows (for the scheduling/booking use)
- `ownerId` (string)
- `weekday` (number 0–6) or `date` (Date) for one-off windows
- `startMinute` (number, minutes from midnight in `timezone`), `endMinute` (number)
- `slotMinutes` (number — slot length, e.g. 30), `timezone` (string, IANA)
- `bufferMinutes` (number — gap between bookings)

**`bookings`** — (optional) an external booking against an availability window
- `ownerId` (string — whose calendar), `slotStartAt` (Date, UTC), `slotEndAt` (Date, UTC)
- `bookerName` (string), `bookerEmail` (string), `note` (string)
- `eventId` (ObjectId ref → events — the event row this booking created)
- `status` (string: `confirmed` | `cancelled`)
- `createdAt` (Date)

Index for the calendar range query and overlap checks:
`db.collection("events").createIndex({ ownerId: 1, startAt: 1 })` and a query on
`{ startAt: { $lt: rangeEnd }, endAt: { $gt: rangeStart } }` for the visible window.

---

## 3. How CloudGrid injects things

You never provision infra or set connection strings by hand. Declared inputs are
injected as env vars at `grid dev` (local) and at runtime (after `grid plug`):

| What | Declared in cloudgrid.yaml | Injected env var(s) | Read in code |
|------|----------------------------|---------------------|--------------|
| MongoDB | `needs: { database: true }` | `DATABASE_MONGODB_URL` (+ legacy `MONGODB_URL`) | `lib/db.js` |
| Auth provider key (optional) | `vault: { AUTH_PROVIDER_KEY: auth-provider-key }` | `AUTH_PROVIDER_KEY` | `lib/auth.js` |
| Stripe secret (optional, paid booking) | `vault: { STRIPE_KEY: stripe-live-key }` | `STRIPE_KEY` | `lib/stripe.js` |
| Stripe webhook secret (optional) | `vault: { STRIPE_WEBHOOK_SECRET: stripe-webhook-secret }` | `STRIPE_WEBHOOK_SECRET` | `api/webhooks/stripe/route.js` |
| Email/SMS key (optional, reminders) | `vault: { SENDGRID_API_KEY: sendgrid-key }` | `SENDGRID_API_KEY` | reminder job / `lib/notify.js` |
| AI (optional) | `needs: { ai: true }` | `AI_GATEWAY_URL` | via `@cloudgrid-io/ai` |

The `vault:` block only **maps** an org vault item key → an env var name. You must
store the real value once with `grid secrets set <vault-item-key> <value>` (e.g.
`grid secrets set sendgrid-key SG.xxx`). Non-secret public config (a public auth
key, a base URL) → `grid env`. Never commit a secret; never hardcode a connection
string. The base template ships with `needs: { database: true }` only — the vault
block stays commented until you actually add auth / payments / reminders.

**DB read rule (critical):** read the Mongo URL LAZILY inside a getter, never at
module top level — a top-level `const uri = process.env.DATABASE_MONGODB_URL`
fails `next build` (the module is imported for route analysis before the grid
injects the var). Same lazy pattern for any Stripe / provider client.

```js
// lib/db.js — same proven shape as app-with-data
import { MongoClient } from "mongodb";
export async function getDb() {
  const uri = process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL;
  if (!uri) throw new Error("DATABASE_MONGODB_URL not set — run via `grid dev` / `grid plug`.");
  globalThis.__mongo ??= new MongoClient(uri).connect();
  return (await globalThis.__mongo).db();
}
```

---

## 4. Wiring auth + payments (optional layers)

Both are optional — a personal single-user calendar needs neither. Add them only
when the use demands it, and always through the vault → env-var mechanism above.

### Auth (multi-user calendars, invites, per-user availability)
- Pick a provider SDK: **Clerk** (`@clerk/nextjs`) or **Auth0**
  (`@auth0/nextjs-auth0`). Add it to `package.json`.
- Initialize it in `lib/auth.js` from `process.env.AUTH_PROVIDER_KEY` (vault). A
  public key (if the provider needs one client-side) is non-secret → `grid env`.
- Stamp `ownerId` on every `events` / `availability` / `bookings` write with the
  signed-in user id, and filter reads by it.
- In `middleware.js`, gate the write APIs and the owner's dashboard; leave the
  public `book/[slug]` page + the read side of `availability` open so external
  people can book without an account.

### Payments (paid bookings / deposits — the booking-SaaS shape)
- Add `stripe` to `package.json`; init a lazy client in `lib/stripe.js` from
  `process.env.STRIPE_KEY` (vault). Map `STRIPE_KEY` and `STRIPE_WEBHOOK_SECRET`
  in the `vault:` block.
- On booking a paid slot, create a Stripe **Checkout Session** (`mode: "payment"`)
  and create the `bookings`/`events` doc as `pending`.
- Add `api/webhooks/stripe/route.js`: verify the signature with
  `stripe().webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET)`
  (read the RAW body — do NOT JSON-parse before verifying) and on
  `checkout.session.completed` mark the booking `confirmed`. Point the Stripe
  dashboard webhook at `<live-url>/api/webhooks/stripe`.

---

## 5. Scheduled reminders (cron) — INTENDED SHAPE, BLOCKED on #1543

A calendar scheduler wants scheduled work: every few minutes, find events whose
reminder is due and send an email/SMS. On CloudGrid that is a **second service of
`type: cron`** in the same entity, sharing the app-level Mongo.

**PLATFORM STATUS — NOT YET DEPLOYABLE.** Cron deploy is a **PENDING platform
issue (#1543)**. Do NOT uncomment the cron service in `cloudgrid.yaml` yet;
plugging it today will not schedule the job. Ship the HTTP app now; add the cron
service once #1543 lands. Until then, this is the intended shape only.

Intended `cloudgrid.yaml` addition (currently commented in the shipped file):

```yaml
services:
  web:
    type: nextjs
    path: /
  reminders:            # BLOCKED #1543 — do not uncomment until it ships
    type: cron
    schedule: "*/15 * * * *"   # every 15 min
    timezone: UTC              # UTC | EST | PST
    run: job                   # run the container's default job (or an https URL)
```

Intended job (`services/reminders/job.js`): reads `DATABASE_MONGODB_URL` the same
lazy way, queries
`events` where `reminderMinutes != null`, `reminderSentAt == null`, and
`startAt <= now + reminderMinutes`, sends via the mail/SMS provider (its key mapped
in `vault:`), then sets `reminderSentAt` so it never double-sends. A cron service
has NO `path` (no HTTP route) and shares the app-level `needs.database`.

Interim workaround until #1543: trigger reminders from an external scheduler
hitting an authenticated HTTP route on `web` (e.g. `POST /api/cron/reminders`
guarded by a shared secret from the vault), instead of a `type: cron` service.

---

## 6. Deploy steps

Runtime app → **local edition** only (Claude Desktop / Claude Code / CLI); the
hosted edition cannot build a runtime container. Order matters — `plug` needs a
linked directory, so `init` first.

1. `grid init` (or `grid_init`) an app `<name>` — creates the entity +
   `.cloudgrid/link.json` and a starter `cloudgrid.yaml` with empty `services:{}`.
2. Fill: put the app under `services/web/` and set `cloudgrid.yaml` to this
   blueprint's active fields (`services.web` nextjs `/`, `needs:{database:true}`).
   Uncomment a `vault:` entry only if you added auth / payments / reminders.
3. (If you mapped vault items) store the values:
   `grid secrets set <vault-item-key> <value>`. Non-secret public config → `grid env`.
   Do NOT set `DATABASE_MONGODB_URL` / `MONGODB_URL` yourself — the grid injects them.
4. (Optional) `grid dev` to run locally against the injected dev Mongo (+ secrets).
5. `grid plug` to deploy. A runtime deploy is **ASYNC** — the first response is
   `status: building`, not a live URL. Poll `grid status` (surface a liveness
   signal, never a bare wait) until Ready.
6. Once live, return the app URL. Re-plug the same entity to update the same URL.
   (Do NOT add the cron `reminders` service until #1543 ships — see §5.)

---

## 7. Edition note

Because this is a built + deployed container (Next.js + Mongo), it requires the
**local edition** (Claude Desktop / Claude Code) or the CLI. The hosted edition
(Claude Web / hosted MCP) is inline-only and can only publish static pages —
offer a static calendar mockup there, but the real scheduler must be built and
plugged from the local edition.
