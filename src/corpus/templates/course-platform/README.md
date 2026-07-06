# course-platform template — blueprint (structure + cloudgrid.yaml)

A Teachable-style course platform: sell online courses, gate lessons behind a
Stripe purchase, and track each student's lesson progress — a persistent
Next.js + Mongo app with auth and payments. This is a **blueprint**: it ships the
correct `cloudgrid.yaml` and an `AGENTS.md` structure guide (file tree, Mongo
collections, CloudGrid env/vault wiring, auth + Stripe routes, deploy steps), not
runnable app code. Adapt the structure and build the app under `services/web/`.

## What's here

- **`cloudgrid.yaml`** — full-annotated reference with only the active fields
  uncommented: `name`, a `vault:` block (`STRIPE_KEY`, `STRIPE_WEBHOOK_SECRET`,
  `AUTH_PROVIDER_KEY`), `services.web` (type: nextjs, path: /), and
  `needs: { database: true }`. Copy it as-is.
- **`AGENTS.md`** — the structure guide. Read it before building: it is the
  CloudGrid-specific spec for the file tree, collections, secret injection, and
  the async runtime deploy.

## Blueprint: structure + cloudgrid.yaml, adapt and build

Read `AGENTS.md`, then build the app following it — put the code under
`services/web/`, read `DATABASE_MONGODB_URL` (legacy `MONGODB_URL` fallback) and
the vault-injected `STRIPE_KEY` / `AUTH_PROVIDER_KEY` lazily inside getters,
declare `needs: { database: true }`, and deploy with `grid plug` (async — poll to
a live URL; local edition only).
