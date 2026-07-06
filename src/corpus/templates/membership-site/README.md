# membership-site template — BLUEPRINT

A paid membership / subscriber-content site: a Next.js app with user auth,
Stripe subscription checkout, gated routes that check membership status, and
grid-shared Mongo for persistence. This is a **blueprint** — it ships the
`cloudgrid.yaml` and a structure guide (`AGENTS.md`), not finished app code. Read
`AGENTS.md` for the file tree, Mongo collections, and the CloudGrid wiring
(Mongo via `needs:{database:true}` → `DATABASE_MONGODB_URL`; Stripe/auth secrets
via the `vault:` block → env vars), then build the app under `services/web/`
following it, adapt the plans/content/fields to the user, and deploy (async —
poll to a live URL). It requires the local edition.

- `cloudgrid.yaml` — active: `name` + `services.web{type: nextjs, path: /}` +
  `needs:{database:true}` + `vault:` (Stripe + auth secrets → env vars).
- `AGENTS.md` — the structure guide: file tree, collections, CloudGrid injection,
  auth + Stripe wiring, deploy steps, edition note.

**blueprint: structure + cloudgrid.yaml, adapt and build.**
