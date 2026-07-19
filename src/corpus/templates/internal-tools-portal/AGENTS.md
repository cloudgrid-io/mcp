# AGENTS.md — internal-tools-portal (blueprint / structure guide)

This is a **blueprint**, not filled app code. It tells you how to build a
persistent internal tools portal / admin tools hub / back-office portal correctly
**on CloudGrid**: a Next.js app under `services/web/`, backed by the grid-shared
MongoDB, gated by staff-only auth via a provider SDK (Clerk or Auth0) whose keys
come from the org **vault**, with role-based access control (RBAC) where **each
internal tool is its own route** under a shared authenticated shell.

Read this whole file, then build the app following it. Do not invent a different
service layout — the CLI looks for code under `services/web/`.

---

## 1. File tree

App code MUST live under `services/web/` — `path:` in `cloudgrid.yaml` is the URL
mount, NOT the filesystem path. The service named `web` → the CLI looks for
`services/web/`. Files at the repo root fail with
`Error: Service directory not found: …/services/web`.

```
cloudgrid.yaml                                # name + services.web (nextjs) + needs:{database:true} + vault: auth keys
services/web/package.json                     # next, react, react-dom, mongodb + auth SDK (@clerk/nextjs or @auth0/nextjs-auth0)
services/web/middleware.js                    # auth middleware — protect ALL routes except /sign-in, /sign-up, public assets
services/web/lib/db.js                        # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/lib/auth.js                      # current-user helper: resolve session → { userId, email, roles[] }; requireRole(role)
services/web/lib/tools.js                     # the tool registry: id, label, path, requiredRole — drives the hub grid + gating
services/web/app/layout.js                    # root layout, wraps children in the auth provider (<ClerkProvider> / Auth0 provider)
services/web/app/page.js                      # server component: the hub — cards for each tool the signed-in staffer may open
services/web/app/tools/[tool]/page.js         # server component: a single tool surface, role-gated by lib/tools.js + requireRole
services/web/app/admin/users/page.js          # server component: admin-only — manage staff + role assignments
services/web/app/api/me/route.js              # GET current staff profile { email, roles } for the client shell
services/web/app/api/tools/[tool]/route.js    # per-tool data API: GET/POST/etc., re-checks the tool's requiredRole server-side
services/web/app/api/staff/route.js           # GET list / POST invite (admin); assign roles
services/web/app/api/staff/[id]/route.js      # PATCH roles / deactivate (admin only)
services/web/app/api/audit/route.js           # GET audit log (admin); every tool mutation appends an entry
```

Sign-in / sign-up pages depend on the provider: Clerk gives you catch-all routes
(`app/sign-in/[[...sign-in]]/page.js`), Auth0 uses its hosted login + a
`app/api/auth/[auth0]/route.js` handler. Follow the chosen provider's Next.js
App-Router quickstart for those exact files.

**Each tool is a route.** Add a new internal tool by (a) adding an entry to
`lib/tools.js` with its `requiredRole`, and (b) creating its page under
`app/tools/<id>/` (or a dedicated `app/<id>/` route) plus any data API under
`app/api/tools/<id>/`. The hub (`app/page.js`) renders only the tools the current
staffer's roles allow, and each tool + its API re-checks the role server-side.

---

## 2. Mongo collections + fields

Three collections in the grid-shared Mongo. Keyed to the auth provider's stable
user id so the identity and the staff record line up.

**`staff`** — one document per staff member (the RBAC source of truth).
| field         | type     | notes                                                       |
|---------------|----------|-------------------------------------------------------------|
| `_id`         | ObjectId | Mongo id                                                    |
| `authUserId`  | string   | provider user id (Clerk `userId` / Auth0 `sub`) — unique    |
| `email`       | string   | from the auth session                                       |
| `name`        | string   | display name                                                |
| `roles`       | string[] | e.g. `["support"]`, `["ops","admin"]` — drives tool access  |
| `active`      | boolean  | deactivated staff keep no access even if the SSO account lives |
| `createdAt`   | Date     |                                                             |
| `lastSeenAt`  | Date     |                                                             |

**`toolData`** — generic per-tool records (adapt/split per real tool; one
collection with a `tool` discriminator keeps the blueprint compact).
| field       | type     | notes                                                        |
|-------------|----------|--------------------------------------------------------------|
| `_id`       | ObjectId | Mongo id                                                     |
| `tool`      | string   | tool id from `lib/tools.js` (e.g. `"feature-flags"`)         |
| `key`       | string   | record key within the tool                                   |
| `value`     | mixed    | the tool's payload                                           |
| `updatedBy` | string   | `authUserId` of the last editor                              |
| `updatedAt` | Date     |                                                              |

**`auditLog`** — append-only record of who did what (internal tools need a trail).
| field        | type     | notes                                                   |
|--------------|----------|---------------------------------------------------------|
| `_id`        | ObjectId | Mongo id                                                |
| `actor`      | string   | `authUserId`                                            |
| `actorEmail` | string   | denormalized for readable logs                          |
| `tool`       | string   | tool id                                                 |
| `action`     | string   | e.g. `"update"`, `"delete"`, `"role.grant"`             |
| `target`     | string   | record key / affected staff id                          |
| `at`         | Date     |                                                         |

RBAC flow: a staffer signs in via the provider → `middleware.js` blocks
unauthenticated requests → `lib/auth.js` looks up the `staff` doc by `authUserId`,
returns `{ userId, email, roles }` (and denies inactive staff). The hub shows only
tools whose `requiredRole` is in the staffer's `roles`; every tool page + API
re-checks `requireRole` server-side. Mutations append to `auditLog`. Seed the
first `admin` by inserting a `staff` doc with `roles: ["admin"]`; admins manage
everyone else via `app/admin/users`.

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
  A tool that talks to a third-party API (Stripe, SendGrid, an internal service
  token) adds one more `vault:` line per secret, e.g. `STRIPE_KEY: stripe-live-key`.
- **AI (optional):** if a tool needs an LLM (draft copy, summarize a record), add
  `needs: { ai: true }` and the grid injects **`AI_GATEWAY_URL`** for use with
  `@cloudgrid-io/ai`. Not required for the core portal.

Non-secret config (log level, feature toggles) → `services.web.env` in the yaml,
or `grid env`. Actual secrets → the vault (never `env:`, never committed).

---

## 4. Wiring staff-only auth + RBAC

Pick one provider and follow its Next.js App-Router quickstart. The CloudGrid
specifics:

1. **Keys from the vault, not the SDK dashboard's `.env`.** Store the provider's
   secret + publishable keys as org vault items; the `vault:` block injects them
   as env vars. Do not commit local env files (`.env`).
2. **Provider in the layout.** Wrap `app/layout.js` children in the provider
   component (`<ClerkProvider>` or the Auth0 provider).
3. **Middleware gate (staff-only).** `services/web/middleware.js` protects EVERY
   route except the sign-in/sign-up pages and public assets. There is no public
   surface — an internal portal is entirely behind auth. Unauthenticated requests
   redirect to sign-in. (For extra lockdown, restrict sign-ups to your corporate
   domain / an invite allowlist in the provider config.)
4. **Roles live on the `staff` record, in Mongo — not on the client.** `lib/auth.js`
   reads the session, looks up the `staff` doc by `authUserId`, and returns
   `{ userId, email, roles }`, denying inactive staff. `lib/tools.js` maps each
   tool id → its `requiredRole`.
5. **Server-side role checks on every tool + mutation.** In `app/tools/[tool]/page.js`
   and each `app/api/tools/[tool]/route.js`, re-resolve the staffer server-side
   and `requireRole(tool.requiredRole)` before rendering data or performing the
   action; reject with 403 otherwise. The hub hiding a card is UX only — never
   the security boundary. Append every mutation to `auditLog`.

If a tool needs payments (e.g. an internal refund console), add Stripe the same
way: map `STRIPE_KEY: stripe-live-key` in `vault:`, add `app/api/checkout/route.js`
(or a refund route) and a `app/api/webhooks/stripe/route.js` webhook route reading
`process.env.STRIPE_KEY`. The webhook route must be excluded from the auth
middleware (Stripe calls it unauthenticated; verify the Stripe signature instead).

---

## 5. Deploy steps

A runtime deploy is **async** and needs the **local edition** (see below).

1. **Write** the code under `services/web/` and set `cloudgrid.yaml` to the active
   shape: `name: internal-tools-portal` + `services.web { type: nextjs, path: / }`
   + `needs: { database: true }` + the `vault:` auth-key map.
2. **`grid plug --no-deploy`** — registers the entity from the manifest (honors
   its `name:`) and writes `.cloudgrid/link.json`, without building yet.
3. **Create the vault items** the `vault:` block references (the auth provider's
   secret + publishable keys, plus any per-tool API secrets). `grid secrets` /
   vault UI — never commit them.
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
