# Web edition (hosted MCP)

The MCP server ships in two editions from one codebase. The tool logic lives in
`src/tools/register.js`; each edition is a thin entrypoint that injects an
identity context.

| | Local (`src/index.js`) | Web (`src/web.js`) |
|---|---|---|
| Transport | stdio | MCP Streamable HTTP |
| Runs | as a subprocess on the user's machine | hosted (e.g. GKE) |
| Reaches | Claude Code, Cursor, Claude Desktop | claude.ai web, any HTTP MCP client |
| Tools | full set (36), incl. CLI-wrapping | 14 shared direct-API tools (see README) |
| Identity | `~/.cloudgrid/credentials` | per-session token in memory |

The web edition registers the 14 direct-API tools that call the platform without
the CLI, including `grid_plug` (the deploy/publish verb). It omits the 22
CLI-wrapping tools — those need a local machine. The full tool list is generated
from the registry in [README.md](README.md).

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

1. `grid_login` returns the sign-in URL (no browser auto-open on a server).
2. The user completes Google sign-in.
3. `grid_login_status` polls and holds the token in the session.

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
publish into the user's org; claims work). The in-tool `grid_login` remains
as the fallback.

- `MCP_PUBLIC_URL` — this server's public origin (default `https://mcp.cloudgrid.io`),
  used in the OAuth metadata.
- `MCP_REQUIRE_AUTH=1` — make the connect mandatory: unauthenticated `/mcp` requests
  get a 401 challenge, which is what triggers a client's native connect flow.
  Default off: anonymous-first, auth honored when presented.

Endpoints: `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`,
`/oauth/register`, `/oauth/authorize` (redirects to the CloudGrid sign-in), `/oauth/authorize/complete` (where the sign-in returns), `/oauth/token`.

**Operational dependency — do not remove without reading this.** `/oauth/authorize`
redirects to the CloudGrid sign-in with a `return_url` of
`<this host>/oauth/authorize/complete`, and the API accepts it only if that exact string
is in its `CONSOLE_AUTH_RETURN_URLS` allowlist. Take the entry away and hosted sign-in
fails with a console-owned `400 Invalid return_url` — a failure with no breadcrumb back to
this repo. Added in cloudgrid-io/cloudgrid#3098; it has to stay for every host running with
`MCP_REQUIRE_AUTH=1`.

Dynamic client **registrations are stateless and durable**: a `client_id` is an
HMAC-signed token that carries its own redirect-URI set, so it survives restarts,
deploys, and any replica count with no datastore. Only the short-lived authorize
sessions and auth codes (5-minute, retry-on-failure) remain in-memory — losing
them to a restart just re-prompts sign-in, it never drops a registered connector.

### Client-registration signing key (durable registration)

Signing that `client_id` needs a stable server key. Set it or the fix for durable
registration is not actually in effect.

- Set `MCP_OAUTH_HMAC_SECRET` in the deployment env, sourced from a Kubernetes
  **Secret** (NEVER a ConfigMap; the key must not be logged). It is a
  whitespace/comma-separated list: the first entry signs, all entries verify.
  Mount it on the connected and staging deployments; the anonymous edge does not
  mount OAuth and does not need it.
- **Unlike `MCP_TRUSTED_SERVER_SECRET`, this is NOT safe to omit.** With no secret
  set, each process falls back to its own per-process ephemeral key: within one
  process the flow works, but across a restart or multiple replicas a `client_id`
  minted by one process fails on another — authorize breaks intermittently, per
  request, and every functional probe still passes. Missing the secret silently
  leaves the registration-durability defect live while looking fixed.
- Verify from the boot log: `[oauth] client-registration secret configured (N key(s))`
  confirms durable mode; the `MCP_OAUTH_HMAC_SECRET is NOT set` warning means the
  ephemeral fallback is active.
- Rotate rolling-update-safe: append the new key (verify-only) and deploy first,
  then promote it to the first (signing) position and deploy, then drop the old
  key later. Prepending straight away makes new pods sign under a key the
  not-yet-updated pods cannot verify, causing transient 400s.

## Launch follow-ups
- **CORS / DNS-rebinding / allowed hosts.** Configure at deploy time for the public
  host.
