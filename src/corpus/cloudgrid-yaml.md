# cloudgrid.yaml reference — the full manifest schema for agents

> **Canonical source:** `cloudgrid-yaml-reference.md` in the CloudGrid platform
> repo. This is the agent-facing distribution
> of that reference — practically complete, not a verbatim dump. **Keep in sync**
> with the upstream: when the platform reference changes, update this doc.
>
> Fetch this doc any time with `grid_get_template("doc", "cloudgrid-yaml")`.
> For matching an intent to a template, see the companion
> `grid_get_template("doc", "capability-map")`.

`cloudgrid.yaml` is the manifest at the **root of your project** that defines your
entity (an app or an agent). It declares the services your entity runs, the
infrastructure it needs, and how it behaves. `grid init` creates it; `grid plug`
reads it to build and deploy.

**Wiring a database or cache? Use `needs:`** — `needs: {database: true}` is
canonical and the deployer injects the connection env vars from it. See §7 for the
`needs:`-vs-`requires:` note. `requires:` is the deprecated v1 alias; don't author
new yaml with it.

---

## 1. Minimal, real, deployable examples

These are the shapes verified against live deploys. Copy one and adapt it.

### Single HTML page → deploys as an inspiration (instant)

One self-contained HTML page (CSS+JS inline, images/fonts as data: URIs). No
`needs:`. Publishes instantly via `grid_deploy` with the inline `html` param,
works on any edition (hosted or local).

```yaml
name: landing-page
services:
  web:
    type: static
    path: /
```

### Node.js app

Code lives under `services/web/` (`src/index.js` + `package.json`). Runtime deploy
(async, local edition only).

```yaml
name: my-api
services:
  web:
    type: node
    path: /
```

### Next.js app

```yaml
name: my-dashboard
services:
  web:
    type: nextjs
    path: /
```

### Next.js + database — the canonical shape

Declare the datastore with `needs: {database: true}`. The deployer provisions
Mongo and injects `DATABASE_MONGODB_URL` (plus the legacy `MONGODB_URL` alias) at
dev-time and runtime. `requires:` is the deprecated v1 alias — don't author new
yaml with it, and never set `needs:` and `requires:` together (the validator
rejects the combination). See §7 for the details.

This mirrors the live-verified `app-with-data` template exactly: app code under
`services/web/`, and the app reads `process.env.DATABASE_MONGODB_URL` (falling
back to the legacy `MONGODB_URL`) **lazily** (inside a getter, never at module top
level — a top-level read fails `next build`).

```yaml
# Rename this app. The grid injects the DB connection string (and a Redis URL if
# you add a cache) as environment variables at runtime — do NOT set them
# yourself, and never commit a connection string or secret.
#
# `needs: { database: true }` is canonical: the deployer provisions Mongo and
# injects DATABASE_MONGODB_URL (plus the legacy MONGODB_URL alias). `requires:` is
# the deprecated v1 alias — don't mix the two (the validator rejects it).
name: my-app
services:
  web:
    type: nextjs
    path: /
needs:
  database: true
```

### Agent — a cron job

An agent is an app with `kind: agent` and an `agent:` block. Cron is a **service
type**, not a need. `type: cron` requires a `schedule` and cannot have `path` or
`port`.

```yaml
name: nightly-sync
kind: agent
agent:
  purpose: Sync data from an external API every night
services:
  sync:
    type: cron
    schedule: "0 9 * * *"   # 9am daily
    timezone: UTC
```

> A cron/agent that also needs a database declares it the canonical way:
> `needs: {database: true}` (not the deprecated `requires:`).

---

## 2. Full annotated example (the kitchen sink)

Every supported field, commented. **No real project uses all of these at once** —
this is a reference, not a template. (The `needs:` block here is the canonical
schema — the deployer injects the connection env vars from it; see §7.)

```yaml
# ─── Identity ───────────────────────────────────────────────────────
name: my-app                        # Entity slug (required). 2-42 chars, lowercase + hyphens.
description: Order processing API   # One-line summary (max 280 chars). Optional.
icon: "📦"                          # Single emoji or short text (max 64 chars). Optional.
kind: app                           # 'app' (default) or 'agent'. Optional.

# ─── Networking ─────────────────────────────────────────────────────
expose: true                        # Serve public HTTP traffic (default: true).
                                    # Set to false for internal-only entities.
custom_domains:                     # Additional FQDNs the entity serves on. Optional.
  - orders.example.com

# ─── Health probe (entity-level override) ───────────────────────────
probe:                              # HTTP health probe override. Optional.
  path: /healthz                    # Probe path (default: /).
  expected: "<500"                  # Expected status: '<500' (default), '200', '2xx'.

# ─── Deploy notifications ──────────────────────────────────────────
notify: true                        # Slack notification on deploy failure (default: true).

# ─── Scaling ────────────────────────────────────────────────────────
scale: auto                         # 'auto' (default), 'alert', or integer 1-10.

# ─── Infrastructure needs (v2, CANONICAL — the deployer injects from these) ─
needs:
  database: true                    # Mongo (org-tier). Injects DATABASE_MONGODB_URL.
  cache: true                       # Redis with LRU eviction. Injects CACHE_REDIS_URL.
  kv: true                          # Redis, no eviction. Injects KV_REDIS_URL.
  queue: true                       # Redis for BullMQ etc. Injects QUEUE_REDIS_URL.
  pubsub: true                      # Redis pub/sub. Injects PUBSUB_REDIS_URL.
  vector: pgvector                  # pgvector. Injects VECTOR_PGVECTOR_URL. (#1545 shipped, verified live 2026-07-16.)
  object_storage: true              # GATED (platform #1678) - rejected at plug-time; use disk: or a BYO bucket via secret.
  disk: true                        # Persistent filesystem at /data. Injects DISK_PATH.
  ai: true                          # AI Gateway access. Injects AI_GATEWAY_URL.

# ─── Inter-entity communication ────────────────────────────────────
calls:                              # Entities this app calls (outbound grants).
  - org:atomic/billing-api
  - org:atomic/content-service

callers:                            # Inbound caller policy.
  policy: auto                      # 'auto' or 'manual' (default: 'manual').
  scope: org                        # 'org', 'space', or 'explicit' (default: 'org').
  fallback: deny                    # 'deny' or 'warn' (default: 'deny').

# ─── Vault ──────────────────────────────────────────────────────────
vault:                              # Map of ENV_VAR: vault_item_key. Optional.
  STRIPE_KEY: stripe-live-key
  SENDGRID_API_KEY: sendgrid-key

# ─── Connectors and hooks ──────────────────────────────────────────
connectors:
  - id: team-slack
    target: org                     # 'system' or 'org'
    channel: "#deploys"

hooks:                              # Outbound events. on ∈ release.published |
  - on: deploy.failed               #   deploy.failed | feedback.received | entity.created
    via: team-slack                 # Must match a connector id above.
    template: "Deploy failed for {entity_name}: {error}"

triggers:                           # Inbound events routed into your app.
  - from: team-slack
    event: message
    channel: "#support"
    route: /webhooks/slack          # Path in your app that receives the POST.

# ─── Local development ─────────────────────────────────────────────
dev:
  snapshot:
    mask:                           # Fields to redact in dev snapshots (collection.field).
      - users.email
      - users.phone

# ─── Services ──────────────────────────────────────────────────────
services:
  web:
    type: nextjs                    # 'node', 'nextjs', 'python', 'static', or 'cron'.
    path: /                         # HTTP route prefix. false = internal-only.
    port: 3000                      # Container port (default: 8080).
    base_image: distroless          # 'alpine' or 'distroless' (nextjs only).
    health:                         # Health probe config.
      path: /api/health
      expected: "200"
    env:                            # Static env vars (not secrets).
      LOG_LEVEL: info
    depends_on:                     # Wait for these before starting.
      - worker

  worker:
    type: node
    path: false                     # No public URL — internal service.
    source:
      path: src/worker              # Custom source location (instead of services/worker/).
    needs:                          # Per-service needs override (merged per-key).
      queue: true                   # Adds queue (inherits database, cache from app-level).
    persist:                        # Service-level persistence.
      - name: scratch
        path: /tmp/scratch
        size: 500Mi

  reports:
    type: cron
    schedule: "0 9 * * 1"           # Every Monday at 9am.
    timezone: UTC                   # 'UTC', 'EST', or 'PST'.
    run: job                        # 'job' (run code) or an HTTP URL.

  frontend:
    type: static
    path: /app
    build:                          # Build step for static sites.
      command: npm run build
      output: dist
      env:
        VITE_API_URL: https://api.example.com
    node_version: "22"              # Node version for build: '18', '20', '22', '24'. STRING, not int.
```

---

## 3. Top-level fields

### Required

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Entity slug. 2-42 chars, lowercase alphanumeric + hyphens, starts/ends with a letter or digit. Becomes part of the public URL. |
| `services` | map | One or more named service configs. See §4. |

### Optional

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `description` | string | — | One-line summary, max 280 chars. Auto-generated by Grid Brain if unset. |
| `icon` | string | — | Single emoji or short text, max 64 chars. |
| `kind` | string | `app` | `app` or `agent` (an agent is an app with an `agent:` block). |
| `expose` | boolean | `true` | Whether the entity serves public HTTP. `false` = internal-only. |
| `custom_domains` | string[] | — | Additional FQDNs served. |
| `probe` | object | — | Entity-level health probe override: `{ path, expected }`. |
| `notify` | boolean | `true` | Slack notification on deploy failure. |
| `scale` | string \| int | `auto` | `auto`, `alert`, or integer 1-10. |
| `needs` | object | — | Infrastructure capabilities (canonical). See §5 + caveat box. |
| `calls` | string[] | — | Entities this app calls outbound. |
| `callers` | object | — | Inbound caller policy. |
| `vault` | map | — | `ENV_VAR: vault_item_key` mappings. |
| `connectors` / `hooks` / `triggers` | array | — | Connector refs, outbound event hooks, inbound trigger webhooks. |
| `dev` | object | — | Local development config (`grid dev`). |
| `agent` | object | — | Agent metadata (loosely typed: `purpose`, `schedule`, `trigger`). |
| `auto_depends_on_private_requires` | boolean | `true` | Auto-inject private resources as service deps. |

### Deprecated (still accepted)

| Field | Replacement | Notes |
|-------|-------------|-------|
| `domain` | `custom_domains` | Single custom domain string. |
| `network` | `expose` | `{ public: bool }`. |
| `requires` | `needs` | v1 infra requirements. Deprecated — author `needs:` instead. **Cannot be mixed with `needs`** (the validator rejects the combination). |
| `persist` (top-level) | `needs.disk` | v1 entity-level filesystem persistence. |

---

## 4. Services

Each service is a named entry under `services:`. The name is the service identifier
(same slug rules as the entity name). **By default, a service's code lives at
`services/<service-name>/`** — `path:` is the URL mount, NOT the filesystem path. A
service named `web` → the CLI looks for `services/web/`. (Override with `source.path`.)

### Service types

| Type | What it runs | Required files | Default port | `path`? |
|------|-------------|----------------|--------------|---------|
| `node` | Node.js server | `src/index.js` (or `.ts`), `package.json` | 8080 | yes |
| `nextjs` | Next.js app (standalone output) | `next.config.*`, `package.json` | 8080 | yes |
| `python` | Python server | `src/main.py`, `requirements.txt` | 8080 | yes |
| `static` | Static files served by nginx (optional `build`) | `index.html` or build output | 8080 | yes |
| `cron` | Scheduled job | `src/job.js` or `src/main.py` | none | **no** — needs `schedule`, no `path`/`port` |

### Service fields

| Field | Type | Required | Default | Applies to |
|-------|------|----------|---------|-----------|
| `type` | string | Yes | — | All |
| `path` | string \| `false` | No | — | All except cron |
| `port` | integer (1-65535) | No | 8080 | All except cron |
| `lang` | string | No | — | node only (`javascript` \| `typescript`) |
| `base_image` | string | No | `distroless` | nextjs only (`alpine` \| `distroless`) |
| `source` | object | No | — | All — `{ path }`, default `services/<name>/`, `.` = project root |
| `build` | object | No | — | static only — `{ command, output, env }` |
| `node_version` | string | No | `"22"` | static build (`"18"`/`"20"`/`"22"`/`"24"` — STRING) |
| `health` | bool \| string \| object | No | TCP | All except cron |
| `env` | map (string values) | No | — | All (reserved names forbidden) |
| `schedule` | string (cron) | Required for cron | — | cron only |
| `run` | string | No | `job` | cron only (`job` or an HTTP URL) |
| `timezone` | string | No | `UTC` | cron only (`UTC`/`EST`/`PST`) |
| `depends_on` | string[] | No | — | All except cron (no self/circular, no cron) |
| `persist` | bool \| array | No | — | All except cron |
| `needs` | object | No | — | All (overrides/extends app-level per-key) |

### `path` — HTTP routing

`"/"` serves at root; `"/api"` under a prefix; `false` = internal only (no public
URL); omitted = treated as `false` with a soft warning. **Only one service can
claim `"/"`.**

### `source` — custom source location

```yaml
source:
  path: src/worker   # relative to project root; no leading /, no .., no globs
```

Use `.` for a flat layout where the service code lives at the project root:

```yaml
services:
  web:
    type: node
    path: /
    source:
      path: .
```

### `build` — static site build step (static only)

```yaml
build:
  command: npm run build       # required
  output: dist                 # built output dir (default: dist)
  env:
    VITE_API_URL: https://api.example.com
```

### `health` — probe config

Omitted / `false` → TCP probe. `true` → HTTP at `/health`. `"/healthz"` → HTTP at
that path. `{ path, expected }` → HTTP with expected status
(`healthy` (default, 2xx/3xx), `<500`, `200`, `2xx`).

### `env` — static environment variables

String key-values injected at runtime (not build). **Reserved names (rejected):**
`PORT`, `APP_NAME`, `SERVICE_NAME`, `NODE_ENV`, `MONGODB_URL`, `REDIS_URL`,
`AI_GATEWAY_URL`, `N8N_WEBHOOK_URL`, and any key starting with `CLOUDGRID_`. Use
`grid secrets set` for sensitive values.

### Per-service `needs` override

Merge is per-key — service values override app-level for that key; absent keys
inherit:

```yaml
needs:            # App-level
  database: true
  cache: true
  pubsub: true
services:
  worker:
    type: node
    path: false
    needs:
      queue: true      # Added
      pubsub: false    # Overridden (opted out)
    # Effective: database: true, cache: true, queue: true, pubsub: false
```

---

## 5. Needs (infrastructure) — the nine needs

The `needs:` block declares infrastructure capabilities; the platform provisions
them and injects connection details as env vars. **Cron is NOT a need — it is a
service type.**

| Need | Provides | Injected env var(s) | Backing |
|------|----------|---------------------|---------|
| `database` | Primary datastore | `DATABASE_MONGODB_URL` (+legacy `MONGODB_URL`) | MongoDB |
| `cache` | Key-value store, LRU eviction | `CACHE_REDIS_URL` (+legacy `REDIS_URL`) | Redis |
| `kv` | Key-value store, no eviction | `KV_REDIS_URL` | Redis |
| `queue` | Durable job queue substrate | `QUEUE_REDIS_URL` | Redis |
| `pubsub` | Broadcast pub/sub | `PUBSUB_REDIS_URL` | Redis |
| `vector` | Vector embeddings DB | `VECTOR_PGVECTOR_URL` (+legacy `PGVECTOR_URL`) | pgvector (Postgres) |
| `object_storage` | Object/blob bucket - **GATED (#1678)**: rejected at plug-time, use `disk` or a BYO bucket via secret | `OBJECT_STORAGE_GCS_BUCKET`, `OBJECT_STORAGE_GCS_REGION` | GCS |
| `disk` | Persistent filesystem mount | `DISK_PATH` | PVC |
| `ai` | AI Gateway access | `AI_GATEWAY_URL` | CloudGrid AI Gateway |

`cache`, `kv`, `queue`, `pubsub` all share one physical Redis but each gets a
distinct env var. `cache` runs `allkeys-lru` eviction (derived data); the other
three run `noeviction` (durable data).

### Usage forms

```yaml
needs:
  database: true                                # Grid decides tier
  database: pool                                # Shared Mongo (free)
  database: dedicated                           # Entity-private Mongo
  database: { tier: external, secret: MY_DB }   # Bring your own (value from vault)

  cache: true                                   # Platform Redis
  cache: { engine: external, secret: MY_REDIS } # Bring your own (same forms for kv/queue/pubsub)

  # vector - AVAILABLE (#1545 shipped, verified live 2026-07-16):
  vector: true                                  # Platform default engine
  vector: pgvector                              # pgvector explicitly
  vector: { engine: pgvector, dim: 1536 }       # With dimension hint

  # object_storage - GATED (#1678), rejected at plug-time; use disk: or a BYO bucket:
  object_storage: true                          # Default size (100MB)
  object_storage: { size: 10Gi }                # Custom size

  disk: true                                    # 50MB at /data
  disk: { size: 1Gi, mount: /var/data }         # Custom (forbidden mounts: /proc, /sys, /dev)

  ai: true                                      # Enable AI Gateway (ai: false = disabled, default)
```

### Injected environment variables

**Always injected** (do not set these yourself):

| Variable | Description |
|----------|-------------|
| `PORT` | Port your service should listen on (your `port:` or 8080). |
| `APP_NAME` | Entity slug. |
| `SERVICE_NAME` | Service name (the key under `services:`). |
| `NODE_ENV` | `production` in deployed environments. |

**Per `needs:` declaration:** as in the table above. Legacy aliases
(`MONGODB_URL`, `REDIS_URL`, `PGVECTOR_URL`) are injected alongside the canonical
names during the transition; new apps should read the canonical names
(`DATABASE_MONGODB_URL`, etc.) with the legacy name as a fallback.

### Persistence (disk)

Two ways to declare filesystem persistence — use `needs.disk` (recommended) or
service-level `persist:` (fine-grained). Do not mix the entity-level flag form and
the service-level verbose array form.

```yaml
# Recommended:
needs:
  disk: { size: 1Gi, mount: /var/sqlite }

# Fine-grained, per-service:
services:
  web:
    type: node
    path: /
    persist:
      - name: db
        path: /data/sqlite
        size: 1Gi
```

Persistence pins the service to 1 replica with a `Recreate` rollout strategy
(single-writer constraint).

---

## 6. Validation rules (the ones agents trip on)

The platform validates `cloudgrid.yaml` at plug time — strictly.

1. **No `Dockerfile`.** Images are generated from `services.*.type`; a Dockerfile
   is silently ignored.
2. **No `org:` or `entity_id:` in the YAML.** Identity lives in
   `.cloudgrid/link.json` (gitignored), not the manifest.
3. **No mixing `requires:` and `needs:`.** Use one or the other — the validator
   rejects the combination. Author `needs:` (canonical); `requires:` is the
   deprecated v1 alias.
4. **No mixed persistence forms.** Entity-level flag form and service-level
   verbose array form cannot coexist.
5. **Unknown fields are rejected** with a "did you mean?" suggestion.
6. **Reserved env var names cannot be set** in `services.*.env` (see §4 `env`).
7. **`port` must be an integer 1-65535** (not a float). Forbidden on `type: cron`.
8. **`depends_on`:** no self-references, no circular dependencies, no references to
   cron services.
9. **`node_version` must be a string** (`"22"`, not `22`).
10. **Cron services require `schedule`** and cannot have `path` or `port`.
11. **Entity names** must match `^[a-z][a-z0-9-]*[a-z0-9]$` (2-42 chars) — no
    leading/trailing hyphens.

### File layout

```
my-app/
├── cloudgrid.yaml
├── .cloudgrid/link.json      # gitignored; local binding to the server-side entity
├── services/
│   ├── web/                  # service "web" → services/web/
│   │   ├── package.json
│   │   └── src/index.js
│   └── worker/
│       ├── package.json
│       └── src/index.js
└── .gitignore                # includes .cloudgrid/
```

Use `source.path: .` for a flat project where the code lives at the root.

---

## 7. `needs:` vs `requires:` — and the live deploy mechanics (READ THIS)

Bake these into any yaml you author:

- **`needs:` is canonical and it injects.** `needs: {database: true}` provisions
  Mongo and injects the connection env vars — `DATABASE_MONGODB_URL` plus the
  legacy `MONGODB_URL` alias. Likewise `cache: true` → `CACHE_REDIS_URL` (+legacy
  `REDIS_URL`), `vector: pgvector` → `VECTOR_PGVECTOR_URL` (+legacy
  `PGVECTOR_URL`), and so on across the nine needs (see §5). An app reading the
  legacy names keeps working because the aliases are injected alongside.
  (*Historical note: the deployer once did not inject from `needs:` — platform
  issue #1527, now fixed and verified live. The old `requires:` workaround is
  obsolete.*)
- **`requires:` is the deprecated v1 alias** — `requires: [mongodb]` /
  `requires: [redis]`. The CLI warns it's deprecated. **Don't author new yaml with
  it**; use `needs:` instead.
- **`needs:` and `requires:` together are HARD-REJECTED** by the validator ("use
  one or the other"). So author **`needs:`-only** — never set both.
- **A single self-contained HTML page deploys as an inspiration** via `grid_deploy`
  with the inline `html` param — instant, synchronous, works on the hosted edition
  and any client.
- **A `cloudgrid.yaml` with `services:` makes it a runtime** — async build,
  **local edition only** (Claude Desktop/Code or the CLI, not hosted). `plug`
  returns `status: building`; poll status until live, then use the returned live
  URL. Re-plug the same entity to update the same URL.
- **Read injected env vars lazily** (inside a getter/handler), never at module top
  level — a top-level read of `DATABASE_MONGODB_URL` fails `next build`, which
  imports the module for route analysis before the grid injects the var.

The canonical DB shape (mirrors the `app-with-data` template):

```yaml
name: my-app
services:
  web:
    type: nextjs
    path: /
needs:
  database: true
```

---

*This doc is the agent-facing distribution of the platform's canonical
`cloudgrid-yaml-reference.md`. See also `grid_get_template("doc", "capability-map")`
for matching a user intent to a template + the `needs:` injection status.*
