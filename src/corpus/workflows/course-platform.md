---
name: course-platform
when: "course platform, sell online courses, teachable-style"
needs: database
deploy: runtime
editions: local
kind: blueprint
capabilities_note: "persistent — needs a database (Mongo) plus auth + Stripe payments (vault-injected secrets). Runtime app, async build, local edition only. Declare the canonical needs:{database:true}; the deployer injects DATABASE_MONGODB_URL (+legacy MONGODB_URL). Secrets (STRIPE_KEY, STRIPE_WEBHOOK_SECRET, AUTH_PROVIDER_KEY) come from the vault: block."
summary: "Build a Teachable-style course platform on the grid — sell online courses, gate lessons behind a Stripe purchase, track per-student progress. This is a BLUEPRINT — the template ships the correct cloudgrid.yaml + an AGENTS.md structure guide (file tree, Mongo collections courses/lessons/enrollments/progress, env/vault wiring, auth + Stripe checkout/webhook routes, async deploy). Read AGENTS.md, then build the app under services/web/ following it. Edition-gate first, scaffold, wire DATABASE_MONGODB_URL and vault secrets lazily, declare needs:{database:true} (not requires:), deploy async, poll to a live URL."
---

# Workflow: course-platform

The user wants a Teachable-style course platform: sell online courses, gate
lessons behind a Stripe purchase, and track each student's lesson progress. That
is a **persistent runtime app** — Next.js + the grid's shared Mongo, with auth
and payments — not a static page.

**This is a blueprint.** The template does NOT ship runnable app code. It ships
the correct `cloudgrid.yaml` and an `AGENTS.md` structure guide. Your job is to
**read `AGENTS.md`, then build the app under `services/web/` following it.**

Be honest that a runtime deploy is async (not instant like a static drop) and
that it needs the local edition.

## 1. Edition check FIRST (hard gate)

A course platform is a built + deployed container. It requires the **local
edition** (Claude Desktop / Claude Code) or the CLI.

- **Hosted edition (Claude Web / hosted MCP):** you CANNOT build a runtime app —
  hosted is inline-only and can only publish static pages. Tell the user plainly,
  offer a **static course landing page** instead, and STOP the runtime path here.
- **Local edition:** continue.

## 2. Auth + grid

1. Ensure signed in: `grid_login_status`; if not, `grid_login`.
2. A grid is required. Respect the grid picker: if the user has more than one
   grid, ask which to use; do not assume a target.

## 3. Read the blueprint

Fetch the structure guide: `grid_get_template("template", "course-platform")`. It
contains AGENTS.md — the CloudGrid-specific spec you must follow:

- the file tree under `services/web/` (catalog page, course detail, gated lesson
  player, dashboard, and the API routes: courses, enrollments, progress, checkout,
  Stripe webhook),
- the Mongo collections + fields (`courses`, `lessons`, `enrollments`,
  `progress`) and the access rule (a lesson is viewable if `isFreePreview` OR an
  `enrollments` doc exists — enforced on the server),
- how CloudGrid injects the DB URL and the vault secrets,
- how to wire auth (a provider SDK like Clerk/Auth0) and Stripe (checkout +
  webhook routes),
- the async deploy steps.

## 4. Scaffold + fill cloudgrid.yaml

`grid_create_project` an app `<name>`. It scaffolds the project folder and writes
a `cloudgrid.yaml` with an EMPTY `services: {}`. No server entity exists yet —
the first `grid plug` auto-creates it from the manifest (honoring its `name:`)
and writes `.cloudgrid/link.json`. Then set `cloudgrid.yaml` to the shape below and
write the app under **`services/web/`** (`path: /` is the URL mount, NOT the
filesystem path).

```yaml
name: my-courses
vault:
  STRIPE_KEY: stripe-live-key
  STRIPE_WEBHOOK_SECRET: stripe-webhook-secret
  AUTH_PROVIDER_KEY: auth-provider-key
services:
  web:
    type: nextjs
    path: /
needs:
  database: true
```

**Declare the datastore with `needs: { database: true }`** — the canonical shape.
The deployer provisions Mongo and injects `DATABASE_MONGODB_URL` (plus the legacy
`MONGODB_URL` alias). `requires:` is the deprecated v1 alias; don't author new
yaml with it, and never set `needs:` and `requires:` together (the validator
rejects it).

## 5. Build the app (following AGENTS.md)

Build the Next.js app under `services/web/` per the guide. Critical CloudGrid
rules:

- **Read every injected var LAZILY, inside a getter — never at module top level**,
  or `next build` fails. That covers `process.env.DATABASE_MONGODB_URL` (legacy
  `MONGODB_URL` fallback) in `lib/db.js`, and the vault secrets `STRIPE_KEY` /
  `STRIPE_WEBHOOK_SECRET` in `lib/stripe.js` and `AUTH_PROVIDER_KEY` in
  `lib/auth.js`.
- **Access is granted by the Stripe webhook**, not the checkout redirect: on
  `checkout.session.completed`, create the `enrollments` doc. Verify the webhook
  signature with `STRIPE_WEBHOOK_SECRET` against the RAW body.
- **Gate the lesson player on the server** — check enrollment (or free preview),
  never rely on hiding UI.

## 6. Config (secrets + env)

- Secrets → `grid_set_secret`: `grid secrets set stripe-live-key`,
  `grid secrets set stripe-webhook-secret`, `grid secrets set auth-provider-key`.
  The `vault:` block injects them as `STRIPE_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `AUTH_PROVIDER_KEY`.
- Non-secret config (e.g. the auth **publishable** key) → `grid_set_env`.
- Do **NOT** set the DB vars yourself (`DATABASE_MONGODB_URL` / legacy
  `MONGODB_URL`) — the grid injects them.

## 7. Deploy (async)

Deploy the folder with `grid_plug`. A **runtime deploy is ASYNC**: the first
response is `status: "building"`, NOT a live URL yet.
- Poll `grid_status` (or the returned poll_url) until the entity is live.
- Surface a liveness signal while it builds — never a bare silent wait.
- Only once it is live, return the deployed app URL (NOT the build/log link).

## 8. Wire Stripe + return the live URL

Register the Stripe webhook to `https://<live-url>/api/webhooks/stripe` in the
Stripe dashboard, and set its signing secret into the `stripe-webhook-secret`
vault item. Give the user the live app URL — that is the deliverable. To iterate,
re-plug the SAME entity so it updates the same URL. Keep it honest: async build,
local-edition only, credentials injected by the grid.
