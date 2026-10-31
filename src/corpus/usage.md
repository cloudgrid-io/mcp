# Using CloudGrid skills and MCP

Two surfaces expose the **same** CloudGrid actions — drop, login, claim, init,
plug, logs, share, feedback, brain:

- **Skills** — `SKILL.md` files an agent loads (this repo). They trigger from
  natural language (their `description`) or a slash command.
- **MCP server** — the same actions as MCP tools, for clients that speak the Model
  Context Protocol. Published separately as
  [`@cloudgrid-io/mcp`](https://github.com/cloudgrid-io/mcp).

Which one you use depends on the client. Pick your client below.

## Prerequisites

- **Node 18+** (for `npx`).
- **A CloudGrid account** — every plug is owned by a signed-in user. Run
  `grid login` once, or use the `login` skill / the `grid_login` MCP tool from
  the conversation; the hosted MCP asks you to sign in on the first plug.

---

## Claude Code (terminal, VS Code, JetBrains)

Three install routes. They land in **different menus** — this is the most common
point of confusion.

### Route 1 — skills via the skills CLI
```
npx skills add cloudgrid-io/skills
```
- Installs into `~/.claude/skills/` (personal). Auto-loads, no restart.
- **Find them under `/skills`** (labeled Personal). **Not** under `/plugin`.
- Invoke as **`/drop`**, `/login`, … (bare — the personal route has no namespace), or describe the task.

### Route 2 — skills as a plugin
```
/plugin marketplace add cloudgrid-io/skills
/plugin install cloudgrid
```
- **Find it under `/plugin`**; the skills also show under `/skills` (labeled Plugin).
- Invoke as **`/cloudgrid:plug`** (plugin namespace + short skill name), or describe the task.

### Route 3 — the MCP server
```
claude mcp add cloudgrid -- npx -y @cloudgrid-io/mcp
```
- **Find it under `/mcp`.** Exposes tools `grid_plug`, `grid_login`, …
- Invoke by describing the task; the model calls the tool.

> Where did my install go? `/skills` (skills), `/plugin` (plugin), `/mcp` (MCP).
> If you don't see something, you're probably looking in the wrong menu, or you
> installed a different route than you're checking. `/doctor` flags real problems.

### Sharing with a team (Claude Code)
Commit a project-scoped MCP so teammates get it on clone:
```
cd your-shared-repo
claude mcp add cloudgrid -s project -- npx -y @cloudgrid-io/mcp
git add .mcp.json && git commit -m "add CloudGrid MCP"
```
Or each person runs Route 1 or `claude mcp add ... -s user` once.

---

## Claude Desktop (chat)

Desktop chat extends via **MCP only** — it does not read a skills folder. Add to
`~/Library/Application Support/Claude/claude_desktop_config.json`:
```json
{ "mcpServers": { "cloudgrid": { "command": "npx", "args": ["-y", "@cloudgrid-io/mcp"] } } }
```
Then **fully quit and reopen** Claude Desktop. The CloudGrid tools appear under the
tools icon. Invoke by describing the task: "drop this HTML to CloudGrid."

---

## Codex, Cursor, Cline, Gemini CLI, and other coding agents

```
npx skills add cloudgrid-io/skills
```
Installs into the universal `.agents/skills/` location these agents read (Cursor
also reads `~/.cursor/skills`; target one agent with `-a codex` / `-a cursor`).
Codex and Cursor also take the plugin route (`codex plugin marketplace add
cloudgrid-io/skills`; Cursor's in-app marketplace) and the MCP server — local
(`npx -y @cloudgrid-io/mcp` in their MCP config) or remote with nothing installed
(`https://mcp.cloudgrid.io/mcp` as a `url` entry in `~/.codex/config.toml` or
`~/.cursor/mcp.json`). See INSTALL.md for exact snippets.

---

## claude.ai web and the ChatGPT app

These connect to **remote** MCP servers (by URL), not local ones. The hosted web
edition is live — add it as a custom connector:

One endpoint:

```
https://mcp.cloudgrid.io/mcp
```

A client that supports OAuth signs you in with CloudGrid when you add it;
otherwise `grid_login` signs you in from inside the conversation on the first
plug. Every plug is owned by your account from the first one.

- **claude.ai web** — Settings → Connectors → add custom connector.
- **ChatGPT** — add it as a custom connector (Developer Mode; availability depends
  on plan / rollout).
- **Codex and Cursor** accept the same URL — see the section above.

---

## Skill vs MCP — which should I use?

Same capabilities; different surface.

- **Skills** carry guidance (when to use, how to phrase results) and auto-trigger
  from natural language. Best in agents that read skills (Claude Code, Cursor, …).
- **MCP** exposes the actions as tools. Best where skills are not read (Claude
  Desktop, claude.ai web, ChatGPT) or when you want explicit tools.

You can install both; they do not conflict.

## Capabilities (both surfaces)

| Action | What it does |
|---|---|
| drop | Share an artifact, get a public URL. Owned by your account; re-drop with the entity id to update the same URL. |
| login | Sign in to CloudGrid, with or without the CLI. |
| claim | Claim a drop you plugged outside a grid into a grid of your choosing; the URL stays the same. |
| init | Scaffold a new app or agent. |
| plug | Deploy a directory or URL. |
| logs | Tail an entity's logs. |
| share | Set visibility and print the URL. |
| feedback | Read the feedback feed. |
| brain | Refresh Grid Brain metadata. |
