# Web edition (hosted MCP)

The MCP server ships in two editions from one codebase. The tool logic lives in
`src/tools.js`; each edition is a thin entrypoint that injects an identity context.

| | Local (`src/index.js`) | Web (`src/web.js`) |
|---|---|---|
| Transport | stdio | MCP Streamable HTTP |
| Runs | as a subprocess on the user's machine | hosted (e.g. GKE) |
| Reaches | Claude Code, Cursor, Claude Desktop | claude.ai web, any HTTP MCP client |
| Tools | full set, incl. CLI-wrapping | light set: drop, claim, login, visibility |
| Identity | `~/.cloudgrid/credentials` | per-session token in memory |

The web edition omits the CLI-wrapping tools (init, plug, logs, share, feedback,
brain) — those need a local machine. It keeps the direct-API tools, which need no
local environment.

## Run it

```
PORT=8080 npm run start:web      # from a clone
```

- `POST /mcp` — the MCP Streamable HTTP endpoint (one transport per session).
- `GET /mcp`, `DELETE /mcp` — SSE stream and session close.
- `GET /healthz` — liveness for the host.

Smoke test (spawns the server, connects an HTTP client, drops anonymously):

```
npm run smoke:web
```

## Container

```
docker build -t cloudgrid-mcp-web .
docker run -p 8080:8080 cloudgrid-mcp-web
```

The image carries no `cloudgrid` CLI — the web edition never calls it. It serves on
`PORT` (default 8080) and answers `GET /healthz`.

## Deploying (platform)

Hosting is platform work (GKE): a Deployment + Service + Ingress at a stable host
(e.g. `mcp.cloudgrid.io`), `PORT=8080`, `GET /healthz` as the probe. The container
is stateless; sessions live in memory, so a single replica is simplest first, or a
sticky-session ingress for more.

## Identity on the web

A hosted server cannot read a local credentials file, so each session signs in
through the server:

1. `gridctl_login` returns the sign-in URL (no browser auto-open on a server).
2. The user completes Google sign-in.
3. `gridctl_login_status` polls and holds the token in the session.

Anonymous drop needs no sign-in and works immediately.

## Trusted-server credential (anonymous-drop cap)

Anonymous drops are capped per IP. A shared host sends them all from one cluster
egress IP, so the cap is hit quickly. Provision this host as a trusted server and
the platform keys the cap on the per-user id instead:

- Set `MCP_TRUSTED_SERVER_SECRET` in the deployment env (the same cluster Secret the
  API validates against). When set, the web edition sends, on anonymous drops:
  - `X-CloudGrid-Trusted-Server-Auth: <MCP_TRUSTED_SERVER_SECRET>`
  - `X-CloudGrid-Trusted-Server-End-User: <MCP session id>` (stable, opaque per session)
- A missing or wrong secret falls back to the per-IP cap server-side (never an error),
  so it is safe to deploy before the Secret is provisioned.

## Transport-level OAuth (native Connect)

The web edition implements the MCP authorization spec — metadata discovery,
dynamic client registration, and the PKCE authorization-code flow — as a bridge
over CloudGrid's existing sign-in. A client that completes the connect sends a
Bearer on its MCP requests, and that token becomes the session's identity (drops
publish into the user's org; claims work). The in-tool `gridctl_login` remains
as the fallback.

- `MCP_PUBLIC_URL` — this server's public origin (default `https://mcp.cloudgrid.io`),
  used in the OAuth metadata.
- `MCP_REQUIRE_AUTH=1` — make the connect mandatory: unauthenticated `/mcp` requests
  get a 401 challenge, which is what triggers a client's native connect flow.
  Default off: anonymous-first, auth honored when presented.

Endpoints: `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`,
`/oauth/register`, `/oauth/authorize` (the sign-in interstitial), `/oauth/token`.
State is in-memory, single replica — same posture as MCP sessions.

## Launch follow-ups
- **CORS / DNS-rebinding / allowed hosts.** Configure at deploy time for the public
  host.
