---
name: forum
when: "forum, discussion board, community forum, threaded discussions"
needs: database
deploy: runtime
editions: local
kind: blueprint
capabilities_note: >-
  persistent — needs a database (Mongo). Runtime app, async build, local edition
  only. Sign-in-to-post auth via a hosted provider (Clerk/Auth0) with keys from
  the org vault (vault block maps items to env vars). Declare the canonical needs
  database=true; the deployer injects DATABASE_MONGODB_URL (+legacy MONGODB_URL).
  BLUEPRINT — ships structure + cloudgrid.yaml, not app code.
summary: >-
  Build a persistent threaded community forum on the grid — Next.js + Mongo with
  threads / posts (self-referential parentId nesting) / users collections,
  sign-in-to-post auth via a hosted provider (keys from the vault block), and
  moderation. This is a BLUEPRINT — read templates/forum/AGENTS.md for the file
  tree, Mongo schema, secret/DB injection, and auth wiring, then build the app
  under services/web/. Edition-gate first, scaffold, declare needs database=true
  (not requires) plus a vault block for auth keys, deploy async, poll to a live URL.
---

# Workflow: forum

The user wants a **community forum / discussion board** — members sign in, start
threads, and post **nested replies**, with moderation. That is a **persistent
runtime app** backed by the grid's shared Mongo, not a static page: threads and
replies must survive refresh and be shared across everyone. The shape mirrors the
proven `app-with-data` template, with a `threads` → `posts` domain (self-referential
`parentId` nesting) plus a thin `users` mirror, and sign-in-to-post auth via a
hosted provider.

**This is a BLUEPRINT.** The `forum` template ships the STRUCTURE and the
`cloudgrid.yaml`, not runnable app code. **Read `templates/forum/AGENTS.md`
first** — it is the structure guide (file tree, Mongo collections + fields, how
CloudGrid injects the DB + vault secrets, how to wire auth + moderation, deploy
steps) — then build the app under `services/web/` following it.

Be honest that a runtime deploy is async (not instant like a static drop) and
that it needs the local edition.

## 1. Edition check FIRST (hard gate)

A persistent app is a built + deployed container. It requires the **local
edition** (Claude Desktop / Claude Code) or the CLI.

- **Hosted edition (Claude Web / hosted MCP):** you CANNOT build a runtime app —
  hosted is inline-only and can only publish static pages. Tell the user
  plainly, offer a **static read-only mock** instead, and STOP the runtime path.
- **Local edition:** continue.

## 2. Auth + grid

1. Ensure signed in: `grid_login_status`; if not, `grid_login`.
2. A grid is required. Respect the grid picker: if the user has more than one
   grid, ask which to use; do not assume a target.

## 3. Read the blueprint, then scaffold

1. **Fetch the blueprint: `grid_get_template("template", "forum")`** and read
   `AGENTS.md` — it defines the file tree, the `threads` / `posts` / `users`
   collections + fields, the nesting model, and the CloudGrid wiring. This is the
   spec you build to.
2. `grid_create_project` an app `<name>`. `init` creates the entity + `.cloudgrid/link.json`
   and writes a `cloudgrid.yaml` with an EMPTY `services: {}`. `plug` needs a
   linked directory, so run `init` FIRST. Then write the app under
   **`services/web/`** and fill `cloudgrid.yaml` to the shape below.

## 4. Build the app + wire Mongo, auth, moderation

Follow `AGENTS.md`. Set `cloudgrid.yaml` to the active shape (app code lives under
`services/web/`; `path:` is the URL mount, NOT the filesystem path):

```yaml
name: my-forum
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

- **Declare the datastore with `needs: { database: true }`** — the canonical
  shape. The deployer provisions Mongo and injects `DATABASE_MONGODB_URL` (plus
  the legacy `MONGODB_URL` alias). `requires:` is the deprecated v1 alias — don't
  author new yaml with it, and never set `needs:` and `requires:` together (the
  validator rejects it).
- **Read the DB from `process.env.DATABASE_MONGODB_URL`** (legacy `MONGODB_URL`
  fallback) behind a **lazy getter** in `services/web/lib/db.js` — never read the
  connection string at module top level, or `next build` fails.
- **Auth (sign-in-to-post):** add a hosted provider SDK (Clerk / Auth0). Map the
  provider's keys through the `vault:` block → env vars (rename to the exact env
  names the SDK expects, e.g. `CLERK_SECRET_KEY`). Reading threads is public;
  `POST`/`PATCH`/`DELETE` require a session (guard in `middleware.js` + the write
  routes). See `AGENTS.md` §4.
- **Moderation:** allow delete/edit only for the author or a `moderator` role;
  prefer **soft delete** on posts (`deleted: true`) so the reply tree stays intact.

## 5. (Optional) Run locally

Mention that the user can `grid dev` to run locally against the injected Mongo
(and vault-injected auth keys) before deploying. Don't require it.

## 6. Config

- Auth-provider keys / secrets → the `vault:` block + `grid_set_secret`. Non-secret
  config → `grid_set_env`.
- Do **NOT** set the DB connection vars yourself (`DATABASE_MONGODB_URL` or the
  legacy `MONGODB_URL`) — the grid injects them.

## 7. Deploy (async)

Deploy the folder with `grid_deploy`. A **runtime deploy is ASYNC**: the first
response is `status: "building"`, NOT a live URL yet.
- Poll `grid_status` (or the returned poll_url) until the entity is live.
- Surface a liveness signal while it builds — never a bare silent wait.
- Only once it is live, return the deployed app URL (NOT the build/log link).

## 8. Return the live URL + iterate

Give the user the live forum URL — that is the deliverable. To iterate, re-plug
the SAME entity so it updates the same URL. Keep it honest: this is a blueprint you
built out, async build, local-edition only, credentials injected by the grid.
