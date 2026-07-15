# Template: approval-workflow (blueprint — Next.js + Mongo)

A multi-step approval system: a requester submits a **request**, it advances
through an ordered chain of **approval steps** decided by assigned **roles**
(approve / reject / delegate), every action lands in an append-only **audit**
log, and approvers are notified as each step activates. Persistent Next.js +
Mongo runtime app (`needs: { database: true }`), extending the proven
`app-with-data` shape with a state machine, auth-provider roles, and
notifications.

**This is a BLUEPRINT — structure + cloudgrid.yaml, not shipped app code.**
Read `AGENTS.md` (fetch this bundle) for the file tree, collections, state
machine, and CloudGrid wiring, then build the app under `services/web/`.

## Fetch bundle

- `grid_get_template("template", "approval-workflow")` → this blueprint:
  - `AGENTS.md` — file tree, Mongo collections (`users`, `requests`, `steps`,
    `audit`), the state machine, auth/payments wiring, deploy steps, edition note.
  - `cloudgrid.yaml` — the full-annotated reference with only `name`,
    `services.web { type: nextjs, path: / }`, and `needs: { database: true }`
    active, plus a commented `vault:` block for `AUTH_PROVIDER_KEY`.
  - `README.md` — one-paragraph what/why.
- `grid_get_template("template", "app-with-data")` → the concrete Next.js + Mongo
  CRUD wiring (lazy `lib/db.js`, App Router route, server page) to adapt from.

## Key rules

1. **Blueprint, not code** — read `AGENTS.md` and build; nothing ships here to run.
2. **Service code lives under `services/web/`.** `path: /` is the URL mount, NOT
   the filesystem path.
3. **Declare `needs: { database: true }`** (the canonical shape). The deployer
   provisions Mongo and injects `DATABASE_MONGODB_URL` (plus the legacy
   `MONGODB_URL` alias). Never set `needs:` and `requires:` together; never
   author `requires:`.
4. **Read the DB string lazily** inside the `getDb` getter
   (`process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL`), never at
   module top level, or `next build` fails.
5. **Secrets via the `vault:` block** → env vars (e.g. `AUTH_PROVIDER_KEY`,
   `STRIPE_KEY`); store real values with `grid secrets set`, never hardcode.
6. **Runtime app → local edition only.** Deploy with `grid plug` (async — poll
   to a live URL). Hosted (Claude Web) can only publish static pages.

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields (plus a commented vault: block to
# uncomment for the auth provider secret).
name: approval-workflow
services:
  web:
    type: nextjs
    path: /
needs:
  database: true
```
