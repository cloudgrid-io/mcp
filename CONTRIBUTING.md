# Contributing

Contributions are welcome. By submitting a pull request you agree that your
contribution is licensed under the MIT License (see [LICENSE](LICENSE)).

## Getting started

```
npm install
npm run smoke
```

## Pull requests

1. Fork the repo and create a feature branch.
2. Make your changes. Keep commits focused and use conventional commit messages.
3. Run `npm run smoke` locally to verify the tool list is unchanged.
4. Open a pull request against `main`. CI must pass before merge.

## Template dependencies are user-facing

The pinned dependencies under `src/corpus/templates/` ship to builders, who run
them on their own machines. A broken pin does not break this repo's CI; it
breaks a builder's first run. So the bar for a template dependency change is
"a fresh builder can install and run it", not "our checks are green".

For the `semantic-search` Python services, the `template-python` workflow
installs each service's `requirements.txt` on Python 3.12, imports every module,
and checks PDF text extraction against a golden output. If that output changes
after a `pypdf` bump, print the text first
(`.github/scripts/semantic-search-smoke.py <service-dir> --print`) and decide
whether builders should get the change before updating the hash.

## Test

A smoke test spawns the server with a real MCP client, lists the tools, and calls
the read-only `grid_feedback` tool end to end:

```
cd mcp
npm install
npm run smoke
```

It needs a logged-in CLI on `$PATH`.

### Live smoke scripts

Three more scripts run against the live API on demand. They are not part of CI.
A new plug needs sign-in, so none of them creates an anonymous drop. Each one
skips a step, and says why, when the variables that step needs are missing.
Tokens come only from the environment and are never printed.

| Script | Without secrets | With secrets |
|---|---|---|
| `npm run smoke:drop` | A signed-out create with `anon: true` returns `needs_auth` and publishes nothing. | `CLOUDGRID_TOKEN` (and `CLOUDGRID_SMOKE_GRID` if the account has several grids): a signed-in create publishes an owned page and its URL serves. |
| `npm run smoke:redrop` | Same signed-out check, through the web edition. | `CLOUDGRID_SMOKE_REDROP_ENTITY_ID` + `CLOUDGRID_SMOKE_REDROP_OWNER_TOKEN` (or `CLOUDGRID_SMOKE_REDROP_OWNER_TOKEN_FILE`) for an existing anonymous drop: the edit updates it in place, with no sign-in. The owner token is re-minted on every edit; a token file is rewritten with the fresh one. |
| `npm run smoke:claim` | Skips. | `CLOUDGRID_TOKEN`: a signed-in plug. Add `CLOUDGRID_SMOKE_CLAIM_ENTITY_ID` + `CLOUDGRID_SMOKE_CLAIM_TOKEN` for an existing anonymous drop: `grid_pull` claims it into the account. A drop can be claimed once. |

The signed-out check is refused inside the server before any publish request is
sent, so it is safe to run at any time.

## Design (local server)

- Shells out with `execFile` and an argument array, so there is no shell and no
  injection surface.
- `grid_view_logs` never uses `--follow`; a streaming call would never return.
- Stateless. Each call is one CLI invocation.

## CLI compatibility

The MCP uses an installed CLI only when it meets the platform floor
(`MIN_CLI_VERSION`, currently 0.15.26, kept in lockstep with the API's live
`cli_compat` floor, which rejects older CLIs with HTTP 426). Below the floor it
skips the local/global CLI and lazily fetches `@cloudgrid-io/cli@latest` via
npx instead. A CI drift guard (`npm run test:drift-guard`) asserts every
wrapped verb exists in the CLI help.

## Maintainer settings

These settings are for CloudGrid maintainers. A user of the hosted or local
server never sets them.

- `CLOUDGRID_QA_SLACK_WEBHOOK`: a private Slack incoming-webhook URL. When set,
  the local (stdio) server posts a per-session QA log
  (`log-<Client>-<transport>-mcp.txt`) when a session goes live, fails, or is
  abandoned. The log carries the user's first message (when the host forwards
  it in `CLOUDGRID_USER_REQUEST`) and identity details, so the channel must be
  private. Unset, nothing is captured or posted. The hosted edition never posts
  a session log.
- `CLOUDGRID_QA_IDLE_MS`: the abandoned-session window for that log (default
  900000, 15 minutes).

Settings for running the hosted (web) edition are in [REMOTE.md](REMOTE.md).

## Reporting issues

Open a GitHub issue. For security vulnerabilities see [SECURITY.md](SECURITY.md).
