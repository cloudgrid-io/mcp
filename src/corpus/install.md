# Install

CloudGrid Skills work in any agent that reads `SKILL.md` files. The steps below
cover the CLI prerequisite, then each agent.

## Prerequisite: the CloudGrid CLI

Every skill drives the `cloudgrid` CLI. Install it once and log in:

```
npm install -g @cloudgrid-io/cli
cloudgrid login
```

`cloudgrid whoami` confirms you are logged in.

## Add the skills

Pick the method that matches your agent.

### Any agent (gh skill extension)

```
gh skill install cloudgrid-io/skills
```

### Any agent (skills CLI)

```
npx skills add cloudgrid-io/skills
```

### Claude Code

```
/plugin marketplace add cloudgrid-io/skills
```

The marketplace manifest lives in `.claude-plugin/`.

### Codex

Three routes:

```
codex plugin marketplace add cloudgrid-io/skills      # plugin (manifest: .codex-plugin/)
npx skills add cloudgrid-io/skills -a codex           # skills only (-> ~/.agents/skills)
```

Or the MCP server, in `~/.codex/config.toml` — local or the hosted URL:

```toml
[mcp_servers.cloudgrid]
command = "npx"
args = ["-y", "@cloudgrid-io/mcp"]

# or remote, nothing installed:
# [mcp_servers.cloudgrid]
# url = "https://mcp.cloudgrid.io/mcp"
```

### Cursor

Cursor reads Agent Skills natively (v2.4+):

```
npx skills add cloudgrid-io/skills -a cursor          # -> ~/.cursor/skills + ~/.agents/skills
```

Or install the plugin from Cursor's in-app marketplace (manifest: `.cursor-plugin/`).
Or the MCP server, in `~/.cursor/mcp.json`:

```json
{ "mcpServers": { "cloudgrid": { "command": "npx", "args": ["-y", "@cloudgrid-io/mcp"] } } }
```

Remote variant, nothing installed: `{ "mcpServers": { "cloudgrid": { "url": "https://mcp.cloudgrid.io/mcp" } } }`

### Manual

```
git clone https://github.com/cloudgrid-io/skills.git
```

Then point your agent at the cloned directory.

## MCP server

The `@cloudgrid-io/mcp` package is published on npm:

```
npx -y @cloudgrid-io/mcp
```

It wraps the same `cloudgrid` CLI and uses the same credentials, so no extra login
is needed. Remote-capable clients can point at `https://mcp.cloudgrid.io/mcp`
instead. See [USAGE.md](USAGE.md) for per-client snippets.

### Claude Desktop — one-click install

Claude Desktop users can install the MCP as a Desktop Extension with no terminal,
no Node, and no JSON editing. Download the bundle and double-click it (or in Claude
Desktop: Settings, Extensions, Install from file):

```
https://github.com/cloudgrid-io/mcp/releases/latest/download/cloudgrid.mcpb
```

The bundle carries the full local toolset (including the `cloudgrid` CLI), so deploy
and secrets tools work without a separate install. Sign in from chat with the
`cloudgrid_login` tool on first use.

## For agents

If you are an agent reading this to install the skills yourself, read
[INSTALL_FOR_AGENTS.md](INSTALL_FOR_AGENTS.md) instead. It is written as steps you
can execute directly.
