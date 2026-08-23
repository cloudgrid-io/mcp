// Restart-recovery for the hosted web edition — issue #292.
//
// Hosted MCP sessions live in process memory (`transports` / `sessionContexts`).
// A pod restart evicts them all; the client keeps presenting the same stale
// mcp-session-id and, before this fix, every subsequent tool call 400'd
// ("No valid session. Send an initialize request first.") with no in-conversation
// recovery. Claude web does not re-initialize on that signal, so the user was
// bricked until they disconnected/reconnected in client settings.
//
// The fix: on a non-initialize request carrying an unknown session id, rebuild a
// fresh session ON THE SAME id (priming the SDK transport with a synthetic
// initialize) and serve the call. Identity derives ONLY from the credential on
// that request — never from anything remembered about the id.
//
// This exercises a REAL process restart, not a unit stub: a child establishes a
// session, is killed, and a fresh child boots on the SAME port with empty memory;
// the SAME stale session id must then complete a tool call.
//
// Two editions run in parallel:
//   - anon      (MCP_REQUIRE_AUTH=0) — the default GTM posture.
//   - connected (MCP_REQUIRE_AUTH=1) — mcp-connected.cloudgrid.io, where auth is
//     IN-BAND via grid_login. Here the rebuild path must gate on a MISSING Bearer
//     only, never expiry: an expired-but-present Bearer (a connected session after
//     a restart) must rebuild and reach the tool layer, NOT draw a 401 the client
//     cannot answer (the #286 brick). That is the P0 this file guards.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

const nowSeconds = Math.floor(Date.now() / 1000);
const userA = jwt({ sub: "user-a", email: "alice@example.com", exp: nowSeconds + 3600 });
const userB = jwt({ sub: "user-b", email: "bob@example.com", exp: nowSeconds + 3600 });
const expiredBearer = jwt({ sub: "user-a", email: "alice@example.com", exp: nowSeconds - 60 });

const PROTOCOL_VERSION = "2025-06-18";
const INITIALIZE_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "restart-recovery", version: "0.0.0" },
  },
};

async function listen(server, p = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(p, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

async function reservePort() {
  const reservation = createServer();
  const p = await listen(reservation);
  await closeServer(reservation);
  return p;
}

// One edition of the web server, pinned to a fixed port so it can be restarted
// in place. CLOUDGRID_API_URL points at a closed loopback port so no test ever
// touches production; grid_login tolerates the resulting connection error and
// still returns a login URL built from the public base.
function makeHandle(requireAuth) {
  return { requireAuth, port: null, baseUrl: null, child: null, childClosed: null };
}

function childEnv(h) {
  return {
    PORT: String(h.port),
    MCP_PUBLIC_URL: h.baseUrl,
    MCP_REQUIRE_AUTH: h.requireAuth ? "1" : "0",
    CLOUDGRID_API_URL: "http://127.0.0.1:1",
    CLOUDGRID_PUBLIC_API_URL: "http://127.0.0.1:1",
    CLOUDGRID_QA_SLACK_WEBHOOK: "",
    MCP_TRUSTED_SERVER_SECRET: "",
    HTTPS_PROXY: "", HTTP_PROXY: "", ALL_PROXY: "",
    https_proxy: "", http_proxy: "", all_proxy: "",
    NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1",
  };
}

async function waitForHealth(h, getStderr) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (h.child.exitCode !== null || h.child.signalCode !== null) {
      throw new Error(`web child exited before becoming healthy (${h.child.exitCode}):\n${getStderr()}`);
    }
    try {
      const response = await fetch(`${h.baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // still starting
    }
    await sleep(50);
  }
  throw new Error(`web child did not become healthy:\n${getStderr()}`);
}

// Boot the web edition on its fixed port. Retries the bind briefly: a just-killed
// predecessor can hold the port for a beat even with SO_REUSEADDR.
async function startChild(h) {
  let stderr = "";
  for (let attempt = 1; attempt <= 20; attempt++) {
    stderr = "";
    h.child = spawn(process.execPath, ["src/web.js"], {
      env: childEnv(h),
      stdio: ["ignore", "ignore", "pipe"],
    });
    h.childClosed = new Promise((resolve) => h.child.once("close", resolve));
    h.child.stderr.setEncoding("utf8");
    h.child.stderr.on("data", (chunk) => { stderr += chunk; });
    try {
      await waitForHealth(h, () => stderr);
      return;
    } catch (err) {
      await stopChild(h);
      if (attempt < 20 && /EADDRINUSE/.test(stderr)) { await sleep(100); continue; }
      throw err;
    }
  }
}

async function stopChild(h) {
  if (!h.child) return;
  if (h.child.exitCode === null && h.child.signalCode === null) h.child.kill("SIGTERM");
  const closed = await Promise.race([
    h.childClosed.then(() => true),
    sleep(1500).then(() => false),
  ]);
  if (!closed) {
    h.child.kill("SIGKILL");
    await h.childClosed;
  }
  h.child = null;
  h.childClosed = null;
}

// Restart: fully stop the current process (evicting all in-memory sessions), then
// boot a fresh one on the SAME port. This is the pod restart the bug is about.
async function restart(h) {
  await stopChild(h);
  await startChild(h);
}

// One JSON-RPC data frame out of an SSE (or plain-JSON) MCP response body.
function parseMessage(text) {
  const frames = [];
  for (const line of text.split("\n")) {
    const trimmed = line.replace(/\r$/, "");
    if (trimmed.startsWith("data:")) frames.push(trimmed.slice(5).trim());
  }
  const payloads = frames.length ? frames : [text];
  for (const raw of payloads) {
    if (!raw) continue;
    try {
      const msg = JSON.parse(raw);
      if (msg && (msg.result !== undefined || msg.error !== undefined)) return msg;
    } catch {
      // not this frame
    }
  }
  return null;
}

async function rawPost(h, { bearer, body, sessionId, protocolVersion = PROTOCOL_VERSION }) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (bearer != null) headers.Authorization = `Bearer ${bearer}`;
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  if (protocolVersion) headers["Mcp-Protocol-Version"] = protocolVersion;
  const response = await fetch(`${h.baseUrl}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    sessionId: response.headers.get("mcp-session-id"),
    wwwAuthenticate: response.headers.get("www-authenticate"),
    text,
    message: parseMessage(text),
  };
}

// Open a real session and return its server-assigned mcp-session-id.
async function openSession(h, bearer) {
  const res = await rawPost(h, { bearer, body: INITIALIZE_BODY, protocolVersion: null });
  assert.equal(res.status, 200, `initialize should succeed:\n${res.text}`);
  assert.ok(res.sessionId, "initialize must return an mcp-session-id header");
  return res.sessionId;
}

function toolCall(id, name, args = {}) {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

const anon = makeHandle(false);
const connected = makeHandle(true);

before(async () => {
  anon.port = await reservePort();
  anon.baseUrl = `http://127.0.0.1:${anon.port}`;
  connected.port = await reservePort();
  connected.baseUrl = `http://127.0.0.1:${connected.port}`;
  await startChild(anon);
  await startChild(connected);
});

after(async () => {
  await stopChild(anon);
  await stopChild(connected);
});

test("stale session id from before a restart completes a tool call (the #292 acceptance test)", async () => {
  const sessionId = await openSession(anon, userA);

  // Pre-restart: the tool call works normally.
  const before = await rawPost(anon, { bearer: userA, body: toolCall(2, "grid_start"), sessionId });
  assert.equal(before.status, 200, `pre-restart grid_start should work:\n${before.text}`);
  assert.ok(before.message?.result, "pre-restart grid_start returned a result");

  // The pod restarts. Every in-memory session is gone.
  await restart(anon);

  // The SAME stale session id must complete a tool call, not 400 — the recovery
  // below is what makes it work again, not a surviving session.
  const recovered = await rawPost(anon, { bearer: userA, body: toolCall(3, "grid_start"), sessionId });
  assert.equal(
    recovered.status,
    200,
    `after a restart, the SAME stale session id must complete a tool call, not 400:\n${recovered.text}`,
  );
  const structured = recovered.message?.result?.structuredContent;
  assert.ok(structured?.playbook, "recovered grid_start returned the playbook");
  assert.ok(Array.isArray(structured?.workflows), "recovered grid_start returned workflows");
  assert.equal(structured.context.signed_in, true, "still signed in via the request's Bearer");
  assert.equal(structured.context.email, "alice@example.com", "identity is Alice's, from her Bearer");
});

test("a rebuilt session takes its identity from the request's credential, never the stale id (isolation)", async () => {
  // Alice opens a session and it resolves to her.
  const sessionId = await openSession(anon, userA);
  const asAlice = await rawPost(anon, { bearer: userA, body: toolCall(2, "grid_start"), sessionId });
  assert.equal(asAlice.message?.result?.structuredContent?.context?.email, "alice@example.com");

  await restart(anon);

  // Bob's client happens to present Alice's old session id, but Bob's Bearer.
  // The rebuilt session MUST resolve to Bob — a session id is not proof of
  // identity. Getting this wrong is a cross-account credential leak.
  const asBob = await rawPost(anon, { bearer: userB, body: toolCall(3, "grid_start"), sessionId });
  assert.equal(asBob.status, 200, `Bob's rehydrated call should succeed:\n${asBob.text}`);
  const ctx = asBob.message?.result?.structuredContent?.context;
  assert.equal(ctx?.signed_in, true, "Bob is signed in");
  assert.equal(ctx?.email, "bob@example.com", "the rebuilt session resolves to Bob");
  assert.notEqual(ctx?.email, "alice@example.com", "Alice's identity must NOT leak onto Bob's request");
  assert.ok(
    !asBob.text.includes("alice@example.com"),
    "no trace of Alice's identity anywhere in Bob's rehydrated response",
  );
});

test("the anonymous publish path recovers from a stale session (no credential needed)", async () => {
  // A guest (no Bearer) opens a session, then a restart evicts it.
  const sessionId = await openSession(anon, null);
  await restart(anon);

  // A non-initialize call with NO Bearer on the stale id must still be served —
  // guest publishing must never depend on session survival (#292 criterion 4).
  const recovered = await rawPost(anon, { bearer: null, body: toolCall(3, "grid_start"), sessionId });
  assert.equal(
    recovered.status,
    200,
    `an anonymous stale-session call must recover, not 400:\n${recovered.text}`,
  );
  const ctx = recovered.message?.result?.structuredContent?.context;
  assert.equal(ctx?.signed_in, false, "still anonymous after recovery");
});

test("grid_login is reachable from a stale-session state (recovery path stays open)", async () => {
  const sessionId = await openSession(anon, null);
  await restart(anon);

  // The exact constraint #286 violated: the recovery tools must work from any
  // session state. grid_login on a stale (evicted) session must return a login
  // URL, not a bricked error.
  const res = await rawPost(anon, { bearer: null, body: toolCall(3, "grid_login"), sessionId });
  assert.equal(res.status, 200, `grid_login must be reachable after a restart:\n${res.text}`);
  const loginUrl = res.message?.result?.structuredContent?.login_url;
  assert.ok(loginUrl && /\/auth\/login\?/.test(loginUrl), `grid_login returned a login URL: ${loginUrl}`);
});

test("a brand-new connection with no session id and no initialize still 400s (unchanged)", async () => {
  // The recovery only applies to a stale session id. A first-contact non-init
  // request with no id at all is a genuine protocol error and must still fail.
  const res = await rawPost(anon, { bearer: null, body: toolCall(3, "grid_start"), sessionId: null });
  assert.equal(res.status, 400, "no session id + no initialize is still a 400");
  assert.match(res.text, /No valid session/);
});

// --- Connected edge (MCP_REQUIRE_AUTH=1) — the P0 this review caught ----------
//
// On mcp-connected, auth is IN-BAND via grid_login (founder decision
// 2026-08-23). The rebuild path must mirror the DEPLOYED transport guard
// literally — a MISSING Bearer only, never expiry. An expired-but-present Bearer
// is exactly the connected co-founder's session after a restart; if the rebuild
// path consulted expiry it would 401 him behind a challenge his client cannot
// answer, with grid_login stuck behind the same 401 — the #286 brick rebuilt on
// the rebuild path. This is the class the anon-only tests above cannot catch.

test("[#292 connected] stale session + EXPIRED Bearer rebuilds and serves, does NOT 401", async () => {
  // Open a session with a valid Bearer (initialize needs one under REQUIRE_AUTH),
  // then the pod restarts and the token has since expired — the co-founder's
  // scenario. The stale-session tool call must reach the tool layer (200), where
  // the in-band needs_auth ask is the recovery path — not draw a transport 401.
  const sessionId = await openSession(connected, userA);
  await restart(connected);

  const res = await rawPost(connected, {
    bearer: expiredBearer,
    body: toolCall(3, "grid_start"),
    sessionId,
  });
  assert.equal(
    res.status,
    200,
    `an expired-but-present Bearer on a stale session must rebuild and serve, not 401:\n${res.text}`,
  );
  assert.equal(res.wwwAuthenticate, null, "a proceeding rebuild must not carry a WWW-Authenticate challenge");
  const ctx = res.message?.result?.structuredContent?.context;
  assert.equal(ctx?.signed_in, false, "an expired token is not signed in");
  assert.equal(ctx?.session_expired, true, "grid_start reports the expiry in-band, the recovery path");
});

test("[#292 connected] stale session + MISSING Bearer still challenges (deployed guard preserved)", async () => {
  // The other half of the deployed `if (REQUIRE_AUTH && !jwt)` guard: no anonymous
  // on the connected edge. A stale-session call with no Bearer at all still draws
  // the 401 challenge, exactly as production does today.
  const sessionId = await openSession(connected, userA);
  await restart(connected);

  const res = await rawPost(connected, {
    bearer: null,
    body: toolCall(3, "grid_start"),
    sessionId,
  });
  assert.equal(res.status, 401, `a missing Bearer under REQUIRE_AUTH must still challenge:\n${res.text}`);
  assert.match(res.wwwAuthenticate ?? "", /^Bearer\b/i, "expected a Bearer WWW-Authenticate challenge");
});
