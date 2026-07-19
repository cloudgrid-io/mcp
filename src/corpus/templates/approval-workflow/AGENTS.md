# AGENTS.md — approval-workflow (blueprint)

A multi-step approval system: a requester submits a **request**, it advances
through an ordered chain of **approval steps**, each step is decided (approve /
reject / delegate) by an assigned approver **role**, and every action is
recorded. This is a **blueprint** — a structure guide, not app code. Read it,
then build the Next.js + Mongo app on the grid following the shape below.

The proven base shape is `app-with-data` (Next.js + Mongo, App Router, lazy DB
getter). This blueprint extends it with a state machine, roles, and
notifications. Fetch that template for the concrete Mongo/CRUD wiring:
`grid_get_template("template", "app-with-data")`, then adapt it to the collections
here.

## 1. File tree

Service code MUST live under `services/web/` — `path: /` in `cloudgrid.yaml` is
the URL mount, NOT the filesystem path. Files at the root fail with
`Error: Service directory not found: …/services/web`.

```
cloudgrid.yaml                               # name + services.web (nextjs) + needs:{database:true} (+ vault: for auth)
services/web/package.json                    # next, react, react-dom, mongodb (+ auth provider SDK, + stripe if used)
services/web/middleware.js                   # auth provider middleware — gates /dashboard + /api behind sign-in
services/web/lib/db.js                        # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/lib/workflow.js                  # state machine: advance/decide a request across its ordered steps
services/web/lib/auth.js                       # read current user + role from the auth provider session
services/web/lib/notify.js                     # send step-assigned / decided notifications (email/Slack connector)
services/web/app/layout.js                     # root layout + auth provider wrapper
services/web/app/page.js                       # server component: my requests + requests awaiting my approval
services/web/app/request-form.js               # client: create a request, choose the approval chain
services/web/app/requests/[id]/page.js         # server: one request, its steps, timeline, decide buttons
services/web/app/requests/[id]/decide.js       # client: approve / reject / delegate the current step
services/web/app/api/requests/route.js         # GET (list mine/pending) / POST (create request + seed steps)
services/web/app/api/requests/[id]/route.js    # GET one request (with steps + audit)
services/web/app/api/requests/[id]/decide/route.js  # POST a decision → advances the state machine
services/web/app/api/webhooks/auth/route.js    # auth provider webhook: upsert users into the `users` collection
```

If an approval gates a payment, add
`services/web/app/api/checkout/route.js` (create a Stripe Checkout session) and
`services/web/app/api/webhooks/stripe/route.js` (mark the request paid on
`checkout.session.completed`).

## 2. Mongo collections

The grid provisions one Mongo database (see wiring below). Model these
collections in it:

**`users`** — one per person, mirrored from the auth provider.
- `_id` (ObjectId), `authId` (provider user id, unique), `email`, `name`,
  `role` (enum: `requester` | `approver` | `admin`), `createdAt`.

**`requests`** — one per approval request (the aggregate root).
- `_id`, `title`, `description`, `amount` (optional, if it gates a payment),
  `requesterId` (→ users), `status` (enum: `pending` | `approved` | `rejected`
  | `cancelled`), `currentStep` (int, 0-based index into `steps`), `createdAt`,
  `updatedAt`.

**`steps`** — the ordered approval chain for a request (or embed as a `steps: []`
array on the request document — either works; a separate collection scales better
for querying "awaiting my approval").
- `_id`, `requestId` (→ requests), `order` (int, 0-based), `approverRole`
  (which role decides this step) or `approverId` (a specific user),
  `status` (enum: `waiting` | `active` | `approved` | `rejected` | `skipped`),
  `decidedBy` (→ users, nullable), `decidedAt` (nullable), `comment`.

**`audit`** — append-only event log (never mutate/delete rows).
- `_id`, `requestId`, `actorId` (→ users), `action` (enum: `created` |
  `approved` | `rejected` | `delegated` | `cancelled`), `at`, `detail`.

Suggested indexes: `requests.requesterId`, `requests.status`,
`steps.requestId + order`, `steps.approverRole + status`, `audit.requestId + at`.

## 3. The state machine (`lib/workflow.js`)

The core of this blueprint. Keep the transitions in one module so both the API
routes and the UI agree on what is legal.

- **Create**: seed the `steps` for the request from the chosen chain; set
  `steps[0].status = active`, the rest `waiting`; `request.status = pending`,
  `request.currentStep = 0`; append `audit(created)`.
- **Approve current step**: only the assigned role/user may decide; mark the
  active step `approved`; if a next step exists, set it `active` and bump
  `currentStep`; else set `request.status = approved`. Append `audit(approved)`.
- **Reject current step**: mark it `rejected`, set `request.status = rejected`,
  mark remaining `waiting` steps `skipped`. Append `audit(rejected)`.
- **Delegate**: reassign the active step's `approverId` to another user, append
  `audit(delegated)` — the step stays `active`.
- Guard every transition against the current `status`/`currentStep` server-side;
  never trust the client to say which step is active.
- Fire `lib/notify.js` on step activation (notify the new approver) and on final
  decision (notify the requester).

## 4. How CloudGrid injects everything

- **Mongo (the datastore):** you declare `needs: { database: true }` in
  `cloudgrid.yaml`. You do NOT provision a DB or set a connection string. The
  deployer provisions shared Mongo and injects the connection string as the
  **`DATABASE_MONGODB_URL`** env var (plus the legacy **`MONGODB_URL`** alias) at
  dev-time (`grid dev`) and at runtime (after `grid plug`). Read it in
  `lib/db.js` via `process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL`
  **lazily, inside the getter — never at module top level**, or `next build`
  fails when it imports the module for route analysis before the var exists.
- **Secrets (auth / payments) via the `vault:` block:** the CloudGrid-correct way
  to inject secrets is the `vault:` block in `cloudgrid.yaml`, which maps a vault
  item to an env var. This blueprint's yaml has a commented `vault:` block —
  uncomment it and store the real value with `grid secrets set`, then the
  deployer injects it as an env var:
  ```yaml
  vault:
    AUTH_PROVIDER_KEY: auth-provider-secret-key   # → process.env.AUTH_PROVIDER_KEY
    # STRIPE_KEY: stripe-live-key                  # → process.env.STRIPE_KEY (if a step gates a payment)
    # SENDGRID_API_KEY: sendgrid-key               # → process.env.SENDGRID_API_KEY (email notifications)
  ```
  Do NOT hardcode keys and do NOT set `DATABASE_MONGODB_URL`/`MONGODB_URL`
  yourself — the grid injects the DB vars.
- **AI (optional):** if you add AI (e.g. auto-summarize a request), declare
  `needs: { ai: true }`; the grid injects **`RUNTIME_GATEWAY_URL`** and you call it
  through `@cloudgrid-io/runtime`.
- **Non-secret config** → `grid env`. **Secrets** → `grid secrets set` (mapped by
  `vault:`).

## 5. Wiring auth (roles) and payments

**Auth + roles (required — approvals need to know who you are):**
1. Add an auth provider SDK to `package.json` (e.g. `@clerk/nextjs` or the Auth0
   Next.js SDK).
2. Put the provider's publishable key in `services/web/app/layout.js` (client
   wrapper) and the secret key in `process.env.AUTH_PROVIDER_KEY` (from the
   `vault:` block — never inline it).
3. `services/web/middleware.js` gates `/dashboard`, `/requests/*`, and `/api/*`
   behind sign-in.
4. `lib/auth.js` reads the current user + `role` from the session; the state
   machine uses `role` to decide who may approve a given step.
5. `app/api/webhooks/auth/route.js` receives the provider's user-created/updated
   webhook and upserts the person into the `users` collection with a default
   `role: requester`.

**Payments (optional — only if an approved request triggers a charge):**
1. Add `stripe` to `package.json`; put the key in `STRIPE_KEY` via `vault:`.
2. `app/api/checkout/route.js` creates a Checkout session after the request
   reaches `approved`.
3. `app/api/webhooks/stripe/route.js` verifies the signature and, on
   `checkout.session.completed`, records payment on the `requests` document.

## 6. Deploy steps

1. `grid_create_project` an app `<name>` — scaffolds the project folder and a
   `cloudgrid.yaml` with an empty `services: {}`. No server entity exists yet —
   the first `grid plug` auto-creates it from the manifest (honoring its
   `name:`) and writes `.cloudgrid/link.json`.
2. Fill `cloudgrid.yaml` to this blueprint's shape (copy this template's file):
   `services.web { type: nextjs, path: / }` + `needs: { database: true }` +
   (uncomment) the `vault:` block for `AUTH_PROVIDER_KEY`.
3. Write the app under `services/web/` following the file tree above.
4. `grid secrets set` the auth provider key (and Stripe/SendGrid keys if used);
   they are injected via the `vault:` mapping.
5. (Optional) `grid dev` to run locally against injected Mongo before deploying.
6. `grid plug` to deploy. A runtime deploy is **async** — the first response is
   `status: building`, not a live URL. Poll `grid status` (surface a liveness
   signal, never a bare silent wait) until it is live, then return the live app
   URL. Re-plug the SAME entity to update the same URL.

## 7. Edition note

This is a built + deployed container (a **runtime** app), so it requires the
**local edition** (Claude Code / Claude Desktop) or the CLI. The **hosted**
edition (Claude Web / hosted MCP) is inline-only and can publish only static
pages — it CANNOT build this runtime app. On hosted, tell the user plainly and
offer a static mock instead; do not attempt the runtime path there.
