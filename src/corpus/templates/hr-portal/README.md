# hr-portal template — blueprint (structure + cloudgrid.yaml)

A persistent HR / employee portal: a Next.js app on CloudGrid backed by the
grid-shared MongoDB, with employee/admin auth via a provider SDK (Clerk or
Auth0) whose keys come from the org vault, and a leave/PTO request + approval
flow (`employees` + `leaveRequests` collections). It is a persistent runtime app
because HR records and leave requests must survive refresh and be shared across
users — not a static page.

**This is a blueprint: structure + cloudgrid.yaml, not filled app code.** Read
`AGENTS.md` for the full structure guide — the `services/web/` file tree, the
Mongo collections, how CloudGrid injects the DB (`DATABASE_MONGODB_URL`) and the
vault-backed auth keys, how to wire auth roles, and the `write files → grid plug
→ poll` deploy flow (the first plug auto-creates the entity from
`cloudgrid.yaml`) — then adapt it and build the app following it.
