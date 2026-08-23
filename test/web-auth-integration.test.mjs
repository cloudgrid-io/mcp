import test, { after, afterEach, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

const nowSeconds = Math.floor(Date.now() / 1000);
const expiredTransportA = jwt({
  sub: "first-user",
  email: "first@example.com",
  exp: nowSeconds - 60,
});
const freshTransportA = jwt({
  sub: "first-user",
  email: "first@example.com",
  exp: nowSeconds + 3600,
});
const explicitB = jwt({
  sub: "chosen-user",
  email: "chosen@example.com",
  exp: nowSeconds + 3600,
});
const refreshedTransportC = jwt({
  sub: "first-user",
  email: "first@example.com",
  exp: nowSeconds + 3600,
  jti: "refresh-c",
});
const refreshedTransportD = jwt({
  sub: "first-user",
  email: "first@example.com",
  exp: nowSeconds + 3600,
  jti: "refresh-d",
});
const differentTransportC = jwt({
  sub: "rotated-user-c",
  email: "rotated-c@example.com",
  exp: nowSeconds + 3600,
});

let mock;
// Two web children share the mock and helpers: the anonymous edge
// (MCP_REQUIRE_AUTH off, the #279 harness) and the connected edge
// (MCP_REQUIRE_AUTH on, where an expired/invalid Bearer must be challenged).
const anon = { child: null, childClosed: null, baseUrl: null };
const connected = { child: null, childClosed: null, baseUrl: null };
let actualStatusCalls = 0;
let client;
let transport;
let requestHeaders;
let rawGetController;

const CHILD_START_ATTEMPTS = 5;
const CHILD_STOP_TIMEOUT_MS = 1_000;
const CHILD_KILL_TIMEOUT_MS = 2_000;

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

async function reservePort() {
  const reservation = createServer();
  const port = await listen(reservation);
  await closeServer(reservation);
  return port;
}

async function waitForHealth(handle, getStderr) {
  const proc = handle.child;
  for (let attempt = 0; attempt < 80; attempt++) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`web child exited before becoming healthy (${proc.exitCode}):\n${getStderr()}`);
    }
    try {
      const response = await fetch(`${handle.baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // The child is still starting.
    }
    await sleep(50);
  }
  throw new Error(`web child did not become healthy:\n${getStderr()}`);
}

async function waitForClose(handle, timeoutMs) {
  if (!handle.childClosed) return true;
  let timer;
  try {
    return await Promise.race([
      handle.childClosed.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopChild(handle) {
  const child = handle.child;
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    if (!await waitForClose(handle, CHILD_KILL_TIMEOUT_MS)) {
      throw new Error("web child stdio did not close after exit");
    }
    return;
  }

  child.kill("SIGTERM");
  if (await waitForClose(handle, CHILD_STOP_TIMEOUT_MS)) return;

  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  if (!await waitForClose(handle, CHILD_KILL_TIMEOUT_MS)) {
    throw new Error("web child did not close after SIGKILL");
  }
}

function childEnv({ mcpPort, mockPort, requireAuth }) {
  const loopback = `http://127.0.0.1:${mockPort}`;
  return {
    PORT: String(mcpPort),
    MCP_PUBLIC_URL: `http://127.0.0.1:${mcpPort}`,
    MCP_REQUIRE_AUTH: requireAuth ? "1" : "0",
    CLOUDGRID_API_URL: loopback,
    CLOUDGRID_PUBLIC_API_URL: loopback,
    CLOUDGRID_QA_SLACK_WEBHOOK: "",
    MCP_TRUSTED_SERVER_SECRET: "",
    HTTPS_PROXY: "",
    HTTP_PROXY: "",
    ALL_PROXY: "",
    https_proxy: "",
    http_proxy: "",
    all_proxy: "",
    NO_PROXY: "localhost,127.0.0.1",
    no_proxy: "localhost,127.0.0.1",
  };
}

async function startChild(handle, { mockPort, requireAuth }) {
  for (let attempt = 1; attempt <= CHILD_START_ATTEMPTS; attempt++) {
    const mcpPort = await reservePort();
    handle.baseUrl = `http://127.0.0.1:${mcpPort}`;
    let attemptStderr = "";
    handle.child = spawn(process.execPath, ["src/web.js"], {
      env: childEnv({ mcpPort, mockPort, requireAuth }),
      stdio: ["ignore", "ignore", "pipe"],
    });
    handle.childClosed = new Promise((resolve) => handle.child.once("close", resolve));
    handle.child.stderr.setEncoding("utf8");
    handle.child.stderr.on("data", (chunk) => {
      attemptStderr += chunk;
    });

    try {
      await waitForHealth(handle, () => attemptStderr);
      return;
    } catch (err) {
      await stopChild(handle);
      if (attempt < CHILD_START_ATTEMPTS && /EADDRINUSE/.test(attemptStderr)) continue;
      throw err;
    }
  }
}

function structured(result) {
  return result?.structuredContent ?? result?.structured ?? {};
}

const INITIALIZE_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "raw-web-auth", version: "0.0.0" },
  },
};

const TOOLS_LIST_BODY = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };

// A raw POST /mcp, bypassing the MCP SDK so we can assert the exact HTTP status
// and WWW-Authenticate header the transport auth guard produces. Pass
// bearer:null to omit the Authorization header entirely.
async function rawPost(base, { bearer, body, sessionId, protocolVersion } = {}) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (bearer !== null && bearer !== undefined) headers.Authorization = `Bearer ${bearer}`;
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  if (protocolVersion) headers["Mcp-Protocol-Version"] = protocolVersion;
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  await response.body?.cancel().catch(() => {});
  return response;
}

async function connectSession(initialBearer, base = anon.baseUrl) {
  requestHeaders = new Headers({ Authorization: `Bearer ${initialBearer}` });
  transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: requestHeaders },
    // The SDK opens an optional long-lived GET after initialize. Decline that
    // client-managed stream so each test can issue and cancel its own real GET.
    fetch: (url, init) => init?.method === "GET"
      ? Promise.resolve(new Response(null, { status: 405 }))
      : fetch(url, init),
  });
  client = new Client({ name: "web-auth-integration", version: "0.0.0" });
  await client.connect(transport);
  assert.ok(transport.sessionId, "initialize returned an MCP session id");
}

async function issueSessionGet(bearer, base = anon.baseUrl) {
  rawGetController = new AbortController();
  const response = await fetch(`${base}/mcp`, {
    headers: {
      Authorization: `Bearer ${bearer}`,
      Accept: "text/event-stream",
      "Mcp-Session-Id": transport.sessionId,
      "Mcp-Protocol-Version": transport.protocolVersion,
    },
    signal: rawGetController.signal,
  });
  assert.equal(response.status, 200);
  rawGetController.abort();
  await response.body?.cancel().catch(() => {});
  rawGetController = null;
}

before(async () => {
  mock = createServer((req, res) => {
    const url = new URL(req.url, "http://mock.invalid");
    if (url.pathname === "/auth/status") {
      res.setHeader("Content-Type", "application/json");
      if (url.searchParams.get("code") === "connectivity-probe") {
        res.statusCode = 404;
        res.end(JSON.stringify({ status: "not_started" }));
        return;
      }
      actualStatusCalls++;
      res.end(JSON.stringify(
        actualStatusCalls === 1
          ? { status: "authenticated", jwt: explicitB }
          : { status: "pending" },
      ));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  try {
    const mockPort = await listen(mock);
    await startChild(anon, { mockPort, requireAuth: false });
    await startChild(connected, { mockPort, requireAuth: true });
  } catch (err) {
    try {
      await stopChild(anon);
      await stopChild(connected);
    } finally {
      await closeServer(mock);
    }
    throw err;
  }
});

beforeEach(() => {
  actualStatusCalls = 0;
  client = null;
  transport = null;
  requestHeaders = null;
  rawGetController = null;
});

afterEach(async () => {
  rawGetController?.abort();
  try {
    await client?.close();
  } catch {
    // Cleanup should not hide the assertion that failed.
  }
});

after(async () => {
  try {
    await stopChild(anon);
    await stopChild(connected);
  } finally {
    await closeServer(mock);
  }
});

test("explicit in-tool login survives later same-subject POST and GET transport refreshes", async () => {
  await connectSession(expiredTransportA);

  await client.callTool({ name: "grid_login", arguments: {} });
  const authenticated = structured(await client.callTool({ name: "grid_login_status", arguments: {} }));
  assert.deepEqual(authenticated, { status: "authenticated", email: "chosen@example.com" });

  requestHeaders.set("Authorization", `Bearer ${refreshedTransportC}`);
  const start = structured(await client.callTool({ name: "grid_start", arguments: {} }));
  assert.equal(start.context.signed_in, true);
  assert.equal(start.context.email, "chosen@example.com");
  assert.equal(start.context.identity_changed, undefined);

  await client.callTool({ name: "grid_login", arguments: {} });
  await issueSessionGet(refreshedTransportD);

  const pending = structured(await client.callTool({ name: "grid_login_status", arguments: {} }));
  assert.equal(pending.status, "pending");
});

test("GET transport identity capture still resets state before explicit login", async () => {
  await connectSession(freshTransportA);

  await issueSessionGet(differentTransportC);
  requestHeaders.set("Authorization", `Bearer ${freshTransportA}`);

  const start = structured(await client.callTool({ name: "grid_start", arguments: {} }));
  assert.equal(start.context.signed_in, true);
  assert.equal(start.context.email, "first@example.com");
  assert.equal(start.context.identity_changed, true);
});

test("a different transport subject clears an explicit login", async () => {
  await connectSession(expiredTransportA);

  await client.callTool({ name: "grid_login", arguments: {} });
  const authenticated = structured(await client.callTool({ name: "grid_login_status", arguments: {} }));
  assert.deepEqual(authenticated, { status: "authenticated", email: "chosen@example.com" });

  requestHeaders.set("Authorization", `Bearer ${differentTransportC}`);
  const start = structured(await client.callTool({ name: "grid_start", arguments: {} }));

  assert.equal(start.context.signed_in, true);
  assert.equal(start.context.email, "rotated-c@example.com");
  assert.equal(start.context.identity_changed, true);
});

// --- Connected edge (MCP_REQUIRE_AUTH=1) — #288 transport gate reverted -------
//
// #288 added a transport-level 401 on an expired/invalid Bearer (the "#286
// challenge"). It shipped in 0.21.3/0.21.4, was pulled from production hours later
// (monorepo manifests re-pinned to 0.21.2 — a deployment-only rollback; the code
// stayed on main), and #286 is closed not-planned. Auth on this connector is
// IN-BAND via grid_login / grid_plug (2026-08-23 founder decision), so a
// transport 401 on an expired-but-present Bearer is wrong by design: it bricks the
// client, with grid_login itself stuck behind the same 401 and no in-conversation
// recovery. This PR removes the gate. The ONLY connected-edge auth gate is the
// deployed missing-Bearer guard (commit 7728b94, src/web.js:109): no Bearer ->
// 401; an expired/invalid-but-present Bearer proceeds to the tool layer, where the
// needs_auth ask is the recovery path. The four tests below map to the review's
// (a)-(d) and go RED on the un-reverted #288 gate, GREEN once it is removed.

function assertChallenge(response) {
  assert.equal(response.status, 401, "expected a 401 auth challenge");
  assert.match(
    response.headers.get("www-authenticate") ?? "",
    /^Bearer\b/i,
    "expected a Bearer WWW-Authenticate challenge header",
  );
}

function assertNoChallenge(response) {
  assert.equal(response.status, 200, "expected the request to proceed");
  assert.equal(
    response.headers.get("www-authenticate"),
    null,
    "a proceeding request must not carry a WWW-Authenticate challenge",
  );
}

test("[#288 revert / a+d] connected: a NEW session with an expired Bearer reaches the tool layer, and grid_login is reachable", async () => {
  // (a) initialize with an expired Bearer must proceed (was a 401 under #288), and
  // (d) the in-band recovery — grid_login — must be reachable from there.
  await connectSession(expiredTransportA, connected.baseUrl);
  const login = structured(await client.callTool({ name: "grid_login", arguments: {} }));
  assert.ok(
    login.login_url && /\/auth\/login/.test(login.login_url),
    `grid_login must be reachable with an expired Bearer: ${JSON.stringify(login)}`,
  );
});

test("[#288 revert / b+d] connected: a session whose Bearer expires mid-life proceeds, and grid_login stays reachable", async () => {
  // (b) initialize with a valid Bearer, the token then expires and the client keeps
  // sending it — the incident itself. The next POST must NOT be challenged, and
  // (d) grid_login must still be reachable so the user can re-auth in-band.
  await connectSession(freshTransportA, connected.baseUrl);

  const raw = await rawPost(connected.baseUrl, {
    bearer: expiredTransportA,
    body: TOOLS_LIST_BODY,
    sessionId: transport.sessionId,
    protocolVersion: transport.protocolVersion,
  });
  assertNoChallenge(raw);

  requestHeaders.set("Authorization", `Bearer ${expiredTransportA}`);
  const login = structured(await client.callTool({ name: "grid_login", arguments: {} }));
  assert.ok(login.login_url, "grid_login must stay reachable after the Bearer expired");
});

test("[#279] connected: a valid explicit login is authoritative when the Bearer expires", async () => {
  // #279 must NOT regress: a completed in-session grid_login keeps the session
  // signed in even as the transport Bearer expires. (With the #288 gate gone, an
  // expired Bearer no longer 401s regardless — this now asserts the identity
  // stays the explicit login, not merely that the request proceeds.)
  await connectSession(freshTransportA, connected.baseUrl);

  await client.callTool({ name: "grid_login", arguments: {} });
  const authenticated = structured(await client.callTool({ name: "grid_login_status", arguments: {} }));
  assert.deepEqual(authenticated, { status: "authenticated", email: "chosen@example.com" });

  requestHeaders.set("Authorization", `Bearer ${expiredTransportA}`);
  const start = structured(await client.callTool({ name: "grid_start", arguments: {} }));
  assert.equal(start.context.signed_in, true, "explicit login keeps the session signed in");
  assert.equal(start.context.email, "chosen@example.com", "identity stays the explicit login (#279)");
});

test("[#288 revert / c] connected: a MISSING Bearer is still challenged (deployed posture preserved)", async () => {
  // (c) The half of the deployed guard that stays: no anonymous on the connected
  // edge. A request with no Bearer at all still draws the 401 challenge.
  const response = await rawPost(connected.baseUrl, {
    bearer: null,
    body: INITIALIZE_BODY,
  });

  assertChallenge(response);
});

test("connected edge: a valid Bearer proceeds without challenge", async () => {
  await connectSession(freshTransportA, connected.baseUrl);

  const response = await rawPost(connected.baseUrl, {
    bearer: freshTransportA,
    body: TOOLS_LIST_BODY,
    sessionId: transport.sessionId,
    protocolVersion: transport.protocolVersion,
  });

  assertNoChallenge(response);
});

test("anonymous edge: an absent Bearer still proceeds", async () => {
  const response = await rawPost(anon.baseUrl, {
    bearer: null,
    body: INITIALIZE_BODY,
  });

  assertNoChallenge(response);
});

test("anonymous edge: an expired Bearer still proceeds", async () => {
  const response = await rawPost(anon.baseUrl, {
    bearer: expiredTransportA,
    body: INITIALIZE_BODY,
  });

  assertNoChallenge(response);
});

test("[#288 revert] connected: a malformed, undecodable Bearer proceeds to the tool layer, not challenged", async () => {
  // A present-but-undecodable Bearer is not "missing" — under the deployed !jwt
  // guard it proceeds. The tool layer treats it as no usable credential (needs_auth
  // in-band); the transport must not 401 or crash on it.
  const response = await rawPost(connected.baseUrl, {
    bearer: "not-a-real-jwt",
    body: INITIALIZE_BODY,
  });

  assertNoChallenge(response);
});
