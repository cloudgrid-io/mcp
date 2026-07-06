# marketplace template — two-sided marketplace blueprint

A blueprint for a multi-vendor / two-sided marketplace on CloudGrid: a persistent
Next.js + Mongo app (`vendors`, `listings`, `orders`) with seller auth + roles,
Stripe Connect payouts, and commission logic — the `app-with-data` runtime shape
with auth and payments layered on. Because a real marketplace involves choices
(which auth provider, take-rate, listing schema), this template ships the
**structure and `cloudgrid.yaml`, not finished app code** — you adapt it and build.

> **This is a blueprint: structure + cloudgrid.yaml, adapt and build.** Read
> `AGENTS.md` for the file tree, Mongo collections, CloudGrid injection table
> (needs + vault), auth + Stripe Connect wiring, and the deploy flow — then
> generate the app under `services/web/` and `grid plug` it (runtime, local
> edition, async — poll to a live URL).

## Files

- `cloudgrid.yaml` — active fields: `name`, `services.web` (nextjs, `/`),
  `needs: { database: true }`, and a `vault:` block mapping `STRIPE_KEY`,
  `STRIPE_WEBHOOK_SECRET`, and `AUTH_PROVIDER_KEY`.
- `AGENTS.md` — the structure guide (read this first).
- `index.md` — the fetch-bundle summary + cloudgrid.yaml.
