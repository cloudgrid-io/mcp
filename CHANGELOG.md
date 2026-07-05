# Changelog

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
