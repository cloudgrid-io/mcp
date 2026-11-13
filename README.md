# @cloudgrid-io/mcp

An MCP server for CloudGrid. It exposes the CloudGrid actions as MCP tools.

## Hosted server

Add this URL to your AI tool as a remote MCP server (in claude.ai and ChatGPT,
add it as a custom connector):

```
https://mcp.cloudgrid.io/mcp
```

Sign in to CloudGrid when your AI tool asks; the connection uses OAuth. There is
nothing to install and nothing to configure. The hosted server carries the tools
that call the CloudGrid API directly. How it works and how it is hosted:
[REMOTE.md](REMOTE.md).

## Local server

The local edition runs on your machine over stdio and adds the tools that wrap
the `grid` CLI (logs, rollbacks, env vars, secrets, scaffolding). Use it in Claude Code, Cursor or Claude Desktop when you build runtime
apps from a folder on disk.

Install and sign in to the CLI:

```
npm install -g @cloudgrid-io/cli
grid login
```

Then point your MCP client at:

```
npx -y @cloudgrid-io/mcp
```

The server reads no credentials of its own. It uses the CLI's stored sign-in at
`~/.cloudgrid/credentials`; `grid_login` writes the same file.

### One CloudGrid server per client

Add either the hosted server or the local server to a given client, not both.
With both, each `grid_*` tool appears twice and the two hold separate sign-in
state, so they can disagree about whether you are signed in. To check, look for
duplicate `grid_*` entries in the client's tool list, or two CloudGrid servers
in its MCP or connector settings. Keep the local server where you build runtime
apps from folders, and the hosted server in chat-only clients.

### Settings (local server)

All optional:

- `CLOUDGRID_TELEMETRY=off`: turns off `grid_report` error reports.
- `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`: route API calls through a proxy.
- `NODE_EXTRA_CA_CERTS=/path/to/root-ca.pem`: trust an extra root certificate,
  for networks that inspect TLS.

`GRID_AUTH_STALE` is out of scope: grids whose owner enforces SSO can return it
when your session predates an SSO policy change. The server does not retry; sign
in again through Console SSO.

<!-- gen:tools -->
## Tools

38 tools registered (15 shared across both editions, 23 local-only). No deprecated aliases. MIN_CLI_VERSION: 0.15.26.

### Direct-API tools (both editions)

| Tool | Wraps | Summary |
|---|---|---|
| `grid_pickup` | API | Pick up an app: copies any app the user can see into one of their grids as a NEW, separate entity (a fork, like a git... |
| `grid_pull` | API | Pull an app to continue or edit it IN PLACE, like `git clone` of the SAME entity: the next plug with its target_entit... |
| `grid_collab` | API | Collab: grants the signed-in user PUSH ACCESS to the SAME live entity that someone else owns, as a collaborator on th... |
| `grid_create_grid` | API | Create a new grid (the workspace the user's apps live in) for the signed-in user, who becomes its admin. |
| `grid_note` | API | Record a one-paragraph summary of what was built this session and why, for the local edition's optional QA session lo... |
| `grid_plug` | API | Plug an app, website, game, or HTML page into CloudGrid at a live public URL. |
| `grid_get_app_source` | API | Retrieve the CURRENT deployed HTML of an inspiration/drop inline as text, for editing and re-plugging the SAME URL wh... |
| `grid_visibility` | API | Change who can see a CloudGrid inspiration OR runtime app/agent. |
| `grid_check_deploy` | API | Check whether an async runtime-app build (a deploy, which here means a plug) has finished and the app is live. |
| `grid_list_grids` | API | List the signed-in user's grids, each with slug, name, role, whether it is the active grid, and setup status (render_... |
| `grid_start` | API | A short orientation for building with CloudGrid: the account this session is signed in as and its active grid, how to... |
| `grid_get_template` | corpus | Load a specific CloudGrid workflow, template, example, rule, troubleshooting note, or reference doc by kind and name:... |
| `grid_report` | API | Report a genuine CloudGrid failure (a build, deploy, or platform call that failed unexpectedly) to the CloudGrid team... |
| `grid_hello` | API | Create a minimal hello page and plug it into the user's grid, returning the live URL. |
| `grid_delete` | `grid delete entity` | Archive a CloudGrid inspiration. |

The direct-API tools call the platform without the CLI, so they also work in
the web edition. `grid_login` writes the same `~/.cloudgrid/credentials` the
CLI uses, so the two share one identity.

### CLI-wrapping tools (local edition only)

| Tool | Wraps | Summary |
|---|---|---|
| `grid_login` | API | Start a CLI-free CloudGrid sign-in. |
| `grid_login_status` | API | Finish a browser sign-in started from this server. |
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
| `grid_edit_existing_app` | `grid pull` | Continue/edit an EXISTING entity locally: downloads its source + cloudgrid.yaml and links the folder so the next `gri... |
| `grid_rename` | `grid rename` | Rename a CloudGrid entity's display name (slug stays the same). |
| `grid_take_offline` | `grid unplug` | Take an entity off the grid. |
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

## Privacy Policy

Full policy: <https://cloudgrid.io/privacy>

### What this MCP server does with your data

**Authentication.** `grid_login` opens a browser-based Google sign-in flow via
CloudGrid's API (`/auth/login`). The returned JWT is stored at
`~/.cloudgrid/credentials` with `0600` permissions — the CLI and the MCP share
one credential file by design (`auth.js:7-8`). The web edition has no sign-in
tool: the AI tool's connector signs in with OAuth, and this server issues its own
short-lived access token, with the CloudGrid session sealed inside it, so the
session is never handed to the AI tool.

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
error summary, diagnostic metadata (platform, Node version, transport), a flag
recording whether the user agreed to share the conversation (`deploy.js:544`),
and a `context` object the model supplies — which by its declared shape
(`register.js:964-975`) can carry the failing inputs (for example the HTML or
args) and the original request. The transcript itself is not sent by this tool.
The report scrub is **two-layer**: values AND the `message` field are scanned
for known secret shapes (API key prefixes such as `sk-ant-`, `sk-proj-`,
`AKIA…`; JWTs; PEM private-key blocks; Bearer tokens; basic-auth URL
credentials) and matches are replaced with `[REDACTED]`. Arbitrary or
unknown-shape secrets that do not match a known pattern still transit
unredacted. The client-side scrub (`scrubReportContext` + `scrubSecretValues`
in deploy.js) runs before the POST; the server endpoint applies a server-side
key-name filter on top. To keep a secret out of a report, do not place it in
the `message` or `context` you send, or set `CLOUDGRID_TELEMETRY=off` to
disable reporting entirely.

**Version check.** At startup the local edition makes one request to
`https://registry.npmjs.org/@cloudgrid-io/mcp/latest` to detect a stale `.mcpb`
install, which never auto-updates. It sends no account data and no user content.
The hosted edition does not do this.

**QA session log.** Off by default. The local (stdio) server posts a
per-session QA log to the CloudGrid team only on a machine where a maintainer
has turned it on (see [CONTRIBUTING.md](CONTRIBUTING.md)); a user never sets
it. When on, it posts on deploy, error, idle timeout, or process shutdown. The
log includes: session metadata (user ID, email, grid slug, client name), the
user's first message (scrubbed, capped at 2 000 chars), a per-tool-call trail
with allowlisted arg keys only, and an optional narrative set via `grid_note` or
`grid_plug`'s `session_note` (capped at 4 000 chars). The first message is
captured from the `CLOUDGRID_USER_REQUEST` environment variable (forwarded by
Claude Code) or `grid_plug`'s `user_request` argument (local edition only).
**The hosted edition sends nothing on its own**: its `grid_plug` has no
`user_request` or `session_note`, and there is no post on a plug, on idle, or on
close. The one hosted post is `grid_note`, which the user asks for: it POSTs the
note to the CloudGrid API (`/api/v2/feedback`) under the user's own sign-in,
with the grid slug and the client name — no email address, no tool-call trail,
nothing else from the conversation; signed out, it returns `needs_auth` and
sends nothing. `grid_report` (both editions) sends a failure report to the
CloudGrid API only after the user agrees: the message and context the model
passes plus the client name and platform, and the conversation only when they
explicitly agree to that. Free-text values
(the first message, the narrative, tool arguments, and error messages) pass
through a scrubber that redacts JWTs, PEM keys, Bearer tokens, and known
provider API-key formats. Identity fields (`_keyResult` values and the header
block) and structured result data bypass the text scrubber.

**No other data collection by this server.** The server does not track usage
analytics or transmit data beyond the flows listed above and the authenticated
CloudGrid API calls the individual tools make (e.g. `/grids`,
`/pickup`, `/deploys`, `/inspirations/{id}/source`). CLI-wrapping tools shell
out to the CloudGrid `grid` CLI, which shares the same
`~/.cloudgrid/credentials` file and does not send additional telemetry through
this server. They prefer the CLI bundled in the `.mcpb` or a compatible `grid`
already on your `PATH`; if neither is present or new enough, they fall back to
`npx -y @cloudgrid-io/cli@latest` (`cli.js:411-424`), which **downloads and runs
the CLI from the npm registry** (`registry.npmjs.org`) on first use — software
installation, and the second flow that can reach npm (the startup version check
above is the first). Platform-level data handling is covered by the linked
privacy policy.
