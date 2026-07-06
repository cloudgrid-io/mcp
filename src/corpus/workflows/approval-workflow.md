---
name: approval-workflow
when: approval workflow, request approvals, multi-step approval system — a persistent app where requests advance through an ordered chain of approver roles (approve/reject/delegate) with an audit log. Needs a database → runtime → local edition.
needs: database
deploy: runtime
editions: local
kind: blueprint
capabilities_note: BLUEPRINT — structure + cloudgrid.yaml, not shipped app code. Persistent Next.js + Mongo. Declare the canonical `needs: { database: true }`; the deployer injects DATABASE_MONGODB_URL (+legacy MONGODB_URL). Auth-provider roles + optional payments wired via a `vault:` secret block → env vars. Runtime app, async build, local edition only.
summary: Build a multi-step approval system on the grid — requests advance through an ordered chain of approval steps decided by assigned roles (approve/reject/delegate), with an append-only audit log and approver notifications. This is a BLUEPRINT: read AGENTS.md for the file tree, Mongo collections (users/requests/steps/audit), the state machine, and CloudGrid wiring (DB injection, vault: secrets, deploy), then build the Next.js + Mongo app under services/web/ following it. Edition-gate first, scaffold, declare needs:{database:true}, wire auth via a vault: secret, deploy async, poll to a live URL.
---

# Workflow: approval-workflow

The user wants a **multi-step approval system**: a requester submits a request,
it advances through an ordered chain of approval steps, each step is decided
(approve / reject / delegate) by an assigned approver role, every action is
recorded in an audit log, and approvers are notified as their step activates.
That is a **persistent runtime app** backed by the grid's shared Mongo, with a
state machine, auth-provider roles, and notifications — the same proven shape as
`app-with-data`, extended.

**This is a BLUEPRINT.** The template ships the *structure* (an `AGENTS.md`
guide + a `cloudgrid.yaml`), not runnable app code. The recipe is: read the
blueprint, then build the app following it. Be honest that a runtime deploy is
async (not instant like a static drop) and that it needs the local edition.

## 1. Edition check FIRST (hard gate)

A persistent approval app is a built + deployed container. It requires the
**local edition** (Claude Desktop / Claude Code) or the CLI.

- **Hosted edition (Claude Web / hosted MCP):** you CANNOT build a runtime app —
  hosted is inline-only and can only publish static pages. Tell the user
  plainly, offer a **static mock** of the approval UI instead, and STOP the
  runtime path here.
- **Local edition:** continue.

## 2. Auth + grid

1. Ensure signed in: `gridctl_login_status`; if not, `gridctl_login`.
2. A grid is required. Respect the grid picker: if the user has more than one
   grid, ask which to use; do not assume a target.

## 3. Read the blueprint

Fetch the blueprint and read it before building:
`gridctl_fetch("template", "approval-workflow")`. Its **`AGENTS.md`** is the
structure guide — the file tree (under `services/web/`), the Mongo collections
(`users`, `requests`, `steps`, `audit`), the **state machine** (how a request
advances / is decided across its ordered steps), how CloudGrid injects the DB
and secrets, how to wire auth roles (and optional payments), and the deploy
steps. Also fetch the concrete CRUD shape to adapt from:
`gridctl_fetch("template", "app-with-data")` (lazy `lib/db.js`, App Router
route, server page).

## 4. Scaffold

`gridctl_init` an app `<name>`. `init` creates the entity + `.cloudgrid/link.json`
and writes a `cloudgrid.yaml` with an EMPTY `services: {}`. `plug` needs a linked
directory, so run `init` FIRST. Then (a) write the app under **`services/web/`**
following `AGENTS.md`, and (b) fill `cloudgrid.yaml` to the shape below.

## 5. Build the app + wire Mongo

1. Set `cloudgrid.yaml`. **App code MUST live under `services/<name>/`** —
   `path:` is the URL mount, NOT the filesystem path.
   ```yaml
   name: my-approvals
   services:
     web:
       type: nextjs
       path: /
   needs:
     database: true
   ```
   **Declare the datastore with `needs: { database: true }`** — the canonical
   shape. The deployer provisions Mongo and injects `DATABASE_MONGODB_URL` (plus
   the legacy `MONGODB_URL` alias). `requires:` is the deprecated v1 alias; don't
   author new yaml with it, and never set `needs:` and `requires:` together (the
   validator rejects the combination).
2. Build the collections + state machine from `AGENTS.md`. **Read the DB from
   `process.env.DATABASE_MONGODB_URL`** (legacy `process.env.MONGODB_URL`
   fallback) inside a **lazy getter — never at module top level**, or
   `next build` fails.
3. Keep the state machine (advance / decide across steps) in one module so the
   API routes and the UI agree on legal transitions; guard every transition
   server-side and never trust the client about which step is active.

## 6. Wire auth roles (and optional payments) via `vault:`

Approvals need to know who you are and their role. Add an auth-provider SDK
(Clerk / Auth0), gate routes in `middleware.js`, and read the user + `role` in
`lib/auth.js`. The provider secret is injected the CloudGrid-correct way — via
the **`vault:` block** in `cloudgrid.yaml` mapping a vault item to an env var:

```yaml
vault:
  AUTH_PROVIDER_KEY: auth-provider-secret-key   # → process.env.AUTH_PROVIDER_KEY
  # STRIPE_KEY: stripe-live-key                  # only if an approved request charges
```

Store the real value with `grid secrets set` (mapped by `vault:`); non-secret
config → `grid env`. Do **NOT** hardcode keys and do **NOT** set
`DATABASE_MONGODB_URL`/`MONGODB_URL` yourself — the grid injects the DB vars.

## 7. (Optional) Run locally

Mention that the user can `grid dev` to run locally against the injected Mongo
before deploying. Don't require it.

## 8. Deploy (async)

Deploy the folder with `gridctl_plug`. A **runtime deploy is ASYNC**: the first
response is `status: "building"`, NOT a live URL yet.
- Poll `gridctl_status` (or the returned poll_url) until the entity is live.
- Surface a liveness signal while it builds — never a bare silent wait.
- Only once it is live, return the deployed app URL (NOT the build/log link).

## 9. Return the live URL + iterate

Give the user the live app URL — that is the deliverable. To iterate, re-plug the
SAME entity so it updates the same URL. Keep it honest: this is a blueprint you
built out, an async runtime build, local-edition only, credentials injected by
the grid.
