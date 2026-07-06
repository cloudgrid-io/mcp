# restaurant-reservations template — BLUEPRINT (structure + cloudgrid.yaml)

A restaurant website with online reservations: a public Next.js site (menu
content + a booking form / table booking) backed by grid-shared MongoDB, with
CloudGrid-native wiring for the database, third-party secrets (Stripe deposit,
email/SMS via the `vault:` block), optional staff auth, and a scheduled reminder
job. Reservations persist in Mongo (`needs: { database: true }` → injected
`DATABASE_MONGODB_URL`); this is a runtime app (local edition, async deploy) —
not a static page.

**This is a blueprint: structure + `cloudgrid.yaml`, adapt and build.** There is
no app code here. Read `AGENTS.md` for the file tree, the Mongo collections
(`menu`, `reservations`, `tables`), how CloudGrid injects the DB and vault
secrets, how to wire Stripe/auth, and the deploy steps — then build the app under
`services/web/` following it. Note: the confirmation-reminder **cron** service is
documented but NOT yet deployable (platform issue #1543) — keep that block
commented.
