# Template: forum (BLUEPRINT — threaded community forum)

A persistent, sign-in-to-post community forum: `threads` → nested `posts` with
moderation, on Next.js + grid-shared MongoDB, auth via a hosted provider
(Clerk / Auth0). This is a **blueprint** — it gives you the structure and
`cloudgrid.yaml`, NOT runnable app code. Read `AGENTS.md`, then build the app
under `services/web/` following it. The shape mirrors the proven `app-with-data`
template (lazy Mongo getter, App-Router routes, `needs: { database: true }`).

**Fetch the bundle:** `gridctl_fetch("template", "forum")` returns this
directory — `cloudgrid.yaml`, `AGENTS.md` (the structure guide), and this file.

**Key rules:**

1. **App code MUST live under `services/web/`.** `path: /` is the URL mount, not
   the filesystem path. Root files fail with `Service directory not found`.
2. **Read the DB connection LAZILY** in `lib/db.js` —
   `process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL` inside the
   getter, never at module top level (a top-level read fails `next build`). The
   grid injects it from `needs: { database: true }`. Never hardcode it.
3. **Declare `needs: { database: true }`** — the canonical shape. Never author
   `requires:`, and never set `needs:` and `requires:` together (the validator
   rejects the combination).
4. **Auth secrets come from the `vault:` block** → env vars, injected by the
   grid at build + runtime. Never inline a provider key.
5. **Runtime app → local edition, async deploy.** `grid plug` returns
   `status: building`; poll to a live URL.

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference)
# with EVERY field present as a comment; only the fields below are uncommented,
# so it deploys to exactly these active fields.
name: forum
services:
  web:
    type: nextjs
    path: /
vault:
  AUTH_PROVIDER_SECRET_KEY: auth-provider-secret-key
  AUTH_PROVIDER_PUBLISHABLE_KEY: auth-provider-publishable-key
needs:
  database: true
```

> **Capability:** `needs: { database: true }` → the deployer provisions MongoDB
> and injects `DATABASE_MONGODB_URL` (plus the legacy `MONGODB_URL` alias). The
> `vault:` mappings inject the auth-provider keys as env vars. `requires:` is the
> deprecated v1 alias — don't mix it with `needs:`.

## Collections (see AGENTS.md for full fields)

- **`users`** — thin mirror of the auth-provider identity (`authorId` unique,
  `displayName`, `role: member|moderator`).
- **`threads`** — `title`, `authorId`, `authorName`, `replyCount`, `createdAt`,
  `lastPostAt`.
- **`posts`** — `threadId`, `parentId` (self-referential for nesting; `null` =
  top-level), `authorId`, `authorName`, `body`, `deleted` (soft-delete for
  moderation), `createdAt`.

## Build it

Read `AGENTS.md` for the file tree, Mongo schema, secret injection, auth +
moderation wiring, and deploy steps. Adapt the domain, then `grid dev` (local) /
`grid plug` (deploy, async — poll to a live URL).
