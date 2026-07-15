# AGENTS.md — restaurant-reservations (BLUEPRINT)

This is a **structure guide**, not runnable code. It tells an agent how to build a
restaurant website with online reservations correctly **on CloudGrid**: a public
Next.js site (menu + booking form) backed by grid-shared MongoDB, with the
CloudGrid-native wiring for the DB, secrets, optional payments/auth, and a
scheduled reminder job. Read it end to end, then build the app under
`services/web/` following the same proven shape as the `app-with-data` template.

Do NOT ship this as-is — there is no app code here. Adapt the tree below.

---

## 1. File tree

App code MUST live under `services/<service-name>/`. The service is named `web`,
so the CLI looks for `services/web/`. `path: /` in `cloudgrid.yaml` is the URL
mount, NOT the filesystem path — files at the repo root fail with
`Error: Service directory not found: …/services/web`.

```
cloudgrid.yaml                                   # name + services.web (nextjs) + needs:{database:true} + vault:
AGENTS.md                                        # this guide
services/web/package.json                        # next, react, react-dom, mongodb (+ stripe if deposits)
services/web/lib/db.js                           # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/lib/mail.js                         # SendGrid client from process.env.SENDGRID_API_KEY (vault-injected)
services/web/app/layout.js                       # root layout + site chrome / inline CSS
services/web/app/page.js                         # home: hero + menu (server component, reads menu collection)
services/web/app/reserve/page.js                 # reservation page (renders the booking form)
services/web/app/reserve/reservation-form.js     # "use client" form: POST a reservation
services/web/app/api/menu/route.js               # GET menu items (public)
services/web/app/api/reservations/route.js       # POST create reservation, GET list (staff)
services/web/app/api/reservations/[id]/route.js  # PATCH status (confirm/seat/cancel), DELETE
# ─ optional: card deposit to hold a table (Stripe) ─
services/web/app/api/checkout/route.js           # POST → create Stripe Checkout Session for a deposit
services/web/app/api/webhooks/stripe/route.js    # POST ← Stripe webhook: mark reservation deposit paid
# ─ optional: staff auth (Clerk/Auth0) ─
services/web/middleware.js                        # protect /staff/* routes with the provider SDK
services/web/app/staff/page.js                    # staff dashboard: today's reservations
# ─ scheduled reminders (SEE §7 — cron deploy PENDING #1543) ─
services/reminder/package.json                    # mongodb + sendgrid; a one-shot job entry
services/reminder/index.js                        # find tomorrow's reservations → send reminder emails
```

Keep the public reservation flow **unauthenticated** — a diner should book
without an account. Auth is only for the staff dashboard.

---

## 2. MongoDB collections + fields

The grid provisions one shared Mongo database (see §3). Use these collections:

### `menu`
Menu content shown on the home page. Seed it once (script or an admin route).
| field | type | notes |
|-------|------|-------|
| `_id` | ObjectId | |
| `section` | string | e.g. "Starters", "Mains", "Desserts" |
| `name` | string | dish name |
| `description` | string | short copy |
| `price` | number | in cents, or a display string — pick one and be consistent |
| `order` | number | sort order within a section |
| `available` | boolean | hide sold-out items |

### `reservations`
The booking records — the persistent core of this app.
| field | type | notes |
|-------|------|-------|
| `_id` | ObjectId | |
| `name` | string | guest name |
| `email` | string | for confirmation + reminder |
| `phone` | string | optional |
| `partySize` | number | number of covers |
| `date` | string (`YYYY-MM-DD`) | requested date |
| `time` | string (`HH:mm`) | requested slot |
| `tableId` | ObjectId \| null | assigned table (nullable until seated) |
| `status` | string | `pending` → `confirmed` → `seated` / `cancelled` / `no_show` |
| `notes` | string | allergies, occasion, seating pref |
| `depositPaid` | boolean | true after Stripe webhook (if deposits on) |
| `reminderSentAt` | Date \| null | set by the cron job so it never double-sends |
| `createdAt` | Date | index + sort |

### `tables` (optional — table booking)
| field | type | notes |
|-------|------|-------|
| `_id` | ObjectId | |
| `label` | string | "T1", "Window 4" |
| `seats` | number | capacity |
| `zone` | string | "patio", "main", "bar" |

Availability = look up reservations for a `date`/`time` window and subtract from
`tables` capacity. Add a unique index on `{ tableId, date, time }` to prevent
double-booking a specific table, and index `reservations.createdAt` and
`{ date: 1, time: 1 }` for the availability query and the reminder job.

---

## 3. How CloudGrid injects things (the whole point)

You never provision infra or set connection strings by hand. Declare intent in
`cloudgrid.yaml`; the platform provisions and injects env vars.

- **Database (Mongo).** `needs: { database: true }` → the grid provisions shared
  Mongo and injects the connection string as **`DATABASE_MONGODB_URL`** (plus the
  legacy **`MONGODB_URL`** alias) at `grid dev` (locally) and at runtime (after
  `grid plug`). Read it **lazily** inside a getter, `process.env.DATABASE_MONGODB_URL
  || process.env.MONGODB_URL` — **never at module top level**, or `next build`
  throws when it imports the module for route analysis before the var exists.
  `db.client.db()` returns the DB from the connection-string path segment.
  Do NOT set `DATABASE_MONGODB_URL`/`MONGODB_URL` yourself.

- **Secrets (Stripe, email, auth) → `vault:` block.** Map an org vault item to an
  env var in `cloudgrid.yaml` `vault:` (already uncommented in this blueprint):
  `STRIPE_KEY: stripe-live-key`, `SENDGRID_API_KEY: sendgrid-key`,
  `AUTH_PROVIDER_KEY: auth-provider-secret`. The platform reads the named item
  from the org vault and injects it as that env var at runtime. Store the actual
  secret value with `grid_set_secret` (or the org vault UI) — never commit it. In
  code read `process.env.STRIPE_KEY`, `process.env.SENDGRID_API_KEY`, etc. Vault
  is the CloudGrid-correct path for third-party keys; `grid_set_env` is for
  non-secret config only.

- **AI (optional).** If you add AI (e.g. menu-copy generation, natural-language
  booking parsing), declare `needs: { ai: true }` → the grid injects
  **`AI_GATEWAY_URL`**; call it via `@cloudgrid-io/ai`. Not required for the base
  blueprint.

Reserved env var names you must NOT set: `PORT`, `APP_NAME`, `SERVICE_NAME`,
`NODE_ENV`, `MONGODB_URL`, `REDIS_URL`, `AI_GATEWAY_URL`, `CLOUDGRID_*`.

---

## 4. Wiring auth and/or payments

### Payments — Stripe deposit to hold a table (optional)
1. `vault: { STRIPE_KEY: stripe-live-key }` (present in `cloudgrid.yaml`); add
   `stripe` to `services/web/package.json`.
2. `app/api/checkout/route.js` — read `process.env.STRIPE_KEY`, construct the
   Stripe client, create a Checkout Session for the deposit amount, tuck the
   `reservationId` into the session `metadata`, return the session URL; the client
   redirects to it.
3. `app/api/webhooks/stripe/route.js` — verify the Stripe signature, and on
   `checkout.session.completed` set `depositPaid: true` (and `status: confirmed`)
   on the reservation from `metadata.reservationId`. This route MUST be public
   (exclude it from auth middleware) and read the raw request body for signature
   verification. Register its URL in the Stripe dashboard as the webhook endpoint
   after the app is live.

### Auth — staff dashboard login (optional)
1. `vault: { AUTH_PROVIDER_KEY: auth-provider-secret }` (uncomment it), add the
   provider SDK (e.g. `@clerk/nextjs` or `@auth0/nextjs-auth0`) to
   `package.json`.
2. `middleware.js` — protect `/staff/*` (and staff-only API routes) with the
   provider; leave `/`, `/reserve`, `/api/menu`, `/api/reservations` (POST),
   `/api/webhooks/stripe` public.
3. Initialize the SDK from `process.env.AUTH_PROVIDER_KEY` (+ any public
   publishable key via `grid_set_env`). The public booking flow needs no login.

Keep the public reservation POST open; only staff read/mutate endpoints
(`GET /api/reservations`, `PATCH/DELETE /api/reservations/[id]`, `/staff/*`) sit
behind auth.

---

## 5. Deploy steps

Runtime app → **local edition** only (Claude Desktop / Claude Code / CLI); the
build is **asynchronous**.

1. `grid_login_status` (→ `grid_login` if needed). Pick the grid if the
   user has more than one.
2. `grid_create_project` an app `<name>` — creates the entity + `.cloudgrid/link.json`
   and a `cloudgrid.yaml` with empty `services: {}`. Run `init` FIRST (plug needs
   a linked dir).
3. **Fill** — write the app under `services/web/`, then set `cloudgrid.yaml` to
   this blueprint's active fields: `name`, `services.web { type: nextjs, path: / }`,
   `needs: { database: true }`, and the `vault:` mappings you actually use.
4. Store secrets: `grid_set_secret` for the vault item values (Stripe/SendGrid/
   auth). Non-secret config (publishable keys, feature flags) → `grid_set_env`.
5. (Optional) `grid dev` — runs Next.js locally with `DATABASE_MONGODB_URL` and
   vault vars injected against dev Mongo. Seed `menu`, test a booking.
6. `grid_deploy` — builds + deploys `services/web/`. **Async**: the first
   response is `status: building`, not a URL. Poll `grid_status` (or the
   returned poll URL) until live; surface a liveness signal while it builds
   (never a bare silent wait). Only then return the **live app URL** (not the
   build/log link).
7. Iterate by re-plugging the SAME entity — it updates the same URL. If you
   turned on Stripe, register the live `/api/webhooks/stripe` URL in Stripe.

---

## 6. Edition note

This is a **runtime app** (built + deployed container), so it requires the
**local edition** (Claude Desktop / Claude Code) or the CLI. On the **hosted**
edition (Claude Web / hosted MCP) you CANNOT build a runtime app — hosted is
inline-only and can publish static pages only. If the user is on hosted, say so
plainly and offer a static, non-persistent menu page instead (no bookings), then
stop the runtime path.

---

## 7. Cron reminders — INTENDED SHAPE, NOT YET DEPLOYABLE (#1543)

The design calls for a scheduled job that emails confirmation reminders to guests
with a booking the next day. On CloudGrid this is a second **cron service** in the
same entity:

```yaml
services:
  reminder:
    type: cron
    schedule: "0 15 * * *"   # daily 15:00
    timezone: UTC
    run: job                 # runs services/reminder/ as a one-shot job
```

The cron job (`services/reminder/index.js`) reads the SAME grid-injected
`DATABASE_MONGODB_URL` and the vault-injected `SENDGRID_API_KEY`, queries
`reservations` where `date` is tomorrow and `reminderSentAt` is null and
`status` is `confirmed`, sends each a reminder, and stamps `reminderSentAt` so it
never double-sends.

> **PENDING platform issue #1543:** cron deploy is not yet available. Keep the
> `reminder:` cron block **commented out** in `cloudgrid.yaml` (as shipped) —
> plugging an entity with an active cron service will be rejected until #1543
> lands. Build the rest now; enable the cron block once cron ships. Interim
> workaround: trigger the same reminder logic from an external scheduler hitting
> a protected HTTP route, or run it manually.

---

## 8. DB wiring reference (copy the app-with-data shape)

`services/web/lib/db.js` — lazy cached Mongo client (identical pattern to the
`app-with-data` template):

```js
import { MongoClient } from "mongodb";

function clientPromise() {
  const uri = process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL;
  if (!uri) throw new Error("DATABASE_MONGODB_URL not set — the grid injects it; use grid dev / grid plug.");
  if (!globalThis.__mongoClientPromise) {
    globalThis.__mongoClientPromise = new MongoClient(uri).connect();
  }
  return globalThis.__mongoClientPromise;
}

export async function getDb() {
  const client = await clientPromise();
  return client.db();
}
```

Every route/server component imports `getDb()` from here. Mark reservation and
menu routes `export const dynamic = "force-dynamic"` so they always hit Mongo.
Validate `partySize`, `date`, `time`, `email` on the server before insert.
