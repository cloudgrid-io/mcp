# AGENTS.md — lms (blueprint)

This is a **blueprint**, not runnable app code. It is the structure guide an agent
follows to build a learning management system (LMS) on CloudGrid: a training
platform where instructors publish courses (organized into modules and lessons),
students enroll and work through them, and instructors grade submissions and track
progress. Role-based auth (instructor vs. student) is the spine of the whole app.

The `cloudgrid.yaml` in this directory is complete and correct — copy it as-is.
Everything below tells you WHAT to build under `services/web/` and HOW CloudGrid
wires it together. Build the app following this; do not expect the code to exist.

---

## 1. File tree (build this under `services/web/`)

App code MUST live under `services/<service-name>/`. The service is named `web`,
so the CLI looks in `services/web/`. `path: /` in `cloudgrid.yaml` is the URL
mount, NOT the filesystem path. Files at the project root fail with
`Error: Service directory not found: …/services/web`.

```
cloudgrid.yaml                                    # this dir — name + vault + services.web(nextjs) + needs:{database:true}
services/web/package.json                         # next, react, react-dom, mongodb, + auth SDK (e.g. @clerk/nextjs)
services/web/middleware.js                        # auth middleware — protects /dashboard, /learn/*, /teach/* ; publishes session
services/web/lib/db.js                            # LAZY Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/lib/auth.js                          # helpers: getUserId(), getRole() from the auth provider session; requireRole()
services/web/lib/enrollment.js                    # server guard: isEnrolled(userId, courseId); computeProgress(userId, courseId)
services/web/app/layout.js                        # root layout + auth provider wrapper + inline CSS
services/web/app/page.js                          # course catalog (server component: lists published courses from Mongo)
services/web/app/courses/[slug]/page.js           # course detail + module/lesson outline; "Enroll" vs "Continue"
services/web/app/learn/[courseSlug]/[lessonId]/page.js  # lesson player — GATED: redirect unless enrolled (student)
services/web/app/dashboard/page.js                # student dashboard: enrolled courses + progress bars + grades
services/web/app/teach/page.js                    # instructor dashboard — GATED to role=instructor: courses + submissions to grade
services/web/app/api/courses/route.js             # GET list (public: published) / POST create (instructor only)
services/web/app/api/modules/route.js             # GET modules+lessons for a course / POST add (instructor only)
services/web/app/api/enrollments/route.js         # GET my enrollments / POST enroll student in a course
services/web/app/api/progress/route.js            # POST mark-lesson-complete (upsert) ; GET course progress %
services/web/app/api/submissions/route.js         # POST student submits assignment/quiz ; GET a student's submissions
services/web/app/api/grades/route.js              # POST instructor grades a submission (score + feedback) ; GET a student's grades
```

Keep it a real Next.js App Router app (`next@^15`, `react@^19`). Only add
dependencies you use: `mongodb` and one auth SDK (add `stripe` only if you sell
paid courses — see §4).

---

## 2. Mongo collections + fields

The grid provisions a shared MongoDB (`needs: { database: true }`). Suggested
collections (adapt names/fields freely):

- **`users`** — `{ _id, authId, name, email, role: "instructor" | "student",
  createdAt }`. Mirrors the auth-provider user; `role` drives every gate. Upsert
  on first login keyed by `authId`.
- **`courses`** — `{ _id, slug, title, description, instructorId, published: bool,
  createdAt }`. One document per course. `instructorId` = the owning instructor.
- **`modules`** — `{ _id, courseId, title, order }`. A course is organized into
  ordered modules (chapters/units).
- **`lessons`** — `{ _id, moduleId, courseId, title, order, content, videoUrl,
  isFreePreview: bool }`. Ordered lessons inside a module.
- **`assignments`** — `{ _id, courseId, lessonId, title, prompt, maxScore }`.
  A gradable task attached to a lesson (assignment or quiz).
- **`enrollments`** — `{ _id, userId, courseId, enrolledAt }`. The access grant —
  the lesson player and submission APIs check for it.
- **`progress`** — `{ _id, userId, courseId, lessonId, completedAt }`. One doc per
  student per completed lesson. Course progress % = `completed lessons / total lessons`.
- **`submissions`** — `{ _id, userId, assignmentId, courseId, answer, submittedAt }`.
  A student's work turned in for an assignment.
- **`grades`** — `{ _id, submissionId, userId, assignmentId, courseId, score,
  feedback, gradedBy, gradedAt }`. The instructor's grade for a submission.

Add indexes: `users.authId` (unique), `courses.slug` (unique),
`modules.courseId+order`, `lessons.moduleId+order`,
`enrollments.userId+courseId` (unique), `progress.userId+lessonId` (unique),
`submissions.userId+assignmentId` (unique).

Two access rules the whole platform hinges on — **enforce both on the server**
(in the page + API route), never only in the UI:
- **A lesson is viewable if** `isFreePreview` OR an `enrollments` doc exists for
  `(userId, courseId)`.
- **Only `role: instructor`** may create courses/modules/lessons/assignments and
  post grades. A student may only submit work and read their own grades/progress.

---

## 3. How CloudGrid injects everything

You never provision infra or set connection strings by hand. Declared needs and
vault items are injected as environment variables at `grid dev` (local) and at
runtime (after `grid plug`).

- **Mongo** — `needs: { database: true }` → the grid injects
  **`DATABASE_MONGODB_URL`** (plus the legacy **`MONGODB_URL`** alias). Read
  `process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL` **lazily inside a
  getter** in `lib/db.js`. A top-level read (`const uri = process.env…; if (!uri)
  throw`) breaks `next build`, which imports the module for route analysis before
  the grid injects the var. Never hardcode a URI; never commit a secret.
- **Secrets via the `vault:` block** — the block maps org vault items to env vars:
  `AUTH_PROVIDER_KEY` ← `auth-provider-key` (the server-side auth secret that lets
  you verify sessions and roles). Set each vault item ONCE with
  `grid secrets set <item>` (e.g. `grid secrets set auth-provider-key`); the
  platform injects it as the named env var. Read it lazily too (inside the auth
  client getter in `lib/auth.js`), not at module top level. If you add paid
  courses, map `STRIPE_KEY`/`STRIPE_WEBHOOK_SECRET` the same way.
- **AI (optional — auto-grading / quiz generation / a study tutor)** — add
  `needs: { ai: true }` → the grid injects **`RUNTIME_GATEWAY_URL`**; call it via
  `@cloudgrid-io/runtime`. Not enabled in this blueprint; add the need if you want it.

Reserved env var names you must NOT set yourself: `PORT`, `NODE_ENV`,
`DATABASE_MONGODB_URL`/`MONGODB_URL`, `RUNTIME_GATEWAY_URL`, `CLOUDGRID_*`.

---

## 4. Wiring auth (roles) + optional payments

### Auth + roles (provider SDK) — the core of the LMS
Use a hosted auth provider SDK (e.g. Clerk or Auth0) rather than rolling your own.
Role-based access (instructor vs. student) is what separates an LMS from a plain
content site, so wire it first.

1. Add the SDK to `package.json` (e.g. `@clerk/nextjs`).
2. Wrap `app/layout.js` in the provider; add `middleware.js` to protect
   `/dashboard`, `/learn/*` (any signed-in user) and `/teach/*` (instructors only).
3. The **publishable** key is a non-secret client env var → set it with
   `grid env` (e.g. `grid env NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=…`). The **secret**
   server key comes from the vault → `AUTH_PROVIDER_KEY` (mapped in `cloudgrid.yaml`),
   read lazily in `lib/auth.js`.
4. `lib/auth.js` exposes `getUserId()` and `getRole()` reading the provider's
   server session, plus `requireRole("instructor")` that throws/redirects for
   students. Every instructor-only API route (`/api/courses` POST,
   `/api/modules` POST, `/api/grades` POST) calls `requireRole("instructor")`
   server-side. Store the role on the `users` doc and/or in the provider's
   user metadata; upsert the `users` doc on first login keyed by `authId`.

### Grading flow (the LMS-specific loop)
1. A student POSTs to `/api/submissions` (guarded by `isEnrolled`) to turn in an
   assignment answer → one `submissions` doc per `(userId, assignmentId)`.
2. The instructor sees ungraded submissions on `/teach`, and POSTs to
   `/api/grades` (guarded by `requireRole("instructor")`) with `score` + `feedback`
   → a `grades` doc referencing the `submissionId`. Never let a client set its own
   score; derive `gradedBy` from the server session.
3. The student reads their grades on `/dashboard` via `/api/grades` GET, scoped to
   `getUserId()` so students only ever see their own grades.

### Payments (Stripe) — OPTIONAL, only for paid courses
If courses are sold rather than freely enrollable, add `stripe` to `package.json`
and a `vault:` mapping for `STRIPE_KEY` + `STRIPE_WEBHOOK_SECRET`:
1. `lib/stripe.js` builds the Stripe client lazily from `process.env.STRIPE_KEY`.
2. **Checkout route** `app/api/checkout/route.js`: POST with a `courseId`, read the
   course price server-side, create a Stripe Checkout Session (`payment` mode) with
   `client_reference_id = userId` and `metadata.courseId`, return `session.url`.
   Never trust a price sent from the client.
3. **Webhook route** `app/api/webhooks/stripe/route.js`: verify the signature with
   `STRIPE_WEBHOOK_SECRET` (`stripe.webhooks.constructEvent(rawBody, sig, secret)`
   — read the RAW body, do not JSON-parse first). On `checkout.session.completed`,
   upsert an `enrollments` doc. This webhook — not the checkout redirect — grants
   access. Register the webhook URL (`https://<live-url>/api/webhooks/stripe`) in
   the Stripe dashboard after the first deploy, then set `stripe-webhook-secret`.

---

## 5. Deploy steps

A runtime deploy is **asynchronous** and requires the **local edition** (§6).

1. **Write the manifest + app** — use the `cloudgrid.yaml` from this template
   (name + vault + `services.web` nextjs + `needs: { database: true }`), and write
   the app under `services/web/` per the tree above.
2. **`grid plug --no-deploy`** — registers the entity from the manifest (honors
   `name: lms`) and writes `.cloudgrid/link.json`, without building yet.
3. **Set secrets** — `grid secrets set auth-provider-key` (and, if selling courses,
   `grid secrets set stripe-live-key` + `grid secrets set stripe-webhook-secret`).
   Set non-secret client config with `grid env` (e.g. the auth publishable key).
   Do NOT set the DB vars — the grid injects them.
4. **`grid plug`** — builds + deploys `services/web/`. The first response is
   `status: building`, NOT a live URL. Poll `grid status` (or the returned
   poll_url) until it is live; surface a liveness signal while it builds, never a
   bare silent wait. Only then return the live app URL.
5. **Iterate** — re-plug the SAME entity so it updates the same URL. (If you added
   Stripe, wire the webhook to the live URL first — §4.)

---

## 6. Edition note

An LMS is a built + deployed **runtime** container. It requires the **local
edition** (Claude Desktop / Claude Code) or the CLI. On the **hosted** edition
(Claude Web / hosted MCP) you cannot build a runtime app — hosted is inline-only
and can only publish static pages. If you are on hosted, say so plainly and stop
the runtime path (a static course *landing* page is the only thing hosted can ship).
