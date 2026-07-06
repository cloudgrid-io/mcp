# internal-tools-portal template — blueprint (structure + cloudgrid.yaml)

A persistent internal tools portal / admin tools hub / back-office portal: a
Next.js app on CloudGrid backed by the grid-shared MongoDB, with staff-only auth
via a provider SDK (Clerk or Auth0) whose keys come from the org vault, role-based
access control (RBAC), and **each internal tool as its own route** under a shared
authenticated shell (`staff` + `toolData` + `auditLog` collections). It is a
persistent runtime app because staff records, tool data, and the audit trail must
survive refresh and be shared across the team — not a static page.

**This is a blueprint: structure + cloudgrid.yaml, not filled app code.** Read
`AGENTS.md` for the full structure guide — the `services/web/` file tree, the
Mongo collections, how CloudGrid injects the DB (`DATABASE_MONGODB_URL`) and the
vault-backed auth keys, how to wire staff-only auth + RBAC (roles on the `staff`
record, server-side checks per tool, the tool registry in `lib/tools.js`), and the
`grid init → fill → grid plug → poll` deploy flow — then adapt it and build the app
following it.
