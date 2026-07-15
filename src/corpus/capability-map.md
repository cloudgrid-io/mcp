# Capability map — intent → template → capabilities → deploy

This is the index an LLM uses to turn a user request into the right CloudGrid
template, the way Superpowers matches a skill's `when:`. Match the request to a
template by its `when:` triggers, adopt that template's `needs:`, then deploy:

> **One deploy verb: `grid_deploy`.** Classify the artifact to pick the shape —
> ONE self-contained HTML page (CSS+JS inline, images/fonts as data: URIs) →
> **inspiration**; separate files/folders/assets or any `needs:` → **runtime app**.

- **single self-contained HTML page → inspiration** (instant, any client / any
  edition) via `grid_deploy` with the inline `html` param.
- **separate files/folders/assets, or anything needing `needs:` → runtime app**
  (async build, **local edition** only) via `grid_deploy` on a linked folder.

Fetch this doc any time with `grid_get_template("doc", "capability-map")`. For the full
cloudgrid.yaml schema (every field, the `needs:` injection table, the
requires-vs-needs caveat, validation rules), fetch the companion reference:
`grid_get_template("doc", "cloudgrid-yaml")`.

## The 60 templates

| Intent (match on `when:`) | Template | `needs:` | Deploy | Edition |
|---|---|---|---|---|
| landing page, marketing/product/hero page, coming-soon, link-in-bio, event page — a single-section page | `landing-page` | none | inspiration (instant) | all |
| SaaS marketing site, product marketing page, features + pricing page — multi-section with pricing tiers, testimonials, FAQ | `saas-marketing` | none | inspiration (instant) | all |
| single-page docs, a quick guide/manual/README-as-a-page, small knowledge base — prose with sidebar + search baked into ONE HTML file (instant, works on hosted). For a multi-page site you'll keep editing, use `docs-app` | `docs-site` | none | inspiration (instant) | all |
| multi-page documentation site you'll keep editing, developer docs portal, knowledge base, help center — sidebar + full-text search + agent-readable llms.txt, built with Astro Starlight (separate content files, not one page). For a quick single page, use `docs-site` | `docs-app` | none | static build | local |
| API documentation, API reference, endpoint docs, REST API docs — method badges, params tables, request/response examples | `api-docs` | none | inspiration (instant) | all |
| status page, service status, uptime page, incident history, is-it-down page — display-only, status baked in | `status-page` | none | inspiration (instant) | all |
| changelog, release notes, what's new, product updates, version history | `changelog` | none | inspiration (instant) | all |
| portfolio, personal site, freelancer site, my work, showcase — projects grid + about + skills + contact | `portfolio` | none | inspiration (instant) | all |
| waitlist, coming soon, early access, join the list, launch page — email capture form (form is static; storing signups needs a runtime crud-app) | `waitlist` | none | inspiration (instant) | all |
| calculator, converter, generator, timer, quiz, interactive tool, mini-app, widget — computed client-side, no saved data | `web-app` | none | inspiration (instant) | all |
| dashboard, metrics, KPIs, stats page, status board, charts, analytics view — display-only, static data baked in | `dashboard` | none | inspiration (instant) | all |
| report, one-pager, summary, brief, whitepaper, case study, formatted document | `report` | none | inspiration (instant) | all |
| slides, deck, pitch, presentation, slideshow | `presentation` (dir: `deck`) | none | inspiration (instant) | all |
| product launch page, launch announcement, new product page, "we just launched" | `product-launch` | none | inspiration (instant) | all |
| company website, business site, corporate site, about-us site, small-business homepage | `company-website` | none | inspiration (instant) | all |
| to-do, task list, notes app, guestbook, CRUD app, a form that SAVES/STORES submissions, anything that PERSISTS data or shares state across users/sessions, sign-in/accounts | `app-with-data` | `database: true` | runtime (async, poll) | local |
| CRM, contacts, leads, sales pipeline, customer manager, deal tracker | `crm` | `database: true` | runtime (async, poll) | local |
| kanban board, task board, trello-style board, workflow columns | `kanban` | `database: true` | runtime (async, poll) | local |
| task manager, to-do app (richer than the app-with-data starter), task list with due dates/priorities | `task-manager` | `database: true` | runtime (async, poll) | local |
| admin dashboard, admin panel, back-office, CRUD admin, manage records | `admin-dashboard` | `database: true` | runtime (async, poll) | local |
| invoice system, invoicing, billing invoices, send invoices, invoice tracker | `invoice` | `database: true` | runtime (async, poll) | local |
| inventory management, stock tracker, warehouse, product stock, SKU manager | `inventory` | `database: true` | runtime (async, poll) | local |
| job board, careers page, job listings, hiring board, open roles | `job-board` | `database: true` | runtime (async, poll) | local |
| ticket system, support tickets, helpdesk, issue tracker, support queue | `ticket-system` | `database: true` | runtime (async, poll) | local |
| REST API, backend for X, API endpoint(s), CRUD API, JSON API, webhook receiver — a backend/service that stores data and isn't a full web UI | `api-service` | `database: true` | runtime (async, poll) | local |
| chatbot, AI assistant, Q&A bot, conversational app, support bot, ask-me-anything, an app that talks to an LLM / generates text with AI | `ai-app` | `ai: true, database: true` | runtime (async, poll) | local |
| blog, CMS, content site with posts, publishing platform, articles | `blog-cms` | `database: true` | runtime (async, poll) | local |
| product catalog, product listings, catalog site, browse products (no checkout) | `product-catalog` | `database: true` | runtime (async, poll) | local |
| analytics dashboard, usage analytics, metrics from stored events | `analytics-dashboard` | `database: true` | runtime (async, poll) | local |
| monitoring dashboard, service health board, uptime/incident monitor (data-backed) | `monitoring-dashboard` | `database: true` | runtime (async, poll) | local |
| financial dashboard, finance metrics, P&L, cashflow board | `financial-dashboard` | `database: true` | runtime (async, poll) | local |
| expense tracker, spending log, budget tracker, expense report | `expense-tracker` | `database: true` | runtime (async, poll) | local |
| time tracking, timesheet, hours logger, billable hours | `time-tracking` | `database: true` | runtime (async, poll) | local |
| event board, events listing, community events, meetup board | `event-board` | `database: true` | runtime (async, poll) | local |
| directory, business directory, member directory, listings directory | `directory` | `database: true` | runtime (async, poll) | local |
| quiz, quiz platform, trivia, assessment, questionnaire | `quiz-platform` | `database: true` | runtime (async, poll) | local |
| API dashboard, API usage dashboard, API requests monitor | `api-dashboard` | `database: true` | runtime (async, poll) | local |
| feature request board, feedback board, roadmap voting, idea board | `feature-request-board` | `database: true` | runtime (async, poll) | local |
| revenue dashboard, sales dashboard, MRR/revenue view | `revenue-dashboard` | `database: true` | runtime (async, poll) | local |
| property listings, real estate site, rentals/homes listings | `property-listings` | `database: true` | runtime (async, poll) | local |
| project management, projects and tasks tracker, team project board | `project-management` | `database: true` | runtime (async, poll) | local |
| search over my documents / PDFs / notes / knowledge base, semantic search, document search, find across my files, searchable archive | `semantic-search` | `database: true` (NO `vector` #1545; active daily refresh cron) | runtime (async, poll) | local |

**Rule of thumb:** if the app must SAVE/remember data, share state across
users/sessions, log in, or store submissions → it is persistent → runtime, local
edition. Pick by shape: a full web UI → `app-with-data`; a plain backend/JSON API
(no UI) → `api-service`; an app that talks to an LLM → `ai-app` (adds `ai:`).
Otherwise a static template deploys instantly anywhere.

**The DB-CRUD family.** `crm`, `kanban`, `task-manager`, `admin-dashboard`,
`invoice`, `inventory`, `job-board`, and `ticket-system` all share the exact
`app-with-data` shape (nextjs + `needs: { database: true }`, app under
`services/web/`, lazy Mongo getter, force-dynamic App-Router routes) — they
differ only by domain schema + UI. Match the request to the closest one by its
`when:`; if it is a bare to-do or generic "save this data" with no specific
domain, use `app-with-data` (the minimal reference). Deploy path is identical for
all of them.

**Document search (`semantic-search`).** For "search over my own documents / PDFs
/ notes / knowledge base" with keyword **and** meaning, `semantic-search` ships
real runnable code in a different shape from the Next.js family: a React (Vite)
**static** frontend at `/` plus a **Python FastAPI** backend at `/backend`, on the
same grid-shared Mongo (`needs: { database: true }`). Hybrid search = Mongo
`$text` + in-app NumPy cosine over embedding arrays + metadata filters. It stores
embeddings in the Mongo `chunks` collection (NO `needs: vector` — pgvector is
blocked on **#1545**) and refreshes via a manager endpoint (NO active cron — a
Python `type: cron` is blocked on **#1585**). Read its `AGENTS.md` for the source
adapter (dropbox/local/url) + embeddings wiring and the health-without-secrets /
startup-index patterns.

## Held / pending platform

| Intent | Would need | Status |
|---|---|---|
| scheduled task, cron job, "run every day/hour", periodic worker | a `type: cron` service (`schedule`, `timezone`) | **SUPPORTED** on CLI 0.14.0 — Python and Node `type: cron` services validate, deploy, and fire (platform #1585 fixed). See the semantic-search `refresh` cron for a working Python-job example. |
| RAG chatbot, "answer over my own docs", semantic search, retrieval-augmented Q&A | `ai-app` + `needs: { vector: pgvector }` | **HELD** — platform issue #1545 (pgvector crashes the deploy). Ship the plain `ai-app` (no vector) for now. |

## Blueprints (structure + cloudgrid.yaml; adapt the app — some pending platform support)

A **blueprint** is a heavier archetype that ships **structure + a correct
`cloudgrid.yaml` + an `AGENTS.md`** rather than fill-in-the-blanks app code
(`kind: blueprint` in the workflow frontmatter). Fetch the workflow, fetch the
template, **read its `AGENTS.md`** for the file tree / collections / CloudGrid
wiring (DB injection, `vault:` secrets for auth + Stripe, deploy), then BUILD the
app under `services/web/` following it. All are persistent Next.js + Mongo →
runtime, async build, **local edition only**. Auth/payment secrets map through a
`vault:` block → env vars (never `requires:`).

| Intent (match on `when:`) | Template | `needs:` | Deploy | Edition |
|---|---|---|---|---|
| online store, e-commerce store, shop with checkout, sell products online | `online-store` | `database: true` (+ Stripe via `vault:`) | runtime (async, poll) | local |
| marketplace, multi-vendor platform, two-sided marketplace | `marketplace` | `database: true` (+ Stripe/auth via `vault:`) | runtime (async, poll) | local |
| HR portal, employee portal, HR management, leave/PTO system | `hr-portal` | `database: true` (+ auth via `vault:`) | runtime (async, poll) | local |
| ERP, enterprise resource planning, integrated multi-module business system | `erp` | `database: true` (+ auth/Stripe via `vault:`) | runtime (async, poll) | local |
| forum, discussion board, community forum, threaded discussions | `forum` | `database: true` (+ auth via `vault:`) | runtime (async, poll) | local |
| membership site, paid community, subscriber content, gated content | `membership-site` | `database: true` (+ Stripe/auth via `vault:`) | runtime (async, poll) | local |
| course platform, sell online courses, Teachable-style | `course-platform` | `database: true` (+ Stripe/auth via `vault:`) | runtime (async, poll) | local |
| LMS, learning management system, training platform | `lms` | `database: true` (+ auth via `vault:`) | runtime (async, poll) | local |
| subscription management, manage subscriptions, self-serve plans/billing | `subscription-management` | `database: true` (+ Stripe via `vault:`) | runtime (async, poll) | local |
| billing dashboard, invoicing and payments dashboard, SaaS billing | `billing-dashboard` | `database: true` (+ Stripe via `vault:`) | runtime (async, poll) | local |
| internal tools portal, admin tools hub, back-office portal | `internal-tools-portal` | `database: true` (+ auth via `vault:`) | runtime (async, poll) | local |
| approval workflow, request approvals, multi-step approval system | `approval-workflow` | `database: true` (+ auth via `vault:`) | runtime (async, poll) | local |
| booking system, reservations, appointment booking, scheduling | `booking-system` | `database: true` (+ Stripe/auth via `vault:`); reminder cron supported (Python/Node `type: cron`, 0.14.0) | runtime (async, poll) | local |
| calendar scheduler, team calendar, scheduling app, meeting scheduler | `calendar-scheduler` | `database: true` (+ optional auth/Stripe via `vault:`); reminder cron supported (Python/Node `type: cron`, 0.14.0) | runtime (async, poll) | local |
| appointment booking, clinic/salon booking, appointment scheduler | `appointment-booking` | `database: true` (+ auth/Stripe via `vault:`); reminder cron supported (Python/Node `type: cron`, 0.14.0) | runtime (async, poll) | local |
| restaurant website with reservations, table booking, restaurant site | `restaurant-reservations` | `database: true` (+ Stripe/email via `vault:`); reminder cron supported (Python/Node `type: cron`, 0.14.0) | runtime (async, poll) | local |
| travel booking portal, trip booking, flights/hotels booking, travel reservations | `travel-booking` | `database: true` (+ Stripe/auth via `vault:`); reminder cron supported (Python/Node `type: cron`, 0.14.0) | runtime (async, poll) | local |
| RAG, ask my docs, knowledge base chatbot, retrieval-augmented search over documents | `ai-knowledge-base` | `ai: true, database: true`; ideal `vector: pgvector` **pending #1545** (store embeddings in Mongo + cosine-rank until it lands) | runtime (async, poll) | local |

The booking family (`booking-system`, `calendar-scheduler`, `appointment-booking`,
`restaurant-reservations`, `travel-booking`) is fully buildable today, **including**
the reminder cron — Python and Node `type: cron` services work on CLI 0.14.0
(platform #1585 fixed). `ai-knowledge-base` builds today on the AI Gateway + Mongo; its
ideal `needs: { vector: pgvector }` embedding store is HELD on **#1545**, so store
chunks in Mongo and cosine-rank in-app until it lands.

## The full `needs:` vocabulary (the whole menu)

`needs:` is a MAP declaring infrastructure capabilities. Values are `true` or an
engine hint. Cron is NOT a need — it is a **service type** (`type: cron` with
`schedule` + `timezone`). See the full cloudgrid.yaml reference §5–§6 via
`grid_get_template("doc", "cloudgrid-yaml")`.

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
2. Adopt that template's `needs:`. Persistence → `database` (`app-with-data` or
   `api-service`); talks to an LLM → `ai: true` + `database` (`ai-app`); scheduled
   work → a `type: cron` service (Python/Node, supported on 0.14.0). (Held for now:
   RAG's ideal `vector: pgvector`, #1545 — store embeddings in Mongo until it lands.)
3. One self-contained HTML page (`needs: none`, assets inlined) → publish as an
   inspiration with `grid_deploy` and the inline `html` param (instant, any
   edition). Separate files/folders/assets, or anything with a `needs:` →
   runtime, local edition, `grid_deploy` a linked folder, then poll to a live URL.

## FAQ

**"What database does CloudGrid support?"**
> All of them — use CloudGrid's managed database out of the box, or bring your own
> by giving me the connection keys (Postgres, MySQL, MongoDB, Supabase, Neon, and
> more). Which would you like?

Under the hood: **managed** is `needs: { database: true }` (grid provisions Mongo,
injects `DATABASE_MONGODB_URL`); **bring-your-own** is
`needs: { database: { tier: external, secret: MY_DB } }` plus
`grid secrets set MY_DB=<connection-string>` (the connection string lives in env
secrets, never committed).

**"Can I run something on a schedule / every day?"**
> Yes — add a `type: cron` service (`schedule` + `timezone`). Python and Node cron
> jobs are supported on CLI 0.14.0. See the semantic-search `refresh` cron for a
> working Python-job example.
