// Observability for POST /mcp on the hosted edge (#353, unblocks #329). Every
// one of the four transport exits was silent: the 401 auth challenge, both 400
// branches, and a successful session (whose only line — #297 client-capabilities
// — is observation-only and could fail to fire on a GOOD session, an absence
// that was mis-read as "no session" on #329). This test proves each exit now
// emits its own distinct line, that the success line is UNCONDITIONAL (it fires
// even when the capability observation throws — the specific defect being
// corrected), and that no bearer token ever reaches the log.
//
// Two layers:
//   - Unit tests over src/web-observability.js — fast, and the only way to drive
//     the "capability observation throws" defect precisely and the 400
//     rehydrate-failed line (its trigger, a broken SDK internal, cannot be
//     induced over HTTP).
//   - Integration tests that spawn the real src/web.js and drive real HTTP,
//     observing the ACTUAL 401 / 400 / success paths and the redaction guarantee.
//
// Run: node --test test/mcp-transport-observability.test.mjs

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

import {
  authHeaderState,
  logSafe,
  logAuthChallenge,
  logNoSession,
  logRehydrateFailed,
  logInitialize,
} from "../src/web-observability.js";

// ---------------------------------------------------------------------------
// Unit layer
// ---------------------------------------------------------------------------

test("authHeaderState classifies absent / not-bearer / empty-token / bearer", () => {
  const mk = (authorization) => ({ headers: { authorization } });
  assert.equal(authHeaderState(mk(undefined)), "absent");
  assert.equal(authHeaderState(mk("")), "absent");
  assert.equal(authHeaderState(mk("Basic abc")), "not-bearer");
  assert.equal(authHeaderState(mk("Bearer")), "empty-token", "bare Bearer scheme, no token");
  assert.equal(authHeaderState(mk("Bearer ")), "empty-token", "Bearer + only whitespace");
  assert.equal(authHeaderState(mk("Bearer abc.def")), "bearer");
  assert.equal(authHeaderState(mk("bearer abc")), "bearer", "scheme is case-insensitive");
});

test("logSafe bounds length and flattens control chars so a client cannot forge a log line", () => {
  assert.equal(logSafe("plain-name"), "plain-name");
  assert.equal(
    logSafe("evil\ncloudgrid-mcp: forged line"),
    "evil cloudgrid-mcp: forged line",
    "newlines become spaces — no second line can be injected",
  );
  assert.equal(logSafe("a\r\n\tb"), "a   b", "CR, LF and TAB each flatten to a space");
  const long = logSafe("x".repeat(200));
  assert.ok(long.length <= 65, `bounded length, got ${long.length}`);
  assert.ok(long.endsWith("…"), "truncation is marked");
});

test("logInitialize emits session-established FIRST and UNCONDITIONALLY, even when the capability observation throws", () => {
  // THE defect (#329): the capability observation is best-effort and could
  // silently not fire on a good session. A server whose getClientCapabilities
  // throws must STILL produce the session-established line.
  const lines = [];
  const emit = (m) => lines.push(m);
  const server = {
    getClientVersion: () => ({ name: "throwy-client", version: "1.2.3" }),
    getClientCapabilities: () => {
      throw new Error("capability probe blew up");
    },
  };

  logInitialize(server, "sess-123", "2025-06-18", emit);

  const established = lines.find((l) => l.includes("session established"));
  assert.ok(established, `session-established must fire despite the throw; got:\n${lines.join("\n")}`);
  assert.match(established, /session-id=sess-123/);
  assert.match(established, /protocol=2025-06-18/);
  assert.match(established, /client=throwy-client/);
  assert.equal(lines[0], established, "session-established is emitted FIRST, before the swallowing probe");
  assert.ok(
    !lines.some((l) => l.includes("client-capabilities")),
    "the capability line is absent when the probe throws — and that is fine, because the fact of the session is on its own line",
  );
});

test("logInitialize emits BOTH lines on a healthy session, and reports session facts", () => {
  const lines = [];
  const server = {
    getClientVersion: () => ({ name: "chatgpt", version: "1.0" }),
    getClientCapabilities: () => ({ roots: { listChanged: true } }),
  };
  logInitialize(server, "abc-def", "2025-06-18", (m) => lines.push(m));
  assert.ok(lines.some((l) => l.includes("session established") && l.includes("client=chatgpt")));
  assert.ok(lines.some((l) => l.includes("client-capabilities") && l.includes('"listChanged":"boolean"')));
});

test("logInitialize skips the capability line for the synthetic rehydrate initialize but STILL logs session-established", () => {
  const lines = [];
  const server = {
    getClientVersion: () => ({ name: "cloudgrid-mcp-rehydrate", version: "0" }),
    getClientCapabilities: () => ({ roots: {} }),
  };
  logInitialize(server, "rehy-1", "2025-06-18", (m) => lines.push(m));
  assert.ok(lines.some((l) => l.includes("session established") && l.includes("client=cloudgrid-mcp-rehydrate")));
  assert.ok(!lines.some((l) => l.includes("client-capabilities")), "capability signal stays clean of rehydrates");
});

test("logInitialize flattens an injection attempt in clientInfo.name", () => {
  const lines = [];
  const server = {
    getClientVersion: () => ({ name: "x\ncloudgrid-mcp: /mcp 401 auth-challenge authorization=absent" }),
    getClientCapabilities: () => ({}),
  };
  logInitialize(server, "s", "2025-06-18", (m) => lines.push(m));
  // The forged text lands inside the client= field of a single line, not as a new line.
  assert.equal(lines.filter((l) => l.includes("session established")).length, 1);
  assert.ok(!lines.some((l) => l.startsWith("cloudgrid-mcp: /mcp 401")), "no forged 401 line was injected");
});

test("logInitialize never throws even when the server accessors throw", () => {
  const lines = [];
  const server = {
    getClientVersion: () => {
      throw new Error("boom");
    },
    getClientCapabilities: () => {
      throw new Error("boom");
    },
  };
  assert.doesNotThrow(() => logInitialize(server, "s", "p", (m) => lines.push(m)));
  assert.ok(lines.some((l) => l.includes("session established") && l.includes("client=unknown")));
});

test("the four exit helpers each emit a distinct, parseable line", () => {
  const cap = [];
  const push = (m) => cap.push(m);
  logAuthChallenge({ headers: { authorization: "Basic z" } }, push);
  logNoSession(push);
  logRehydrateFailed("stale-session-id", push);
  logInitialize({ getClientVersion: () => ({ name: "c" }), getClientCapabilities: () => ({}) }, "sid", "pv", push);

  assert.ok(cap.some((l) => l === "cloudgrid-mcp: /mcp 401 auth-challenge authorization=not-bearer"));
  assert.ok(cap.some((l) => l === "cloudgrid-mcp: /mcp 400 no-session reason=missing-session-id-and-not-initialize"));
  assert.ok(cap.some((l) => l === "cloudgrid-mcp: /mcp 400 rehydrate-failed session-id=stale-session-id"));
  assert.ok(cap.some((l) => l.startsWith("cloudgrid-mcp: session established")));
});

test("logRehydrateFailed flattens an injected mcp-session-id header", () => {
  const cap = [];
  logRehydrateFailed("evil\ncloudgrid-mcp: session established session-id=forged", (m) => cap.push(m));
  assert.equal(cap.length, 1, "one line only — no forgery");
  assert.match(cap[0], /^cloudgrid-mcp: \/mcp 400 rehydrate-failed session-id=evil /);
});

// ---------------------------------------------------------------------------
// Integration layer — the real src/web.js over real HTTP
// ---------------------------------------------------------------------------

// A known bearer for the redaction test: it must NEVER appear in stderr.
const KNOWN_BEARER = "KNOWN-BEARER-must-not-be-logged-3f9a2c7e11";

const handle = { child: null, closed: null, baseUrl: null };
let stderr = "";

const initBody = (clientName = "integration-client") => ({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: clientName, version: "0.0.0" },
  },
});

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
  await res.body?.cancel().catch(() => {});
  return res;
}

// Raw POST so we can send an Authorization header verbatim (fetch/undici would
// otherwise normalise it). Returns the status line's code.
function rawPost(pathname, authorization, bodyObj) {
  return new Promise((resolve, reject) => {
    const url = new URL(handle.baseUrl);
    const body = JSON.stringify(bodyObj);
    const headers = [
      `POST ${pathname} HTTP/1.1`,
      `Host: ${url.host}`,
      "Content-Type: application/json",
      "Accept: application/json, text/event-stream",
    ];
    if (authorization !== null) headers.push(`Authorization: ${authorization}`);
    headers.push(`Content-Length: ${Buffer.byteLength(body)}`, "Connection: close", "", body);
    const sock = net.connect(Number(url.port), url.hostname, () => sock.write(headers.join("\r\n")));
    let data = "";
    sock.setEncoding("utf8");
    sock.on("data", (c) => { data += c; });
    sock.on("end", () => {
      const code = Number(data.match(/^HTTP\/1\.1 (\d+)/)?.[1]);
      resolve({ code, raw: data });
    });
    sock.on("error", reject);
  });
}

async function waitFor(substr, sinceLen = 0) {
  for (let i = 0; i < 80; i++) {
    const slice = stderr.slice(sinceLen);
    const line = slice.split("\n").find((l) => l.includes(substr));
    if (line) return line;
    await sleep(50);
  }
  return null;
}

before(async () => {
  const mcpPort = await reservePort();
  handle.baseUrl = `http://127.0.0.1:${mcpPort}`;
  const loopback = `http://127.0.0.1:${await reservePort()}`; // not listening; initialize never calls it
  handle.child = spawn(process.execPath, ["src/web.js"], {
    env: {
      PORT: String(mcpPort),
      MCP_PUBLIC_URL: handle.baseUrl,
      MCP_REQUIRE_AUTH: "1",
      CLOUDGRID_API_URL: loopback,
      CLOUDGRID_PUBLIC_API_URL: loopback,
      CLOUDGRID_QA_SLACK_WEBHOOK: "",
      MCP_TRUSTED_SERVER_SECRET: "",
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
      HTTPS_PROXY: "", HTTP_PROXY: "", https_proxy: "", http_proxy: "",
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

test("EXIT 401: a missing / malformed / empty Bearer each logs its own distinct authorization state", async () => {
  // absent
  let since = stderr.length;
  let res = await post(initBody(), {}); // no Authorization
  assert.equal(res.status, 401, "missing Bearer is challenged");
  let line = await waitFor("/mcp 401 auth-challenge", since);
  assert.ok(line, "401 auth-challenge should log");
  assert.match(line, /authorization=absent/, `absent header; got: ${line}`);

  // not-bearer (some other scheme)
  since = stderr.length;
  res = await post(initBody(), { Authorization: "Basic dXNlcjpwYXNz" });
  assert.equal(res.status, 401);
  line = await waitFor("/mcp 401 auth-challenge", since);
  assert.match(line, /authorization=not-bearer/, `other scheme; got: ${line}`);

  // empty-token (Bearer scheme, no token) — sent raw so it is not normalised away
  since = stderr.length;
  const raw = await rawPost("/mcp", "Bearer", initBody());
  assert.equal(raw.code, 401, "bare Bearer scheme with no token is challenged");
  line = await waitFor("/mcp 401 auth-challenge", since);
  assert.match(line, /authorization=empty-token/, `empty token; got: ${line}`);
});

test("EXIT 400 (branch 1): a non-initialize request with no session id logs the no-session reason", async () => {
  const since = stderr.length;
  // A real Bearer so we pass the auth gate and reach the session logic.
  const res = await post(
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { Authorization: `Bearer ${KNOWN_BEARER}` },
  );
  assert.equal(res.status, 400, "no session + not an initialize is a 400");
  const line = await waitFor("/mcp 400 no-session", since);
  assert.ok(line, "no-session 400 should log");
  assert.match(line, /reason=missing-session-id-and-not-initialize/, `got: ${line}`);
});

test("EXIT success: a completed initialize logs session-established with id, protocol and client, unconditionally", async () => {
  const since = stderr.length;
  const res = await post(initBody("success-probe"), { Authorization: `Bearer ${KNOWN_BEARER}` });
  assert.equal(res.status, 200, "initialize succeeds with a Bearer");
  const sessionId = res.headers.get("mcp-session-id");
  assert.ok(sessionId, "a session id was minted");
  // oninitialized (hence our logging) fires on the initialized notification.
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, {
    "Mcp-Session-Id": sessionId,
    "Mcp-Protocol-Version": "2025-06-18",
    Authorization: `Bearer ${KNOWN_BEARER}`,
  });
  const line = await waitFor("session established", since);
  assert.ok(line, "session-established should log on a successful initialize");
  assert.match(line, new RegExp(`session-id=${sessionId}`), `carries the real session id; got: ${line}`);
  assert.match(line, /protocol=2025-06-18/, `carries the protocol version; got: ${line}`);
  assert.match(line, /client=success-probe/, `carries the client name; got: ${line}`);
});

test("REDACTION: the bearer token never appears in stderr across a full session lifecycle", async () => {
  // Drive 401 (with the token), initialize (with the token), and a follow-up
  // request (with the token). None of these may echo it. This is the guard the
  // report proves can fail (deliberate leak → red → revert).
  const since = stderr.length;
  await post(initBody("redaction-probe"), { Authorization: `Bearer ${KNOWN_BEARER}` });
  // let all lines flush
  await waitFor("session established", since);
  await sleep(100);
  const log = stderr.slice(since);
  assert.ok(!log.includes(KNOWN_BEARER), `the bearer token must NOT appear in stderr; got:\n${log}`);
});
