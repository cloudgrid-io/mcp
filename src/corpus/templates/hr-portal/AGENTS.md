# AGENTS.md — hr-portal (blueprint / structure guide)

This is a **blueprint**, not filled app code. It tells you how to build a
persistent HR / employee portal correctly **on CloudGrid**: a Next.js app under
`services/web/`, backed by the grid-shared MongoDB, with employee/admin auth via
a provider SDK (Clerk or Auth0) whose keys come from the org **vault**, and a
leave/PTO request + approval flow.

Read this whole file, then build the app following it. Do not invent a different
service layout — the CLI looks for code under `services/web/`.

---

## 1. File tree

App code MUST live under `services/web/` — `path:` in `cloudgrid.yaml` is the URL
mount, NOT the filesystem path. The service named `web` → the CLI looks for
`services/web/`. Files at the repo root fail with
`Error: Service directory not found: …/services/web`.

```
cloudgrid.yaml                              # name + services.web (nextjs) + needs:{database:true} + vault: auth keys
services/web/package.json                   # next, react, react-dom, mongodb + auth SDK (@clerk/nextjs or @auth0/nextjs-auth0)
services/web/middleware.js                  # auth middleware — protect all routes except /sign-in, /sign-up, public assets
services/web/lib/db.js                      # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/lib/auth.js                    # current-user helper: resolve session → { userId, email, role } (employee|admin)
services/web/app/layout.js                  # root layout, wraps children in the auth provider (<ClerkProvider> / Auth0 provider)
services/web/app/page.js                    # server component: employee dashboard — my leave balance + my requests
services/web/app/admin/page.js              # server component: admin queue — pending requests to approve/reject (role-gated)
services/web/app/leave-request-form.js      # client component: submit a new leave/PTO request
services/web/app/api/employees/route.js     # GET list / POST create employee profile (admin); GET self for employee
services/web/app/api/leave-requests/route.js# GET (mine, or all for admin) / POST (submit) leave requests
services/web/app/api/leave-requests/[id]/route.js  # PATCH approve/reject (admin only), DELETE (cancel own pending)
```

Sign-in / sign-up pages depend on the provider: Clerk gives you catch-all routes
(`app/sign-in/[[...sign-in]]/page.js`), Auth0 uses its hosted login + a
`app/api/auth/[auth0]/route.js` handler. Follow the chosen provider's Next.js
App-Router quickstart for those exact files.

---

## 2. Mongo collections + fields

Two collections in the grid-shared Mongo. Keyed to the auth provider's stable
user id so the identity and the HR record line up.

**`employees`**
| field        | type   | notes                                                    |
|--------------|--------|----------------------------------------------------------|
| `_id`        | ObjectId | Mongo id                                               |
| `authUserId` | string | provider user id (Clerk `userId` / Auth0 `sub`) — unique |
| `email`      | string | from the auth session                                    |
| `name`       | string | display name                                             |
| `role`       | string | `"employee"` \| `"admin"`                                |
| `department` | string | e.g. Engineering, Sales                                  |
| `ptoBalance` | number | remaining PTO days                                       |
| `createdAt`  | Date   |                                                          |

**`leaveRequests`**
| field         | type   | notes                                                   |
|---------------|--------|---------------------------------------------------------|
| `_id`         | ObjectId | Mongo id                                              |
| `employeeId`  | string | `authUserId` of the requester                           |
| `type`        | string | `"pto"` \| `"sick"` \| `"unpaid"`                       |
| `startDate`   | Date   |                                                         |
| `endDate`     | Date   |                                                         |
| `days`        | number | computed business days                                  |
| `reason`      | string | optional                                                |
| `status`      | string | `"pending"` \| `"approved"` \| `"rejected"` \| `"cancelled"` |
| `decidedBy`   | string | admin `authUserId` who approved/rejected                |
| `decidedAt`   | Date   |                                                         |
| `createdAt`   | Date   |                                                         |

Approval flow: employee POSTs a request → `status: "pending"`. Admin PATCHes it
→ `approved`/`rejected` (set `decidedBy`, `decidedAt`). On approve, decrement the
employee's `ptoBalance` by `days`. Employees may DELETE (cancel) only their own
`pending` requests.

---

## 3. How CloudGrid injects things

You do **not** provision infrastructure or set connection strings/secrets by
hand. Declare them in `cloudgrid.yaml`; the deployer injects env vars at
dev-time (`grid dev`) and runtime (after `grid plug`).

- **Database (Mongo):** `needs: { database: true }` → the grid injects
  **`DATABASE_MONGODB_URL`** (plus the legacy **`MONGODB_URL`** alias). Read
  `process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL` **lazily inside a
  getter** in `services/web/lib/db.js` — never at module top level, or
  `next build` fails (the module is imported for route analysis before the grid
  injects the var). Never hardcode a connection string.
- **Auth secrets (vault):** the `vault:` block maps org vault items → env vars.
  This blueprint maps:
  ```yaml
  vault:
    AUTH_PROVIDER_SECRET_KEY: auth-provider-secret-key
    AUTH_PROVIDER_PUBLISHABLE_KEY: auth-provider-publishable-key
  ```
  So `process.env.AUTH_PROVIDER_SECRET_KEY` /
  `process.env.AUTH_PROVIDER_PUBLISHABLE_KEY` are available at build+runtime.
  You must first create those items in the org vault (see step 5). Rename the
  keys to the provider's expected names if you prefer to read the SDK's native
  env vars directly (e.g. `CLERK_SECRET_KEY` /
  `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, or `AUTH0_SECRET` / `AUTH0_CLIENT_ID` /
  `AUTH0_CLIENT_SECRET`) — just keep the `vault:` map keys and the code in sync.
- **AI (optional):** if you later add `needs: { ai: true }`, the grid injects
  **`RUNTIME_GATEWAY_URL`** for use with `@cloudgrid-io/runtime` (e.g. drafting policy text
  or summarizing requests). Not required for the core portal.

Non-secret config (log level, default PTO allotment) → `services.web.env` in the
yaml, or `grid env`. Actual secrets → the vault (never `env:`, never committed).

---

## 4. Wiring auth (employee / admin roles)

Pick one provider and follow its Next.js App-Router quickstart. The CloudGrid
specifics:

1. **Keys from the vault, not the SDK dashboard's `.env`.** Store the provider's
   secret + publishable keys as org vault items; the `vault:` block injects them
   as env vars. Do not commit local env files (`.env`).
2. **Provider in the layout.** Wrap `app/layout.js` children in the provider
   component (`<ClerkProvider>` or the Auth0 provider).
3. **Middleware gate.** `services/web/middleware.js` protects every route except
   the sign-in/sign-up pages and public assets. Unauthenticated requests redirect
   to sign-in.
4. **Role resolution.** `lib/auth.js` reads the session, looks up the matching
   `employees` document by `authUserId`, and returns `{ userId, email, role }`.
   Seed the first `admin` by inserting an `employees` doc with `role: "admin"`
   (or promote via an admin-only route). Store `role` on the HR record — do not
   trust a client-sent role.
5. **Server-side role checks on every mutation.** In the API routes and the
   `app/admin/` pages, re-resolve the user server-side and reject non-admins with
   403 before approving/rejecting. Never gate on the client alone.

(If the portal ever needs paid tiers, add Stripe the same way: map
`STRIPE_KEY: stripe-live-key` in `vault:`, add `app/api/checkout/route.js` and a
`app/api/webhooks/stripe/route.js` webhook route reading
`process.env.STRIPE_KEY`. Not part of the core HR portal.)

---

## 5. Deploy steps

A runtime deploy is **async** and needs the **local edition** (see below).

1. **Write** the code under `services/web/` and set `cloudgrid.yaml` to the active
   shape: `name: hr-portal` + `services.web { type: nextjs, path: / }` + `needs:
   { database: true }` + the `vault:` auth-key map.
2. **`grid plug --no-deploy`** — registers the entity from the manifest (honors
   its `name:`) and writes `.cloudgrid/link.json`, without building yet.
3. **Create the vault items** the `vault:` block references (the auth provider's
   secret + publishable keys). `grid secrets` / vault UI — never commit them.
4. **(Optional) `grid dev`** to run locally against the injected dev Mongo + the
   injected vault env vars before deploying.
5. **`grid plug`** to build + deploy the folder. The first response is
   `status: building`, NOT a live URL — **poll `grid status`** (or the returned
   poll URL) until the entity is live, surfacing a liveness signal while it
   builds. Only then return the live app URL. Re-plug the SAME entity to update
   the same URL.

---

## 6. Edition note

This is a persistent, built-and-deployed runtime app (Next.js container + Mongo +
auth). It requires the **local edition** (Claude Desktop / Claude Code) or the
CLI. The **hosted edition** (Claude Web / hosted MCP) is inline-only and can only
publish static pages — it cannot build this runtime app. On hosted, stop the
runtime path and offer a static mock instead.
