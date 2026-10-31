// Edge limits for the hosted web edition: Origin validation on /mcp, a bounded
// session table (cap + idle sweep), rebuilding only session ids this edge issued,
// and per-client-IP rate limits on the OAuth routes and on initialize.
//
// Unit tests drive src/web-guards.js directly; integration tests spawn the real
// src/web.js with small limits so each guard is reachable in a few requests.

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import {
  createOriginMatcher,
  createSessionIds,
  createRateLimiter,
  clientIp,
} from "../src/web-guards.js";

const PROTOCOL_VERSION = "2025-06-18";
const INITIALIZE_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "edge-limits", version: "0" } },
};
const TOOL_CALL = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "grid_start", arguments: {} } };

// --- Unit: Origin matcher ------------------------------------------------------

describe("origin matcher", () => {
  const allowed = createOriginMatcher({ env: {}, publicBase: "https://mcp.example.test" });

  test("allows the default client origins, own origin and loopback", () => {
    for (const o of [
      "https://claude.ai",
      "https://www.claude.ai",
      "https://claude.com",
      "https://chatgpt.com",
      "https://chat.openai.com",
      "https://mcp.example.test",
      "http://localhost:6274",
      "http://127.0.0.1:3000",
      "http://[::1]:8080",
      "https://localhost",
    ]) {
      assert.equal(allowed(o), true, o);
    }
  });

  test("refuses foreign, look-alike, opaque and malformed origins", () => {
    for (const o of [
      "https://evil.example",
      "https://claude.ai.evil.example",
      "https://evilclaude.ai",
      "http://claude.ai",
      "null",
      "https://claude.ai/path",
      "file://",
      "",
    ]) {
      assert.equal(allowed(o), false, o);
    }
  });

  test("MCP_ALLOWED_ORIGINS adds exact and wildcard entries; '*' turns the check off", () => {
    const m = createOriginMatcher({ env: { MCP_ALLOWED_ORIGINS: "https://app.example.org, https://*.tools.example" }, publicBase: "" });
    assert.equal(m("https://app.example.org"), true);
    assert.equal(m("https://a.tools.example"), true);
    assert.equal(m("https://tools.example"), false, "a wildcard does not match the apex");
    assert.equal(m("https://claude.ai"), true, "defaults are kept");
    assert.equal(m("https://evil.example"), false);
    const off = createOriginMatcher({ env: { MCP_ALLOWED_ORIGINS: "*" } });
    assert.equal(off("https://evil.example"), true);
  });
});

// --- Unit: session ids ----------------------------------------------------------

describe("session ids", () => {
  test("a minted id verifies under the same key and edge, and only there", () => {
    const a = createSessionIds({ env: { MCP_TRUSTED_SERVER_SECRET: "k1" }, publicBase: "https://a.test" });
    const id = a.mint();
    assert.match(id, /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}$/);
    assert.ok(id.length <= 64, "fits the log-line bound");
    assert.equal(a.verify(id), true);
    const sameKey = createSessionIds({ env: { MCP_TRUSTED_SERVER_SECRET: "k1" }, publicBase: "https://a.test" });
    assert.equal(sameKey.verify(id), true, "another process with the same key verifies it (restart)");
    const otherKey = createSessionIds({ env: { MCP_TRUSTED_SERVER_SECRET: "k2" }, publicBase: "https://a.test" });
    assert.equal(otherKey.verify(id), false);
    const otherEdge = createSessionIds({ env: { MCP_TRUSTED_SERVER_SECRET: "k1" }, publicBase: "https://b.test" });
    assert.equal(otherEdge.verify(id), false, "an id is bound to the edge that issued it");
  });

  test("forged, tampered and legacy-shaped ids do not verify", () => {
    const s = createSessionIds({ env: { MCP_SESSION_SECRET: "k" }, publicBase: "" });
    const id = s.mint();
    const [r, t] = id.split(".");
    const flipped = `${r}.${t[0] === "A" ? "B" : "A"}${t.slice(1)}`;
    for (const bad of [flipped, `${r}x.${t}`, "6f1c2a4e-0000-4000-8000-000000000000", "", "a.b", null, undefined]) {
      assert.equal(s.verify(bad), false, String(bad));
    }
  });

  test("MCP_SESSION_SECRET takes precedence; with no secret the key is per-process", () => {
    const viaOverride = createSessionIds({ env: { MCP_SESSION_SECRET: "o", MCP_TRUSTED_SERVER_SECRET: "t" } });
    const viaTrusted = createSessionIds({ env: { MCP_TRUSTED_SERVER_SECRET: "t" } });
    assert.equal(viaTrusted.verify(viaOverride.mint()), false);
    const e1 = createSessionIds({ env: {} });
    const e2 = createSessionIds({ env: {} });
    assert.equal(e1.ephemeral, true);
    assert.equal(e1.verify(e1.mint()), true);
    assert.equal(e2.verify(e1.mint()), false);
  });
});

// --- Unit: rate limiter and client IP ---------------------------------------------

describe("rate limiter", () => {
  test("allows a burst of perMinute, then refuses with a Retry-After, then refills", () => {
    let t = 0;
    const rl = createRateLimiter({ perMinute: 3, now: () => t });
    assert.equal(rl.take("a").ok, true);
    assert.equal(rl.take("a").ok, true);
    assert.equal(rl.take("a").ok, true);
    const refused = rl.take("a");
    assert.equal(refused.ok, false);
    assert.equal(refused.retryAfterSec, 20, "one token per 20s at 3/min");
    assert.equal(rl.take("b").ok, true, "keys are independent");
    t += 20_000;
    assert.equal(rl.take("a").ok, true, "a token is back after the refill interval");
  });

  test("0 disables; the sweep drops refilled buckets; the key map is bounded", () => {
    assert.equal(createRateLimiter({ perMinute: 0 }).take("x").ok, true);
    let t = 0;
    const rl = createRateLimiter({ perMinute: 60, maxKeys: 3, now: () => t });
    for (const k of ["a", "b", "c", "d"]) rl.take(k);
    assert.equal(rl.size, 3);
    t += 60_000;
    rl.sweep();
    assert.equal(rl.size, 0);
  });
});

describe("client ip", () => {
  const req = (xff, peer = "10.0.0.9") => ({ headers: xff === undefined ? {} : { "x-forwarded-for": xff }, socket: { remoteAddress: peer } });

  test("one trusted hop: the rightmost X-Forwarded-For entry, never a client-supplied one", () => {
    assert.equal(clientIp(req("203.0.113.7"), 1), "203.0.113.7");
    assert.equal(clientIp(req("1.2.3.4, 203.0.113.7"), 1), "203.0.113.7", "a spoofed left entry is ignored");
    assert.equal(clientIp(req("1.2.3.4, 203.0.113.7, 10.1.1.1"), 2), "203.0.113.7");
  });

  test("no header, or hops=0, falls back to the socket peer", () => {
    assert.equal(clientIp(req(undefined, "::ffff:10.0.0.5"), 1), "10.0.0.5");
    assert.equal(clientIp(req("203.0.113.7"), 0), "10.0.0.9");
  });
});

// --- Integration: the real web edition --------------------------------------------

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

function baseEnv(port, extra) {
  return {
    PATH: process.env.PATH,
    PORT: String(port),
    MCP_PUBLIC_URL: `http://127.0.0.1:${port}`,
    CLOUDGRID_API_URL: "http://127.0.0.1:1",
    CLOUDGRID_PUBLIC_API_URL: "http://127.0.0.1:1",
    CLOUDGRID_QA_SLACK_WEBHOOK: "",
    MCP_TRUSTED_SERVER_SECRET: "",
    HTTPS_PROXY: "", HTTP_PROXY: "", ALL_PROXY: "",
    https_proxy: "", http_proxy: "", all_proxy: "",
    NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1",
    ...extra,
  };
}

async function startWeb(extra = {}, port = null) {
  const p = port ?? (await freePort());
  let stderr = "";
  const child = spawn(process.execPath, ["src/web.js"], { env: baseEnv(p, extra), stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => { stderr += c; });
  const closed = new Promise((r) => child.once("close", r));
  const base = `http://127.0.0.1:${p}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch { /* starting */ }
    if (child.exitCode !== null) throw new Error(`web exited:\n${stderr}`);
    await sleep(50);
  }
  return {
    base,
    port: p,
    stderr: () => stderr,
    async stop() {
      if (child.exitCode === null) child.kill("SIGTERM");
      await Promise.race([closed, sleep(1500).then(() => child.kill("SIGKILL"))]);
      await closed;
    },
  };
}

async function post(h, { body = INITIALIZE_BODY, sessionId, origin, xff } = {}) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Mcp-Protocol-Version": PROTOCOL_VERSION };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  if (origin) headers.Origin = origin;
  if (xff) headers["X-Forwarded-For"] = xff;
  const res = await fetch(`${h.base}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: res.status, sessionId: res.headers.get("mcp-session-id"), retryAfter: res.headers.get("retry-after"), text: await res.text() };
}

describe("web edition: Origin check on /mcp", () => {
  let h;
  before(async () => { h = await startWeb({ MCP_SESSION_SECRET: "edge-test" }); });
  after(async () => { await h.stop(); });

  test("a foreign Origin is refused with 403 and no session is minted", async () => {
    const r = await post(h, { origin: "https://evil.example" });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.sessionId, null);
    assert.match(h.stderr(), /\/mcp 403 origin-refused origin=https:\/\/evil\.example/);
  });

  test("GET and DELETE /mcp are covered too", async () => {
    for (const method of ["GET", "DELETE"]) {
      const res = await fetch(`${h.base}/mcp`, { method, headers: { Origin: "https://evil.example" } });
      assert.equal(res.status, 403, method);
    }
  });

  test("no Origin, an allowed client Origin, and loopback are served", async () => {
    assert.equal((await post(h)).status, 200);
    assert.equal((await post(h, { origin: "https://claude.ai" })).status, 200);
    assert.equal((await post(h, { origin: "https://chatgpt.com" })).status, 200);
    assert.equal((await post(h, { origin: "http://localhost:6274" })).status, 200);
  });
});

describe("web edition: session cap and idle sweep", () => {
  let h;
  before(async () => {
    h = await startWeb({ MCP_SESSION_SECRET: "edge-test", MCP_MAX_SESSIONS: "2", MCP_SESSION_IDLE_TTL_MS: "400", MCP_SESSION_SWEEP_MS: "100" });
  });
  after(async () => { await h.stop(); });

  test("at the cap a new initialize gets 503 with a JSON-RPC error; the sweep frees idle sessions", async () => {
    const a = await post(h);
    const b = await post(h);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    const c = await post(h);
    assert.equal(c.status, 503, c.text);
    assert.equal(c.retryAfter, "30");
    assert.match(JSON.parse(c.text).error.message, /session limit/);
    assert.equal(c.sessionId, null);

    await sleep(900); // both sessions go idle past the TTL and are swept
    const d = await post(h);
    assert.equal(d.status, 200, `after the sweep a new session fits:\n${d.text}`);

    // A swept session's id was issued here, so its next call is rebuilt in place.
    const resumed = await post(h, { body: TOOL_CALL, sessionId: a.sessionId });
    assert.equal(resumed.status, 200, resumed.text);
    // ...and that rebuild counts: the table is full again (d + a).
    assert.equal((await post(h)).status, 503);
  });
});

describe("web edition: rebuild only ids this edge issued", () => {
  test("a forged id gets 404 and builds nothing; an issued id is rebuilt after a restart", async () => {
    const port = await freePort();
    let h = await startWeb({ MCP_SESSION_SECRET: "edge-test", MCP_MAX_SESSIONS: "1" }, port);
    try {
      const forged = await post(h, { body: TOOL_CALL, sessionId: "attacker-chosen-session-id" });
      assert.equal(forged.status, 404, forged.text);
      assert.match(JSON.parse(forged.text).error.message, /initialize/);
      const uuid = await post(h, { body: TOOL_CALL, sessionId: "6f1c2a4e-0000-4000-8000-000000000000" });
      assert.equal(uuid.status, 404, "an unsigned UUID is refused by default");
      assert.match(h.stderr(), /\/mcp 404 session-unknown/);

      const issued = (await post(h)).sessionId;
      assert.ok(issued);
      await h.stop();
      h = await startWeb({ MCP_SESSION_SECRET: "edge-test", MCP_MAX_SESSIONS: "1" }, port);
      const rebuilt = await post(h, { body: TOOL_CALL, sessionId: issued });
      assert.equal(rebuilt.status, 200, rebuilt.text);
      // The forged attempts above built nothing: had they, the cap of 1 would
      // have been reached before the issued id came back.
      const another = await post(h, { body: TOOL_CALL, sessionId: "another-forged-id" });
      assert.equal(another.status, 404);
    } finally {
      await h.stop();
    }
  });

  test("a rebuild past the cap gets 503", async () => {
    const port = await freePort();
    let h = await startWeb({ MCP_SESSION_SECRET: "edge-test", MCP_MAX_SESSIONS: "1" }, port);
    try {
      const first = (await post(h)).sessionId;
      await h.stop();
      h = await startWeb({ MCP_SESSION_SECRET: "edge-test", MCP_MAX_SESSIONS: "1" }, port);
      assert.equal((await post(h)).status, 200, "fill the table");
      const r = await post(h, { body: TOOL_CALL, sessionId: first });
      assert.equal(r.status, 503, r.text);
    } finally {
      await h.stop();
    }
  });

  test("MCP_LEGACY_SESSION_IDS_UNTIL in the future lets a UUID-shaped id rebuild", async () => {
    const until = new Date(Date.now() + 3600_000).toISOString();
    const h = await startWeb({ MCP_SESSION_SECRET: "edge-test", MCP_LEGACY_SESSION_IDS_UNTIL: until });
    try {
      const r = await post(h, { body: TOOL_CALL, sessionId: "6f1c2a4e-0000-4000-8000-000000000000" });
      assert.equal(r.status, 200, r.text);
    } finally {
      await h.stop();
    }
  });
});

describe("web edition: rate limits", () => {
  let h;
  before(async () => {
    h = await startWeb({
      MCP_SESSION_SECRET: "edge-test",
      MCP_REQUIRE_AUTH: "1",
      MCP_OAUTH_HMAC_SECRET: "edge-test-oauth-secret-edge-test-oauth",
      MCP_RATE_OAUTH_REGISTER: "2",
      MCP_RATE_OAUTH_AUTHORIZE: "2",
      MCP_RATE_OAUTH_TOKEN: "2",
      MCP_RATE_MCP_INITIALIZE: "2",
    });
  });
  after(async () => { await h.stop(); });

  const register = (xff) =>
    fetch(`${h.base}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(xff ? { "X-Forwarded-For": xff } : {}) },
      body: JSON.stringify({ redirect_uris: ["https://client.example/cb"] }),
    });

  test("/oauth/register: a burst past the budget gets 429 with Retry-After, per client IP", async () => {
    const ip = "198.51.100.1";
    assert.equal((await register(ip)).status, 201);
    assert.equal((await register(ip)).status, 201);
    const limited = await register(ip);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    assert.equal((await limited.json()).error, "rate_limited");
    // The client IP is the rightmost X-Forwarded-For entry: a spoofed left entry
    // does not buy a new budget, and a different client has its own.
    assert.equal((await register(`9.9.9.9, ${ip}`)).status, 429);
    assert.equal((await register("198.51.100.2")).status, 201);
  });

  test("/oauth/authorize and /oauth/token are limited; /oauth/authorize/poll is not", async () => {
    const ip = "198.51.100.3";
    const hdr = { "X-Forwarded-For": ip };
    for (let i = 0; i < 2; i++) assert.notEqual((await fetch(`${h.base}/oauth/authorize`, { headers: hdr })).status, 429);
    assert.equal((await fetch(`${h.base}/oauth/authorize`, { headers: hdr })).status, 429);
    for (let i = 0; i < 5; i++) assert.notEqual((await fetch(`${h.base}/oauth/authorize/poll?sid=x`, { headers: hdr })).status, 429);
    const token = () =>
      fetch(`${h.base}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...hdr },
        body: "grant_type=authorization_code&code=x",
      });
    assert.equal((await token()).status, 400);
    assert.equal((await token()).status, 400);
    const t = await token();
    assert.equal(t.status, 429);
    assert.ok(t.headers.get("retry-after"));
  });

  test("initialize on /mcp is limited per client IP with a JSON-RPC 429", async () => {
    const auth = "Bearer x.eyJzdWIiOiJ1In0.";
    const init = (xff) =>
      fetch(`${h.base}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: auth, "X-Forwarded-For": xff },
        body: JSON.stringify(INITIALIZE_BODY),
      });
    assert.equal((await init("198.51.100.4")).status, 200);
    assert.equal((await init("198.51.100.4")).status, 200);
    const r = await init("198.51.100.4");
    assert.equal(r.status, 429);
    assert.ok(r.headers.get("retry-after"));
    assert.equal((await r.json()).jsonrpc, "2.0");
    assert.equal((await init("198.51.100.5")).status, 200);
  });

  test("OAuth CORS: metadata stays public; register/token echo only an allowed Origin", async () => {
    const meta = await fetch(`${h.base}/.well-known/oauth-authorization-server`, { headers: { Origin: "https://evil.example" } });
    assert.equal(meta.headers.get("access-control-allow-origin"), "*");
    const pre = (origin) =>
      fetch(`${h.base}/oauth/token`, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } });
    assert.equal((await pre("https://evil.example")).headers.get("access-control-allow-origin"), null);
    assert.equal((await pre("https://claude.ai")).headers.get("access-control-allow-origin"), "https://claude.ai");
    assert.equal((await pre("http://localhost:6274")).headers.get("access-control-allow-origin"), "http://localhost:6274");
  });
});
