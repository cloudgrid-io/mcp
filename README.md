# @cloudgrid-io/mcp

An MCP server for CloudGrid. It exposes the CloudGrid actions as MCP tools.

It ships in two editions from one codebase:

- **Local (stdio)** — runs on your machine, full toolset including the CLI-wrapping
  tools. This README covers it. For Claude Code, Cursor, Claude Desktop.
- **Web (hosted HTTP)** — a light, CLI-free toolset (drop, claim, login,
  visibility) for web clients like claude.ai. See [REMOTE.md](REMOTE.md).

The local edition wraps the `cloudgrid` CLI for authenticated operations (the CLI
handles auth, org context, and error formatting) and calls the API directly for the
drop, claim, and login tools.

## CLI compatibility

MCP 0.8.0 is tested against CLI 0.12. The lazy-npx fallback pins
`@cloudgrid-io/cli@~0.12` so a future CLI major with renamed verbs cannot
silently break a released MCP. A CI drift guard (`npm run test:drift-guard`)
asserts every wrapped verb exists in the CLI help.

### `GRID_AUTH_STALE` is out of scope

Strict-OIDC (org-owned) grids can return `GRID_AUTH_STALE` when the caller's
session predates an SSO policy change. The MCP does not target such grids and
does not handle this code: if a `GRID_AUTH_STALE` response is ever seen, point
the user at Console SSO to re-authenticate — the MCP will not silently retry.

## Prerequisite

Install and log in to the CLI:

```
npm install -g @cloudgrid-io/cli
cloudgrid login
```

The server reads no credentials directly. It runs `cloudgrid`, which uses its own
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

## Tools

### Direct-API tools (both editions)

| Tool | Wraps | Notes |
|---|---|---|
| `gridctl_plug` | `POST /api/v2/plug` | The unified create/re-plug verb: create a new entity, or update the SAME entity in place with `target_entity_id` (same URL). Source via local `path` (local edition) or inline `artifact_files` (both). |
| `gridctl_drop` | `POST /api/v2/plug` | Artifact drop. Anonymous, or owned if signed in. Re-drops in a session update the same drop in place; anonymous drops return an `entity_id` + `owner_token` re-plug/claim handle. |
| `gridctl_claim` | `POST /api/v2/entities/:id/pickup` | Claim an anonymous drop into the signed-in account (the claim token IS the drop's owner token). Direct API. |
| `gridctl_fork` | `POST /api/v2/runtimes/:id/fork` | Start a new entity from an existing runtime (lineage recorded). Needs sign-in. |
| `gridctl_download` | `GET /api/v2/runtimes/:id/source` | Signed 15-minute source-bundle URLs. Needs sign-in. |
| `cloudgrid_login` | `GET /auth/login` | Start a CLI-free sign-in; returns a URL to open. Direct API. |
| `cloudgrid_login_status` | `GET /auth/status` | Finish the sign-in; saves the token to the shared CLI credentials. |
| `cloudgrid_visibility` | `PATCH /api/v2/inspirations/<id>` | Change who can see a drop (private, space, authenticated, org, link). Needs sign-in. Direct API; also in the web edition. |

`cloudgrid_drop`, `cloudgrid_claim`, `cloudgrid_visibility`, and the two
`cloudgrid_login` tools do not wrap the CLI -- they call the API directly, so they
also work in the web edition where no CLI exists. `cloudgrid_login` writes the same
`~/.cloudgrid/credentials` the CLI uses, so the two share one identity.

### CLI-wrapping tools (local edition only)

| Tool | Wraps | Notes |
|---|---|---|
| `cloudgrid_init` | `cloudgrid init` | Register an app or agent; optionally seed a web service. |
| `cloudgrid_logs` | `cloudgrid logs` | Snapshot of recent logs. Does not stream. Read-only. |
| `cloudgrid_share` | `cloudgrid visibility set` | Set visibility, default link. |
| `cloudgrid_feedback` | `cloudgrid feedback list` | Read the org feedback feed. Read-only. |
| `cloudgrid_whoami` | `cloudgrid whoami` | Show the signed-in user and active org. Read-only. |
| `cloudgrid_use` | `cloudgrid use` | Switch the active org. |
| `cloudgrid_logout` | `cloudgrid logout` | Sign out and clear local credentials. Destructive. |
| `cloudgrid_status` | `cloudgrid status` | Org dashboard or entity detail. Read-only. |
| `cloudgrid_info` | `cloudgrid info` | Entity metadata. Read-only. |
| `cloudgrid_get` | `cloudgrid get grids\|entities\|spaces` | List grids, entities, or spaces. Read-only. |
| `cloudgrid_describe_grid` | `cloudgrid describe grid <slug>` | Grid detail. Read-only. |
| `cloudgrid_pickup` | `cloudgrid pickup <name>` | Download an entity's source and bind the folder. |
| `cloudgrid_rename` | `cloudgrid rename` | Rename an entity's display name. |
| `cloudgrid_unplug` | `cloudgrid unplug` | Take an entity off the grid. Destructive; requires confirm. |
| `cloudgrid_delete` | `cloudgrid delete entity` | Archive an inspiration. Destructive; requires confirm. |
| `cloudgrid_rollback` | `cloudgrid rollback` | Rollback to a previous version. |
| `cloudgrid_versions` | `cloudgrid versions` | List published versions. Read-only. |
| `cloudgrid_env` | `cloudgrid env` | Get, set, or list environment variables. |
| `cloudgrid_secrets` | `cloudgrid secrets` | Set or list secret names. Never returns secret values. |
| `cloudgrid_scaffold` | `cloudgrid scaffold` | Generate starter files. |
| `cloudgrid_doctor` | `cloudgrid doctor` | Run local diagnostics. Read-only. |
| `cloudgrid_open` | `cloudgrid open --print` | Return the public URL. Does not open a browser. Read-only. |

`cloudgrid_share` and `cloudgrid_visibility` overlap on purpose: `cloudgrid_share`
wraps the CLI and defaults to `link`; `cloudgrid_visibility` is direct API, takes an
explicit scope, and defaults its target to the session's last drop -- it is the one
the web edition gets.

All tools carry MCP annotations (`readOnlyHint`, `destructiveHint`,
`openWorldHint`) for clients that support them.

## Test

A smoke test spawns the server with a real MCP client, lists the tools, and calls
the read-only `cloudgrid_feedback` tool end to end:

```
cd mcp-server
npm install
npm run smoke
```

It needs a logged-in CLI on `$PATH`.

## Design

- Shells out with `execFile` and an argument array, so there is no shell and no
  injection surface.
- `cloudgrid_logs` never uses `--follow`; a streaming call would never return.
- Stateless. Each call is one CLI invocation.
