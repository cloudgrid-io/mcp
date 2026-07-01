# CloudGrid Skills

Multi-agent skills for CloudGrid. Install them in Claude Code, Codex, or Cursor,
and your agent can build, ship, and run things on CloudGrid through the
`cloudgrid` CLI.

## Why CloudGrid

Claude Code and Codex removed the wall around writing code. CloudGrid removes the
wall around shipping it. A directory or a URL becomes a live, addressable thing in
about 30 seconds. These skills are how your agent crosses that second wall on your
behalf: scaffold, deploy, tail logs, share, read feedback. Everything here is free.

## Install in 3 steps

1. Install the CLI:

   ```
   npm install -g @cloudgrid-io/cli
   ```

2. Log in:

   ```
   cloudgrid login
   ```

3. Add the skills. In Claude Code (recommended):

   ```
   /plugin marketplace add cloudgrid-io/skills
   /plugin install cloudgrid
   ```

   They show under `/plugin` and `/skills` as `cloudgrid:drop`, `cloudgrid:login`,
   … — or just say what you want ("drop this HTML to CloudGrid") and the right one
   triggers.

   Or install with the `gh skill` extension:

   ```
   gh skill install cloudgrid-io/skills
   ```

   Other agents (Cursor, Cline, Gemini CLI): `npx skills add cloudgrid-io/skills`.
   They install as `drop`, `plug`, … — the CloudGrid brand comes from the plugin
   namespace, which those agents don't have.

   Claude Desktop, claude.ai, ChatGPT, and every route in one place: [USAGE.md](USAGE.md).

## Share something in one step, no login

```
/cloudgrid:drop index.html
```

`cloudgrid:drop` publishes an HTML page or file and hands back a public URL. No
account, no CLI. The link lasts 7 days, and you can sign in later to keep it.

## Skills

| Skill | Invoke | What it does |
|---|---|---|
| `drop` | `/cloudgrid:drop` | Share an HTML page or file, get a public URL. Login optional. |
| `login` | `/cloudgrid:login` | Sign in to CloudGrid, with or without the CLI. |
| `claim` | `/cloudgrid:claim` | Claim an anonymous drop into your account after signing in. |
| `init` | `/cloudgrid:init` | Scaffold a new app or agent. |
| `plug` | `/cloudgrid:plug` | Deploy a directory or URL. Live in about 30 seconds. |
| `logs` | `/cloudgrid:logs` | Tail logs for an entity. |
| `share` | `/cloudgrid:share` | Make an entity shareable and print its URL. |
| `feedback` | `/cloudgrid:feedback` | Read the feedback feed. |
| `brain` | `/cloudgrid:brain` | Refresh an entity's Grid Brain metadata. |

## The canonical chain

```
init  ->  plug  ->  logs  ->  share  ->  feedback
```

That is the full "I built a thing and shipped it" loop. [COOKBOOK.md](COOKBOOK.md)
walks through it end to end.

## MCP server

The MCP server is published separately as
[`@cloudgrid-io/mcp`](https://github.com/cloudgrid-io/mcp). It exposes the same
nine actions as MCP tools, for agents that speak the Model Context Protocol.
Install it with `npx -y @cloudgrid-io/mcp`, or point a remote-capable client at
`https://mcp.cloudgrid.io/mcp`. See [USAGE.md](USAGE.md) for per-client setup.

## License

Apache 2.0. See [LICENSE](LICENSE).
