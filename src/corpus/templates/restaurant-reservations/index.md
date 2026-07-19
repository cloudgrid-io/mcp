# Template: restaurant-reservations (BLUEPRINT — Next.js + Mongo)

A restaurant website with online reservations. A public Next.js site (menu +
booking form / table booking) backed by grid-shared MongoDB, with CloudGrid-native
wiring for the DB, third-party secrets (`vault:`), optional Stripe deposit and
staff auth, and a scheduled reminder job. Reservations persist in Mongo — this is
a **runtime app** (local edition, async deploy), not a static page.

**This is a blueprint, not runnable code.** It ships a `cloudgrid.yaml` (active:
`name` + `services.web` nextjs + `needs: { database: true }` + a `vault:` block)
and an `AGENTS.md` structure guide. Fetch both, read `AGENTS.md`, then build the
app under `services/web/` following it — the proven `app-with-data` shape with a
`reservations` domain.

**Key rules:**

1. **App code MUST live under `services/web/`**, not the template root. `path: /`
   is the URL mount, NOT the filesystem path.
2. **Read `DATABASE_MONGODB_URL` LAZILY** (inside the getter), legacy
   `MONGODB_URL` fallback — the grid injects it; never hardcode, never commit.
3. **Third-party secrets go through the `vault:` block** (Stripe `STRIPE_KEY`,
   email `SENDGRID_API_KEY`, optional `AUTH_PROVIDER_KEY`) → injected env vars;
   store values with `grid_set_secret`.
4. **Declare `needs: { database: true }`** (canonical) — never mix `needs:` and
   `requires:`.
5. **Cron reminder service is documented but NOT deployable yet** (platform issue
   #1543) — keep the `reminder:` cron block commented.

## Fetch bundle

```
grid_get_template("template", "restaurant-reservations")   # cloudgrid.yaml + AGENTS.md + README
```

Then read `AGENTS.md` (file tree, `menu`/`reservations`/`tables` collections,
CloudGrid env/vault/deploy wiring, Stripe + auth, cron shape) and build under
`services/web/`. Deploy: `grid plug` (the first plug auto-creates the entity from
`cloudgrid.yaml`; async — poll to a live URL). Local edition only.

## cloudgrid.yaml (active fields)

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference)
# with EVERY field present as a comment; only the fields below are uncommented
# (plus a vault: block and a COMMENTED cron reminder service), so it deploys to
# exactly these active fields.
name: restaurant-reservations
vault:
  STRIPE_KEY: stripe-live-key
  SENDGRID_API_KEY: sendgrid-key
services:
  web:
    type: nextjs
    path: /
needs:
  database: true
```

> **Capability:** `needs: { database: true }` → the deployer provisions Mongo and
> injects `DATABASE_MONGODB_URL` (+ legacy `MONGODB_URL`). Vault items are injected
> as the mapped env vars. `requires:` is the deprecated v1 alias — don't mix it
> with `needs:`. See the capability-map for the full injection table.
