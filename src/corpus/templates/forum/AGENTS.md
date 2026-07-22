# forum — structure guide (BLUEPRINT)

This is a **blueprint**, not runnable app code. It gives you the exact structure
to build a threaded community forum on CloudGrid: a Next.js app under
`services/web/`, backed by grid-shared MongoDB, with sign-in-to-post auth via a
hosted provider (Clerk / Auth0) whose keys come from the org vault. Build the app
by following this guide; the shape mirrors the proven `app-with-data` template
(lazy Mongo getter, App-Router API routes, `needs: { database: true }`).

---

## 1. File tree

Build exactly this layout. **App code MUST live under `services/web/`** — the
service is named `web`, so the CLI looks for `services/web/`. `path: /` in
`cloudgrid.yaml` is the URL mount, NOT the filesystem path. Files at the repo
root fail with `Error: Service directory not found: …/services/web`.

```
cloudgrid.yaml                                  # name + services.web (nextjs) + needs:{database:true} + vault: (auth keys)
services/web/package.json                       # next, react, react-dom, mongodb, + auth provider SDK (e.g. @clerk/nextjs)
services/web/middleware.js                      # auth provider middleware — protects write routes, exposes read routes
services/web/lib/db.js                           # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/lib/auth.js                         # helper: resolve current user (id + display name) from the provider session
services/web/app/layout.js                       # root layout: wraps children in the provider <ClerkProvider>/<Auth0Provider>, sign-in button
services/web/app/page.js                         # server component: lists threads (newest / most-active)
services/web/app/thread/[id]/page.js             # server component: one thread + its nested reply tree
services/web/app/thread/[id]/reply-form.js       # client component: post a reply (sign-in gated)
services/web/app/new-thread.js                   # client component: create a thread (sign-in gated)
services/web/app/api/threads/route.js            # GET list threads / POST create thread (auth required to POST)
services/web/app/api/threads/[id]/route.js       # GET one thread / DELETE (author or moderator only)
services/web/app/api/posts/route.js              # GET posts for a thread / POST a reply (auth required, supports parentId for nesting)
services/web/app/api/posts/[id]/route.js         # DELETE / PATCH a post — moderation (author or moderator)
```

Keep the UI minimal (inline CSS in `layout.js`, same as `app-with-data`). The
domain, not styling, is what this blueprint is about.

---

## 2. MongoDB collections + fields

The grid provisions MongoDB from `needs: { database: true }`. Model three
collections. Store the provider's user id as `authorId` on every authored
document — do not copy PII beyond a display name.

**`users`** — a thin local mirror of the auth-provider identity (upserted on
first post; the provider remains the source of truth for auth).
| field         | type     | notes                                              |
|---------------|----------|----------------------------------------------------|
| `_id`         | ObjectId | Mongo id                                           |
| `authorId`    | string   | provider user id (Clerk/Auth0 `sub`), **unique**   |
| `displayName` | string   | shown next to posts                                |
| `role`        | string   | `member` (default) or `moderator`                  |
| `createdAt`   | Date     |                                                    |

**`threads`** — one row per discussion topic.
| field         | type     | notes                                              |
|---------------|----------|----------------------------------------------------|
| `_id`         | ObjectId | thread id (used in `/thread/[id]`)                 |
| `title`       | string   | required, trimmed                                  |
| `authorId`    | string   | provider user id of the creator                    |
| `authorName`  | string   | denormalized display name                          |
| `replyCount`  | number   | denormalized, bumped on each reply                 |
| `createdAt`   | Date     | sort key for "newest"                              |
| `lastPostAt`  | Date     | sort key for "most-active"                         |

**`posts`** — every reply. Nesting is by `parentId` (self-referential adjacency
list); the top-level post of a thread has `parentId: null`.
| field         | type            | notes                                       |
|---------------|-----------------|---------------------------------------------|
| `_id`         | ObjectId        | post id                                     |
| `threadId`    | ObjectId        | which thread this belongs to (indexed)      |
| `parentId`    | ObjectId / null | reply target; `null` = direct thread reply  |
| `authorId`    | string          | provider user id                            |
| `authorName`  | string          | denormalized display name                   |
| `body`        | string          | required, trimmed                           |
| `deleted`     | boolean         | soft-delete for moderation (keeps tree)     |
| `createdAt`   | Date            | sort within a nesting level                 |

Recommended indexes: `posts.threadId`, `posts.parentId`, unique
`users.authorId`, `threads.lastPostAt`.

**Render nested replies** by fetching all posts for a thread (`{ threadId }`),
then building the tree in memory from `parentId` — one query, arbitrary depth.
For a soft-deleted post keep the node so its children stay reachable; render its
body as "[removed]".

---

## 3. How CloudGrid injects things

You never provision infra or set connection strings by hand. Declared needs and
vault mappings become environment variables at **both** `next build` / `grid
dev` and runtime.

- **Database (`needs: { database: true }`)** → the grid provisions MongoDB and
  injects **`DATABASE_MONGODB_URL`** (plus the legacy **`MONGODB_URL`** alias).
  Read it as `process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL`
  **lazily, inside the getter in `lib/db.js`** — never at module top level, or
  `next build` throws when it imports the module for route analysis before the
  var exists.
- **Auth secrets (`vault:` block)** → each `ENV_VAR: vault-item-key` mapping
  injects that vault item as `process.env.ENV_VAR`. This blueprint maps
  `AUTH_PROVIDER_SECRET_KEY` and `AUTH_PROVIDER_PUBLISHABLE_KEY`. Rename the env
  keys to whatever the provider SDK expects (see §4) and set the vault items with
  `grid_set_secret` / the org vault — do not commit keys.
- **AI (optional)** — if you add `needs: { ai: true }` (e.g. auto-moderation or
  summarize-thread), the grid injects **`RUNTIME_GATEWAY_URL`**; call it via
  `@cloudgrid-io/runtime`. Not required for the base forum.
- **Reserved vars** you must NOT set yourself: `PORT`, `NODE_ENV`,
  `DATABASE_MONGODB_URL`, `MONGODB_URL`, `REDIS_URL`, `RUNTIME_GATEWAY_URL`,
  `CLOUDGRID_*`.

`lib/db.js` — copy the lazy-getter pattern from `app-with-data`:

```js
import { MongoClient } from "mongodb";
function clientPromise() {
  const uri = process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL;
  if (!uri) throw new Error("DATABASE_MONGODB_URL not set — run with grid dev or grid plug.");
  if (!globalThis.__mongoClientPromise) globalThis.__mongoClientPromise = new MongoClient(uri).connect();
  return globalThis.__mongoClientPromise;
}
export async function getDb() { return (await clientPromise()).db(); }
```

---

## 4. Wiring auth (sign-in-to-post)

Reading threads is public; **posting requires a signed-in member**. Use a hosted
auth provider so you don't build password handling. Two common choices:

- **Clerk** — add `@clerk/nextjs`. The SDK reads `CLERK_SECRET_KEY` and
  `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`. Map the vault to those exact env names in
  `cloudgrid.yaml` (rename `AUTH_PROVIDER_SECRET_KEY` →
  `CLERK_SECRET_KEY`, `AUTH_PROVIDER_PUBLISHABLE_KEY` →
  `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`). Wrap `app/layout.js` in
  `<ClerkProvider>`, add `<SignInButton>` / `<UserButton>`, and in
  `middleware.js` protect the write routes.
- **Auth0** — add `@auth0/nextjs-auth0`; it reads `AUTH0_SECRET`,
  `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_BASE_URL`, `AUTH0_ISSUER_BASE_URL`.
  Map the vault items to those names.

Wiring pattern regardless of provider:

1. `middleware.js` — mark `GET /`, `GET /thread/*`, and the read (`GET`) API
   routes as public; require a session for `POST`/`PATCH`/`DELETE`.
2. `lib/auth.js` — resolve the current user server-side (`auth()` in Clerk,
   `getSession()` in Auth0). Return `{ authorId, displayName }` or `null`.
3. In each write route: call the auth helper; if `null`, return `401`. On the
   first authored action, **upsert** the user into the `users` collection
   (keyed by `authorId`) so display names + roles are local.
4. **Moderation** — a `DELETE`/`PATCH` on a post or thread is allowed only when
   the caller's `authorId` matches the document's `authorId` OR the caller's
   `users.role === "moderator"`. Prefer **soft delete** (`deleted: true`) on
   posts so the reply tree stays intact.

The `vault:` block is the CloudGrid-correct way to inject these secrets — never
inline a key in code or `env:`.

---

## 5. Deploy steps

A forum is a runtime (built + deployed container) app — **local edition**
(Claude Desktop / Claude Code / CLI), async build.

1. `grid_login_status` → `grid_login` if needed. Respect the grid picker
   (ask which grid if the user has more than one).
2. `grid_create_project` an app `<name>` — scaffolds the project folder and a
   `cloudgrid.yaml` with empty `services: {}`. No server entity exists yet — the
   first plug auto-creates it from the manifest (honoring its `name:`) and
   writes `.cloudgrid/link.json`.
3. Write the app under `services/web/` per §1, then fill `cloudgrid.yaml` to the
   active shape: `name`, `services.web { type: nextjs, path: / }`, `needs:
   { database: true }`, and the `vault:` mappings for the auth keys.
4. Set the auth secrets: `grid_set_secret` (or the org vault) for the provider
   keys. Do NOT set `DATABASE_MONGODB_URL` — the grid injects it.
5. (Optional) `grid dev` to run locally against injected Mongo before shipping.
6. `grid_plug` to deploy. A runtime deploy is **ASYNC** — the first response
   is `status: building`, not a live URL. Poll `grid_status` (or the returned
   poll_url) until live; surface a liveness signal while it builds, never a bare
   spinner.
7. Only once live, return the deployed app URL. Re-plug the SAME entity to update
   the same URL.

---

## 6. Edition note

This blueprint targets a **runtime** deploy, which requires the **local
edition**. The hosted edition (Claude Web / hosted MCP) is inline-only and can
only publish static pages — it CANNOT build this containerized Next.js + Mongo +
auth forum. On hosted, either switch to a local edition or offer a static,
read-only mock instead and stop the runtime path.
