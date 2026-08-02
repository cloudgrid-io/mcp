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
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { registerTools, decodeJwt } from "./tools.js";
import { mountOAuth, bearerChallenge } from "./oauth.js";
import { mountLanding } from "./landing.js";
import { createSessionLogger } from "./session-logger.js";
import { createSink } from "./log-sink.js";
import { INSTRUCTIONS_WEB } from "./playbook.js";

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

// Transport-level identity per MCP session: a Bearer presented on /mcp requests
// becomes the session's CloudGrid identity (takes precedence over in-tool login).
const sessionAuth = Object.create(null); // sid -> jwt

function bearerOf(req) {
  const h = req.headers.authorization;
  return h && /^Bearer\s+\S+/i.test(h) ? h.replace(/^Bearer\s+/i, "") : null;
}

function isTokenExpired(jwt) {
  if (!jwt) return false;
  const claims = decodeJwt(jwt);
  return Boolean(claims.exp && claims.exp * 1000 <= Date.now());
}

// A web session: identity lives in memory for the session's lifetime only. The
// session id doubles as the stable, opaque end-user id for the trusted-server cap.
function makeWebContext(sessionId) {
  let sessionToken = null;
  return {
    edition: "web",
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
    canOpenBrowser: false,
    getToken: async () => {
      const jwt = sessionAuth[sessionId] ?? sessionToken;
      if (jwt && isTokenExpired(jwt)) return null;
      return jwt;
    },
    getCredentialsStatus: async () => {
      const jwt = sessionAuth[sessionId] ?? sessionToken;
      if (!jwt) return { creds: null, expired: false };
      if (isTokenExpired(jwt)) return { creds: null, expired: true };
      return { creds: { jwt }, expired: false };
    },
    getActiveGrid: async () => null,
    saveToken: async (jwt) => {
      sessionToken = jwt;
      return decodeJwt(jwt);
    },
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

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let transport = sessionId ? transports[sessionId] : undefined;
  const jwt = bearerOf(req);

  if (REQUIRE_AUTH && !jwt) {
    res.setHeader("WWW-Authenticate", bearerChallenge(PUBLIC_BASE));
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Authorization required. Complete the OAuth connect." },
      id: null,
    });
    return;
  }

  if (transport) {
    if (jwt) {
      const prev = sessionAuth[sessionId];
      if (prev) {
        const prevSub = decodeJwt(prev).sub;
        const newSub = decodeJwt(jwt).sub;
        if (prevSub && newSub && prevSub !== newSub) {
          const ctxForSession = sessionContexts[sessionId];
          if (ctxForSession) {
            ctxForSession.state.identityChanged = true;
            ctxForSession.state.pendingLoginCode = null;
            ctxForSession.state.authChoiceOffered = false;
          }
        }
      }
      sessionAuth[sessionId] = jwt;
    }
    await transport.handleRequest(req, res, req.body);
    return;
  }

  if (sessionId || !isInitializeRequest(req.body)) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "No valid session. Send an initialize request first." },
      id: null,
    });
    return;
  }

  // New session: fresh server + per-session identity context. Generate the session
  // id up front so it is also the trusted-server end-user id. (Distinct name from
  // the incoming `sessionId` header above.)
  const newSessionId = randomUUID();
  if (jwt) sessionAuth[newSessionId] = jwt;
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => newSessionId,
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
      delete sessionAuth[transport.sessionId];
      delete sessionContexts[transport.sessionId];
    }
  };
  const server = new McpServer({ name: "cloudgrid-mcp-web", version }, { instructions: INSTRUCTIONS_WEB });
  const webCtx = makeWebContext(newSessionId);
  sessionContexts[newSessionId] = webCtx;
  // QA session log for this MCP session (dark by default). Keyed by the session
  // id — the host connection boundary. No seed user_request here: current hosts
  // don't forward the first message. The model-as-courier path fills it instead —
  // grid_plug's user_request arg lifts the ask into the log (setUserRequest);
  // absent that, the log records the explicit not-provided line.
  webCtx.sessionId = newSessionId;
  webCtx.logger = createSessionLogger({
    transport: "hosted",
    sessionId: newSessionId,
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
  };
  await server.connect(transport);
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
  if (jwt) {
    const prev = sessionAuth[sessionId];
    if (prev) {
      const prevSub = decodeJwt(prev).sub;
      const newSub = decodeJwt(jwt).sub;
      if (prevSub && newSub && prevSub !== newSub) {
        const ctxForSession = sessionContexts[sessionId];
        if (ctxForSession) {
          ctxForSession.state.identityChanged = true;
          ctxForSession.state.pendingLoginCode = null;
          ctxForSession.state.authChoiceOffered = false;
        }
      }
    }
    sessionAuth[sessionId] = jwt;
  }
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
