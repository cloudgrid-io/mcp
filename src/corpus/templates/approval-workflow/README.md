# approval-workflow template (blueprint)

A multi-step approval system: a requester submits a request, it advances through
an ordered chain of approval steps decided by assigned roles (approve / reject /
delegate), every action is recorded in an append-only audit log, and approvers
are notified as each step activates. It is a persistent Next.js + Mongo runtime
app (declares `needs: { database: true }`, extends the proven `app-with-data`
shape) with auth-provider roles wired through a `vault:` secret. This is a
**blueprint: structure + cloudgrid.yaml — adapt and build.** Read `AGENTS.md`
for the full file tree, Mongo collections, the state machine, CloudGrid wiring
(DB injection, `vault:` secrets, deploy), then build the app following it. There
is no shipped app code here.
