# travel-booking template — flights + hotels booking portal (BLUEPRINT)

A blueprint for a persistent travel booking portal on CloudGrid: a Next.js app
under `services/web/` backed by grid-shared Mongo (`flights`, `hotels`,
`bookings`, `trips` collections) with search + availability logic, Stripe
checkout for paid bookings, an auth provider for accounts, and a trip-reminder
cron for scheduled notifications. It exists because trips and bookings must
survive refresh and be shared across sessions — a runtime app, not a static page
— and because the payment + scheduling wiring is CloudGrid-specific
(vault-injected secrets, injected `DATABASE_MONGODB_URL`, a cron service).

> **This is a blueprint: structure + cloudgrid.yaml, adapt and build.** It ships
> the annotated `cloudgrid.yaml` and `AGENTS.md` (file tree, data model, and
> CloudGrid wiring) — NOT prewritten app code. Read `AGENTS.md`, then build the
> app under `services/web/` following it. Note: the trip-reminder **cron service
> is not yet deployable** (platform issue #1543) — see `AGENTS.md` §7 for the
> intended shape and the stopgap.
