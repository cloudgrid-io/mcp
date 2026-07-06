# subscription-management template — BLUEPRINT

A self-serve subscription-management app: a Next.js app where a signed-in
customer sees their current plan, upgrades/downgrades or cancels it, and manages
billing (card, invoices) through the Stripe Billing Portal — with a Stripe
webhook keeping local subscription state in sync, and grid-shared Mongo for
persistence. This is a **blueprint** — it ships the `cloudgrid.yaml` and a
structure guide (`AGENTS.md`), not finished app code. Read `AGENTS.md` for the
file tree, Mongo collections, and the CloudGrid wiring (Mongo via
`needs:{database:true}` → `DATABASE_MONGODB_URL`; Stripe secrets via the `vault:`
block → env vars), then build the app under `services/web/` following it, adapt
the plans/fields to the user, and deploy (async — poll to a live URL). It
requires the local edition.

- `cloudgrid.yaml` — active: `name` + `services.web{type: nextjs, path: /}` +
  `needs:{database:true}` + `vault:` (Stripe secrets → env vars).
- `AGENTS.md` — the structure guide: file tree, collections, CloudGrid injection,
  Stripe change-plan / cancel / billing-portal / webhook wiring, deploy steps,
  edition note.

**blueprint: structure + cloudgrid.yaml, adapt and build.**
