# CloudGrid CLI

[![release](https://img.shields.io/badge/release-v0.9.13-black)](https://github.com/cloudgrid-io/cli/releases)
[![npm](https://img.shields.io/badge/npm-v0.9.13-cb3837)](https://www.npmjs.com/package/@cloudgrid-io/cli)
[![license](https://img.shields.io/badge/license-Apache--2.0-green)](./LICENSE)

> Draft for the public `cloudgrid-io/cli` distribution repo. Structure mirrors
> `higgsfield-ai/cli`, fit to CloudGrid. Source stays private in the monorepo; this
> repo holds the installer + docs only.

Build, ship, and run apps and agents on CloudGrid from your terminal. A directory or a
URL becomes a live, addressable thing in about 30 seconds — deploy, tail logs, share,
read feedback, all without leaving your shell.

## Contents

- [Install](#install)
- [Quickstart](#quickstart)
- [Examples](#examples)
- [Commands](#commands)
- [Flags](#flags)
- [Updating](#updating)
- [Uninstall](#uninstall)
- [Troubleshooting](#troubleshooting)
- [Support](#support)
- [License](#license)

## Install

**macOS / Linux — curl**
```
curl -fsSL https://raw.githubusercontent.com/cloudgrid-io/cli/main/install.sh | sh
```

**macOS / Linux — Homebrew**
```
brew install cloudgrid-io/tap/cloudgrid
```

**Cross-platform (incl. Windows) — npm**
```
npm install -g @cloudgrid-io/cli
```

**Manual** — download the latest from [Releases](https://github.com/cloudgrid-io/cli/releases), extract, and put `cloudgrid` on your `$PATH`.

Verify: `cloudgrid --version` and `cloudgrid doctor`. The shorthand `cg` works for every command.

## Quickstart

```
cloudgrid login          # Google OAuth in the browser
cloudgrid whoami         # confirm user + active org
cloudgrid plug           # build + deploy the current directory, prints the live URL
cloudgrid open           # open it in the browser
```

No account needed to try a one-off share: `cloudgrid plug ./index.html` drops a public link.

## Examples

```
# Scaffold and deploy a Node app
cloudgrid init app my-api --type node
cd my-api && cloudgrid plug

# Deploy the current directory and tail its logs
cloudgrid plug
cloudgrid logs --since 10m

# Make a deploy public, then read feedback
cloudgrid visibility set my-api link
cloudgrid feedback

# Switch org, list what's on the grid
cloudgrid use atomic
cloudgrid grid
```

## Commands

| Command | Purpose |
|---|---|
| `login` / `logout` / `whoami` | Sign in (Google OAuth), sign out, show user + active org |
| `use [slug]` | Set or show the active org |
| `init <kind> <name>` | Register a new app or agent |
| `plug [target]` | Build + deploy (or redeploy); prints the live URL |
| `dev` | Run the linked entity locally with grid-injected resources |
| `status [name]` | Org dashboard, entity detail, or a deploy snapshot |
| `logs [name]` | Stream entity logs |
| `open [name]` | Open the entity URL in the browser |
| `info [name]` / `builds [name]` | Entity metadata; recent deploys |
| `visibility set <slug> <mode>` | private \| authenticated \| org \| link |
| `rollback` / `versions` | Roll back to a prior deploy; list/tag minted versions |
| `env` / `secrets` | Manage runtime env vars and secrets (secret values are never printed) |
| `grid` / `list` | List what's on your hub / org |
| `rename` / `delete` / `unplug` | Rename, archive, take off the grid |
| `pull` / `clone` / `fork` | Download source; clone or fork an entity |
| `feedback [message]` | Send feedback to the CloudGrid team |
| `brain refresh <name>` | Re-run Grid Brain metadata (description, tags, diagram) |
| `doctor` | Diagnostic checks (Node, Docker, API reachability, auth) |
| `completion <shell>` | Shell completion script |

Run `cloudgrid <command> --help` for the full flag set of any command.

## Flags

Global:
- `-V, --version` — print the CLI version
- `-v, --verbose` — detailed output
- `-h, --help` — help for any command

Common per-command:
- `--org <slug>` — pick/override the org
- `--json` — machine-readable output (where supported)
- `--no-clipboard` / `--no-notify` — suppress clipboard copy / OS notification on `plug`
- `--since <dur>` / `--tail <n>` — `logs` window

## Updating

```
npm update -g @cloudgrid-io/cli      # npm
brew upgrade cloudgrid               # homebrew
```
`cloudgrid doctor` warns when a newer version is available.

## Uninstall

```
npm uninstall -g @cloudgrid-io/cli   # npm
brew uninstall cloudgrid             # homebrew
rm -rf ~/.cloudgrid                  # remove stored credentials + config
```

## Troubleshooting

- **`cloudgrid: command not found`** — ensure the npm global bin (or Homebrew bin) is on `$PATH`; re-run the installer.
- **Auth errors / 401** — `cloudgrid login` again; check `cloudgrid whoami` shows the expected org, switch with `cloudgrid use <org>`.
- **Deploy fails** — run `cloudgrid doctor`; check `cloudgrid logs` and `cloudgrid status <name>` for the trace.

## Support

- Skills + MCP: [cloudgrid-io/skills](https://github.com/cloudgrid-io/skills)
- Issues: [cloudgrid-io/cli/issues](https://github.com/cloudgrid-io/cli/issues)

## License

Apache-2.0. See [LICENSE](./LICENSE).
