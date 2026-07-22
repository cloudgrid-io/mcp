# Template: membership-site (BLUEPRINT — Next.js + auth + Stripe + Mongo)

A paid membership / subscriber-content site. **Blueprint, not finished code**:
it ships the `cloudgrid.yaml` and a structure guide (`AGENTS.md`) so an agent
can build it correctly on CloudGrid — a Next.js app with user auth, Stripe
subscription checkout, gated `/members/*` routes that check membership status,
and grid-shared Mongo. Read `AGENTS.md`, build the app under `services/web/`,
adapt plans/content/fields, then deploy (async — poll to a live URL). Local
edition only.

**Fetch the bundle:**
- `grid_get_template("template", "membership-site")` — this blueprint (`cloudgrid.yaml` + `AGENTS.md`).
- `grid_get_template("template", "app-with-data")` — the proven Next.js + Mongo shape to extend (lazy db client, App-Router API).

**Key rules:**

1. **Blueprint — read `AGENTS.md` first.** It has the file tree, Mongo
   collections (`users`, `memberships`), CloudGrid injection table, and the
   auth + Stripe wiring. Build following it; do not invent structure.
2. **App code MUST live under `services/web/`.** `path: /` is the URL mount, NOT
   the filesystem path. Root files fail with `Service directory not found`.
3. **Mongo via `needs:{database:true}`** → the grid injects
   `DATABASE_MONGODB_URL` (legacy `MONGODB_URL` fallback). Read it LAZILY inside
   the getter, never at module top level (top-level read fails `next build`).
4. **Secrets via the `vault:` block** → env vars. `STRIPE_KEY`,
   `STRIPE_WEBHOOK_SECRET`, `AUTH_PROVIDER_KEY` map to vault items; set them with
   `grid_set_secret`, and the deployer injects them at runtime. Read lazily; do
   not commit keys or put secrets in `services.web.env`.
5. **Gate server-side.** Auth answers "who are you"; the `memberships`
   collection answers "have you paid". `app/members/layout.js` checks membership
   status server-side and redirects non-members to `/pricing`. The Stripe
   webhook (`/api/webhook`) is the source of truth that writes membership status.
6. **Never set `needs:` and `requires:` together** — `requires:` is the
   deprecated v1 alias.

## cloudgrid.yaml (active fields)

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: membership-site
services:
  web:
    type: nextjs
    path: /
needs:
  database: true
vault:
  STRIPE_KEY: stripe-live-key
  STRIPE_WEBHOOK_SECRET: stripe-webhook-secret
  AUTH_PROVIDER_KEY: auth-provider-key
```

> **Capability:** `needs: { database: true }` → the deployer provisions Mongo and
> injects `DATABASE_MONGODB_URL` (+ legacy `MONGODB_URL`). The `vault:` block maps
> Stripe/auth secrets to env vars — the CloudGrid-correct way to inject
> credentials. `requires:` is the deprecated v1 alias; don't mix it with `needs:`.
> See the capability-map for the full injection table.

## Deploy (async, local edition)

`grid_create_project` first (creates the entity + link.json), write the app under
`services/web/`, set the vault secrets with `grid_set_secret`, `grid_plug`
(async — poll `grid_status` to a live URL), then register the `/api/webhook`
URL in Stripe and re-plug. Re-plug the same entity to update the same URL.
