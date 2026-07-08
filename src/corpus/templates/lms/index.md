# Template: lms (blueprint — Next.js + Mongo + role-based auth)

A learning management system / training platform: instructors publish courses
(organized into modules and lessons), students enroll and work through them, and
instructors grade submissions and track per-student progress. Persistent
Next.js + Mongo app with role-based (instructor/student) auth.

**This is a blueprint, not app code.** It ships the correct `cloudgrid.yaml` and
an `AGENTS.md` structure guide. Read `AGENTS.md`, then build the app under
`services/web/` following it. Fetch the guide with
`grid_fetch("template", "lms")`.

**Key rules:**

1. **Service code MUST live under `services/web/`**, not the repo/template root.
   `path: /` in `cloudgrid.yaml` is the URL mount, NOT the filesystem path.
2. **Read injected vars LAZILY (inside getters), never at module top level.** The
   grid injects `DATABASE_MONGODB_URL` (legacy `MONGODB_URL` fallback) from
   `needs: { database: true }`, and `AUTH_PROVIDER_KEY` from the `vault:` block. A
   top-level read fails `next build`.
3. **Declare the datastore with `needs: { database: true }`** — the canonical
   shape. `requires:` is the deprecated v1 alias; never set `needs:` and
   `requires:` together (the validator rejects the combination).
4. **Secrets via the `vault:` block** — set the vault item once with
   `grid secrets set auth-provider-key`; the platform injects it as
   `AUTH_PROVIDER_KEY`. The auth publishable (non-secret) key is a `grid env` var,
   not a vault item.
5. **Role gates are the spine** — instructor vs. student is enforced on the
   server (page + API route), not just in the UI. Only instructors create
   courses/lessons and post grades; students submit work and read their own grades.
6. **Runtime deploy is async, local edition only.** `grid plug` returns
   `status: building`; poll to a live URL.

## Domain (Mongo collections)

- `users` (authId, role: instructor|student) — mirrors the auth user; role drives every gate
- `courses` (slug, title, instructorId, published) — one per course
- `modules` (courseId, order) — ordered units within a course
- `lessons` (moduleId, courseId, order, content, isFreePreview) — ordered lessons
- `assignments` (courseId, lessonId, prompt, maxScore) — gradable tasks
- `enrollments` (userId, courseId) — access grant checked by the lesson player
- `progress` (userId, courseId, lessonId, completedAt) — per-lesson completion
- `submissions` (userId, assignmentId, answer) — student work turned in
- `grades` (submissionId, userId, score, feedback, gradedBy) — instructor's grade

Access rules (enforce server-side): a lesson is viewable if `isFreePreview` OR an
`enrollments` doc exists for `(userId, courseId)`; only `role: instructor` may
create content and post grades.

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: lms
vault:
  AUTH_PROVIDER_KEY: auth-provider-key
services:
  web:
    type: nextjs
    path: /
needs:
  database: true
```

> **Capability:** `needs: { database: true }` → the deployer provisions Mongo and
> injects `DATABASE_MONGODB_URL` (+ legacy `MONGODB_URL`). The `vault:` block maps
> the org secret `auth-provider-key` to `AUTH_PROVIDER_KEY` for the role-based auth
> gates. (Add `STRIPE_KEY`/`STRIPE_WEBHOOK_SECRET` only if you sell paid courses.)
> See the capability-map for the full injection table.

## Build it

Read `AGENTS.md` for the full file tree, collection fields, env/vault wiring, the
instructor/student role gates + grading loop, and deploy steps. Then scaffold
(`grid init`), write the app under `services/web/`, set secrets
(`grid secrets set auth-provider-key`), and `grid plug` (async — poll to a live
URL). Re-plug the same entity to iterate.
