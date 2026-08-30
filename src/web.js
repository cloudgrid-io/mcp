// CloudGrid MCP server — web edition (HTTP, hosted).
//
// The same tool core as the local edition, served over the MCP Streamable HTTP
// transport so web clients (claude.ai) can connect by URL with nothing installed.
// The light, CLI-free toolset only: plug, claim, login. Identity is a per-session
// token held in memory for the life of the MCP session (no local files on a
// shared host).
//
// Transport-level OAuth (src/oauth.js): clients can complete the MCP-spec OAuth
// connect — metadata discovery, dynamic registration, PKCE code flow — bridged to
// CloudGrid's existing sign-in. A Bearer presented on /mcp requests becomes the
// session's identity. MCP_REQUIRE_AUTH=1 makes the connect mandatory (401
// challenge); default is anonymous-first with auth honored when presented.
//
// Run: PORT=8080 node src/web.js     Health: GET /healthz

import { installProxy } from "./proxy.js";
installProxy();

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  isInitializeRequest,
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
} from "@modelcontextprotocol/sdk/types.js";
import { registerTools } from "./tools.js";
import { mountOAuth, bearerChallenge } from "./oauth.js";
import { mountLanding } from "./landing.js";
import { createSessionLogger } from "./session-logger.js";
import { createSink } from "./log-sink.js";
import { INSTRUCTIONS_WEB } from "./playbook.js";
import { createWebIdentity } from "./web-identity.js";
import {
  logAuthChallenge,
  logNoSession,
  logRehydrateFailed,
  logInitialize,
} from "./web-observability.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));

const PORT = Number(process.env.PORT || 8080);

// This server's public origin — used in OAuth metadata and the interstitial.
const PUBLIC_BASE = (process.env.MCP_PUBLIC_URL || "https://mcp.cloudgrid.io").replace(/\/+$/, "");

// MCP_REQUIRE_AUTH=1 turns on the 401 challenge: clients must complete the OAuth
// connect before using tools. Default off — anonymous-first is the GTM posture.
const REQUIRE_AUTH = process.env.MCP_REQUIRE_AUTH === "1";

// The trusted-server credential, if this host is provisioned as one. Sent on
// anonymous drops so the platform keys the anon-drop cap on the per-user id rather
// than the shared cluster egress IP. Missing/bad secret falls back to the IP cap
// server-side, so it is safe to leave unset.
const TRUSTED_SERVER_SECRET = process.env.MCP_TRUSTED_SERVER_SECRET || null;

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
// The identity carries the request's transport token; auth is enforced in-band by
// the tool layer (needs_auth via grid_login / grid_plug), not by a transport gate.
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
    savedLocationNote: () => "You are signed in for this session.",
    trustedServer: TRUSTED_SERVER_SECRET
      ? { secret: TRUSTED_SERVER_SECRET, endUserId: sessionId }
      : null,
  };
}

const app = express();
app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: false })); // OAuth token exchange is form-encoded

app.get("/healthz", (_req, res) => res.json({ ok: true, edition: "web" }));

// The human-facing root page and favicon. Mounted on both postures; the auth line
// it renders is driven by the same REQUIRE_AUTH flag used below.
mountLanding(app, PUBLIC_BASE, { requireAuth: REQUIRE_AUTH });

mountOAuth(app, PUBLIC_BASE, { requireAuth: REQUIRE_AUTH });

// One transport per MCP session, keyed by the session id.
const transports = Object.create(null);
const sessionContexts = Object.create(null);

// Per the MCP authorization spec, a resource server that receives no usable
// credential answers 401 with a Bearer WWW-Authenticate challenge — the signal
// Claude web needs to re-run OAuth and render its native login UI. Reused for
// the missing, expired, and invalid transport-token cases.
function sendAuthChallenge(res) {
  res.setHeader("WWW-Authenticate", bearerChallenge(PUBLIC_BASE));
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Authorization required. Complete the OAuth connect." },
    id: null,
  });
}

function captureRequestIdentity(sessionId, jwt) {
  if (!jwt) return;
  const ctx = sessionContexts[sessionId];
  if (!ctx) return;
  const { identityChanged } = ctx.identity.captureTransportToken(jwt);
  if (identityChanged) {
    ctx.state.identityChanged = true;
    ctx.state.pendingLoginCode = null;
    ctx.state.authChoiceOffered = false;
  }
}

// Build a fresh MCP session — server + transport + per-session identity context —
// keyed by `sessionId`. `sessionId` is also the trusted-server end-user id and,
// for a rehydrated (restart-evicted) session, the id the client keeps presenting.
// Identity derives ONLY from the credential passed here (`jwt`), never from
// anything remembered about the id: a session id is not proof of identity.
async function buildSession(sessionId, jwt, protocolVersion) {
  const identity = createWebIdentity({ initialTransportToken: jwt });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => sessionId,
    onsessioninitialized: (sid) => {
      transports[sid] = transport;
    },
  });
  transport.onclose = () => {
    // Flush the QA log when the host closes the session (abandoned / build-only).
    // Fire-and-forget; never blocks the close path.
    try { webCtx.logger?.flush("abandoned").catch(() => {}); } catch { /* never */ }
    if (transport.sessionId) {
      delete transports[transport.sessionId];
      delete sessionContexts[transport.sessionId];
    }
  };
  const server = new McpServer({ name: "cloudgrid-mcp-web", version }, { instructions: INSTRUCTIONS_WEB });
  const webCtx = makeWebContext(sessionId, identity);
  sessionContexts[sessionId] = webCtx;
  // QA session log for this MCP session (dark by default). Keyed by the session
  // id — the host connection boundary. No seed user_request here: current hosts
  // don't forward the first message. The model-as-courier path fills it instead —
  // grid_plug's user_request arg lifts the ask into the log (setUserRequest);
  // absent that, the log records the explicit not-provided line.
  webCtx.sessionId = sessionId;
  webCtx.logger = createSessionLogger({
    transport: "hosted",
    sessionId,
    sink: createSink(process.env),
    ctx: webCtx,
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

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let transport = sessionId ? transports[sessionId] : undefined;
  const jwt = bearerOf(req);

  if (REQUIRE_AUTH && !jwt) {
    // #353: name WHY no usable Bearer was found — absent / not-bearer / empty-token
    // — without revealing the token. This is the whole diagnostic value of the 401.
    logAuthChallenge(req);
    sendAuthChallenge(res);
    return;
  }

  if (transport) {
    // Capture the request's transport token into the session identity — #279: an
    // explicit in-session login stays authoritative over an expired transport
    // token. Do NOT gate on expiry here. #288 added a transport-level 401 on an
    // expired/invalid Bearer (the "#286 challenge"); it shipped in 0.21.3/0.21.4,
    // was pulled from production (manifests re-pinned to 0.21.2) hours later, and
    // #286 is closed not-planned. Auth on this connector is IN-BAND via grid_login
    // / grid_plug (2026-08-23 founder decision), so a transport 401 on expiry is
    // wrong by design — it bricks the client with grid_login behind the same 401.
    // An expired-but-present Bearer must reach the tool layer, where the needs_auth
    // ask is the recovery path. The only auth gate is the missing-Bearer guard at
    // the top of this handler (the deployed v0.21.2 posture).
    captureRequestIdentity(sessionId, jwt);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  const isInit = isInitializeRequest(req.body);

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
    // A genuine new session — mint a fresh id. The only auth gate is the top-of-
    // handler missing-Bearer guard (the deployed v0.21.2 posture); the #288
    // expired-Bearer transport 401 is reverted (see the transport-present block
    // above), so an expired-but-present Bearer proceeds to the tool layer where
    // the in-band needs_auth ask lives, rather than being challenged.
    const newSessionId = randomUUID();
    ({ transport } = await buildSession(newSessionId, jwt, negotiateProtocol(req.body?.params?.protocolVersion)));
    await transport.handleRequest(req, res, req.body);
    return;
  }

  // A stale session id the process no longer knows — a non-initialize call whose
  // session was evicted by a pod restart (#292). Rebuild ON THE SAME id the client
  // keeps presenting, so it recovers without reconnecting. Identity comes ONLY from
  // this request's Bearer; the stale id carries no remembered identity, and a
  // rebuilt session legitimately loses the prior in-memory explicit-login override
  // — degrading to a fresh grid_login, never silently reusing a login (#279/#280).
  //
  // No auth gate beyond the top-of-handler missing-Bearer guard (the deployed
  // v0.21.2 posture): auth on the connected edge is IN-BAND via grid_login /
  // grid_plug (2026-08-23 founder decision), so an expired-but-present Bearer — a
  // connected session after a restart — must rebuild and reach the tool layer where
  // the needs_auth ask is the recovery path, NOT be challenged with grid_login
  // stuck behind the same 401 (the #286 brick, on the rebuild path). Gating on
  // expiry (hasUsableCredential) here is exactly what #288 got wrong and was pulled
  // from production for.
  ({ transport } = await buildSession(sessionId, jwt, negotiateProtocol(req.headers["mcp-protocol-version"])));
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
    delete transports[sessionId];
    delete sessionContexts[sessionId];
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
  const transport = sessionId ? transports[sessionId] : undefined;
  if (!transport) {
    res.status(400).send("Invalid or missing session id");
    return;
  }
  const jwt = bearerOf(req);
  captureRequestIdentity(sessionId, jwt);
  await transport.handleRequest(req, res);
}

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.error(
    `cloudgrid-mcp web edition listening on :${PORT} (POST /mcp, GET /healthz, OAuth ${REQUIRE_AUTH ? "required" : "optional"})`,
  );
});
