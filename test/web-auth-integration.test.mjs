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
let baseUrl;
let childStderr = "";
let actualStatusCalls = 0;
let client;
let transport;
let requestHeaders;
let rawGetController;

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

async function waitForHealth() {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(`web child exited before becoming healthy (${child.exitCode}):\n${childStderr}`);
    }
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch {
      // The child is still starting.
    }
    await sleep(50);
  }
  throw new Error(`web child did not become healthy:\n${childStderr}`);
}

async function stopChild() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
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
  const mockPort = await listen(mock);
  const mcpPort = await reservePort();
  baseUrl = `http://127.0.0.1:${mcpPort}`;
  child = spawn(process.execPath, ["src/web.js"], {
    env: {
      ...process.env,
      PORT: String(mcpPort),
      MCP_PUBLIC_URL: baseUrl,
      CLOUDGRID_API_URL: `http://127.0.0.1:${mockPort}`,
      CLOUDGRID_PUBLIC_API_URL: `http://127.0.0.1:${mockPort}`,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    childStderr += chunk;
  });
  await waitForHealth();
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
  await stopChild();
  await closeServer(mock);
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
