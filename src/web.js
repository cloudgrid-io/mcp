// CloudGrid MCP server — web edition (HTTP, hosted).
//
// The same tool core as the local edition, served over the MCP Streamable HTTP
// transport so web clients (claude.ai) can connect by URL with nothing installed.
// The light, CLI-free toolset only. Identity is the access token the client
// presents on each request (no local files on a shared host).
//
// Sign-in (src/web-auth.js, src/oauth.js, src/mcp-tokens.js): the MCP-spec OAuth
// connect — metadata discovery, dynamic registration, PKCE code flow — bridged to
// CloudGrid's existing sign-in, on every host. Browsing tools work signed out;
// every other tool needs an account, and each AI tool is asked to sign in the way
// it understands (authMode). A presented token is verified on every request.
//
// Run: PORT=8080 node src/web.js     Health: GET /healthz

import { installProxy } from "./proxy.js";
installProxy();

import { readFileSync } from "node:fs";
import express from "express";
import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  isInitializeRequest,
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
} from "@modelcontextprotocol/sdk/types.js";
import { registerTools } from "./tools.js";
import { mountOAuth, createBaseResolver } from "./oauth.js";
import { createTokenService, resolveSealKeys, resolveSigningKeys } from "./mcp-tokens.js";
import {
  authMode,
  bearerChallenge,
  callsProtectedTool,
  createBearerResolver,
  createDownstreamExchanger,
  createPlatformValidator,
  observeApiRefusals,
  parseAuthModeOverrides,
  signInRequiredResult,
} from "./web-auth.js";
import { API_BASE } from "./tools/constants.js";
import { createRefreshStore, createMemoryBackend } from "./refresh-store.js";
import { createRedisClient } from "./redis-client.js";
import { mountLanding } from "./landing.js";
import { mountOpenAiChallenge } from "./openai-challenge.js";
import { createSessionLogger } from "./session-logger.js";
import { createSink } from "./log-sink.js";
import { INSTRUCTIONS_WEB } from "./playbook.js";
import { createWebIdentity } from "./web-identity.js";
import { createErrorHandler } from "./web-errors.js";
import {
  logAuthChallenge,
  logNoSession,
  logRehydrateFailed,
  logInitialize,
  logOriginRefused,
  logSessionCap,
  logSessionUnknown,
} from "./web-observability.js";
import {
  createOriginMatcher,
  originGuard,
  createSessionIds,
  sendRateLimited,
  clientIp,
  envInt,
} from "./web-guards.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));

const PORT = Number(process.env.PORT || 8080);

// This server's public origin — used in OAuth metadata and the interstitial.
const PUBLIC_BASE = (process.env.MCP_PUBLIC_URL || "https://mcp.cloudgrid.io").replace(/\/+$/, "");
// Other public origins served by this same server (MCP_ALIAS_URLS, comma
// separated), e.g. https://mcp-connected.cloudgrid.io. Each is answered for its
// own origin, and a token issued on any of them is accepted on all.
const ALIAS_BASES = String(process.env.MCP_ALIAS_URLS || "")
  .split(/[\s,]+/)
  .filter(Boolean)
  .map((u) => u.replace(/\/+$/, ""))
  .filter((u) => u !== PUBLIC_BASE);
const BASES = [PUBLIC_BASE, ...ALIAS_BASES];
const baseFor = createBaseResolver(BASES);

// Access tokens: signed by this server (MCP_TOKEN_SIGNING_KEYS), for this
// server's resources only.
const signing = resolveSigningKeys(process.env);
// Fail closed: a hosted server that holds the OAuth registration secret is a
// real deployment, and a per-process signing key there would issue tokens no
// other pod (and no later pod) can verify.
const LOCAL_PUBLIC_URL = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(PUBLIC_BASE);
if (signing.ephemeral && (process.env.MCP_OAUTH_HMAC_SECRET || !LOCAL_PUBLIC_URL)) {
  console.error(
    "cloudgrid-mcp: MCP_TOKEN_SIGNING_KEYS is not set. Refusing to start: a hosted server " +
      "(OAuth secret set, or a public MCP_PUBLIC_URL) needs a stable access-token signing key. " +
      "Local runs on http://127.0.0.1 or http://localhost may leave it unset.",
  );
  process.exit(1);
}
if (signing.ephemeral) {
  console.warn(
    "cloudgrid-mcp: MCP_TOKEN_SIGNING_KEYS is not set; access tokens are signed with a per-process key, " +
      "so every client must sign in again after a restart. Set it in production.",
  );
} else {
  console.error(`cloudgrid-mcp: access-token signing key configured (${signing.keys.length} key(s), signing kid ${signing.keys[0].kid.slice(0, 8)}…)`);
}
const tokens = createTokenService({
  keys: signing.keys,
  sealKeys: resolveSealKeys(process.env, signing.keys),
  issuers: BASES,
  audiences: BASES.map((b) => `${b}/mcp`),
});
const AUTH_MODE_OVERRIDES = parseAuthModeOverrides(process.env.MCP_AUTH_MODE_OVERRIDES);
const modeOf = (clientInfo) => authMode(clientInfo, AUTH_MODE_OVERRIDES);
// CloudGrid session tokens presented directly as the Bearer (what releases
// before 0.22 returned as the access token) are accepted only if they were
// issued before MCP_LEGACY_TOKENS_ISSUED_BEFORE (epoch seconds; set to the 0.22
// release time). Unset: 0, so none is accepted; a restart can never move the
// cutoff. No 0.22 server hands out a session token, so a newer one is not a
// pre-0.22 connection.
const LEGACY_ISSUED_BEFORE = envInt(process.env, "MCP_LEGACY_TOKENS_ISSUED_BEFORE", 0);
const validatePlatformToken = createPlatformValidator({ apiBase: API_BASE });
// A tool call the API refuses as signed out marks that session refused, so the
// client's next request gets a 401 and it signs in again (src/web-auth.js).
const exchangeDownstream = createDownstreamExchanger({ apiBase: API_BASE, trustedSecret: process.env.MCP_TRUSTED_SERVER_SECRET || null });
observeApiRefusals({
  apiBase: API_BASE,
  onRefused: (token) => validatePlatformToken.markRefused(exchangeDownstream.parentOf(token) ?? token),
});
const resolveBearer = createBearerResolver({
  tokens,
  validatePlatformToken,
  exchangeDownstream,
  isFamilyLive: (fam) => (refreshStore ? familyLive(fam) : true),
  legacyIssuedBefore: LEGACY_ISSUED_BEFORE,
});
const REFRESH_TOKEN_TTL_S = envInt(process.env, "MCP_REFRESH_TOKEN_TTL_S", 30 * 24 * 3600);

// The refresh-token store: Redis at MCP_REDIS_URL (password MCP_REDIS_PASSWORD,
// from a Secret). MCP_REFRESH_STORE=memory keeps it in this process instead
// (tests and local runs: it does not survive a restart and is not shared
// between replicas). Neither: no refresh tokens.
function createRefresh(env) {
  let backend = null;
  if (env.MCP_REDIS_URL) {
    backend = createRedisClient({ url: env.MCP_REDIS_URL, password: env.MCP_REDIS_PASSWORD || undefined });
    console.error(`cloudgrid-mcp: refresh tokens on, stored in Redis at ${new URL(env.MCP_REDIS_URL).host}`);
  } else if (env.MCP_REFRESH_STORE === "memory") {
    backend = createMemoryBackend();
    console.warn("cloudgrid-mcp: refresh tokens on, stored in this process only (MCP_REFRESH_STORE=memory)");
  } else {
    console.error("cloudgrid-mcp: no refresh store configured; access tokens are issued without refresh tokens");
    return null;
  }
  return createRefreshStore({ backend, refreshTtlSeconds: REFRESH_TOKEN_TTL_S, onRevoke: (fam) => familyLive.forget(fam) });
}

// Whether a refresh family is still live, for access tokens that name one.
// Positive answers are cached for 30 s; a revocation in this process takes
// effect at once (onRevoke above). Returns true | false | "unavailable".
const familyLive = (() => {
  const live = new Map(); // family -> until
  const revoked = new Set();
  const MAX = 5000;
  async function check(fam) {
    if (revoked.has(fam)) return false;
    const until = live.get(fam);
    if (until && until > Date.now()) return true;
    let ok;
    try {
      ok = await refreshStore.isLive(fam);
    } catch {
      return "unavailable";
    }
    if (live.size >= MAX) live.delete(live.keys().next().value);
    if (ok) live.set(fam, Date.now() + 30_000);
    return ok;
  }
  check.forget = (fam) => {
    live.delete(fam);
    if (revoked.size >= MAX) revoked.delete(revoked.keys().next().value);
    revoked.add(fam);
  };
  return check;
})();
const refreshStore = createRefresh(process.env);

// Access-token lifetime: one setting, MCP_ACCESS_TOKEN_TTL_S. Its default
// follows the refresh store:
//   - store on: 1 hour, renewed by rotating refresh tokens;
//   - no store (or a store failure at sign-in): 30 days (founder decision on
//     cloudgrid#5783, fallback B), never past the CloudGrid session sealed in
//     the token, and every call checks with the API, cached at most 30 s, that
//     the session is not signed out, so a sign-out takes effect on the next call.
// Turning the store on changes only what is issued; clients see no difference.
const ACCESS_TOKEN_TTL_NO_REFRESH_S = envInt(process.env, "MCP_ACCESS_TOKEN_TTL_S", 30 * 24 * 3600);
const ACCESS_TOKEN_TTL_S = refreshStore ? envInt(process.env, "MCP_ACCESS_TOKEN_TTL_S", 3600) : ACCESS_TOKEN_TTL_NO_REFRESH_S;

// The trusted-server credential, if this host is provisioned as one. Sent on
// anonymous drops so the platform keys the anon-drop cap on the per-user id rather
// than the shared cluster egress IP. Missing/bad secret falls back to the IP cap
// server-side, so it is safe to leave unset.
const TRUSTED_SERVER_SECRET = process.env.MCP_TRUSTED_SERVER_SECRET || null;

// --- Edge limits -------------------------------------------------------------
// Sessions live in this process's memory, so their number is capped and idle
// ones are swept. A client whose session was swept keeps working: its next
// request carries an id this edge issued, which is rebuilt in place (below).
// A session holds a full server and transport, about 0.8 MB resident when
// measured; 300 keeps a 512 MiB container clear of its limit. 0 = no cap.
const MAX_SESSIONS = envInt(process.env, "MCP_MAX_SESSIONS", 300);
const SESSION_IDLE_TTL_MS = envInt(process.env, "MCP_SESSION_IDLE_TTL_MS", 30 * 60 * 1000);
const SESSION_SWEEP_MS = envInt(process.env, "MCP_SESSION_SWEEP_MS", 60 * 1000);
// Proxies in front of this process that append to X-Forwarded-For (the ingress).
const PROXY_HOPS = envInt(process.env, "MCP_TRUSTED_PROXY_HOPS", 1);
// Per-client-IP request budgets, per minute (0 turns one off). The OAuth
// register and token calls, and /mcp traffic, come from the connectors'
// servers, so one address can carry many users: those budgets are sized for that.
const RATE_LIMITS = {
  register: envInt(process.env, "MCP_RATE_OAUTH_REGISTER", 60),
  authorize: envInt(process.env, "MCP_RATE_OAUTH_AUTHORIZE", 30),
  token: envInt(process.env, "MCP_RATE_OAUTH_TOKEN", 120),
  mcp: envInt(process.env, "MCP_RATE_MCP", 1200),
  initialize: envInt(process.env, "MCP_RATE_MCP_INITIALIZE", 600),
};

const isOriginAllowed = createOriginMatcher({ publicBase: PUBLIC_BASE });
const sessionIds = createSessionIds({ publicBase: PUBLIC_BASE });
if (sessionIds.ephemeral) {
  console.warn(
    "cloudgrid-mcp: no MCP_SESSION_SECRET or MCP_TRUSTED_SERVER_SECRET set; session ids are signed with a " +
      "per-process key, so sessions are not rebuilt after a restart (clients are asked to initialize again).",
  );
}
// A fixed one-minute window per client IP, in this process's memory. The key is
// the rightmost X-Forwarded-For entry (clientIp), so Express's own `trust proxy`
// is not used; IPv6 addresses are grouped by /56 (ipKeyGenerator). Over the
// budget: 429 with Retry-After, JSON-RPC shaped on /mcp.
function perIpLimit(perMinute, { jsonRpc = false, skip } = {}) {
  return rateLimit({
    windowMs: 60_000,
    limit: Math.max(1, perMinute),
    skip: perMinute > 0 ? skip : () => true,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(clientIp(req, PROXY_HOPS)),
    handler: (_req, res) => sendRateLimited(res, Number(res.getHeader("Retry-After")) || 60, { jsonRpc }),
    // The client address comes from keyGenerator, not req.ip.
    validate: { xForwardedForHeader: false, trustProxy: false },
  });
}
const limit = {
  register: perIpLimit(RATE_LIMITS.register),
  authorize: perIpLimit(RATE_LIMITS.authorize),
  token: perIpLimit(RATE_LIMITS.token),
  mcp: perIpLimit(RATE_LIMITS.mcp, { jsonRpc: true }),
  initialize: perIpLimit(RATE_LIMITS.initialize, { jsonRpc: true, skip: (req) => !isInitializeRequest(req.body) }),
};

function bearerOf(req) {
  const h = req.headers.authorization;
  return h && /^Bearer\s+\S+/i.test(h) ? h.replace(/^Bearer\s+/i, "") : null;
}

// Negotiate the MCP protocol version with the same rule the SDK's _oninitialize
// uses (a supported requested version wins, else LATEST). Used only to report the
// negotiated version on the session-established log line (#353) — the SDK exposes
// no getter for it post-init — and to build the synthetic rehydrate initialize.
function negotiateProtocol(requested) {
  return typeof requested === "string" && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : LATEST_PROTOCOL_VERSION;
}

// A web session: identity lives in memory for the session's lifetime only. The
// session id doubles as the stable, opaque end-user id for the trusted-server cap.
// The identity carries the account credential of the request's verified token;
// the sign-in gate in the POST /mcp handler decides what may run without one.
function makeWebContext(sessionId, identity) {
  return {
    edition: "web",
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
    canOpenBrowser: false,
    identity,
    getToken: identity.getToken,
    getCredentialsStatus: identity.getCredentialsStatus,
    getActiveGrid: async () => null,
    saveToken: identity.saveToken,
    markTokenRevoked(jwt) { identity.markRevoked(jwt); },
    savedLocationNote: () => "You are signed in for this session.",
    trustedServer: TRUSTED_SERVER_SECRET
      ? { secret: TRUSTED_SERVER_SECRET, endUserId: sessionId }
      : null,
  };
}

const app = express();
// Origin check first, so a refused request is not parsed.
app.use(
  "/mcp",
  originGuard(isOriginAllowed, {
    onRefused: (origin) => logOriginRefused(origin),
  }),
);
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: false })); // OAuth token exchange is form-encoded

app.get("/healthz", (_req, res) => res.json({ ok: true, edition: "web" }));

// The human-facing root page and favicon.
mountLanding(app, PUBLIC_BASE);

// OpenAI app-directory domain verification (404 unless the token is set).
mountOpenAiChallenge(app, process.env.MCP_OPENAI_APPS_CHALLENGE);

// Rate limits run before the OAuth handlers. Exact paths: the interstitial's
// /oauth/authorize/poll is not limited here (it polls every two seconds).
app.post("/oauth/register", limit.register);
app.get("/oauth/authorize", limit.authorize);
app.post("/oauth/authorize/approve", limit.authorize);
app.post("/oauth/token", limit.token);

mountOAuth(app, {
  bases: BASES,
  tokens,
  accessTokenTtlSeconds: ACCESS_TOKEN_TTL_S,
  accessTokenTtlNoRefreshSeconds: ACCESS_TOKEN_TTL_NO_REFRESH_S,
  refresh: refreshStore,
  validatePlatformToken,
  isOriginAllowed,
});

// One transport per MCP session, keyed by the session id.
// Maps, not plain objects: the keys are client-supplied session ids.
const transports = new Map();
const sessionContexts = new Map();

function setSessionContext(sid, ctx) {
  sessionContexts.set(sid, ctx);
}

function dropSession(sid) {
  transports.delete(sid);
  sessionContexts.delete(sid);
}

function touchSession(sid) {
  const ctx = sessionContexts.get(sid);
  if (ctx) ctx.lastSeen = Date.now();
}

function atSessionCap() {
  return MAX_SESSIONS > 0 && sessionContexts.size >= MAX_SESSIONS;
}

function sendSessionCap(res) {
  logSessionCap(sessionContexts.size);
  res.setHeader("Retry-After", "30");
  res.status(503).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "The server is at its session limit. Try again shortly." },
    id: null,
  });
}

// Close sessions with no request for SESSION_IDLE_TTL_MS. The entry is dropped
// first; transport.close() then runs the transport's onclose, which flushes the
// session log (and leaves alone an entry rebuilt on the same id meanwhile).
function sweepIdleSessions(now = Date.now()) {
  if (SESSION_IDLE_TTL_MS <= 0) return;
  for (const [sid, ctx] of [...sessionContexts]) {
    if (now - (ctx.lastSeen ?? 0) < SESSION_IDLE_TTL_MS) continue;
    const transport = transports.get(sid);
    dropSession(sid);
    if (transport) transport.close().catch(() => {});
  }
}

if (SESSION_SWEEP_MS > 0) {
  setInterval(() => {
    sweepIdleSessions();
  }, SESSION_SWEEP_MS).unref();
}

// Per the MCP authorization spec, a resource server that receives no usable
// credential answers 401 with a Bearer WWW-Authenticate challenge, the signal a
// client acts on to run OAuth (or refresh its token) and retry.
function sendAuthChallenge(req, res, opts = {}) {
  res.setHeader("WWW-Authenticate", bearerChallenge(baseFor(req), { error: opts.error }));
  res.status(401).json({
    jsonrpc: "2.0",
    error: {
      code: -32001,
      message: opts.error === "invalid_token"
        ? "The access token is not valid. Sign in to CloudGrid again."
        : opts.atConnect
          ? "Sign in to CloudGrid to connect."
          : "Sign in to CloudGrid to use this tool.",
    },
    id: null,
  });
}

function sendAuthUnavailable(res) {
  res.setHeader("Retry-After", "5");
  res.status(503).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Sign-in could not be checked right now. Try again shortly." },
    id: null,
  });
}

// The account behind the request's Bearer, verified. Answers the request itself
// (401 or 503) and returns undefined when the Bearer is present but unusable;
// returns null when there is no Bearer.
async function requestPrincipal(req, res) {
  const bearer = bearerOf(req);
  if (!bearer) return null;
  const r = await resolveBearer(bearer);
  if (r.ok) return r;
  if (r.reason === "unavailable") {
    sendAuthUnavailable(res);
    return undefined;
  }
  logAuthChallenge(req, undefined, r.reason);
  sendAuthChallenge(req, res, { error: "invalid_token" });
  return undefined;
}

// A protected call with no account, in the "tool-error" mode: answered here
// with the tool error that carries the sign-in challenge. Only a single
// tools/call message is answered this way; anything else gets the 401.
function sendSignInToolError(req, res) {
  const body = req.body;
  if (Array.isArray(body) || body?.id === undefined) return false;
  res.status(200).json({ jsonrpc: "2.0", id: body.id, result: signInRequiredResult(baseFor(req)) });
  return true;
}

// A session belongs to one account. The first verified token on it binds the
// account; a session started signed out is bound when the user signs in (and
// its signed-out state is cleared). A token for another account on a bound
// session ends that session: the request gets 404 and the client starts a new
// one, so nothing a session remembers crosses to a different account.
// Returns false when it has answered the request.
// A request with no token on a bound session never runs as that account: the
// client lost its token, so it gets the challenge and signs in again. A session
// id is not proof of identity.
function bindRequestIdentity(req, sessionId, principal, res) {
  const ctx = sessionContexts.get(sessionId);
  if (!ctx) return true;
  if (!principal) {
    if (!ctx.boundSub) return true;
    logAuthChallenge(req, undefined, "bound-session-no-token");
    sendAuthChallenge(req, res, { error: "invalid_token" });
    return false;
  }
  if (ctx.boundSub && principal.sub !== ctx.boundSub) {
    const transport = transports.get(sessionId);
    dropSession(sessionId);
    if (transport) transport.close().catch(() => {});
    logSessionUnknown(sessionId);
    res.status(404).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Session not found. Send an initialize request to start a new session." },
      id: null,
    });
    return false;
  }
  if (!ctx.boundSub) {
    ctx.boundSub = principal.sub;
    ctx.state = { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null, client: ctx.state.client };
  }
  ctx.identity.captureTransportToken(principal.platformToken);
  return true;
}


// Build a fresh MCP session — server + transport + per-session identity context —
// keyed by `sessionId`. `sessionId` is also the trusted-server end-user id and,
// for a rehydrated (restart-evicted) session, the id the client keeps presenting.
// Identity derives ONLY from the credential passed here (`jwt`), never from
// anything remembered about the id: a session id is not proof of identity.
async function buildSession(sessionId, principal, protocolVersion, mode = "call") {
  const identity = createWebIdentity({ initialTransportToken: principal?.platformToken ?? null });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
    onsessioninitialized: (sid) => {
      transports.set(sid, transport);
    },
  });
  transport.onclose = () => {
    // No session-log post on close (#433): the hosted edition sends nothing
    // unless the user asks for it through grid_note or grid_report.
    if (transport.sessionId && transports.get(transport.sessionId) === transport) {
      dropSession(transport.sessionId);
    }
  };
  const server = new McpServer({ name: "cloudgrid-mcp-web", version }, { instructions: INSTRUCTIONS_WEB });
  const webCtx = makeWebContext(sessionId, identity);
  webCtx.lastSeen = Date.now();
  webCtx.authMode = mode;
  webCtx.boundSub = principal?.sub ?? null;
  setSessionContext(sessionId, webCtx);
  // Session logger for this MCP session (dark by default, and the hosted
  // servers carry no webhook). Explicit-only (#433): it never posts — not on a
  // plug, on idle, or on close. The hosted grid_note POSTs to the CloudGrid API
  // instead (runNote). No user_request seed and no courier args — the hosted
  // grid_plug schema has none.
  webCtx.sessionId = sessionId;
  webCtx.logger = createSessionLogger({
    transport: "hosted",
    sessionId,
    sink: createSink(process.env),
    ctx: webCtx,
    explicitOnly: true,
  });
  registerTools(server, webCtx);
  // Capture the calling agent's clientInfo (name+version) for this session once
  // the MCP handshake completes, so grid_report can attribute the origin
  // (which agent: Claude/ChatGPT/Cursor/…). Never fatal — missing → "unknown".
  server.server.oninitialized = () => {
    try {
      webCtx.state.client = server.server.getClientVersion() ?? null;
    } catch {
      webCtx.state.client = null;
    }
    // #353/#297: emit the session-established line UNCONDITIONALLY (id, protocol,
    // client) and then the best-effort #297 capability key-shape line. The two
    // are deliberately separate — see logInitialize: the fact that a session was
    // created must not depend on the swallow-everything capability probe, whose
    // silent non-firing on a good session sent the #329 diagnosis sideways.
    logInitialize(server.server, sessionId, protocolVersion);
  };
  await server.connect(transport);
  return { transport, identity };
}

// Drive an in-process MCP initialize so a freshly-built transport is usable
// WITHOUT the client sending its own initialize. This is the restart-recovery
// path: a client whose session was evicted by a pod restart keeps presenting the
// same stale mcp-session-id on ordinary tool calls and never re-initializes on
// its own (Claude web does not act on the transport's 400 — see #292). The SDK's
// StreamableHTTPServerTransport rejects any non-initialize request until it has
// seen an initialize ("Bad Request: Server not initialized"), so we feed it a
// synthetic initialize here — adopting the stale id via sessionIdGenerator — then
// serve the real request on the same session. Verified against the SDK: this sets
// _initialized, adopts the session id, and fires onsessioninitialized so the
// transport registers itself for reuse by the client's subsequent requests.
async function primeSession(transport, req) {
  const wst = transport._webStandardTransport;
  if (!wst || typeof wst.handleRequest !== "function") {
    throw new Error("cannot rehydrate session: transport internals unavailable");
  }
  const protocolVersion = negotiateProtocol(req.headers["mcp-protocol-version"]);
  const initBody = {
    jsonrpc: "2.0",
    id: "cg-rehydrate-init",
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "cloudgrid-mcp-rehydrate", version },
    },
  };
  const initReq = new Request(`${PUBLIC_BASE}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  });
  const initRes = await wst.handleRequest(initReq, { parsedBody: initBody });
  // Drain the synthetic initialize's SSE response so its stream closes and no
  // keep-alive timer leaks. The initialize result itself is discarded — the
  // client never sees it; it only ever sees the response to its real request.
  try { await initRes.text(); } catch { /* the init result is discarded either way */ }
}

// Every POST /mcp counts against the per-IP budget; initialize also against
// its own, smaller one.
app.post("/mcp", limit.mcp, limit.initialize, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let transport = sessionId ? transports.get(sessionId) : undefined;

  // The sign-in gate. A Bearer that is present but not valid (expired, for
  // another resource, forged, signed out) is a 401 on every request: the client
  // refreshes or signs in again. Sign-in is no longer in-band (grid_login is
  // gone from this edition), so the 401 always has a way out; this is what
  // makes the old #286 objection to an expiry 401 not apply any more.
  const principal = await requestPrincipal(req, res);
  if (principal === undefined) return;
  const isInit = isInitializeRequest(req.body);
  if (!principal) {
    // Any initialize, well-formed or not, so a client that never sends a valid
    // one still learns that sign-in is needed.
    const asksInitialize = !Array.isArray(req.body) && req.body?.method === "initialize";
    if (asksInitialize && modeOf(req.body?.params?.clientInfo) === "connect") {
      logAuthChallenge(req, undefined, "connect");
      sendAuthChallenge(req, res, { atConnect: true });
      return;
    }
    if (callsProtectedTool(req.body)) {
      const mode = transport ? sessionContexts.get(sessionId)?.authMode : undefined;
      if (mode === "tool-error" && sendSignInToolError(req, res)) return;
      logAuthChallenge(req, undefined, "protected-tool");
      sendAuthChallenge(req, res);
      return;
    }
  }

  if (transport) {
    // The verified account of this request becomes the session identity.
    if (!bindRequestIdentity(req, sessionId, principal, res)) return;
    touchSession(sessionId);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // A brand-new connection with no session id that is NOT an initialize is a real
  // protocol error — there is nothing to recover.
  if (!sessionId && !isInit) {
    // #353: 400 branch 1 — a brand-new connection that is not an initialize.
    logNoSession();
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "No valid session. Send an initialize request first." },
      id: null,
    });
    return;
  }

  if (isInit) {
    // A genuine new session — mint a fresh id. The sign-in gate above has
    // already run.
    if (atSessionCap()) {
      sendSessionCap(res);
      return;
    }
    const newSessionId = sessionIds.mint();
    ({ transport } = await buildSession(
      newSessionId,
      principal,
      negotiateProtocol(req.body?.params?.protocolVersion),
      modeOf(req.body?.params?.clientInfo),
    ));
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // A stale session id the process no longer knows — a non-initialize call whose
  // session was evicted by a pod restart (#292). Rebuild ON THE SAME id the client
  // keeps presenting, so it recovers without reconnecting. Identity comes ONLY from
  // this request's Bearer; the stale id carries no remembered identity, and a
  // rebuilt session legitimately loses the prior in-memory explicit-login override
  // — never silently reusing a login (#279/#280). The sign-in gate above has
  // already run for this request.
  //
  // Only an id this edge issued is rebuilt: the id's HMAC tag must verify (see
  // createSessionIds). Anything else is a session this server does not know, and
  // the transport spec's answer to that is 404, on which the client starts a new
  // session. A rebuild also counts against the session cap.
  if (!sessionIds.verify(sessionId)) {
    logSessionUnknown(sessionId);
    res.status(404).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Session not found. Send an initialize request to start a new session." },
      id: null,
    });
    return;
  }
  if (atSessionCap()) {
    sendSessionCap(res);
    return;
  }
  ({ transport } = await buildSession(sessionId, principal, negotiateProtocol(req.headers["mcp-protocol-version"])));
  // Rehydrate the evicted session. If priming fails (e.g. an SDK internal moved
  // out from under us), tear the half-built session down and fall back to the
  // original 400 rather than leaking a broken session or hanging the request —
  // a re-initialize still recovers the client.
  try {
    await primeSession(transport, req);
  } catch {
    // #353: 400 branch 2 — a stale-id rehydrate that could not be primed.
    logRehydrateFailed(sessionId);
    try { await transport.close(); } catch { /* best effort */ }
    dropSession(sessionId);
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "No valid session. Send an initialize request first." },
      id: null,
    });
    return;
  }
  await transport.handleRequest(req, res, req.body);
});

// SSE stream (GET) and session close (DELETE) reuse the same transport.
async function handleSessionRequest(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).send("Invalid or missing session id");
    return;
  }
  const principal = await requestPrincipal(req, res);
  if (principal === undefined) return;
  if (!bindRequestIdentity(req, sessionId, principal, res)) return;
  touchSession(sessionId);
  await transport.handleRequest(req, res);
}

app.get("/mcp", limit.mcp, handleSessionRequest);
app.delete("/mcp", limit.mcp, handleSessionRequest);

// Last middleware, after every route: any error a route did not answer itself
// gets a generic response, never Express's default error page. See web-errors.js.
app.use(createErrorHandler());

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.error(
    `cloudgrid-mcp web edition listening on :${PORT} (POST /mcp, GET /healthz; origins ${BASES.join(", ")})`,
  );
});
