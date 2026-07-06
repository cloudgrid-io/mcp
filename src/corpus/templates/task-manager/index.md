# Template: task-manager (persistent Next.js + Mongo task list)

A real, deployable task manager — richer than the bare `app-with-data` to-do
starter. Tasks live in the grid-shared MongoDB, so they survive refresh and are
shared across sessions. Same proven shape, adapted to a `tasks` domain (title,
done, due, priority) with a complete-toggle and an active/done filter.

**Key rules (all proven by the app-with-data end-to-end deploy):**

1. **Service code MUST live under `services/<name>/`, not the repo/template
   root.** `path:` in `cloudgrid.yaml` is the URL mount, NOT the filesystem path.
   The service named `web` → the CLI looks for `services/web/`. App files at the
   root fail with `Error: Service directory not found: …/services/web`.
2. **Read the DB connection string LAZILY (inside the getter), never at module
   top level.** The grid injects it as `DATABASE_MONGODB_URL` (plus the legacy
   `MONGODB_URL` alias) at dev-time and runtime; the app reads
   `process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL` inside `getDb`.
   A top-level read fails `next build`. Never hardcode a connection string; never
   commit a secret.
3. **Declare the datastore with `needs: { database: true }`.** The deployer
   provisions Mongo and injects the connection string. `requires:` is the
   deprecated v1 alias; don't author new yaml with it, and never set `needs:` and
   `requires:` together (the validator rejects the combination).

## File tree

```
cloudgrid.yaml                         # name + services.web (nextjs) + needs: { database: true }
services/web/package.json              # next, react, react-dom, mongodb driver only
services/web/lib/db.js                 # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
services/web/app/layout.js             # root layout + inline CSS
services/web/app/page.js               # server component: reads tasks from Mongo
services/web/app/task-list.js          # client list: POST / PATCH (toggle done) / DELETE, plus a filter
services/web/app/api/tasks/route.js    # GET (list) / POST (add) / PATCH (toggle) / DELETE (remove)
```

## cloudgrid.yaml

```yaml
name: my-tasks
services:
  web:
    type: nextjs
    path: /
needs:
  database: true
```

> **Capability:** this template's need is `database: true`. The deployer
> provisions Mongo and injects `DATABASE_MONGODB_URL` (plus the legacy
> `MONGODB_URL` alias). `requires:` is the deprecated v1 alias — don't mix it with
> `needs:` (the validator rejects the combination). See the capability-map for
> the full injection table.

## The tasks collection

Documents: `{ title, done, due, priority, createdAt }` where `priority` is one of
`low` / `medium` / `high`. The API route on `tasks` does GET (list), POST (add),
PATCH (toggle done), DELETE (remove); the page is a server component that reads
the collection and hands it to a client list with an active/done filter.

## Adapt it

- Rename the `tasks` collection to your data.
- Change the document fields (tags, projects, assignees, subtasks).
- Add sorting by due date or priority on top of the existing fields.
- Add `cache: true` to `needs:` only if you actually need Redis.
- Run `grid dev` to test locally, `grid plug` to deploy (async — poll to live).
