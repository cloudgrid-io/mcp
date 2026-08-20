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
const rotatedC = jwt({
  sub: "rotated-user-c",
  email: "rotated-c@example.com",
  exp: nowSeconds + 3600,
});
const rotatedD = jwt({
  sub: "rotated-user-d",
  email: "rotated-d@example.com",
  exp: nowSeconds + 3600,
});

let mock;
let child;
let childClosed;
let baseUrl;
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

async function waitForHealth(proc, getStderr) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`web child exited before becoming healthy (${proc.exitCode}):\n${getStderr()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // The child is still starting.
    }
    await sleep(50);
  }
  throw new Error(`web child did not become healthy:\n${getStderr()}`);
}

async function waitForClose(timeoutMs) {
  if (!childClosed) return true;
  let timer;
  try {
    return await Promise.race([
      childClosed.then(() => true),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopChild() {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) {
    if (!await waitForClose(CHILD_KILL_TIMEOUT_MS)) {
      throw new Error("web child stdio did not close after exit");
    }
    return;
  }

  child.kill("SIGTERM");
  if (await waitForClose(CHILD_STOP_TIMEOUT_MS)) return;

  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  if (!await waitForClose(CHILD_KILL_TIMEOUT_MS)) {
    throw new Error("web child did not close after SIGKILL");
  }
}

function childEnv({ mcpPort, mockPort }) {
  const loopback = `http://127.0.0.1:${mockPort}`;
  return {
    PORT: String(mcpPort),
    MCP_PUBLIC_URL: `http://127.0.0.1:${mcpPort}`,
    MCP_REQUIRE_AUTH: "0",
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

async function startChild(mockPort) {
  for (let attempt = 1; attempt <= CHILD_START_ATTEMPTS; attempt++) {
    const mcpPort = await reservePort();
    baseUrl = `http://127.0.0.1:${mcpPort}`;
    let attemptStderr = "";
    child = spawn(process.execPath, ["src/web.js"], {
      env: childEnv({ mcpPort, mockPort }),
      stdio: ["ignore", "ignore", "pipe"],
    });
    childClosed = new Promise((resolve) => child.once("close", resolve));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      attemptStderr += chunk;
    });

    try {
      await waitForHealth(child, () => attemptStderr);
      return;
    } catch (err) {
      await stopChild();
      if (attempt < CHILD_START_ATTEMPTS && /EADDRINUSE/.test(attemptStderr)) continue;
      throw err;
    }
  }
}

function structured(result) {
  return result?.structuredContent ?? result?.structured ?? {};
}

async function connectSession(initialBearer) {
  requestHeaders = new Headers({ Authorization: `Bearer ${initialBearer}` });
  transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
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

async function issueSessionGet(bearer) {
  rawGetController = new AbortController();
  const response = await fetch(`${baseUrl}/mcp`, {
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
    const url = new URL(req.url, "http://mock.local");
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
    await startChild(mockPort);
  } catch (err) {
    try {
      await stopChild();
    } finally {
      await closeServer(mock);
    }
    throw err;
  }
});

beforeEach(() => {
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
    await stopChild();
  } finally {
    await closeServer(mock);
  }
});

test("explicit in-tool login survives later POST and GET transport Bearer rotation", async () => {
  await connectSession(expiredTransportA);

  await client.callTool({ name: "grid_login", arguments: {} });
  const authenticated = structured(await client.callTool({ name: "grid_login_status", arguments: {} }));
  assert.deepEqual(authenticated, { status: "authenticated", email: "chosen@example.com" });

  requestHeaders.set("Authorization", `Bearer ${rotatedC}`);
  const start = structured(await client.callTool({ name: "grid_start", arguments: {} }));
  assert.equal(start.context.signed_in, true);
  assert.equal(start.context.email, "chosen@example.com");
  assert.equal(start.context.identity_changed, undefined);

  await client.callTool({ name: "grid_login", arguments: {} });
  await issueSessionGet(rotatedD);

  const pending = structured(await client.callTool({ name: "grid_login_status", arguments: {} }));
  assert.equal(pending.status, "pending");
});

test("GET transport identity capture still resets state before explicit login", async () => {
  await connectSession(freshTransportA);

  await issueSessionGet(rotatedC);
  requestHeaders.set("Authorization", `Bearer ${freshTransportA}`);

  const start = structured(await client.callTool({ name: "grid_start", arguments: {} }));
  assert.equal(start.context.signed_in, true);
  assert.equal(start.context.email, "first@example.com");
  assert.equal(start.context.identity_changed, true);
});
