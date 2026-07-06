# lms template — blueprint (structure + cloudgrid.yaml)

A learning management system / training platform: instructors publish courses
organized into modules and lessons, students enroll and progress through them,
and instructors grade submissions and track each student's progress — a
persistent Next.js + Mongo app with role-based (instructor/student) auth. This is
a **blueprint**: it ships the correct `cloudgrid.yaml` and an `AGENTS.md`
structure guide (file tree, Mongo collections, CloudGrid env/vault wiring, the
auth-role + grading flow, deploy steps), not runnable app code. Adapt the
structure and build the app under `services/web/`.

## What's here

- **`cloudgrid.yaml`** — full-annotated reference with only the active fields
  uncommented: `name`, a `vault:` block (`AUTH_PROVIDER_KEY`), `services.web`
  (type: nextjs, path: /), and `needs: { database: true }`. Copy it as-is.
- **`AGENTS.md`** — the structure guide. Read it before building: it is the
  CloudGrid-specific spec for the file tree, collections, secret injection, the
  instructor/student role gates + grading loop, and the async runtime deploy.

## Blueprint: structure + cloudgrid.yaml, adapt and build

Read `AGENTS.md`, then build the app following it — put the code under
`services/web/`, read `DATABASE_MONGODB_URL` (legacy `MONGODB_URL` fallback) and
the vault-injected `AUTH_PROVIDER_KEY` lazily inside getters, enforce the
instructor/student role gates on the server, declare `needs: { database: true }`,
and deploy with `grid plug` (async — poll to a live URL; local edition only).
