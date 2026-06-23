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
| `cloudgrid_drop` | `POST /api/v2/drop/auto` | Artifact drop. Anonymous, or owned if signed in. Direct API. |
| `cloudgrid_claim` | `POST /api/v2/anon-claim` | Claim an anonymous drop into the signed-in account. Direct API. |
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
| `cloudgrid_plug` | `cloudgrid plug` | Deploy a directory or URL. |
| `cloudgrid_logs` | `cloudgrid logs` | Snapshot of recent logs. Does not stream. Read-only. |
| `cloudgrid_share` | `cloudgrid visibility set` | Set visibility, default link. |
| `cloudgrid_feedback` | `cloudgrid feedback list` | Read the org feedback feed. Read-only. |
| `cloudgrid_brain` | `cloudgrid brain refresh` | Re-run the Grid Brain hooks. |
| `cloudgrid_whoami` | `cloudgrid whoami` | Show the signed-in user and active org. Read-only. |
| `cloudgrid_use` | `cloudgrid use` | Switch the active org. |
| `cloudgrid_logout` | `cloudgrid logout` | Sign out and clear local credentials. Destructive. |
| `cloudgrid_status` | `cloudgrid status` | Org dashboard or entity detail. Read-only. |
| `cloudgrid_info` | `cloudgrid info` | Entity metadata. Read-only. |
| `cloudgrid_builds` | `cloudgrid builds` | Recent builds and deploys. Read-only. |
| `cloudgrid_grid` | `cloudgrid grid` | List entities on the hub. Read-only. |
| `cloudgrid_rename` | `cloudgrid rename` | Rename an entity. |
| `cloudgrid_unplug` | `cloudgrid unplug` | Take an entity off the grid. Destructive; requires confirm. |
| `cloudgrid_delete` | `cloudgrid delete` | Archive and delete an entity. Destructive; requires confirm. |
| `cloudgrid_rollback` | `cloudgrid rollback` | Rollback to a previous version. |
| `cloudgrid_versions` | `cloudgrid versions` | List published versions. Read-only. |
| `cloudgrid_env` | `cloudgrid env` | Get, set, or list environment variables. |
| `cloudgrid_secrets` | `cloudgrid secrets` | Set or list secret names. Never returns secret values. |
| `cloudgrid_scaffold` | `cloudgrid scaffold` | Generate starter files. |
| `cloudgrid_doctor` | `cloudgrid doctor` | Run local diagnostics. Read-only. |
| `cloudgrid_open` | `cloudgrid open` | Return the public URL. Does not open a browser. Read-only. |

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
