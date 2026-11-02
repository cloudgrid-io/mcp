# Web edition (hosted MCP)

The MCP server ships in two editions from one codebase. The tool logic lives in
`src/tools/register.js`; each edition is a thin entrypoint that injects an
identity context.

| | Local (`src/index.js`) | Web (`src/web.js`) |
|---|---|---|
| Transport | stdio | MCP Streamable HTTP |
| Runs | as a subprocess on the user's machine | hosted (e.g. GKE) |
| Reaches | Claude Code, Cursor, Claude Desktop | claude.ai web, any HTTP MCP client |
| Tools | full set (38), incl. CLI-wrapping | 17 direct-API tools (see README) |
| Identity | `~/.cloudgrid/credentials` | per-session token in memory |

The web edition registers the 17 direct-API tools that call the platform without
the CLI, including `grid_plug` (the deploy/publish verb). It omits the 21
CLI-wrapping tools — those need a local machine. The full tool list is generated
from the registry in [README.md](README.md).

## Run it

```
PORT=8080 npm run start:web      # from a clone
```

- `POST /mcp` — the MCP Streamable HTTP endpoint (one transport per session).
- `GET /mcp`, `DELETE /mcp` — SSE stream and session close.
- `GET /healthz` — liveness for the host.

Smoke test (spawns the server, connects an HTTP client, checks that a signed-out
create is refused and publishes nothing):

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

A hosted server cannot read a local credentials file. The user signs in through
their AI tool's connector (the OAuth connect below); the hosted edition has no
sign-in tool. Browsing tools (`grid_start`, `grid_get_template`,
`grid_get_app_source`) work signed out; every other tool needs an account.

How each AI tool is asked to sign in depends on the client (`authMode` in
`src/web-auth.js`, chosen from `clientInfo` at initialize):

- Claude (web, desktop, mobile) and ChatGPT: HTTP 401 with a `WWW-Authenticate`
  challenge on the first tool call that needs an account.
- Claude Code, Gemini CLI, VS Code, Cursor, Copilot Studio and any other client:
  HTTP 401 on `initialize`, so sign-in happens when the server is added.
- `MCP_AUTH_MODE_OVERRIDES` (`name=mode`, comma separated; modes `call`,
  `tool-error`, `connect`) changes one client's signal without a release. In
  `tool-error` mode the call is answered with a tool error carrying
  `_meta["mcp/www_authenticate"]`.

`clientInfo` only picks the signal: a protected call without a valid token is
refused in every mode, so nothing is published signed out. A signed-in user may plug an entity outside their grid; later,
only its owner can claim it into a grid of their choosing (`grid_pull` with its
`claim_token`), and it can be re-plugged in place with its `owner_token`.

## What leaves the server

Nothing from the conversation is sent anywhere unless the user asks for it:
`grid_note` files a build note with the CloudGrid API (`POST /api/v2/feedback`,
under the user's own sign-in) — the note text, the grid slug and the client
name; no email, no tool-call trail — and `grid_report` sends a failure report
(the message and context the model passes, plus the client name and platform;
the conversation only when the user explicitly agrees). Both reach the CloudGrid
team through the API, not through a webhook; a signed-out `grid_note` returns
`needs_auth` and sends nothing. There is no automatic session-log post on the hosted edition — not on a
plug, not on idle, not on close — and the hosted `grid_plug` schema carries no
`user_request` or `session_note` fields, and the hosted servers carry no
`CLOUDGRID_QA_SLACK_WEBHOOK`. The local (stdio) edition keeps its opt-in QA log
(README, "QA session log").

## Trusted-server credential (per-user cap)

Drops plugged outside a grid are capped per IP. A shared host sends them all from one cluster
egress IP, so the cap is hit quickly. Provision this host as a trusted server and
the platform keys the cap on the per-user id instead:

- Set `MCP_TRUSTED_SERVER_SECRET` in the deployment env (the same cluster Secret the
  API validates against). When set, the web edition sends, on such drops:
  - `X-CloudGrid-Trusted-Server-Auth: <MCP_TRUSTED_SERVER_SECRET>`
  - `X-CloudGrid-Trusted-Server-End-User: <MCP session id>` (stable, opaque per session)
- A missing or wrong secret falls back to the per-IP cap server-side (never an error),
  so it is safe to deploy before the Secret is provisioned.

## Transport-level OAuth (native Connect)

The web edition implements the MCP authorization spec — metadata discovery,
dynamic client registration, and the PKCE authorization-code flow — as a bridge
over CloudGrid's existing sign-in, on every host. The token endpoint returns an
access token this server signs for itself (`alg: EdDSA`, `typ: at+jwt`, `aud` =
the resource URL). Every request that presents one is checked for signature,
audience, issuer and expiry; an invalid token gets a 401 with
`error="invalid_token"`. The CloudGrid session the sign-in produced is sealed
inside the token (AES-256-GCM) and used only for this server's own calls to the
CloudGrid API; it is never returned to the client or accepted from it.

- `MCP_PUBLIC_URL` — this server's public origin (default `https://mcp.cloudgrid.io`),
  used in the OAuth metadata.
- `MCP_ALIAS_URLS` — other public origins served by the same server (comma
  separated). Each is answered for its own origin, and a token issued on any of
  them is accepted on all.
- `MCP_TOKEN_SIGNING_KEYS` — the access-token signing keys, from a Kubernetes
  Secret: base64url 32-byte Ed25519 seeds, comma separated. The first signs, all
  verify; each key's `kid` is its RFC 7638 thumbprint. Rotate by appending the new
  key, then moving it to the front, then (after the longest token lifetime)
  dropping the old one. Unset: a per-process key, and clients sign in again after
  a restart.
  A server that has `MCP_OAUTH_HMAC_SECRET` but no signing key refuses to start.
- `MCP_TOKEN_SEAL_KEYS` — optional keys that seal the CloudGrid session inside
  the token (same list format). Unset: derived from each signing key.
- Access tokens last 24 hours while no refresh store is configured.
- Signing out of CloudGrid reaches the AI tool: the server checks the sealed
  session with the API (cached for a few minutes), and any API call refused as
  signed out marks it, so the next request gets a 401 and the AI tool signs in
  again.
- A session belongs to one account: a token for another account on the same
  `mcp-session-id` gets 404, and the client starts a new session.
- Tool calls send the API a short-lived token scoped for a connected AI tool
  (`POST /api/v2/auth/token/downstream`, authenticated as the trusted server),
  not the CloudGrid session itself. If the API does not offer it yet, the
  session itself is used.
- A CloudGrid session token presented directly as the Bearer (what releases before
  0.22 returned as the access token) is accepted while it lasts, if it was issued
  before `MCP_LEGACY_TOKENS_ISSUED_BEFORE` (epoch seconds; default: this
  process's start), after the API confirms it is valid and not signed out.

Endpoints: `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server`,
`/oauth/register`, `/oauth/authorize` (the sign-in interstitial), `/oauth/token`.

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
  Every host serves OAuth, so every deployment mounts it.
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

## App card after a plug

On the web edition, `grid_plug` and `grid_hello` bind the live-result card
(`ui://cloudgrid/live-result.html`) through `_meta.ui.resourceUri`, the MCP Apps
key, and `openai/outputTemplate`, ChatGPT's alias for it. The card shows the
app URL with Open, Copy link, Update, and who can open it, and calls
`grid_visibility` and `grid_check_deploy` over the host bridge. Clients without
the UI extension get the text result, which starts with the URL.

The card's CSP admits no outside origin. A live preview frame is off by
default; set `MCP_PREVIEW_ORIGIN` to a bare https origin (for example
`https://preview.example.com`) to turn it on. The resource CSP then names that
one origin in `frameDomains`, and each plug result carries
`<origin>/<entity_id>` in its `_meta` for the card to frame. Any other value is
ignored.

## Launch follow-ups
- **CORS / DNS-rebinding / allowed hosts.** Configure at deploy time for the public
  host.
