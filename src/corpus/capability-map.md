# Capability map — intent → template → capabilities → deploy

This is the index an LLM uses to turn a user request into the right CloudGrid
template, the way Superpowers matches a skill's `when:`. Match the request to a
template by its `when:` triggers, adopt that template's `needs:`, then deploy:

- **static → inspiration** (instant, any client / any edition) via `gridctl_drop`.
- **anything needing `needs:` → runtime** (async build, **local edition** only)
  via `gridctl_plug` on a linked folder.

Fetch this doc any time with `gridctl_fetch("doc", "capability-map")`.

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
`schedule` + `timezone`). See the cloudgrid.yaml reference §5, §12, §14.

| `needs:` key | Provides | Injected env var(s) | Status |
|---|---|---|---|
| `database: true` | MongoDB primary datastore | `DATABASE_MONGODB_URL` (+legacy `MONGODB_URL`) | **Today via `requires: [mongodb]`** — `needs:` pending #1527 |
| `cache: true` | Redis, LRU eviction | `CACHE_REDIS_URL` (+legacy `REDIS_URL`) | **Today via `requires: [redis]`** — `needs:` pending #1527 |
| `kv: true` | Redis, no eviction | `KV_REDIS_URL` | Pending #1527 |
| `queue: true` | Redis durable job queue | `QUEUE_REDIS_URL` | Pending #1527 |
| `pubsub: true` | Redis pub/sub broadcast | `PUBSUB_REDIS_URL` | Pending #1527 |
| `vector: pgvector` | pgvector embeddings DB | `VECTOR_PGVECTOR_URL` (+legacy `PGVECTOR_URL`) | Pending #1527 |
| `object_storage: true` | GCS bucket | `OBJECT_STORAGE_GCS_BUCKET`, `OBJECT_STORAGE_GCS_REGION` | Pending #1527 |
| `disk: true` | Persistent filesystem at `/data` | `DISK_PATH` | Pending #1527 |
| `ai: true` | AI Gateway access | `AI_GATEWAY_URL` | **Today** (AI Gateway) |
| `type: cron` (service) | Scheduled job (`schedule`, `timezone`) | — | Service type, not a need |

### Injection status — today vs pending #1527

- **Injects TODAY:** `database` and `cache` — but ONLY via the deprecated
  `requires:` field (`requires: [mongodb]` → `MONGODB_URL`; `requires: [redis]`
  → `REDIS_URL`). `needs:`-based provisioning does NOT inject anything on the
  live deployer yet (bug #1527). `ai` (AI Gateway) is available today.
- **Pending #1527:** `needs:`-based provisioning for everything — `vector`,
  `queue`, `pubsub`, `kv`, `object_storage`, `disk`, and `needs: database` /
  `needs: cache` once the deployer honors `needs:`.
- **`needs:` and `requires:` cannot both be active** in one yaml — the validator
  rejects the combination ("use one or the other"). So a DB template ships
  `requires: [mongodb]` active with the canonical `needs: { database: true }`
  shown only as a **comment** (and declared in the workflow frontmatter as
  metadata), flipping to `needs:` when #1527 lands.

## How to choose

1. Read the request; match it against the workflow `when:` triggers above.
2. Adopt that template's `needs:`. Persistence → `database`. (Future: scheduled →
   `cron` service; semantic search / RAG → `vector` + `ai`.)
3. Static (`needs: none`) → publish as an inspiration with `gridctl_drop`
   (instant, any edition). Anything with a `needs:` → runtime, local edition,
   `gridctl_plug` a linked folder, then poll to a live URL.
