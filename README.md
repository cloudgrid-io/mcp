# @cloudgrid-io/mcp

An MCP server for CloudGrid. It exposes the CloudGrid actions as MCP tools.

It ships in two editions from one codebase:

- **Local (stdio)** — runs on your machine, full toolset including the CLI-wrapping
  tools. This README covers it. For Claude Code, Cursor, Claude Desktop.
- **Web (hosted HTTP)** — a lighter toolset (14 shared direct-API tools, no CLI
  wrappers) for web clients like claude.ai. See [REMOTE.md](REMOTE.md).

The local edition wraps the `grid` CLI for authenticated operations (the CLI
handles auth, org context, and error formatting) and calls the API directly for the
plug, login, and visibility tools.

## CLI compatibility

The MCP uses an installed CLI only when it meets the platform floor
(`MIN_CLI_VERSION`, currently 0.15.26 — kept in lockstep with the API's live
`cli_compat` floor, which rejects older CLIs with HTTP 426). Below the floor it
skips the local/global CLI and lazily fetches `@cloudgrid-io/cli@latest` via
npx instead. A CI drift guard (`npm run test:drift-guard`) asserts every
wrapped verb exists in the CLI help.

### `GRID_AUTH_STALE` is out of scope

Strict-OIDC (org-owned) grids can return `GRID_AUTH_STALE` when the caller's
session predates an SSO policy change. The MCP does not target such grids and
does not handle this code: if a `GRID_AUTH_STALE` response is ever seen, point
the user at Console SSO to re-authenticate — the MCP will not silently retry.

## Prerequisite

Install and log in to the CLI:

```
npm install -g @cloudgrid-io/cli
grid login
```

The server reads no credentials directly. It runs `grid`, which uses its own
stored credentials at `~/.cloudgrid/credentials`.

## Run

```
npx -y @cloudgrid-io/mcp
```

Or from a clone:

```
cd mcp
npm install
npm start
```

It speaks MCP over stdio. Point any MCP client at the `cloudgrid-mcp` command.

### One CloudGrid server per client

Run EITHER this local (stdio) server — standalone or via the Claude Code
plugin, which bundles it — OR a hosted connector (`mcp.cloudgrid.io` /
`mcp-connected.cloudgrid.io`) in a given client. Never both: each `grid_*`
tool appears twice, the two servers hold separate sign-in state (the local
edition shares the CLI's `~/.cloudgrid/credentials`; the connector holds an
OAuth session), and they can disagree about whether you are signed in — the
model may then act on whichever answered last. How to tell: duplicate
`grid_*` entries in the client's tool list, or two CloudGrid servers in its
MCP/connector settings. Which to keep: the local edition wherever you build
runtime apps from folders (it has `path` + the CLI); the connector in
chat-only clients where you publish single pages.

### QA session log (optional)

Set `CLOUDGRID_QA_SLACK_WEBHOOK` to an **internal / private** Slack incoming-webhook
URL to receive a per-session QA log (`log-<Client>-<transport>-mcp.txt`) when a
session goes live, fails, or is abandoned. The log carries the user's first
message (when the host forwards it) and identity details, so the target channel
MUST be internal. Unset → the feature is fully dark (nothing captured, nothing
posted). `CLOUDGRID_QA_IDLE_MS` overrides the abandoned-idle window (default
900000 = 15 min).

<!-- gen:tools -->
## Tools

36 tools registered (14 shared across both editions, 22 local-only). No deprecated aliases. MIN_CLI_VERSION: 0.15.26.

### Direct-API tools (both editions)

| Tool | Wraps | Summary |
|---|---|---|
| `grid_pickup` | API | Pick up an app: make your OWN COPY of any app you can see (like a git fork) into a grid you can build in. |
| `grid_pull` | API | Pull an app to continue/edit it IN PLACE — like `git clone` of the SAME entity: your next grid_plug (with its target_... |
| `grid_create_grid` | API | Create a new grid (workspace) for the signed-in user — they become its admin. |
| `grid_note` | API | Optionally leave a one-paragraph summary of what you built this session and why. |
| `grid_plug` | API | Plug an app, website, game, or single HTML page into CloudGrid — the live runtime that runs it and provides its infra... |
| `grid_get_app_source` | API | Retrieve the CURRENT deployed HTML of an inspiration/drop inline as text, so you can edit it and re-plug the SAME URL... |
| `grid_login` | API | Start a CLI-free CloudGrid sign-in. |
| `grid_login_status` | API | Finish a sign-in started by grid_login. |
| `grid_visibility` | API | Change who can see a CloudGrid inspiration OR runtime app/agent. |
| `grid_check_deploy` | API | Check whether an async runtime-app build has finished and the app is live. |
| `grid_list_grids` | API | List the signed-in user's grids, each with slug, name, role, and provisioning status. |
| `grid_start` | API | Orient before building with CloudGrid — the live runtime environment where the user's apps run WITH the infrastructur... |
| `grid_get_template` | corpus | Load a specific CloudGrid workflow, template, example, rule, or doc by name — deterministic retrieval from the bundle... |
| `grid_report` | API | Report a genuine CloudGrid failure to the CloudGrid team — ONLY with the user's explicit consent. |

The direct-API tools call the platform without the CLI, so they also work in
the web edition. `grid_login` writes the same `~/.cloudgrid/credentials` the
CLI uses, so the two share one identity.

### CLI-wrapping tools (local edition only)

| Tool | Wraps | Summary |
|---|---|---|
| `grid_create_project` | `grid new` | Scaffold a new CloudGrid app or agent folder (cloudgrid.yaml + a web service), optionally pre-declaring resources. |
| `grid_view_logs` | `grid logs` | Tail recent logs for an entity. |
| `grid_share` | `grid visibility set` | Set an entity's visibility and print its URL. |
| `grid_feedback` | `grid feedback list` | List recent feedback events for the active grid. |
| `grid_whoami` | `grid whoami` | Show the signed-in user and active grid. |
| `grid_switch_grid` | `grid use` | Switch the active grid. |
| `grid_logout` | `grid logout` | Sign out and clear local credentials. |
| `grid_status` | `grid status` | Grid dashboard, entity detail, or deploy snapshot. |
| `grid_info` | `grid info` | Show metadata for a CloudGrid entity. |
| `grid_get` | `grid get <grids|entities|spaces> --json` | List CloudGrid grids, entities, or spaces. |
| `grid_describe_grid` | `grid describe grid <slug> --json` | Show a grid's detail: role, members, spaces, tier, wildcard-TLS state. |
| `grid_edit_existing_app` | `grid pull` | Continue/edit an EXISTING entity locally: download its source + cloudgrid.yaml and link the folder so your next `grid... |
| `grid_rename` | `grid rename` | Rename a CloudGrid entity's display name (slug stays the same). |
| `grid_take_offline` | `grid unplug` | Take an entity off the grid. |
| `grid_delete` | `grid delete entity` | Archive a CloudGrid inspiration. |
| `grid_rollback_deploy` | `grid rollback` | Rollback an entity to a previous version. |
| `grid_list_versions` | `grid versions` | List published versions for an entity. |
| `grid_set_env` | `grid env` | Manage environment variables for an entity. |
| `grid_set_secret` | `grid secrets` | Set or list secret names for an entity. |
| `grid_scaffold` | `grid scaffold` | Scaffold service folders declared in cloudgrid.yaml (idempotent). |
| `grid_diagnose` | `grid doctor` | Run CloudGrid diagnostics on the local environment. |
| `grid_get_url` | `grid open --print` | Return the public URL for an entity. |

<!-- /gen:tools -->

`grid_share` and `grid_visibility` overlap on purpose: `grid_share`
wraps the CLI and defaults to `link`; `grid_visibility` is direct API, takes an
explicit scope, and defaults its target to the session's last drop — it is the one
the web edition gets.

All tools carry MCP annotations (`readOnlyHint`, `destructiveHint`,
`openWorldHint`) for clients that support them.

## Test

A smoke test spawns the server with a real MCP client, lists the tools, and calls
the read-only `grid_feedback` tool end to end:

```
cd mcp
npm install
npm run smoke
```

It needs a logged-in CLI on `$PATH`.

## Design

- Shells out with `execFile` and an argument array, so there is no shell and no
  injection surface.
- `grid_view_logs` never uses `--follow`; a streaming call would never return.
- Stateless. Each call is one CLI invocation.

## Privacy Policy

Full policy: <https://cloudgrid.io/privacy>

### What this MCP server does with your data

**Authentication.** `grid_login` opens a browser-based Google sign-in flow via
CloudGrid's API (`/auth/login`). The returned JWT is stored at
`~/.cloudgrid/credentials` with `0600` permissions — the CLI and the MCP share
one credential file by design (`auth.js:7-8`). The web edition holds the JWT in
memory only for the session duration.

**Deploying.** `grid_plug` uploads your app files (HTML, source, assets) to
`https://api.cloudgrid.io/api/v2/plug`. Before upload, inline sources are
scanned for known API-key patterns (OpenRouter, Anthropic, OpenAI, Google,
GitHub, AWS, Slack, Stripe); a match blocks the deploy. This is not a guarantee
— a determined model can obfuscate a key past the scan — but it stops the
good-faith "embed it so it works" path. Auth headers (Bearer JWT, grid slug) are
attached to identify the caller.

**Error reporting.** `grid_report` sends an error report to
`https://api.cloudgrid.io/api/v2/errors`. The tool description instructs the
model to call it only with the user's explicit consent, and setting
`CLOUDGRID_TELEMETRY=off` disables it unconditionally — but there is no
programmatic consent check in the report handler itself. The payload includes an
error summary, diagnostic metadata (platform, Node version, transport), and a
flag recording whether the user agreed to share the conversation
(`deploy.js:544`). The transcript itself is not sent by this tool. Secrets in
the report context are redacted client-side before sending.

**Version check.** At startup the local edition makes one request to
`https://registry.npmjs.org/@cloudgrid-io/mcp/latest` to detect a stale `.mcpb`
install, which never auto-updates. It sends no account data and no user content.
The hosted edition does not do this.

**QA session log.** When `CLOUDGRID_QA_SLACK_WEBHOOK` is set (unset by default,
fully dark otherwise), the server posts a per-session QA log to an internal
Slack channel on deploy, error, idle timeout, or process shutdown. The log
includes: session metadata (user ID, email, grid slug, client name), the user's
first message (scrubbed, capped at 2 000 chars), a per-tool-call trail with
allowlisted arg keys only, and an optional narrative set via `grid_note` or
`grid_plug`'s `session_note` (capped at 4 000 chars). The first message is
captured from two sources: the `CLOUDGRID_USER_REQUEST` environment variable
(forwarded by Claude Code) or `grid_plug`'s `user_request` argument
(model-as-courier). The hosted edition has only the second. Free-text values
(the first message, the narrative, tool arguments, and error messages) pass
through a scrubber that redacts JWTs, PEM keys, Bearer tokens, and known
provider API-key formats. Identity fields (`_keyResult` values and the header
block) and structured result data bypass the text scrubber.

**No other data collection by this server.** The server does not track usage
analytics or transmit data beyond the flows listed above and the authenticated
CloudGrid API calls the individual tools make (e.g. `/orgs`, `/grids`,
`/pickup`, `/deploys`, `/inspirations/{id}/source`). CLI-wrapping tools shell
out to the locally installed `grid` CLI, which shares the same
`~/.cloudgrid/credentials` file and does not send additional telemetry through
this server. Platform-level data handling is covered by the linked privacy
policy.
