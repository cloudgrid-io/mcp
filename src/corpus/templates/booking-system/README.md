# booking-system template — appointment / reservation booking (BLUEPRINT)

A blueprint for a persistent booking system on CloudGrid: a Next.js app under
`services/web/` backed by grid-shared Mongo (`services`, `availabilityRules`,
`bookings` collections) with slot-availability logic, Stripe checkout for paid
appointments, an auth provider for accounts, and a reminder cron for scheduled
notifications. It exists because reservations must survive refresh and be shared
across sessions — a runtime app, not a static page — and because the payment +
scheduling wiring is CloudGrid-specific (vault-injected secrets, injected
`DATABASE_MONGODB_URL`, a cron service).

> **This is a blueprint: structure + cloudgrid.yaml, adapt and build.** It ships
> the annotated `cloudgrid.yaml` and `AGENTS.md` (file tree, data model, and
> CloudGrid wiring) — NOT prewritten app code. Read `AGENTS.md`, then build the
> app under `services/web/` following it. Note: the reminder **cron service is
> not yet deployable** (platform issue #1543) — see `AGENTS.md` §7 for the
> intended shape and the stopgap.
