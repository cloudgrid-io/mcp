---
name: lms
when: "LMS, learning management system, training platform"
needs: database
deploy: runtime
editions: local
kind: blueprint
capabilities_note: "persistent — needs a database (Mongo) plus role-based auth secrets. Runtime app, async build, local edition only. Declare needs { database: true } (deployer injects DATABASE_MONGODB_URL / legacy MONGODB_URL) and a vault block mapping AUTH_PROVIDER_KEY to an env var (add STRIPE_KEY / STRIPE_WEBHOOK_SECRET only for paid courses). This is a BLUEPRINT — read AGENTS.md for the structure, then build."
summary: "Build a learning management system on the grid — a Next.js app with instructor/student role-based auth, courses organized into modules + lessons, student enrollment + per-lesson progress, and an assignment-submission + instructor-grading loop, backed by grid-shared Mongo. This is a BLUEPRINT: fetch the template, read AGENTS.md for the file tree + CloudGrid wiring (needs database true, vault for the auth secret), build the app under services/web/, deploy async, poll to a live URL."
---

# Workflow: lms

The user wants a learning management system / training platform: instructors
publish **courses** organized into **modules** and **lessons**, **students**
enroll and work through them, and instructors **grade** submissions and track each
student's **progress**. Role-based auth (instructor vs. student) is the spine —
that is what separates an LMS from a plain content site. It is a persistent
**runtime app** backed by the grid's shared Mongo, not a static page.

**This is a BLUEPRINT.** The template does NOT ship runnable app code — it ships
the correct `cloudgrid.yaml` and an `AGENTS.md` structure guide. Your job is to
read `AGENTS.md` and build the app under `services/web/` following it.

Be honest that a runtime deploy is async (not instant like a static drop) and that
it needs the local edition.

## 1. Edition check FIRST (hard gate)

A persistent app is a built + deployed container. It requires the **local
edition** (Claude Desktop / Claude Code) or the CLI.

- **Hosted edition (Claude Web / hosted MCP):** you CANNOT build a runtime app —
  hosted is inline-only and can only publish static pages. Tell the user plainly,
  offer a static course *landing* page instead, and STOP the runtime path here.
- **Local edition:** continue.

## 2. Auth + grid

1. Ensure signed in: `grid_login_status`; if not, `grid_login`.
2. A grid is required. Respect the grid picker: if the user has more than one
   grid, ask which to use; do not assume a target.

## 3. Read the blueprint

Fetch the structure guide and read it before writing anything:
`grid_fetch("template", "lms")`. `AGENTS.md` is the CloudGrid-specific spec for
this app — the file tree under `services/web/`, the Mongo collections
(users/courses/modules/lessons/assignments/enrollments/progress/submissions/grades),
how the grid injects Mongo + the vault auth secret, the instructor/student role
gates + grading loop, and the async deploy. Do not expect the app code to exist;
you build it from the guide.

## 4. Scaffold

`grid_init` an app `<name>`. `init` creates the entity + `.cloudgrid/link.json`
and writes a `cloudgrid.yaml` with an EMPTY `services: {}`. `plug` needs a linked
directory, so run `init` FIRST. Then (a) write the app under **`services/web/`**
per the AGENTS.md tree, and (b) fill `cloudgrid.yaml` to the shape below.

## 5. cloudgrid.yaml + wiring

Set `cloudgrid.yaml`. **App code MUST live under `services/<name>/`** — `path:` is
the URL mount, NOT the filesystem path.

```yaml
name: my-lms
vault:
  AUTH_PROVIDER_KEY: auth-provider-key
services:
  web:
    type: nextjs
    path: /
needs:
  database: true
```

- **Declare the datastore with `needs: { database: true }`** — the canonical
  shape. The deployer provisions Mongo and injects `DATABASE_MONGODB_URL` (plus
  the legacy `MONGODB_URL` alias). `requires:` is the deprecated v1 alias; never
  author new yaml with it, and never set `needs:` and `requires:` together (the
  validator rejects it).
- **Read injected vars LAZILY inside getters, never at module top level** — the DB
  URL in `lib/db.js` and `AUTH_PROVIDER_KEY` in `lib/auth.js`. A top-level read
  fails `next build`.
- **Enforce the instructor/student role gates on the server** (page + API route),
  not just in the UI — only instructors create courses/lessons and post grades;
  students submit work and read their own grades/progress. See AGENTS.md §2/§4.
- (Optional) add `STRIPE_KEY`/`STRIPE_WEBHOOK_SECRET` to `vault:` and a checkout +
  webhook route only if courses are sold rather than freely enrollable.

## 6. Config

- Secrets → `grid_secrets` (e.g. `grid secrets set auth-provider-key`;
  `stripe-live-key`/`stripe-webhook-secret` only for paid courses). Non-secret
  config → `grid_env` (e.g. the auth publishable key).
- Do **NOT** set the DB connection vars yourself (`DATABASE_MONGODB_URL` or the
  legacy `MONGODB_URL`) — the grid injects them.

## 7. Deploy (async)

Deploy the folder with `grid_plug`. A **runtime deploy is ASYNC**: the first
response is `status: "building"`, NOT a live URL yet.
- Poll `grid_status` (or the returned poll_url) until the entity is live.
- Surface a liveness signal while it builds — never a bare silent wait.
- Only once it is live, return the deployed app URL (NOT the build/log link).

## 8. Return the live URL + iterate

Give the user the live app URL — that is the deliverable. To iterate, re-plug the
SAME entity so it updates the same URL. Keep it honest: async build, local-edition
only, credentials injected by the grid. (If you added Stripe, register the webhook
to the live URL after the first deploy.)
