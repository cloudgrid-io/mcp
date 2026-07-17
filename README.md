# @cloudgrid-io/mcp

An MCP server for CloudGrid. It exposes the CloudGrid actions as MCP tools.

It ships in two editions from one codebase:

- **Local (stdio)** — runs on your machine, full toolset including the CLI-wrapping
  tools. This README covers it. For Claude Code, Cursor, Claude Desktop.
- **Web (hosted HTTP)** — a light, CLI-free toolset (drop, claim, login,
  visibility) for web clients like claude.ai. See [REMOTE.md](REMOTE.md).

The local edition wraps the `grid` CLI for authenticated operations (the CLI
handles auth, org context, and error formatting) and calls the API directly for the
drop, claim, and login tools.

## CLI compatibility

The MCP uses an installed CLI only when it meets the platform floor
(`MIN_CLI_VERSION`, currently 0.15.2 - kept in lockstep with the API's live
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
cd mcp-server
npm install
npm start
```

It speaks MCP over stdio. Point any MCP client at the `cloudgrid-mcp` command.

### QA session log (optional)

Set `CLOUDGRID_QA_SLACK_WEBHOOK` to an **internal / private** Slack incoming-webhook
URL to receive a per-session QA log (`log-<Client>-<transport>-mcp.txt`) when a
session goes live, fails, or is abandoned. The log carries the user's first
message (when the host forwards it) and identity details, so the target channel
MUST be internal. Unset → the feature is fully dark (nothing captured, nothing
posted). `CLOUDGRID_QA_IDLE_MS` overrides the abandoned-idle window (default
900000 = 15 min).

## Tools

### Direct-API tools (both editions)

| Tool | Wraps | Notes |
|---|---|---|
| `grid_deploy` | `POST /api/v2/plug` | THE deploy/publish verb (CloudGrid calls it "plug"): create a new entity, or update the SAME entity in place with `target_entity_id` (same URL). Source via inline `html` (single page), local `path` (local edition), or inline `artifact_files` (both). Anonymous drops return an `entity_id` + `owner_token` re-plug/claim handle. |
| `grid_claim_anonymous_deploy` | `POST /api/v2/entities/:id/pickup` | Claim an anonymous drop into the signed-in account (the claim token IS the drop's owner token). |
| `grid_copy_app` | `POST /api/v2/runtimes/:id/fork` | Start a new entity from an existing runtime (lineage recorded). Needs sign-in. |
| `grid_download_source` | `GET /api/v2/runtimes/:id/source` | Signed 15-minute source-bundle URLs. Needs sign-in. |
| `grid_get_app_source` | `GET /api/v2/.../source` | Fetch a deployed entity's source (resolves entity_id from a URL). Read-only. |
| `grid_login` | `GET /auth/login` | Start a CLI-free sign-in; returns a URL to open. |
| `grid_login_status` | `GET /auth/status` | Finish the sign-in; saves the token to the shared CLI credentials. |
| `grid_set_sharing` | `PATCH /api/v2/inspirations/<id>` | Change who can see a drop (private, space, authenticated, org, link). Needs sign-in. |
| `grid_list_grids` | `GET /api/v2/orgs` | List the caller's grids. Read-only. |
| `grid_start` | corpus | Orientation: the playbook + workflow index + live context. Call FIRST. Read-only. |
| `grid_get_template` | corpus | Fetch a workflow / template / example / doc from the bundled corpus. Read-only. (`grid_fetch` is a kept deprecated alias.) |
| `grid_note` / `grid_report` / `grid_feedback` | API | Session notes, consent-gated error reports, feedback feed. |

The direct-API tools call the platform without the CLI, so they also work in
the web edition. `grid_login` writes the same `~/.cloudgrid/credentials` the
CLI uses, so the two share one identity.

### CLI-wrapping tools (local edition only)

| Tool | Wraps | Notes |
|---|---|---|
| `grid_create_project` | `grid init` | Register an app or agent; optionally seed a web service. |
| `grid_view_logs` | `grid logs` | Snapshot of recent logs. Does not stream. Read-only. (`grid_logs` is a kept deprecated alias.) |
| `grid_share` | `grid visibility set` | Set visibility, default link. |
| `grid_whoami` | `grid whoami` | Show the signed-in user and active grid. Read-only. |
| `grid_switch_grid` | `grid use` | Switch the active grid. |
| `grid_logout` | `grid logout` | Sign out and clear local credentials. Destructive. |
| `grid_status` | `grid status` | Grid dashboard or entity detail. Read-only. |
| `grid_info` | `grid info` | Entity metadata. Read-only. |
| `grid_get` | `grid get grids\|entities\|spaces` | List grids, entities, or spaces. Read-only. |
| `grid_describe_grid` | `grid describe grid <slug>` | Grid detail. Read-only. |
| `grid_edit_existing_app` | `grid pickup <name>` | Download an entity's source and bind the folder. |
| `grid_rename` | `grid rename` | Rename an entity's display name. |
| `grid_take_offline` | `grid unplug` | Take an entity off the grid. Destructive; requires confirm. |
| `grid_delete` | `grid delete entity` | Archive an inspiration. Destructive; requires confirm. |
| `grid_rollback_deploy` | `grid rollback` | Rollback to a previous version. |
| `grid_list_versions` | `grid versions` | List published versions. Read-only. |
| `grid_set_env` | `grid env` | Get, set, or list environment variables. |
| `grid_set_secret` | `grid secrets` | Set or list secret names. Never returns secret values. |
| `grid_scaffold` | `grid scaffold` | Generate starter files. |
| `grid_diagnose` | `grid doctor` | Run local diagnostics. Read-only. |
| `grid_get_url` | `grid open --print` | Return the public URL. Does not open a browser. Read-only. |

`grid_share` and `grid_set_sharing` overlap on purpose: `grid_share`
wraps the CLI and defaults to `link`; `grid_set_sharing` is direct API, takes an
explicit scope, and defaults its target to the session's last drop -- it is the one
the web edition gets.

37 tool names are advertised in total: 35 canonical + 2 kept deprecated
aliases (`grid_fetch`, `grid_logs`). The 0.20.8 alias diet dropped the other 16
legacy aliases. Per-tool internals (signature, sketch, behavior):
[docs/TOOL-INTERNALS.md](docs/TOOL-INTERNALS.md).

All tools carry MCP annotations (`readOnlyHint`, `destructiveHint`,
`openWorldHint`) for clients that support them.

## Test

A smoke test spawns the server with a real MCP client, lists the tools, and calls
the read-only `grid_feedback` tool end to end:

```
cd mcp-server
npm install
npm run smoke
```

It needs a logged-in CLI on `$PATH`.

## Design

- Shells out with `execFile` and an argument array, so there is no shell and no
  injection surface.
- `grid_logs` never uses `--follow`; a streaming call would never return.
- Stateless. Each call is one CLI invocation.
