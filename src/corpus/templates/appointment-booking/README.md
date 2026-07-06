# appointment-booking template — BLUEPRINT (Next.js + auth + Mongo, optional Stripe)

An appointment / clinic / salon booking app: a business defines providers and
bookable services, publishes availability, and clients book an open time slot —
with auth so a provider owns their calendar, optional Stripe deposits, and
grid-shared Mongo (`providers`, `services`, `availability`, `appointments`) as
the source of truth for what is booked. It exists because scheduling is
correctness-sensitive (no double-booking, availability minus taken slots), so it
ships as a **blueprint: the structure + the cloudgrid.yaml — adapt and build**,
not finished code. Read `AGENTS.md` for the file tree, Mongo collections, the
slot-computation and anti-double-booking rules, and the CloudGrid wiring
(`needs: { database: true }` → `DATABASE_MONGODB_URL`; auth/Stripe secrets via
the `vault:` block → env vars), then build the app under `services/web/` and
deploy (async — poll to a live URL; local edition only). A scheduled reminder
cron service is designed but its deploy is **PENDING platform issue #1543** — see
AGENTS.md § 7.
