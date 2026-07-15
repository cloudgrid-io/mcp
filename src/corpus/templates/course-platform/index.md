# Template: course-platform (blueprint — Next.js + Mongo + auth + Stripe)

A Teachable-style course platform: sell online courses, gate lessons behind a
Stripe purchase, and track per-student lesson progress. Persistent
Next.js + Mongo app with auth and payments.

**This is a blueprint, not app code.** It ships the correct `cloudgrid.yaml` and
an `AGENTS.md` structure guide. Read `AGENTS.md`, then build the app under
`services/web/` following it. Fetch the guide with
`grid_get_template("template", "course-platform")`.

**Key rules:**

1. **Service code MUST live under `services/web/`**, not the repo/template root.
   `path: /` in `cloudgrid.yaml` is the URL mount, NOT the filesystem path.
2. **Read injected vars LAZILY (inside getters), never at module top level.** The
   grid injects `DATABASE_MONGODB_URL` (legacy `MONGODB_URL` fallback) from
   `needs: { database: true }`, and `STRIPE_KEY` / `STRIPE_WEBHOOK_SECRET` /
   `AUTH_PROVIDER_KEY` from the `vault:` block. A top-level read fails `next build`.
3. **Declare the datastore with `needs: { database: true }`** — the canonical
   shape. `requires:` is the deprecated v1 alias; never set `needs:` and
   `requires:` together (the validator rejects the combination).
4. **Secrets via the `vault:` block** — set each vault item once with
   `grid secrets set <item>`; the platform injects it as the named env var. The
   auth publishable (non-secret) key is a `grid env` var, not a vault item.
5. **Runtime deploy is async, local edition only.** `grid plug` returns
   `status: building`; poll to a live URL. Register the Stripe webhook to the live
   URL after the first deploy.

## Domain (Mongo collections)

- `courses` (slug, title, priceCents, published) — sellable courses
- `lessons` (courseId, order, content, isFreePreview) — ordered lessons
- `enrollments` (userId, courseId, stripeSessionId) — access grant, created by the Stripe webhook
- `progress` (userId, courseId, lessonId, completedAt) — per-lesson completion

Access rule: a lesson is viewable if `isFreePreview` OR an `enrollments` doc
exists for `(userId, courseId)`. Enforce on the server, not just in the UI.

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields.
name: course-platform
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

> **Capability:** `needs: { database: true }` → the deployer provisions Mongo and
> injects `DATABASE_MONGODB_URL` (+ legacy `MONGODB_URL`). The `vault:` block maps
> org secrets (`stripe-live-key`, `stripe-webhook-secret`, `auth-provider-key`) to
> env vars for the checkout/webhook and auth routes. See the capability-map for
> the full injection table.

## Build it

Read `AGENTS.md` for the full file tree, collection fields, env/vault wiring, auth
+ Stripe route contracts, and deploy steps. Then scaffold (`grid init`), write the
app under `services/web/`, set secrets (`grid secrets set …`), and `grid plug`
(async — poll to a live URL). Re-plug the same entity to iterate.
