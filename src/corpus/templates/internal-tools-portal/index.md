# Template: internal-tools-portal (blueprint — persistent Next.js + Mongo + auth)

A **blueprint** for an internal tools portal / admin tools hub / back-office
portal: a persistent Next.js app on CloudGrid backed by the grid-shared MongoDB,
with staff-only auth via a provider SDK (Clerk or Auth0) whose keys come from the
org vault, role-based access control (RBAC), and **each internal tool as its own
route** under a shared authenticated shell. This ships the **structure +
cloudgrid.yaml**, NOT filled app code — read `AGENTS.md` and build the app
following it.

**Key rules:**

1. **This is a blueprint.** Fetch it, read `AGENTS.md` (file tree, Mongo
   collections, CloudGrid wiring, RBAC, deploy flow), then build the app under
   `services/web/`. There is no ready-made app code to copy.
2. **Service code MUST live under `services/<name>/`, not the repo root.**
   `path:` in `cloudgrid.yaml` is the URL mount, NOT the filesystem path. The
   service named `web` → the CLI looks for `services/web/`.
3. **Declare the datastore with `needs: { database: true }`** — the deployer
   provisions Mongo and injects `DATABASE_MONGODB_URL` (plus the legacy
   `MONGODB_URL` alias). Read it lazily inside a getter, never at module top
   level (a top-level read fails `next build`). `requires:` is the deprecated v1
   alias; never set `needs:` and `requires:` together.
4. **Auth secrets come from the `vault:` block, not committed env files.** The
   yaml maps the provider's secret + publishable keys → env vars
   (`AUTH_PROVIDER_SECRET_KEY`, `AUTH_PROVIDER_PUBLISHABLE_KEY`); the deployer
   injects them at build + runtime. Create the vault items first.
5. **Every tool is a route, gated server-side.** A tool registry (`lib/tools.js`)
   maps tool id → `requiredRole`; roles live on the `staff` Mongo record. The hub
   hides cards as UX, but each tool page + API re-checks the role server-side —
   the hidden card is never the security boundary.

Runtime app → **local edition only**, async deploy (poll to a live URL).

## Fetch bundle

Fetch this blueprint with `grid_get_template("template", "internal-tools-portal")`. It
returns `cloudgrid.yaml`, `AGENTS.md` (the structure guide), and this README — no
app code. Follow `AGENTS.md` to build, then `grid plug → poll` (the first plug
auto-creates the entity from `cloudgrid.yaml`).

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: internal-tools-portal
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

> **Capability:** `needs: { database: true }` → the deployer provisions Mongo and
> injects `DATABASE_MONGODB_URL` (plus the legacy `MONGODB_URL` alias). The
> `vault:` block injects the auth provider's keys as env vars. `requires:` is the
> deprecated v1 alias — don't mix it with `needs:`.
