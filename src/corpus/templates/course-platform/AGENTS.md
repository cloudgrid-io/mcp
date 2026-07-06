# AGENTS.md — course-platform (blueprint)

This is a **blueprint**, not runnable app code. It is the structure guide an agent
follows to build a Teachable-style course platform on CloudGrid: sell online
courses, gate lessons behind purchase, and track per-student lesson progress.

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
cloudgrid.yaml                                   # this dir — name + vault + services.web(nextjs) + needs:{database:true}
services/web/package.json                        # next, react, react-dom, mongodb, stripe, + auth SDK (e.g. @clerk/nextjs)
services/web/middleware.js                       # auth middleware — protects /dashboard, /learn/* ; publishes user session
services/web/lib/db.js                           # LAZY Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/lib/stripe.js                        # LAZY Stripe client from process.env.STRIPE_KEY (vault-injected)
services/web/lib/auth.js                          # helper: current userId from the auth provider session
services/web/app/layout.js                        # root layout + auth provider wrapper + inline CSS
services/web/app/page.js                          # course catalog (server component: lists published courses from Mongo)
services/web/app/courses/[slug]/page.js           # course detail + lesson list; "Buy" (unenrolled) vs "Continue" (enrolled)
services/web/app/learn/[courseSlug]/[lessonId]/page.js  # lesson player — GATED: 403/redirect unless enrolled
services/web/app/dashboard/page.js                # student dashboard: enrolled courses + progress bars
services/web/app/api/courses/route.js             # GET list / POST create (instructor)
services/web/app/api/enrollments/route.js         # GET my enrollments (derived from paid checkouts)
services/web/app/api/progress/route.js            # POST mark-lesson-complete (upsert into progress); GET course progress
services/web/app/api/checkout/route.js            # POST → create Stripe Checkout Session for a course, return session URL
services/web/app/api/webhooks/stripe/route.js     # POST ← Stripe: on checkout.session.completed → create enrollment
```

Keep it a real Next.js App Router app (`next@^15`, `react@^19`). Only add
dependencies you use: `mongodb`, `stripe`, and one auth SDK.

---

## 2. Mongo collections + fields

The grid provisions a shared MongoDB (`needs: { database: true }`). Suggested
collections (adapt names/fields freely):

- **`courses`** — `{ _id, slug, title, description, priceCents, currency,
  instructorId, published: bool, createdAt }`. One document per sellable course.
- **`lessons`** — `{ _id, courseId, title, order, content, videoUrl, isFreePreview: bool }`.
  Ordered lessons belonging to a course.
- **`enrollments`** — `{ _id, userId, courseId, stripeSessionId, enrolledAt }`.
  Created by the Stripe webhook after a successful purchase. This document is the
  access grant — the lesson player checks for it.
- **`progress`** — `{ _id, userId, courseId, lessonId, completedAt }`. One doc per
  student per completed lesson; unique compound index on `(userId, lessonId)`.
  A course's progress % = `completed lessons / total lessons`.

Add indexes: `courses.slug` (unique), `lessons.courseId+order`,
`enrollments.userId+courseId` (unique), `progress.userId+lessonId` (unique).

Access rule the whole platform hinges on: **a lesson is viewable if
`isFreePreview` OR an `enrollments` doc exists for `(userId, courseId)`.** Enforce
this on the server (in the lesson page + any lesson-content API), never only in
the UI.

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
  `STRIPE_KEY` ← `stripe-live-key`, `STRIPE_WEBHOOK_SECRET` ← `stripe-webhook-secret`,
  `AUTH_PROVIDER_KEY` ← `auth-provider-key`. Set each vault item ONCE with
  `grid secrets set <item>` (e.g. `grid secrets set stripe-live-key`); the platform
  injects them as the named env vars. Read them lazily too (inside the Stripe/auth
  client getters), not at module top level.
- **AI (only if you add tutoring/quiz-gen)** — `needs: { ai: true }` → injects
  **`AI_GATEWAY_URL`**; call it via `@cloudgrid-io/ai`. Not enabled in this
  blueprint; add the need if you want it.

Reserved env var names you must NOT set yourself: `PORT`, `NODE_ENV`,
`DATABASE_MONGODB_URL`/`MONGODB_URL`, `AI_GATEWAY_URL`, `CLOUDGRID_*`.

---

## 4. Wiring auth + payments

### Auth (provider SDK)
Use a hosted auth provider SDK (e.g. Clerk or Auth0) rather than rolling your own.

1. Add the SDK to `package.json` (e.g. `@clerk/nextjs`).
2. Wrap `app/layout.js` in the provider; add `middleware.js` to protect
   `/dashboard` and `/learn/*` routes.
3. The **publishable** key is a non-secret client env var → set it with
   `grid env` (e.g. `grid env NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=…`). The **secret**
   server key comes from the vault → `AUTH_PROVIDER_KEY` (mapped in `cloudgrid.yaml`),
   read lazily in `lib/auth.js`.
4. `lib/auth.js` exposes `getUserId()` reading the provider's server session; every
   protected route and the progress/enrollment APIs derive the user from it.

### Payments (Stripe)
1. `lib/stripe.js` builds the Stripe client lazily from `process.env.STRIPE_KEY`
   (vault-injected).
2. **Checkout route** `app/api/checkout/route.js`: POST with a `courseId`, look up
   the course price from Mongo, create a Stripe Checkout Session in `payment` mode
   with `client_reference_id = userId` and `metadata.courseId`, and return
   `session.url`. Never trust a price sent from the client — read it server-side.
3. **Webhook route** `app/api/webhooks/stripe/route.js`: POST endpoint Stripe calls.
   Verify the signature with `STRIPE_WEBHOOK_SECRET`
   (`stripe.webhooks.constructEvent(rawBody, sig, secret)`) — read the RAW request
   body, do not JSON-parse first. On `checkout.session.completed`, upsert an
   `enrollments` doc for `(client_reference_id, metadata.courseId)`. This webhook —
   not the checkout redirect — is what actually grants access.
4. Register the webhook URL (`https://<live-url>/api/webhooks/stripe`) in the
   Stripe dashboard after the first deploy, then set its signing secret into the
   vault item `stripe-webhook-secret`.

---

## 5. Deploy steps

A runtime deploy is **asynchronous** and requires the **local edition** (§6).

1. **`grid init`** an app named `course-platform`. `init` creates the entity +
   `.cloudgrid/link.json` and writes a `cloudgrid.yaml` with an empty
   `services: {}`. Run it FIRST — `plug` needs a linked directory.
2. **Fill** — replace the generated `cloudgrid.yaml` with the one in this template
   (name + vault + `services.web` nextjs + `needs: { database: true }`), and write
   the app under `services/web/` per the tree above.
3. **Set secrets** — `grid secrets set stripe-live-key`,
   `grid secrets set stripe-webhook-secret`, `grid secrets set auth-provider-key`.
   Set non-secret client config with `grid env` (e.g. the auth publishable key).
   Do NOT set the DB vars — the grid injects them.
4. **`grid plug`** — builds + deploys `services/web/`. The first response is
   `status: building`, NOT a live URL. Poll `grid status` (or the returned
   poll_url) until it is live; surface a liveness signal while it builds, never a
   bare silent wait. Only then return the live app URL.
5. **Wire the Stripe webhook** to the live URL (§4), then re-plug the SAME entity
   to iterate — it updates the same URL.

---

## 6. Edition note

A course platform is a built + deployed **runtime** container. It requires the
**local edition** (Claude Desktop / Claude Code) or the CLI. On the **hosted**
edition (Claude Web / hosted MCP) you cannot build a runtime app — hosted is
inline-only and can only publish static pages. If you are on hosted, say so
plainly and stop the runtime path (a static course *landing* page is the only
thing hosted can ship).
