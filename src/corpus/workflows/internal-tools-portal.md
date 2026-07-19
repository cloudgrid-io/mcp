---
name: internal-tools-portal
when: internal tools portal, admin tools hub, back-office portal — a persistent app hosting several internal tools behind staff-only auth, with RBAC where each tool is its own route. Needs a database + auth provider → runtime → local edition.
needs: database
deploy: runtime
editions: local
kind: blueprint
capabilities_note: persistent — needs a database (Mongo) + a provider SDK auth (Clerk/Auth0) with keys from the vault, RBAC on staff records. Runtime app, async build, local edition only. Declare `needs: { database: true }` (deployer injects DATABASE_MONGODB_URL / legacy MONGODB_URL) and a `vault:` block for the auth keys. This is a BLUEPRINT — no app code ships; read AGENTS.md for the structure, then build.
summary: Build a persistent Next.js + Mongo internal tools portal on the grid with staff-only auth (Clerk/Auth0, keys from vault:), RBAC, and each internal tool as its own route — `staff` + `toolData` + `auditLog` collections. This is a BLUEPRINT: fetch it, read AGENTS.md for the file tree + CloudGrid wiring (DATABASE_MONGODB_URL, vault keys, tool registry, deploy), then build the app under services/web/. Edition-gate first, scaffold, declare needs:{database:true} + vault: auth keys (never requires:), deploy async, poll to a live URL.
---

# Workflow: internal-tools-portal

The user wants an internal tools portal / admin tools hub / back-office portal —
several internal tools (feature flags, refund console, data lookups, ops actions)
living behind **staff-only auth** in one place, with **role-based access control**
where **each tool is its own route**. Staff records, tool data, and the audit
trail must **remember** across refresh and be shared across the team, so this is a
**persistent runtime app** backed by the grid's shared Mongo with a provider SDK
for auth — not a static page.

This is a **blueprint**. No app code ships. Fetch the template, **read its
`AGENTS.md` for the structure** (file tree, `staff` + `toolData` + `auditLog`
collections, the `lib/tools.js` tool registry, CloudGrid wiring for DB +
vault-backed auth keys, RBAC, deploy flow), then build the app following it.

Follow this recipe. Be honest that a runtime deploy is async (not instant like a
static drop) and that it needs the local edition.

## 1. Edition check FIRST (hard gate)

A persistent, auth-gated app is a built + deployed container. It requires the
**local edition** (Claude Desktop / Claude Code) or the CLI.

- **Hosted edition (Claude Web / hosted MCP):** you CANNOT build a runtime app —
  hosted is inline-only and can only publish static pages. Tell the user plainly,
  offer a **static mock** instead, and STOP the runtime path here.
- **Local edition:** continue.

## 2. Auth + grid

1. Ensure signed in: `grid_login_status`; if not, `grid_login`.
2. A grid is required. Respect the grid picker: if the user has more than one
   grid, ask which to use; do not assume a target.

## 3. Fetch the blueprint + read AGENTS.md

`grid_get_template("template", "internal-tools-portal")`. It returns `cloudgrid.yaml`,
`AGENTS.md` (the structure guide), and the README — **no app code**. Read
`AGENTS.md` end to end before writing anything: it defines the `services/web/`
file tree, the Mongo collections + fields, the tool registry, how CloudGrid injects
the DB and vault-backed auth keys, how to wire staff-only auth + RBAC, and the
deploy steps.

## 4. Scaffold

`grid_create_project` an app `<name>`. It scaffolds the project folder and writes a `cloudgrid.yaml` with an EMPTY
`services: {}`. No server entity exists yet — the first `grid plug` auto-creates
it from the manifest (honoring its `name:`) and writes `.cloudgrid/link.json`.
Then (a) build the app under **`services/web/`**
following `AGENTS.md`, and (b) fill `cloudgrid.yaml` to the shape below.

## 5. Build the app + set cloudgrid.yaml

1. Build the Next.js app under `services/web/` per `AGENTS.md` — the
   `staff` + `toolData` + `auditLog` collections, the tool registry in
   `lib/tools.js`, the hub (`app/page.js`) that shows only the tools the signed-in
   staffer's roles allow, each tool as its own route (`app/tools/[tool]/`), the
   admin user/role management, and the auth wiring (provider in the layout,
   staff-only middleware gate, server-side role checks per tool + mutation).
   **App code MUST live under `services/<name>/`** — `path:` is the URL mount,
   NOT the filesystem path.
2. Set `cloudgrid.yaml` to the active shape:
   ```yaml
   name: my-internal-tools-portal
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
   **Declare the datastore with `needs: { database: true }`** — the canonical
   shape. The deployer provisions Mongo and injects `DATABASE_MONGODB_URL` (plus
   the legacy `MONGODB_URL` alias). Read it **lazily inside a getter**, never at
   module top level (a top-level read fails `next build`). `requires:` is the
   deprecated v1 alias; don't author new yaml with it, and never set `needs:` and
   `requires:` together (the validator rejects it).
3. **Auth keys come from the `vault:` block, not committed env files.** The
   `vault:` map injects the provider's secret + publishable keys as env vars at
   build + runtime. A tool that calls a third-party API adds one more `vault:`
   line per secret.
4. **RBAC is server-side.** Roles live on the `staff` Mongo record; the hub
   hiding a card is UX only. Every tool page + API re-checks `requireRole`
   server-side and appends mutations to `auditLog`.

## 6. Config

- Create the vault items the `vault:` block references (the auth provider's
  secret + publishable keys, plus any per-tool API secrets) — `grid_set_secret` /
  vault UI. Never commit them.
- Non-secret config → `grid_set_env`.
- Do **NOT** set the DB connection vars yourself (`DATABASE_MONGODB_URL` or the
  legacy `MONGODB_URL`) — the grid injects them.

## 7. (Optional) Run locally

Mention that the user can `grid dev` to run locally against the injected Mongo +
vault env vars before deploying. Don't require it.

## 8. Deploy (async)

Deploy the folder with `grid_deploy`. A **runtime deploy is ASYNC**: the first
response is `status: "building"`, NOT a live URL yet.
- Poll `grid_status` (or the returned poll_url) until the entity is live.
- Surface a liveness signal while it builds — never a bare silent wait.
- Only once it is live, return the deployed app URL (NOT the build/log link).

## 9. Return the live URL + iterate

Give the user the live app URL — that is the deliverable. To iterate, re-plug the
SAME entity so it updates the same URL. Keep it honest: async build, local-edition
only, DB + auth credentials injected by the grid / vault.
