---
name: calendar-scheduler
when: "calendar scheduler, team calendar, scheduling app, meeting scheduler"
needs: database
deploy: runtime
editions: local
kind: blueprint
capabilities_note: "persistent — needs a database (Mongo). Runtime app, async build, local edition only. Declare the canonical needs:{database:true}; the deployer injects DATABASE_MONGODB_URL (+legacy MONGODB_URL). Scheduled reminders want a type:cron service — BLOCKED on platform issue #1543 (documented, not yet deployable). Optional auth/payments/reminder secrets map through a vault: block (AUTH_PROVIDER_KEY / STRIPE_KEY / SENDGRID_API_KEY) with grid secrets set."
summary: "A BLUEPRINT for a calendar / scheduling app — events, availability slots, timezones + recurrence, optional bookings, on persistent Next.js + Mongo. This is not fill-in-the-blanks app code; it ships structure + cloudgrid.yaml. Fetch the template, read AGENTS.md for the file tree / collections / CloudGrid wiring (needs + optional vault) + the cron reminder shape (blocked on #1543), then BUILD the app under services/web/ following it, and deploy async to a live URL (local edition only)."
---

# Workflow: calendar-scheduler

The user wants a calendar / scheduling app — a **team calendar**, a **meeting
scheduler**, or a booking-style **scheduling app**. That is a **persistent runtime
app** (Next.js + the grid's shared Mongo) whose domain is **events and
availability**: events on a calendar, bookable time slots, timezones, recurrence,
and (eventually) scheduled reminders. It is the `app-with-data` / `crm` shape with
a time/availability domain.

**This is a BLUEPRINT.** Unlike a fill-in-the-blanks template, it ships
*structure* — a `cloudgrid.yaml` and an `AGENTS.md` structure guide — not finished
app code. The recipe is: fetch it, **read `AGENTS.md`**, then **build** the app
following it. Be honest that a runtime deploy is async and needs the local edition.

## 1. Edition check FIRST (hard gate)

A calendar scheduler is a built + deployed container (Next.js + Mongo). It
requires the **local edition** (Claude Desktop / Claude Code) or the CLI.

- **Hosted edition (Claude Web / hosted MCP):** you CANNOT build a runtime app —
  hosted is inline-only and can only publish static pages. Tell the user plainly,
  offer a **static calendar mockup** instead, and STOP the runtime path here.
- **Local edition:** continue.

## 2. Auth + grid

1. Ensure signed in: `gridctl_login_status`; if not, `gridctl_login`.
2. A grid is required. Respect the grid picker: if the user has more than one
   grid, ask which to use; do not assume a target.

## 3. Fetch the blueprint and READ AGENTS.md

`gridctl_fetch("template", "calendar-scheduler")`. The deliverable is the
**`AGENTS.md` structure guide** — read it before writing anything. It defines:
- the `services/web/` file tree (calendar page, event + booking routes, `lib/`),
- the Mongo collections (`events`, `availability`, optional `bookings`) + fields,
- the CloudGrid injection table (needs + optional vault + AI gateway),
- the optional auth (Clerk/Auth0 + `ownerId`) and payments (Stripe Checkout +
  signed webhook) layers,
- the intended **cron reminder** service shape — **BLOCKED on platform issue
  #1543** (documented, not yet deployable),
- the deploy flow.

There is no app code to copy — you generate it from the guide.

## 4. Scaffold + fill cloudgrid.yaml

`gridctl_init` an app `<name>` FIRST (creates the entity + `.cloudgrid/link.json`
and a starter `cloudgrid.yaml` with empty `services:{}`; `plug` needs a linked
directory). Then put the app under **`services/web/`** and set `cloudgrid.yaml` to
the blueprint's active fields:

```yaml
name: my-calendar
services:
  web:
    type: nextjs
    path: /
needs:
  database: true
```

**App code MUST live under `services/<name>/`** — `path:` is the URL mount, NOT
the filesystem path. **Declare `needs: { database: true }`** (canonical) — the
deployer provisions Mongo and injects `DATABASE_MONGODB_URL` (+ legacy
`MONGODB_URL`). `requires:` is the deprecated v1 alias; never author it and never
set `needs:` and `requires:` together (the validator rejects the combination).
Add a `vault:` entry only when you actually layer in auth / payments / reminders.

## 5. Build the app following AGENTS.md

Generate the files under `services/web/` per the guide:
- **Lazy getter** for Mongo — read `process.env.DATABASE_MONGODB_URL` (legacy
  `MONGODB_URL` fallback) **inside** a getter, never at module top level (a
  top-level read fails `next build`). Same lazy pattern for any Stripe/auth client.
- **Store all times as UTC `Date` in Mongo**; convert at the edges. Keep timezone
  / recurrence / overlap logic in a pure `lib/time.js` (expand RRULEs at read
  time — do not store every instance).
- Range-query events for the visible window (`startAt < end && endAt > start`);
  index `{ ownerId: 1, startAt: 1 }`.
- (Optional) auth: init an SDK in `lib/auth.js` from `AUTH_PROVIDER_KEY`, stamp
  `ownerId` on writes, gate write APIs in `middleware.js`, keep the public
  `book/[slug]` page open.
- (Optional) payments: Stripe Checkout for paid bookings + a signature-verified
  webhook (read the RAW body before verifying).

## 6. Scheduled reminders (cron) — BLOCKED on #1543

Reminders want a second service of `type: cron` (scan due reminders every few
minutes, send mail/SMS). **Cron deploy is a PENDING platform issue (#1543)** — do
NOT uncomment the cron `reminders` service in `cloudgrid.yaml` yet; it will not
schedule. Ship the HTTP app now and add cron once #1543 lands. If the user needs
reminders sooner, use the interim workaround in AGENTS.md §5 (an external
scheduler hitting an authenticated `POST /api/cron/reminders` route on `web`).

## 7. Config / secrets

- Map any secrets in the `vault:` block, then **store the values**:
  `grid secrets set auth-provider-key …`, `grid secrets set stripe-live-key sk_live_…`,
  `grid secrets set sendgrid-key SG.…`. Non-secret public config → `gridctl_env`.
- Do **NOT** set the DB connection vars yourself (`DATABASE_MONGODB_URL` / legacy
  `MONGODB_URL`) — the grid injects them.

## 8. (Optional) Run locally

Mention the user can `grid dev` to run locally against the injected dev Mongo (+
secrets) before deploying. Don't require it.

## 9. Deploy (async)

Deploy the folder with `gridctl_plug`. A **runtime deploy is ASYNC**: the first
response is `status: "building"`, NOT a live URL yet.
- Poll `gridctl_status` (or the returned poll_url) until the entity is live.
- Surface a liveness signal while it builds — never a bare silent wait.
- Only once it is live, return the deployed app URL (NOT the build/log link).

## 10. Return the live URL + iterate

Give the user the live app URL — the deliverable. To iterate, re-plug the SAME
entity so it updates the same URL. Keep it honest: this is a blueprint you built
from, the build is async, it is local-edition only, Mongo is injected via `needs`,
optional secrets via `vault` + `grid secrets set`, and scheduled reminders wait on
platform issue #1543.
