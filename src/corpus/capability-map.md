# Capability map — intent → template → capabilities → deploy

This is the index an LLM uses to turn a user request into the right CloudGrid
template, the way Superpowers matches a skill's `when:`. Match the request to a
template by its `when:` triggers, adopt that template's `needs:`, then deploy:

- **static → inspiration** (instant, any client / any edition) via `gridctl_drop`.
- **anything needing `needs:` → runtime** (async build, **local edition** only)
  via `gridctl_plug` on a linked folder.

Fetch this doc any time with `gridctl_fetch("doc", "capability-map")`. For the full
cloudgrid.yaml schema (every field, the `needs:` injection table, the
requires-vs-needs caveat, validation rules), fetch the companion reference:
`gridctl_fetch("doc", "cloudgrid-yaml")`.

## The 6 templates

| Intent (match on `when:`) | Template | `needs:` | Deploy | Edition |
|---|---|---|---|---|
| landing page, marketing/product/hero page, coming-soon, waitlist, pricing, portfolio, link-in-bio, event page | `landing-page` | none | inspiration (instant) | all |
| calculator, converter, generator, timer, quiz, interactive tool, mini-app, widget — computed client-side, no saved data | `web-app` | none | inspiration (instant) | all |
| dashboard, metrics, KPIs, stats page, status board, charts, analytics view — display-only, static data baked in | `dashboard` | none | inspiration (instant) | all |
| report, one-pager, summary, brief, whitepaper, case study, formatted document | `report` | none | inspiration (instant) | all |
| slides, deck, pitch, presentation, slideshow | `presentation` (dir: `deck`) | none | inspiration (instant) | all |
| to-do, task list, notes app, guestbook, CRUD app, a form that SAVES/STORES submissions, anything that PERSISTS data or shares state across users/sessions, sign-in/accounts | `app-with-data` | `database: true` | runtime (async, poll) | local |

**Rule of thumb:** if the app must SAVE/remember data, share state across
users/sessions, log in, or store submissions → it is persistent → `app-with-data`
(runtime, local edition). Otherwise a static template deploys instantly anywhere.

## The full `needs:` vocabulary (the whole menu)

`needs:` is a MAP declaring infrastructure capabilities. Values are `true` or an
engine hint. Cron is NOT a need — it is a **service type** (`type: cron` with
`schedule` + `timezone`). See the full cloudgrid.yaml reference §5–§6 via
`gridctl_fetch("doc", "cloudgrid-yaml")`.

| `needs:` key | Provides | Injected env var(s) | Status |
|---|---|---|---|
| `database: true` | MongoDB primary datastore | `DATABASE_MONGODB_URL` (+legacy `MONGODB_URL`) | **Injects via `needs:`** |
| `cache: true` | Redis, LRU eviction | `CACHE_REDIS_URL` (+legacy `REDIS_URL`) | **Injects via `needs:`** |
| `kv: true` | Redis, no eviction | `KV_REDIS_URL` | Injects via `needs:` |
| `queue: true` | Redis durable job queue | `QUEUE_REDIS_URL` | Injects via `needs:` |
| `pubsub: true` | Redis pub/sub broadcast | `PUBSUB_REDIS_URL` | Injects via `needs:` |
| `vector: pgvector` | pgvector embeddings DB | `VECTOR_PGVECTOR_URL` (+legacy `PGVECTOR_URL`) | **Injects via `needs:`** |
| `object_storage: true` | GCS bucket | `OBJECT_STORAGE_GCS_BUCKET`, `OBJECT_STORAGE_GCS_REGION` | Injects via `needs:` |
| `disk: true` | Persistent filesystem at `/data` | `DISK_PATH` | Injects via `needs:` |
| `ai: true` | AI Gateway access | `AI_GATEWAY_URL` | Injects via `needs:` |
| `type: cron` (service) | Scheduled job (`schedule`, `timezone`) | — | Service type, not a need |

### Injection status

- **`needs:` injects the connection env vars today.** `needs: { database: true }`
  → `DATABASE_MONGODB_URL` (+legacy `MONGODB_URL`); `needs: { cache: true }` →
  `CACHE_REDIS_URL` (+legacy `REDIS_URL`); `needs: { vector: pgvector }` →
  `VECTOR_PGVECTOR_URL`; and so on across the nine needs. Author `needs:`.
  (*Historical note: the deployer once did not inject from `needs:` — platform
  bug #1527, now fixed and verified live.*)
- **`requires:` is the deprecated v1 alias.** Don't author new yaml with it.
- **`needs:` and `requires:` cannot both be active** in one yaml — the validator
  rejects the combination ("use one or the other"). So a DB template ships the
  canonical `needs: { database: true }` active, with NO `requires:` (and declares
  `needs: database` in the workflow frontmatter as metadata).

## How to choose

1. Read the request; match it against the workflow `when:` triggers above.
2. Adopt that template's `needs:`. Persistence → `database`. (Future: scheduled →
   `cron` service; semantic search / RAG → `vector` + `ai`.)
3. Static (`needs: none`) → publish as an inspiration with `gridctl_drop`
   (instant, any edition). Anything with a `needs:` → runtime, local edition,
   `gridctl_plug` a linked folder, then poll to a live URL.
