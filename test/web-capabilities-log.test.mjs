// Integration test for issue #297 — log the client's advertised MCP capabilities
// at initialize on the hosted edge, so we can settle (from real traffic) whether
// Claude web ever advertises a UI extension without re-reading the code.
//
// Observes the ACTUAL path: spawns the real hosted server (src/web.js) and drives
// a real MCP initialize (raw POST /mcp + the initialized notification, so we
// control the exact capabilities payload), then reads the log line off the
// child's stderr. The capabilities deliberately carry a nested DECOY secret; the
// test proves the log records the capability KEY SHAPE (names + value TYPES) and
// never a value — the #297 no-credential guarantee, held by construction (keyShape
// in src/web.js emits only key names and JS type names).
//
// Read it back in production with:
//   kubectl logs <mcp-web-pod> | grep 'cloudgrid-mcp: client-capabilities'
// The `capabilities=` field is the advertised key shape; look under
// `experimental` for an `io.modelcontextprotocol/ui` key (the UI extension a
// rendered login card would need).
//
// Run: node --test test/web-capabilities-log.test.mjs

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const handle = { child: null, closed: null, baseUrl: null };
let stderr = "";

// A DECOY secret nested inside an (schema-valid) experimental capability object.
// It must NEVER appear in the log — only its key mapped to the value's type.
const DECOY = "sk-decoy-CREDENTIAL-must-not-be-logged-9f8e7d";
const INIT_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {
      experimental: {
        "io.modelcontextprotocol/ui": {},
        "x-decoy": { token: DECOY },
      },
      roots: { listChanged: true },
    },
    clientInfo: { name: "capabilities-probe", version: "0.0.0" },
  },
};

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function reservePort() {
  const s = createServer();
  const p = await listen(s);
  await new Promise((r) => s.close(r));
  return p;
}

async function post(body, headers = {}) {
  const res = await fetch(`${handle.baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  return res;
}

before(async () => {
  const mcpPort = await reservePort();
  handle.baseUrl = `http://127.0.0.1:${mcpPort}`;
  const loopback = `http://127.0.0.1:${await reservePort()}`; // not listening; initialize never calls it
  handle.child = spawn(process.execPath, ["src/web.js"], {
    env: {
      PORT: String(mcpPort),
      MCP_PUBLIC_URL: handle.baseUrl,
      MCP_REQUIRE_AUTH: "0",
      CLOUDGRID_API_URL: loopback,
      CLOUDGRID_PUBLIC_API_URL: loopback,
      CLOUDGRID_QA_SLACK_WEBHOOK: "",
      MCP_TRUSTED_SERVER_SECRET: "",
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  handle.closed = new Promise((resolve) => handle.child.once("close", resolve));
  handle.child.stderr.setEncoding("utf8");
  handle.child.stderr.on("data", (c) => { stderr += c; });

  for (let i = 0; i < 100; i++) {
    if (handle.child.exitCode !== null) throw new Error(`web child exited early:\n${stderr}`);
    try { if ((await fetch(`${handle.baseUrl}/healthz`)).ok) return; } catch { /* starting */ }
    await sleep(50);
  }
  throw new Error(`web child did not become healthy:\n${stderr}`);
});

after(async () => {
  if (handle.child && handle.child.exitCode === null) handle.child.kill("SIGTERM");
  await handle.closed;
});

test("#297: capabilities are logged once at initialize as a key shape with no values", async () => {
  // Drive a real initialize with our capabilities payload, then the initialized
  // notification (which is when the server's oninitialized — and our logging —
  // fires), reusing the session id the initialize minted.
  const initRes = await post(INIT_BODY);
  assert.equal(initRes.status, 200, "initialize proceeds on the anon edge");
  const sessionId = initRes.headers.get("mcp-session-id");
  assert.ok(sessionId, "initialize minted a session id");
  await initRes.body?.cancel().catch(() => {});

  const notifRes = await post(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { "Mcp-Session-Id": sessionId, "Mcp-Protocol-Version": "2025-06-18" },
  );
  await notifRes.body?.cancel().catch(() => {});

  // Wait for the log line to surface on stderr.
  let line = null;
  for (let i = 0; i < 60 && !line; i++) {
    line = stderr.split("\n").find((l) => l.includes("cloudgrid-mcp: client-capabilities"));
    if (!line) await sleep(50);
  }
  assert.ok(line, `expected a client-capabilities log line; stderr was:\n${stderr}`);

  // Names WHICH client and reveals the capability KEY SHAPE (the UI extension we hunt for).
  assert.match(line, /client=capabilities-probe/, "names the connecting client");
  assert.match(line, /io\.modelcontextprotocol\/ui/, "reveals the advertised UI-extension key");
  // Types, not values: the decoy is reduced to its type; primitive values become type names.
  assert.match(line, /"x-decoy":\{"token":"string"\}/, "the nested decoy value is reduced to its type");
  assert.match(line, /"listChanged":"boolean"/, "primitive capability values become type names, not values");
  // The no-credential guarantee.
  assert.ok(!line.includes(DECOY), "the decoy credential value must not appear in the log line");
  assert.ok(!stderr.includes(DECOY), "the decoy credential must not appear anywhere on stderr");

  // Logged once per session, not per request. Match the capability line
  // specifically — the #353 session-established line also carries client=<name>.
  const count = stderr
    .split("\n")
    .filter((l) => l.includes("client-capabilities") && l.includes("client=capabilities-probe")).length;
  assert.equal(count, 1, "capabilities logged exactly once at initialize");
});
