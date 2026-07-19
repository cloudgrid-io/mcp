# erp template — enterprise resource planning blueprint

A **blueprint** for a multi-module ERP: inventory + orders + finance + HR in one
Next.js App-Router service, backed by grid-shared Mongo, with auth/RBAC (Clerk or
Auth0) and Stripe billing. It exists because an ERP is too large and
domain-specific to ship as ready-to-run code — this template gives you the
CloudGrid-correct skeleton (the file tree, the Mongo collections per module, and
how the grid injects the database, vault secrets, and AI) so you build the actual
app on solid rails instead of guessing at the platform wiring.

> **blueprint: structure + cloudgrid.yaml, adapt and build.** There is no app
> code here to copy. Read [`AGENTS.md`](./AGENTS.md) for the full structure guide
> (file tree, collections, env/vault/deploy wiring), copy the `cloudgrid.yaml`
> (active fields: `name` + `services.web` nextjs at `path: /` + `needs:
> { database: true }` + a `vault:` block for auth/Stripe keys), then build the
> app under `services/web/` following the guide. Deploy is runtime + async
> (write the files → `grid plug` → poll to live; the first plug auto-creates the
> entity from `cloudgrid.yaml`); local edition only.
