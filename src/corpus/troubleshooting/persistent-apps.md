---
name: persistent-apps
when: A persistent (Mongo-backed) app misbehaves — data doesn't survive refresh, MONGODB_URL is undefined, a runtime deploy seems stuck, or it won't build on hosted.
summary: Symptom, cause, and fix for the common app-with-data (runtime Mongo app) problems — in-memory vs persistent, injected MONGODB_URL, async deploys, and the hosted-edition gate.
---

# Troubleshooting: persistent apps (app-with-data)

Match the symptom to the row, apply the fix, and stop.

| Symptom | Cause | Fix |
| --- | --- | --- |
| Data doesn't persist / resets on refresh | You built a static inspiration (in-memory / localStorage), not a runtime app | Use the `app-with-data` workflow: a real Next.js + Mongo runtime that reads `process.env.MONGODB_URL`. Static templates keep state only in memory. |
| `MONGODB_URL is undefined` (or the db.js guard throws) | The env var isn't present because you're not running under the grid | Run locally with `grid dev`, or deploy with `grid plug` — the grid injects `MONGODB_URL` at dev-time and runtime. Do NOT set it yourself and never hardcode a connection string. |
| Deploy seems stuck / no URL returned | Runtime deploys are asynchronous | `plug` returns `status: building`, not a URL. Poll `gridctl_status` (or the poll_url) until the app is live, then return the live URL. Don't treat the build/log link as the deliverable. |
| It won't build on the hosted edition | Hosted MCP is inline-only — it can't run the CLI or folder-plug | Runtime apps need the LOCAL edition (Claude Desktop/Code) or the CLI. On hosted, tell the user persistence isn't available there and offer a static version instead. |
| Redis not available | `redis` wasn't declared | Add `redis: private` to `requires` in `cloudgrid.yaml`; the grid then injects `REDIS_URL`. Only add it if the app actually needs Redis. |

See the `app-with-data` workflow for the full recipe.
