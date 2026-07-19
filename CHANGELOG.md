## 0.20.12

- **PLAYBOOK is now markdown** (`src/corpus/playbook.md`), loaded at startup —
  a backticked word once terminated the old template literal and broke the
  build. Byte-identical content; also retrievable now via
  `grid_get_template({kind:"doc", name:"playbook"})` and indexed by the docs
  search server.
- **CLI 0.15.14 compat (init → new).** The CLI renamed `init` to `new` (help
  listing; `init` remains a hidden alias), dropped `--here` (current dir is
  the default), and folded entity registration into `plug` (auto-creates in
  an unlinked dir from the manifest). Zip deploys now try plain `plug` FIRST
  (new CLIs: one command, manifest name honored natively) and fall back to
  the legacy stash → `init --here` → re-plug dance only when an old CLI
  refuses the unlinked dir. Drift-guard verb map follows the advertised name
  (`new`); the tool argv keeps the `init` alias for old-CLI compat. Verified
  LIVE against the real 0.15.14 (z1514-41cd: index + byte-exact image) and
  covered offline for both generations.

## 0.20.11

- **MCP server `instructions` — orientation for hookless hosts.** Neither
  edition sent the initialize `instructions` field, so hosts with no
  hooks/skills channel (ChatGPT, claude.ai web) had zero orientation and the
  model's training prior won: "share a link" produced GitHub Pages/Netlify
  advice and "build me a game" ended as save-this-file, with the connector
  attached (observed live 2026-07-18; only the literal word "grid" triggered
  tool use). Both editions now send edition-tuned instructions claiming the
  build/make-it-live/share-a-link intents and steering to grid_start ->
  grid_deploy -> live URL. grid_deploy's description additionally claims the
  exact phrases ("give me a link", "share it with friends", "make it live",
  "put it online") and prefers CloudGrid over external-host suggestions.
  Smoke guards assert instructions + trigger phrases on both editions.

## 0.20.10

- **Voice: `grid` only (founder directive #1637).** 22 CLI-wrapping tool
  descriptions said "Wraps `cloudgrid <verb>`" — in every session's context —
  and a Claude Desktop model repeated "run cloudgrid plug" to a user verbatim.
  All descriptions now say `grid <verb>`; CLI exec errors normalize the raw
  invocation (binary path / cli-shim / npx spec) to `Command failed: grid
  <verb>` before the model sees it; smoke gains a guard so a "cloudgrid
  <verb>" can never ship in a description again. (`cloudgrid.yaml` and other
  file names are unchanged — the rule covers command verbs only.)

## 0.20.9

- **Zip deploys.** `grid_deploy`'s `path` now accepts a `.zip` archive (local
  edition): extracted safely (zip-slip guarded, `__MACOSX`/junk skipped, single
  common root stripped when it surfaces an index/manifest) and deployed. A zip
  with its own `cloudgrid.yaml` deploys as that project; a manifest-less
  multi-file zip is wrapped as a static app (synthesized manifest, files under
  `services/web/`) and shipped through the CLI (`grid init --here` + `grid
  plug`) — the direct-API inline wire drops secondary files on inspiration
  creates and never starts path-mode runtime builds (platform issues, filed).
  A single-page zip short-circuits to the instant inline-HTML path. New combo:
  `html` + a zip of assets — the generated page becomes index.html over the
  archive's files (the Claude Desktop "gallery from a zip" flow). Verified by
  a live end-to-end deploy (index + image byte-exact). New offline suite:
  `test/zip-deploy.test.mjs` (23 checks). Adds the `fflate` dependency.

## 0.20.8

- **Alias diet: 53 advertised tool names → 37.** Dropped 16 legacy redirect
  aliases (grid_source, grid_list, grid_fork, grid_download, grid_claim,
  grid_visibility, grid_init, grid_env, grid_secrets, grid_rollback,
  grid_versions, grid_open, grid_doctor, grid_unplug, grid_use, grid_pickup) -
  each alias shipped its full schema to every session via ListTools for zero
  benefit; the corpus and playbook migrated to the canonical names releases ago
  (no test or corpus referenced them). Kept the two with real muscle memory:
  `grid_fetch` (→ grid_get_template) and `grid_logs` (→ grid_view_logs).
  Callers of a dropped name get the standard unknown-tool error; the canonical
  names are unchanged.

- **fix(deploy): `grid_deploy` output-schema `-32602`.** `grid_deploy` declares one
  outputSchema but returns three shapes: the deploy result, the grid-picker
  "which grid?" ask (`needs_grid`/`needs_org`/`grids`/`orgs`), and the signed-in
  CLI-fallback recovery (`via`). The SDK renders the schema with
  `additionalProperties:false` and clients validate every result, so the two
  non-deploy shapes were rejected with `MCP error -32602` (once per undeclared
  key). Declared the picker + fallback fields; the schema stays tight for
  genuinely-unknown keys. Offline Client↔Server regression test added
  (`test:plug-output-schema`). Re-applies stale PR #60 onto the post-rename tool.

## 0.17.0

- Hard rename (no aliases): every `gridctl_<verb>` MCP tool identifier → `grid_<verb>` (all 35 tools), and the bare `gridctl` CLI term → `grid` in descriptions, the PLAYBOOK, README, and REMOTE. Corpus re-snapshotted from cloudgrid-io/skills 0.13.0 (also renamed). Runtime CLI exec is unchanged — the server still shells out to the installed `cloudgrid` binary with the same subcommand argv (`grid` is an alias of the same binary); `CLI_TOOL_VERBS` values (CLI subcommands) are untouched, only the map keys were renamed. Prior changelog entries below are historical and keep their original `gridctl_*` wording.

## 0.14.0

- Template library: 35 new templates (17 Tier A/B full apps + 18 Tier C/D blueprints), synced from cloudgrid-io/skills 0.10.0. Library now 58 templates. blog-cms + kanban + invoice-family live-verified.

## 0.13.0

- Template library Wave 1: 7 static (saas-marketing, docs-site, status-page, changelog, portfolio, api-docs, waitlist) + 4 DB-CRUD (crm, kanban, task-manager, admin-dashboard). Synced from cloudgrid-io/skills. kanban live-verified.

# Changelog

## 0.12.0

Add two new runtime build archetypes, authored in `cloudgrid-io/skills` and
snapshotted into the corpus. Both are DB-backed runtime builds (like
`app-with-data`), live-verified buildable. Additive; no deploy-behavior change.

- **New archetype `api-service`** (node + database) — a plain Node `http`
  service (`type: node`) serving a REST `/items` resource backed by grid-shared
  Mongo. Reads `process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL`
  lazily inside a getter (a module-top read crashes node startup); listens on
  `process.env.PORT || 8080`; clear JSON errors, no secrets. Ships a workflow,
  template tree (`services/api/`), and a filled "Notes API" example.
- **New archetype `ai-app`** (ai + database — chatbot) — a Next.js App Router
  chatbot that calls the grid AI gateway via `@cloudgrid-io/ai`
  `createClient().chat({ messages })` (zero-config in-grid identity, no API key)
  and persists the exchange to Mongo (lazy DB read). Declares
  `needs: { ai: true, database: true }`. Ships a workflow, template tree
  (`services/web/`), and a filled "Trip Planner Bot" example. No vector/RAG — that
  variant is held on platform issue #1545.
- **`capability-map.md`** — snapshot picks up the two new rows plus a
  "held / pending platform" note for scheduled-task (#1543) and ai-app RAG/vector
  (#1545), so the LLM knows they are coming but not yet buildable.
- **Tests** — new offline `test:archetypes` (`test/archetypes.test.mjs`): asserts
  both archetypes' workflow/template/example resolve via `fetchCorpus` + the real
  `gridctl_fetch` handler, both appear in the `gridctl_start` menu, and each
  template is internally consistent (active canonical `needs:`, no active
  `requires:`, lazy DB read, no hardcoded connection string/secret, correct AI
  call shape). GUARDS that neither template declares `needs: vector` (#1545) or a
  cron service (#1543). Wired into CI.

## 0.11.2

Flip the corpus to canonical `needs:` now that the deployer injects from it
(platform issue #1527 fixed and verified live: `needs: {database: true}` injects
both `DATABASE_MONGODB_URL` and the legacy `MONGODB_URL`, and persists). The
`requires:` shim baked in by 0.11.0/0.11.1 is removed.

- **`app-with-data` template** — `cloudgrid.yaml` now declares the canonical
  active `needs: { database: true }` (no `requires:`); `services/web/lib/db.js`
  reads `process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL` (canonical
  first, legacy fallback), keeping the lazy getter + clear unset-error. `index.md`
  and `README.md` regenerated to match.
- **`examples/app-with-data`** — the filled "Team Task Board" reference flipped to
  active `needs: { database: true }` and `DATABASE_MONGODB_URL`.
- **`cloudgrid-yaml.md`** — `needs:` is now the primary/recommended shape
  everywhere; the §7 caveat box is rewritten to say `needs:` is canonical and
  injects the connection env vars, `requires:` is the deprecated v1 alias, and the
  two can't both be set. Kept a one-line historical note that #1527 was the old
  non-injecting bug (now fixed). Static-vs-runtime, read-env-lazily, local-edition
  notes and the full annotated example/tables retained.
- **`capability-map.md`** — injection status updated: `database`/`cache`/`vector`
  and the rest inject via `needs:` (no more "pending #1527").
- **Workflow / troubleshooting** — `workflows/app-with-data.md` and
  `troubleshooting/persistent-apps.md` corrected to recommend `needs:`.
- **Tests** — the Task-41/42 guards are flipped: the DB example/template now must
  use active `needs: { database: true }` and NO active `requires:`. The "never
  active `needs:` + `requires:` together" guard is kept.

## 0.11.1

Distribute Gilad's canonical `cloudgrid.yaml` reference into the agent-facing
corpus, so the MCP/agents/builders can fetch one practically-complete schema and
author `cloudgrid.yaml` correctly — instead of stitching it together from
per-template fragments. Additive; no deploy-behavior change.

- **New corpus doc** — `src/corpus/cloudgrid-yaml.md`, fetchable with
  `gridctl_fetch("doc", "cloudgrid-yaml")` (same top-level `doc` kind as the
  capability-map). Distilled from the platform's authoritative
  `cloudgrid-yaml-reference.md` (cited in the header with a keep-in-sync note).
  Covers: minimal real deployable examples (static / node / nextjs /
  nextjs+database / cron-agent), the full annotated kitchen-sink example, the
  service-types table, the nine `needs:` with their injected env var names, the
  validation rules agents trip on, and a **CloudGrid-today caveat box**.
- **The nextjs+database example uses the working shape today** — active
  `requires: [mongodb]` with the canonical `needs: {database: true}` shown only as
  a comment, mirroring the live-verified `app-with-data` template. The deployer
  does not inject from `needs:` yet (platform issue #1527); `needs:` and
  `requires:` together are validator-rejected.
- **Wiring** — the `gridctl_start` PLAYBOOK gains a rule pointing agents at the
  reference before writing a `cloudgrid.yaml`; `capability-map.md` ↔
  `cloudgrid-yaml.md` cross-link.
- **Tests** — `test/canonical-yaml.test.mjs` asserts the doc fetches, carries the
  needs vocabulary + the requires caveat + a full example + the active-`requires:`/
  commented-`needs:` DB example, and guards that the doc shows no active `needs:` +
  `requires:` together. Wired into CI.

## 0.11.0

Self-describing templates + a capability map, so any LLM can match a user request
to the right template and know its capabilities — the way Superpowers matches a
skill's `when:`. Enriches the 6 existing corpus templates; no deploy-behavior
change (static templates still deploy as instant inspirations; app-with-data
still deploys via `requires: [mongodb]`).

- **Workflow frontmatter** — landing-page, web-app, dashboard, report,
  presentation, and app-with-data now carry expanded `when:` intent triggers plus
  canonical `needs:` / `deploy:` / `editions:` / `capabilities_note:` metadata.
  Static workflows declare `needs: none`, `deploy: inspiration`, `editions: all`;
  app-with-data declares `needs: database`, `deploy: runtime`, `editions: local`.
- **Reference `cloudgrid.yaml` per template** — each static template dir
  (landing-page, web-app, dashboard, report, deck) gains a reference
  `cloudgrid.yaml` (`type: static`) with a header comment noting it deploys as an
  inspiration via `gridctl_drop` and the yaml is only for owning it as a static
  runtime; plus an `index.md` sidecar. `gridctl_fetch("template", …)` still
  returns the fillable HTML (index.html wins), so the instant-inspiration path is
  unchanged. app-with-data's yaml adds a COMMENTED canonical `needs: {database:
  true}` block above the still-active `requires: [mongodb]` (the two cannot both
  be active — the validator rejects it; `requires:` is the only thing that
  injects `MONGODB_URL` today, per #1527).
- **Capability map** — new `src/corpus/capability-map.md`, fetchable via
  `gridctl_fetch("doc", "capability-map")`: an intent→template→needs→deploy→edition
  table plus the full `needs:` vocabulary (all 9 + the cron service type) with
  today-vs-pending-#1527 injection status.
- **Playbook** — `gridctl_start` gains a rule pointing at the capability-map and
  the workflow `when:` triggers for choosing what to build.
- **Tests** — new `test:self-describing` guards the enriched frontmatter fields,
  the capability-map fetch, the static reference yamls, and that NO template
  `cloudgrid.yaml` has an active `needs:` AND `requires:` together (only a
  commented `needs:` alongside active `requires:` is allowed).

## 0.10.0

Removed the deprecated `cloudgrid_*` tool aliases — tools are `gridctl_*` only.
Halves the connector tool list and de-duplicates the permission UI (every tool
previously showed twice in Claude's connector UI: `Cloudgrid drop` + `Gridctl
drop`, etc.). Clients enumerate tools dynamically, so nothing that discovers
tools breaks; only hard-coded `cloudgrid_*` tool references need to switch to
`gridctl_*`.

- **Registration** — `registerTools` no longer derives a `cloudgrid_*` alias for
  each `gridctl_*` tool. The `aliasOf` helper and the second `registerTool` /
  `server.tool` call are gone; `reg` and `regTool` now register each tool under
  its `gridctl_*` name only. Every `gridctl_*` tool and handler is unchanged.
  Local edition advertises 35 tools (was 68); web edition advertises 12 (was 18).
- **Docs / corpus** — switched the remaining hard-coded `cloudgrid_*` MCP-tool
  references (README, REMOTE, `src/corpus/**`, the `org-picker` widget's live
  `callTool`, and the `CLI_TOOL_VERBS` drift-guard labels) to `gridctl_*`. CLI
  commands (`cloudgrid init`, `cloudgrid logs`, …) are unchanged — those are the
  CLI, not MCP tool names.
- **Tests** — smoke/smoke-web/source-fetch now assert the aliases are ABSENT and
  guard that no advertised tool name (and no registered handler) starts with
  `cloudgrid_`. The docs-edition rename aliases (`search_cloudgrid_documentation`,
  `cloudgrid_quickstart_guide`) are a separate mechanism and are untouched.

## 0.9.1

fix: app-with-data template deploys correctly — services/<name>/ layout, lazy DB
client, requires: (not needs:) for DB injection; verified live end-to-end.

The 0.9.0 `app-with-data` template did not deploy. A real end-to-end deploy
(Next.js + Mongo → a live grid) surfaced three defects; the corrected shape was
then verified live (data persists across independent requests). See analysis
`37-user-case-support-analysis.md`.

- **Service layout** — the template app now lives under `services/web/`
  (`services/web/app/`, `services/web/lib/`, `services/web/package.json`) instead
  of the corpus-template root. `path:` in `cloudgrid.yaml` is the URL mount, not
  the filesystem path: a service named `web` makes the CLI look for
  `services/web/`; app files at the root fail with `Error: Service directory not
  found: …/services/web`. Import paths are unchanged (the whole app moved
  together). The example dir mirrors the same layout.
- **Lazy DB client** — `services/web/lib/db.js` now reads `process.env.MONGODB_URL`
  lazily inside `getDb`, never at module top level. A top-level read + throw
  fails `next build`, which imports the module for route analysis before the grid
  injects the var. Moving the check into the getter lets the build pass.
- **`requires:` (not `needs:`)** — `cloudgrid.yaml` keeps `requires: [mongodb]`
  with an explanatory comment. The CLI warns `requires:` is deprecated, but the
  deployer currently only injects `MONGODB_URL` from `requires:`; migrating to
  `needs:` builds fine but injects NO DB connection (every request 500s). This is
  a platform bug (flagged to Gilad); the template stays on `requires:` until the
  deployer honors `needs:`.
- Regenerated the template and example `index.md` fetch-bundles to describe the
  corrected `services/web/` tree, the lazy client, and the requires-not-needs
  note. Updated the `app-with-data` workflow and `persistent-apps`
  troubleshooting docs accordingly. Extended the app-with-data test to assert the
  new service paths, that `cloudgrid.yaml` has `requires:` and not `needs:`, and
  that `db.js` has no module-top-level `process.env.MONGODB_URL` read.

## 0.9.0

New capability: the **app-with-data** golden path — the first runtime
(DB-backed) build workflow in the corpus. Case 2 ("build me a to-do list / a
dashboard that saves data / a form that stores submissions") previously produced
only a static, in-memory page that lost all data on refresh. This ships the
missing path to a **real persistent app**: a Next.js + grid-shared Mongo
runtime. See the support analysis (`37-user-case-support-analysis.md`).

- **New workflow `app-with-data`** (`src/corpus/workflows/app-with-data.md`).
  Fires on persistence intent (saves/persists data, shared state, accounts,
  stored submissions, needs a backend/API/database). Edition-gate FIRST: a
  runtime app needs the LOCAL edition / CLI; hosted is inline-only and is told so
  and offered a static version. Then: auth + grid → `init` (nextjs) →
  `requires: [mongodb]` → fetch template + wire `process.env.MONGODB_URL` →
  optional `grid dev` → deploy `plug` (ASYNC — poll to a live URL) → return the
  live URL and iterate on the same entity.
- **New template `templates/app-with-data/`** — a minimal but real, deployable
  Next.js App Router + `mongodb` driver to-do app: `cloudgrid.yaml`
  (`requires: [mongodb]`), `package.json` (next/react/mongodb only), `lib/db.js`
  (cached client from `process.env.MONGODB_URL` with a clear unset guard),
  `app/api/todos/route.js` (GET/POST/DELETE on a `todos` collection), a page +
  client form, and a README. No secret or connection string is embedded.
- **New example `examples/app-with-data/`** — a richer filled reference (a
  persistent "Team Task Board" with assignee/status and a PATCH move endpoint).
- **New troubleshooting note `troubleshooting/persistent-apps.md`** — data
  doesn't persist, `MONGODB_URL` undefined, async deploy seems stuck, and the
  hosted-edition gate.
- **PLAYBOOK persistence rule (11).** If the user needs to save data / share
  state / log in / store submissions, that's a runtime app-with-data, not a
  static page; local edition only.
- No new tools or CLI verbs — the runtime path uses the already-wrapped
  init/env/secrets/plug/status verbs. `readEntryDir` now prefers `index.md` so a
  multi-file template/example directory resolves deterministically via
  `gridctl_fetch`.

## 0.8.4

Robust content handling for `gridctl_drop`/`cloudgrid_drop`: stop silently
publishing empty/garbage drops. Fixes the real repro where a heavy persona-deck
(~535KB with embedded base64 photos) was base64-encoded by the agent and passed
as `html`; `runDrop` wrapped the base64 blob in an HTML shell and published a
wall of text (an empty-looking page) while reporting SUCCESS.

- **Base64-of-HTML decode (both routes).** New `decodeIfBase64Html` helper: a
  strict-base64 blob (whitespace-stripped, length divisible by 4, ≥64 chars,
  `[A-Za-z0-9+/]` + up to two `=`) that DECODES to full HTML is published as the
  real HTML. Applied to the inline `html` string and to bytes read via `path`
  (a base64 `.txt` file), so both resolve to a real page instead of text.
- **Refuse garbage instead of wrapping it.** After the base64 attempt, content
  that still isn't full HTML is only wrapped when it's a small (≤8KB) genuine
  snippet/fragment (existing "share this snippet" behavior preserved). A large
  blob, undecodable base64, or a bare file path now throws an actionable error
  naming the case — no silent publish.
- **`@`-prefixed / mistaken-path inputs.** A leading `@` on `html` is stripped;
  a path-looking `html` in the local edition is read from disk when the file
  exists (clear error naming the resolved path when it doesn't). On the hosted
  server a path-looking `html` errors, steering to raw inline HTML.
- **Correct `path` content-type.** The `path` route now serves HTML as
  `text/html` (sniffed from the bytes or a `.html`/`.htm` filename) instead of
  always `application/octet-stream`, so an HTML upload renders as a page rather
  than downloading as a blob. A `.txt` that decodes to HTML uploads as
  `index.html`.
- **Auth-aware inline size cap.** The 2MB cap now applies only to anonymous
  inline drops; signed-in inline drops get `AUTHED_HTML_MAX_BYTES` (25MB,
  conservative — kept ≤ the server's single-artifact limit, `TODO(platform-confirm)`).
  The check is relocated to after auth is resolved. `path` (read from disk) is
  uncapped.
- **Guidance.** `gridctl_drop`/`gridctl_plug` descriptions and the `path`/`html`
  input schemas now steer heavy/local files to `path` (never base64, never an
  `@`-prefixed path or a file path as `html`, no `artifact_files` parameter). A
  new playbook rule tells agents to prefer `path` for heavy/local files and to
  use `gridctl_source` to inspect a drop that looks empty.

## 0.8.3

Added `gridctl_source`/`cloudgrid_source`: fetch a drop's current HTML inline so
agents can edit and re-plug in place (fixes the ChatGPT "change the color"
dead-end where the agent had lost the HTML).

- **New tool `gridctl_source` (+ deprecated `cloudgrid_source` alias), both
  editions.** Retrieves the current deployed HTML of an inspiration/drop inline
  as text. Inputs (all optional): `entity_id`, `url`, `grid`+`slug`. Resolution
  order for the fetch URL: explicit `url` → session `lastDrop.url` → composed
  `grid`+`slug` → graceful fail. SSRF-guarded to `https://*.cloudgrid.io` (a
  non-matching host — including a redirect off CloudGrid — is refused, no fetch
  performed), 15s timeout, 1.5MB size cap (`truncated:true` past the cap), and a
  graceful fail on a non-200 (expired/private/claimed). Read-only; creates
  nothing. For multi-file/runtime deploys it points the agent at
  `gridctl_download` (tarball) instead.
- **Playbook rule.** `gridctl_start` now instructs agents: to modify an existing
  drop when the HTML isn't in context, call `gridctl_source` first, edit, then
  re-plug with `target_entity_id` to update the same URL — never ask the user to
  paste the HTML back.
- **Drop/plug guidance.** `gridctl_drop`/`gridctl_plug` descriptions now note
  that if you want to edit an existing drop but no longer have its HTML, call
  `gridctl_source` first, then re-plug with `target_entity_id`.

## 0.8.2

Align `gridctl_report` with the existing CLI error reporter, and attribute every
report's origin (where it came from, which agent, which platform). 0.8.1 posted
to the wrong endpoint (`/errors/feedback` — that's user feedback); this fixes it
to match the CLI and adds source attribution so CLI + MCP reports land uniformly.

- **Repointed to `POST /api/v2/errors`** (was `/errors/feedback`) with the CLI
  reporter's payload shape: `{ type:"error", category, app, message, stack?,
  context, trace_id?, failed_step?, http_status?, cli_version, node_version,
  platform }`. `platform` is now `` `${process.platform} ${process.arch}` `` (e.g.
  `darwin arm64`), matching the CLI. New optional tool inputs `category`,
  `trace_id`, `failed_step`, `http_status` let the agent forward the diagnostics
  from the failed result; `category` defaults to `"mcp"`.
- **Source attribution.** Every report now says WHERE it came from — sent BOTH as
  top-level fields AND mirrored in `context.origin` (belt-and-suspenders: the
  `POST /errors` handler drops unknown top-level keys, but stores + secret-strips
  `context`, so `context.origin` is the durable carrier):
  - `source`: `"mcp-stdio"` (local edition) | `"mcp-hosted"` (web edition).
  - `client`: the calling agent (name + version) from the MCP `clientInfo`
    captured at initialize (e.g. `claude-code`, `ChatGPT`, `cursor`), or
    `"unknown"` if unavailable.
  - `platform`: `` `${process.platform} ${process.arch}` ``.
  - `mcp_version`: this server's version (the CLI's `cli_version` analog; top-level
    `cli_version` stays `null` for MCP-originated reports).

  Example origin: `mcp-hosted · ChatGPT · darwin arm64 · mcp 0.8.2`.
- **`clientInfo` captured at initialize (both editions).** `server.server.oninitialized`
  stashes `server.server.getClientVersion()` (the SDK-parsed initialize
  `clientInfo`) into the session context, so `gridctl_report` can attribute it.
  Never fatal — a missing client falls back to `"unknown"`.
- **Honors `CLOUDGRID_TELEMETRY=off`** (matches the CLI reporter). When set,
  `gridctl_report` returns "reporting disabled" and does not POST. Consent is
  still required regardless.
- Bearer (signed-in) / trusted-server (anon web) auth and client-side secret
  scrubbing are unchanged.

## 0.8.1

Consent-gated error reporting. When a CloudGrid call fails in a way that looks
like a genuine bug, the agent can OFFER to report it to the CloudGrid team — and
only sends anything after the user's explicit yes. Privacy is the default: the
error + failed-request context by default, never the whole conversation unless
the user agrees.

- **New `gridctl_report` tool (both editions).** Inputs: `message` (required —
  the short "what failed" summary), `context` (`tool`, `inputs`, `grid`,
  `original_request`, `error_code`, `error_detail`), and `include_conversation`
  (default **false**; the agent sets it true only on an explicit user yes). Posts
  `{app:"mcp", message, context, node_version, platform}` to
  `POST /api/v2/errors/feedback`. Signed-in → `Authorization: Bearer`; anon on the
  web edition → the trusted-server headers (works once the endpoint accepts them;
  until then a 401 degrades to a friendly "sign in to report"). Obvious
  secret-looking values in `context` are scrubbed client-side (defense-in-depth
  on top of the server's redaction). Never throws — success / 429 / 401 / error
  all return friendly text.
- **`errorGuidance` report offer for genuine bugs only.** A 5xx, `INTERNAL_ERROR`,
  or a build/deploy failure now appends a consent affordance that tells the agent
  to ASK the user first, then call `gridctl_report`, and never send the full
  conversation without an explicit yes. EXPECTED conditions — 429 rate-limit, the
  `needs_grid` picker, 401 sign-in prompts, 409 `EDIT_REJECTED`, 403 — do NOT get
  the offer (they aren't bugs), and unknown 4xx codes still pass through unchanged.
- **Playbook consent rule.** `gridctl_start` now serves a rule: when a build/deploy
  fails unexpectedly, offer to report it only with explicit consent, send just the
  error + failed request by default, and never send the whole conversation unless
  the user agrees.

## 0.8.0

Alignment with the platform org→grid rollout and CLI 0.12. No user-facing
behaviour change — the org→grid migration is dual-live and every alias is still
honored; this release moves the MCP to the grid-native surface ahead of the
(undated, post-soak) alias sunset and stops new stderr deprecation noise.

- **CLI pin `~0.10.1` → `~0.12`.** `MIN_CLI_VERSION`, the lazy-npx `CLI_NPX_PKG`,
  the `.mcpb` bundle install (`scripts/build-mcpb.mjs`), and the drift-guard pin
  (`test/drift-guard.mjs`) all move to CLI 0.12. The drift guard confirms every
  wrapped verb and subcommand still resolves against 0.12; no `--json`
  output-shape changed, so no parsing changed.
- **Grid-native request header.** Direct-API calls now send `X-CloudGrid-Grid`
  alongside `X-CloudGrid-Org` with the **same** slug value (never conflicting —
  differing values would 400 `GRID_HEADER_CONFLICT`). The `-Org` alias is kept in
  parallel for the soak.
- **Wrapped CLI flags `--org` → `--grid`.** The `init`, `feedback`, and `pickup`
  builders now pass `--grid` (CLI 0.12 dropped `--org` on these verbs). `get`
  already used `--grid`. Stops the per-call deprecation note leaking into wrapped
  output.
- **Internal org→grid rename.** `fetchUserOrgs` now reads `data.grids`
  (dual-emitted, same array as `data.orgs`, with `data.orgs`/bare-array fallback);
  `getActiveOrg`→`getActiveGrid`, `readActiveOrgSlug`→`readActiveGridSlug` (parses
  `active_grid_slug` with `active_org_slug` fallback), `ORG_PICKER_*`→
  `GRID_PICKER_*` JS constants. The `needs_org`/`orgs` structured alias fields and
  the org-picker widget's `orgs` read are **kept** (the web card depends on them).
  The picker resource URI/name/filename are unchanged (stable web-card contract).
- **Self-heal stays dormant on the happy path.** `SCOPE_INVALID` is durably fixed
  server-side, so a normal signed-in create no longer trips the `plugViaCliFallback`
  rung. The rung is kept as belt-and-suspenders; a new test asserts a clean authed
  create (201) succeeds **without** invoking the CLI fallback.
- **Doc note.** `GRID_AUTH_STALE` (strict-OIDC / org-owned grids) is out of scope —
  the MCP does not target such grids; a `GRID_AUTH_STALE` response should point the
  user at Console SSO.

## 0.7.3

Grid-picker parity: a signed-in user with more than one grid is now ASKED which
grid to publish to on **every create** — for `gridctl_plug` too, not just
`gridctl_drop`. Previously `gridctl_plug` silently defaulted to the active grid.
The ask is stateless (per-call, no session memory), matching drop.

- **Shared helper `resolveGridOrAsk(ctx, {token, suppliedGrid, edition})`.** The
  stateless grid-disambiguation that lived inline in the `gridctl_drop` handler
  is extracted into one exported helper that both publish verbs call, so they
  can't drift again. It returns `{proceed, grid}`, a `{picker}` result, or a
  `{single}` decision (the caller decides how to treat a not-ready single grid —
  drop blocks, plug warns). Sorts active-grid-first then ready-first; flags "not
  set up yet". `gridctl_drop` behavior is unchanged.
- **`gridctl_plug` now asks.** For authed **creates only** (no `target_entity_id`,
  not `anon`) with no valid grid and more than one grid → returns the picker
  instead of silently defaulting to the active grid. Explicit valid grid →
  proceeds. Single grid → proceeds (warns if it isn't set up yet). Anonymous →
  proceeds (Guest Grid). **Edits (`target_entity_id`) never ask** — the grid is
  fixed by the entity, and the grid list isn't even fetched.
- **Grid naming (org→grid rename).** User-facing text now says "grid" ("Which
  grid should this be published to?" / "Pass the grid slug in the `grid`
  parameter."). The structured payload carries `needs_grid` + `grids[]`, and
  KEEPS `needs_org` + `orgs[]` as aliases so the existing org-picker web widget
  keeps rendering. `gridctl_drop` now accepts a `grid` param alongside the still-
  working `org` alias. The picker widget labels read "grid".
- **Playbook rule** (served by `gridctl_start`): "When signed in and the user has
  more than one grid, do not assume a target — the publish tools will ask; relay
  the choice to the user and pass the chosen grid."
- **Test** `test/grid-picker.test.mjs` (offline, drives the real tool handlers)
  covers all six cases: plug multi-grid create asks; explicit grid proceeds; edit
  does NOT ask; single/anon proceed; drop still asks and its `org` alias works.

## 0.7.2

Self-healing: when the platform's `/plug` create branch trips the known
`400 SCOPE_INVALID (scope=personal, visibility=grid)` bug on a signed-in
create, the MCP no longer flails (retrying permutations, falling back to
anonymous and burning the daily anon cap into a 429 login-loop). It now
recovers or steers the agent instead.

- **Smart error guidance** on the direct-API create paths (`runDrop` and the
  `gridctl_plug` handler). A small, exported pure mapper (`errorGuidance`)
  appends actionable agent-facing next steps to a **known** set of failures —
  and only those; unknown errors pass through UNCHANGED (no blanket
  rewriting):
  - `400 SCOPE_INVALID` → names the known platform issue. Local edition:
    "Falling back to the bundled CloudGrid CLI…". Web edition: "Re-plug of an
    existing entity still works; creating new entities is temporarily affected
    — do NOT retry with other parameters and do NOT fall back to anonymous."
  - `429` (anon cap) → keeps the server text and appends "Do not retry today
    and do not treat this as a sign-in problem. If the user is signed in, use
    the signed-in path instead of anonymous."
  - `409` edit-rejected / `401` on edits → concise next-step guidance.
- **Local-edition CLI self-heal rung.** In the LOCAL edition only, a signed-in
  CREATE (never an edit, never anonymous) that fails with `400 SCOPE_INVALID`
  is transparently retried through the bundled CloudGrid CLI (whose wire is
  unaffected): the in-memory artifacts are written to a temp dir
  (`fs.mkdtemp` under `os.tmpdir`), `plug <dir> --no-clipboard --no-notify`
  runs via the existing Electron-safe `runCloudgrid()`, the live URL is parsed
  from stdout and returned as a normal success (noting the CLI recovery), and
  the temp dir is always cleaned up.
- **Playbook rule.** `gridctl_start` now serves an explicit operating rule: "If
  a signed-in publish fails with a server error, do not fall back to anonymous
  publishing (it burns the anonymous quota and downgrades ownership); surface
  the error, use the CLI fallback if offered, or ask the user."
- **Corpus pipeline** now serves the rules/troubleshooting docs Task 31 adds:
  `scripts/snapshot-corpus.mjs` also recursively snapshots `rules/` and
  `troubleshooting/` from `../skills` (missing dirs tolerated — the skills PR
  may not be merged yet; the manager re-snapshots at integration), and
  `gridctl_fetch`'s KIND→dir map resolves `kind:"rule"` → `rules/` and
  `kind:"troubleshooting"` → `troubleshooting/` (both added to the tool's
  `kind` enum).

## 0.7.1

Fixes every CLI-wrapping tool failing (or hanging) in the Claude Desktop
`.mcpb` — and in any other Electron-based MCP host.

- **Electron-safe bundled-CLI spawning.** Claude Desktop runs the extension
  inside an Electron utility process, so `process.execPath` is the host's
  Electron helper binary, not Node. The bundled-CLI rung used to spawn it as if
  it were Node: on Claude Desktop the child died with FATAL "Unable to find
  helper app" (surfaced raw as the tool error), and on fuse-enabled Electron
  hosts it booted a GUI app that hung for the full 10-minute exec timeout and
  then reported a fake success. The rung now resolves a **verified Node
  runtime** first (`resolveNodeRuntime`): the real `execPath` when it *is*
  Node; otherwise a real Node binary probed from common install locations
  (PATH, `/usr/local/bin`, `/opt/homebrew/bin`, nvm/fnm/volta/MacPorts,
  `Program Files\nodejs`); otherwise `execPath` under `ELECTRON_RUN_AS_NODE=1`
  only after a quick probe proves the host's runAsNode fuse is enabled
  (Claude Desktop's is disabled — verified).
- **Every bundled-CLI spawn carries `env: { …process.env,
  ELECTRON_RUN_AS_NODE: "1" }`** (harmless under plain Node) and routes through
  the new `src/cli-shim.mjs`, which strips the variable again before the CLI
  runs (so it can't leak into e.g. a browser opened for `cloudgrid login`) and
  rewrites `argv` so commander parses identically under Electron-as-Node
  (where `process.versions.electron` is still set and commander would
  otherwise read the CLI entry path as the command: "unknown command
  '…/dist/index.js'") and plain Node.
- **Runtime boot failures fall through** to the global-CLI and npx rungs
  instead of killing the chain; genuine CLI errors still surface immediately
  (no double execution). When no Node runtime exists at all, the rung is
  skipped up front and the final error names the real cause ("No usable
  Node.js runtime found …") instead of leaking a raw Electron FATAL.
- **Fallback rungs work from GUI-launched hosts**: their PATH (a bare
  `/usr/bin:/bin:/usr/sbin:/sbin` in the utility process) is augmented with
  `/usr/local/bin`, `/opt/homebrew/bin`, `~/.volta/bin`, `~/.local/bin` so a
  globally installed `cloudgrid` or `npx` is actually found;
  `ELECTRON_RUN_AS_NODE` is stripped from their env.
- **Browser-open safety**: `tryOpenBrowser` strips `ELECTRON_RUN_AS_NODE` so an
  Electron-based browser can't boot as a headless Node process.
- Windows behavior is unchanged (`.cmd` shims still route through
  `cmd.exe /d /s /c`; the win-cli regression suite still passes).
- New regression suite `test/electron-spawn-env.test.mjs`
  (`npm run test:electron-env`, wired into CI): asserts the spawn env carries
  `ELECTRON_RUN_AS_NODE=1`, the shim routing, the fall-through/no-double-run
  semantics, Claude-Desktop-shaped runtime probing, the fake-success probe
  guard, and the shim's argv/env behavior end-to-end. Fails on the pre-fix
  code, passes on this one.

## 0.7.0

Adopts the **unified plug contract** (`POST /api/v2/plug`, MCP tool spec v2): same-URL in-place editing is back, on every surface.

- **`gridctl_plug` — the unified create/re-plug verb, now direct-API on BOTH
  editions** (it previously wrapped `cloudgrid plug`; the hosted edition had no
  create verb at all). Inputs per spec v2 §3: `path` (local: file or folder,
  honoring `.gitignore`/`.cloudgridignore`) XOR `artifact_files` (hosted:
  inline `{path, content, encoding}` entries), plus `cloudgrid_yaml`,
  `target_entity_id`, `grid` (create-only), `hints.kind`/`hints.yaml`, `anon`,
  and `owner_token` (spec omits it from both blocks — a spec bug; without it an
  anonymous caller cannot re-plug. Flagged upstream, included here). Output:
  `{entity_id, slug, grid, url, poll_url, status, claim_url?, claim_message?,
  owner_token?}` — `entity_id` + `url` are the durable re-plug handle.
  In-place re-plug covers **inspirations**; a deployed app/agent rebuild still
  goes through the CLI (`cloudgrid plug` in the linked folder) — the
  per-service-tarball update wire is a follow-up.
- **`gridctl_drop` re-drops update the same entity in place** — same link, new
  content, expiry reset. The session's drop is targeted by default; `fresh:
  true` forces a new entity (a real create again, not a no-op); an explicit
  `entity_id` targets any earlier drop. A rejected edit (409 `EDIT_REJECTED`,
  401 bad owner token) surfaces clearly and NEVER silently creates.
- **Anonymous owner token (anon owner-token contract).** An anon create returns
  `owner_token` — the bearer capability for BOTH later anonymous re-plug and
  claim. It is re-minted on every anonymous edit (expiry tracks the drop);
  the MCP replaces the stored one, feeds `gridctl_claim` from it, and returns
  `{entity_id, owner_token}` so hosted/stateless callers can re-plug in later
  sessions. An anon-minted drop is edited via the owner-token wire even when
  the caller is signed in (the entity lives in the Guest Grid until claimed).
- **Server-composed `url` consumed everywhere** (create + edit, anon + authed) —
  flat-arch-aware. Client-side composition (`composePlugUrl`) is demoted to a
  fallback used only when the server left `url` empty.
- **New direct-API verbs `gridctl_fork` + `gridctl_download`** (spec v2 §5–6):
  `POST /api/v2/runtimes/:id/fork` and `GET /api/v2/runtimes/:id/source`
  (signed 15-minute bundle URLs). Authed-only, both editions.
- **Stale copy fixed**: "every drop creates a fresh entity", "no in-place
  redrop", "authed 30-day expiry" were all false post-contract — descriptions
  now state the single cockpit expiry (default 7 days, reset on edit) and the
  in-place semantics.
- Trusted-server headers now ride anonymous EDITS too (anon edits consume the
  same daily anon cap, re-keyed per end user); `upgradeVisibilityToLink` stays
  (create-only — an edit keeps the entity's visibility).
- New offline wire-contract test (`npm run test:plug-wire`, in CI) pinning the
  target/owner-token/yaml-part semantics against a mocked API.

## 0.6.0

- **Agent Core — orientation + on-demand loading.** Two new tools on the authed
  editions (local + web; not the anon docs edition):
  - `gridctl_start` → returns the CloudGrid playbook (operating rules + golden
    path), the workflow index (`presentation`, …), and live `context`
    (`active_grid`, `signed_in`). The "orient once" entry point.
  - `gridctl_fetch({kind, name})` → deterministic retrieval of a
    workflow/template/example/rule/doc from the bundled corpus (complements the
    fuzzy `gridctl_search_docs`). `kind ∈ workflow|template|example|rule|doc`.
- **Corpus pipeline.** `scripts/snapshot-corpus.mjs` now directory-walks
  `workflows/`, `templates/`, and `examples/` from the skills repo (in addition
  to the hardcoded doc list); missing directories are tolerated. The `.mcpb`
  build now bundles `src/corpus/` so `gridctl_fetch` works offline.
- **Naming cleanup — `cloudgrid_*` → `gridctl_*` (alias-migrated).** Every tool
  is registered under its new `gridctl_*` name and keeps its legacy
  `cloudgrid_*` name as a **deprecated alias** (same handler) for the migration.
  Docs edition: `search_cloudgrid_documentation` → `gridctl_search_docs`,
  `cloudgrid_quickstart_guide` → `gridctl_quickstart` (aliases retained).
  In-description cross-references updated to the `gridctl_*` names.
- Aligned the `.mcpb` bundled-CLI pin `^0.9.20` → `~0.10.1`.

## 0.5.0

- Added **docs edition** — a public, no-auth, read-only MCP server exposing
  `search_cloudgrid_documentation` and `cloudgrid_quickstart_guide` over
  MCP Streamable HTTP. Safe to expose anonymously (no drop/deploy/secrets
  tools).
- BM25 keyword search over the bundled documentation corpus (15 markdown
  files, ~122 chunks). The search interface is behind a clean seam so the
  backend can be upgraded to semantic/embedding search later.
- Corpus: skills repo markdown (USAGE.md, INSTALL.md, COOKBOOK.md, the nine
  SKILL.md files, README, INSTALL_FOR_AGENTS) + CLI reference. Snapshot at
  build time via `npm run snapshot:corpus`.
- Draft Kubernetes deployment manifest (`k8s/docs-mcp-deployment.yaml`) —
  single replica, read-only, healthz. Not yet applied.
- New scripts: `start:docs`, `smoke:docs`, `snapshot:corpus`.
- The same Docker image serves all three editions; the docs edition starts
  with `node src/docs.js`.

## 0.4.3

- Added `cwd` parameter to directory-sensitive CLI-wrapping tools
  (`cloudgrid_init`, `cloudgrid_plug`, `cloudgrid_env`, `cloudgrid_secrets`,
  `cloudgrid_scaffold`). The parameter sets the working directory for the
  underlying CLI process, so MCP clients can target a specific project
  directory instead of relying on the server's own CWD. Defaults to the
  server's `process.cwd()` when omitted (preserves existing behaviour; in
  Claude Code / Cursor that is the project root). The path is validated —
  a clear error is returned if the directory does not exist.
- Made `cloudgrid_plug` non-interactive by always passing `--auto`. In a
  fresh (unlinked) directory the CLI's framework-detection prompt would
  block indefinitely under MCP because stdin is not a TTY. `--auto` tells
  the CLI to detect and configure the framework without prompting.
- Set `stdin: 'ignore'` on all CLI subprocess spawns (`runCloudgrid`) so
  any unexpected prompt from the CLI fails fast instead of hanging to the
  10-minute timeout.
- Fixed `cloudgrid_env` arg builder: `set` now sends `KEY=VALUE` as a
  single arg (was split), and `get` now sends `<key> <name>` in the
  correct positional order.
- Made `cloudgrid_unplug` pass `--skip-confirm` and `cloudgrid_delete`
  pass `--yes`, so the CLI's confirmation prompts don't block with
  stdin ignored. Both tools already enforce `confirm: true` at the
  MCP schema level.
- No CLI change was needed — the existing `--auto` flag covers the prompt.
- No changes to the web-edition toolset, org-disambiguation logic, or
  name/org-targeted tools (whoami, status, grid, etc.).

## 0.4.2

- Made org disambiguation fully stateless in the web-edition
  `cloudgrid_drop`. The per-session `awaitingOrgPick` flag has been
  removed — org selection now relies solely on the current call's
  parameters. A supplied org that matches a real org slug publishes
  immediately; no valid org with multiple orgs returns the picker once;
  a single-org user publishes silently. This fixes an infinite
  "needs_org" loop when the client reconnects on every tool call
  (ChatGPT Apps SDK behaviour), since the flag would reset each time.
- Removed `awaitingOrgPick` from the web session state initialiser
  (no longer needed).
- No changes to local-edition tools, anonymous drops, or any other
  web-edition behaviour.

## 0.4.1

- Made `cloudgrid_drop` input schema edition-aware. The web edition no
  longer exposes the `path` parameter (the hosted server cannot read
  local files). The `html` parameter description is strengthened to
  instruct the model to paste the complete HTML document inline, with
  all CSS/JS included so it runs standalone. The local edition retains
  both `path` and `html` unchanged.
- Added a defensive guard: if a web-edition drop receives a `path`
  parameter despite its absence from the schema (e.g. from a cached
  tool description), the tool returns a clear error directing the model
  to use `html` instead.
- Fixed org picker being skipped when ChatGPT auto-guessed a valid org
  slug. The web-edition drop now uses per-session state
  (`awaitingOrgPick`) to ensure the org picker is always shown on the
  first drop when the user has multiple orgs, regardless of any
  model-supplied org. Only after the picker has been presented and the
  re-call supplies a valid slug is the org honored. Single-org users
  continue to publish without a prompt.
- Removed the `path` passthrough from the org-picker widget (web edition
  only; `path` is no longer a valid web-edition parameter).

## 0.4.0

- Added ChatGPT Apps SDK UI widgets (web edition, Task 12 Part B). Two
  MCP resource templates are registered as `text/html;profile=mcp-app`
  components, rendered deterministically in ChatGPT instead of
  paraphrased text:
  - **Live-result card** (`ui://cloudgrid/live-result.html`): shown
    after a successful drop. Displays the live URL (Open button), a
    link to the console grid, and a visibility picker with buttons
    for each access level. Changing visibility calls
    `cloudgrid_visibility` via the `window.openai.callTool` bridge.
  - **Org-picker card** (`ui://cloudgrid/org-picker.html`): shown
    when the user has multiple orgs and needs to choose. Buttons for
    each org re-invoke `cloudgrid_drop` with the selected org slug
    via the bridge.
- The `cloudgrid_drop` tool descriptor now carries
  `_meta.ui.resourceUri` and `"openai/outputTemplate"` (web edition
  only) so ChatGPT renders the live-result card by default. The
  `needs_org` result overrides to the org-picker card via per-result
  `_meta["openai/outputTemplate"]`.
- CSP metadata allows `*.cloudgrid.io` for connect and resource
  domains.
- All existing text `content` fallbacks are preserved unchanged.
  Clients that do not support the Apps SDK (Claude, MCP Inspector,
  any non-ChatGPT host) continue to work with text responses.
- No changes to tool input/output schemas, local-edition tools, or
  the anonymous/connected endpoint behavior.

## 0.3.4

- Fixed default visibility for authenticated web-edition drops: after a
  successful drop, the tool now PATCHes visibility to `link` ("Anyone with
  the link") so the published URL is shareable and the console preview
  renders without a sign-in wall. The post-drop message offers to restrict
  access (private / org) via `cloudgrid_visibility`.
- Fixed org disambiguation not firing when the user has multiple orgs: the
  tool now always validates the `org` parameter against the user's real org
  list from `GET /api/v2/orgs`. If the LLM supplies a guessed slug that
  does not match a real org, it is ignored and the tool asks which org to
  use. Previously, any non-empty `org` value skipped disambiguation.
- Updated the `org` parameter description on `cloudgrid_drop` to instruct
  the model to leave it unset and let the tool handle org selection.
- No changes to local-edition tools or behavior.

## 0.3.3

- Enriched `cloudgrid_drop` success response in the web edition: "Your app
  is live" message with the console management link and a visibility offer
  stating the current access level and how to change it. `structuredContent`
  now includes `console_url`, `current_visibility`, and
  `visibility_options` (widget-ready shapes for a future Apps SDK card).
- Added org disambiguation to `cloudgrid_drop` (web edition): when the user
  has multiple orgs and no `org` parameter, the tool returns the org list
  so the LLM (or a future widget) can ask which one. With exactly one org
  it publishes there automatically.
- Added `cloudgrid_orgs` tool (web edition, read-only) to list the
  signed-in user's organizations with slug, name, and role. Uses the
  canonical `GET /api/v2/orgs` endpoint (JWT claims do not carry orgs).
- Added sign-in guidance to `cloudgrid_drop` (web edition): unauthenticated
  non-anonymous calls return a prompt with the `cloudgrid_login` URL
  instead of silently falling through to an anonymous drop.
- Updated `cloudgrid_visibility` description to clarify it can be used
  right after a drop with no target id.
- No changes to local-edition tools or behavior.

## 0.3.2

- Added `outputSchema` to the 5 web-edition tools (`cloudgrid_drop`,
  `cloudgrid_claim`, `cloudgrid_login`, `cloudgrid_login_status`,
  `cloudgrid_visibility`). Handlers now return `structuredContent`
  alongside the human-readable text `content`, so clients that support
  structured tool results (e.g. ChatGPT Apps SDK connectors) can consume
  typed JSON directly. Clients that ignore `structuredContent` continue
  to work unchanged.
- Migrated the 5 web-edition tool registrations from the deprecated
  `server.tool()` to `server.registerTool()`, which supports
  `outputSchema`.
- No changes to the local-only CLI-wrapping tools or to tool behavior.

## 0.3.1

- Fixed stale hardcoded version in MCP `serverInfo`. Both editions (local
  and web) now read `version` from `package.json` at startup, making
  `package.json` the single source of truth for `serverInfo.version`.

## 0.3.0

- Added 17 new tools to the local edition: `cloudgrid_whoami`,
  `cloudgrid_use`, `cloudgrid_logout`, `cloudgrid_status`, `cloudgrid_info`,
  `cloudgrid_builds`, `cloudgrid_grid`, `cloudgrid_rename`,
  `cloudgrid_unplug`, `cloudgrid_delete`, `cloudgrid_rollback`,
  `cloudgrid_versions`, `cloudgrid_env`, `cloudgrid_secrets`,
  `cloudgrid_scaffold`, `cloudgrid_doctor`, `cloudgrid_open`.
  All wrap the `cloudgrid` CLI via the existing `cliTool` helper and
  register in the local edition only (after the edition guard).
- Destructive tools (`cloudgrid_unplug`, `cloudgrid_delete`) require an
  explicit entity name and `confirm: true`.
- `cloudgrid_secrets` exposes `set` and `list` (names) only; never returns
  secret values.
- `cloudgrid_open` returns the URL without launching a browser.
- Added MCP tool annotations (`readOnlyHint`, `destructiveHint`,
  `openWorldHint`) to all 28 tools. Read-only tools (`feedback`, `whoami`,
  `status`, `info`, `builds`, `grid`, `versions`, `doctor`, `logs`, `open`)
  are annotated accordingly; `unplug`, `delete`, and `logout` are marked
  destructive.
- No changes to the web edition tool surface. The 5 direct-API tools
  (`drop`, `claim`, `login`, `login_status`, `visibility`) are unchanged
  beyond receiving annotations.

## 0.2.8

- Moved to dedicated `cloudgrid-io/mcp` repository (clean-start import from
  `cloudgrid-io/skills/mcp-server`).
- Added CI: secret scanning (gitleaks), internal-reference linter, license
  check, smoke test, Dependabot.
- Added release pipeline: `npm publish --provenance` on version tags via
  GitHub Actions.
- No changes to the tool surface or behavior. Backward-compatible.

## 0.2.7 and earlier

Published from `cloudgrid-io/skills`. See that repository for prior history.
