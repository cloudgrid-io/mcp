// Rotating refresh tokens with reuse detection (cloudgrid-io/cloudgrid#5783).
//
//   - the store: single use, rotation, reuse revokes the family, sliding expiry
//     capped by the CloudGrid session's own expiry;
//   - the Redis client, against an in-process RESP server that allows only the
//     commands the hosted store's ACL allows (no scripting, no transactions);
//   - the token endpoint end to end: code -> access + refresh -> refresh ->
//     rotated refresh -> replay of the old one is refused and ends the sign-in.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createRefreshStore, createMemoryBackend } from "../src/refresh-store.js";
import { createRedisClient } from "../src/redis-client.js";

const b64url = (b) => Buffer.from(b).toString("base64url");

// ── The store ────────────────────────────────────────────────────────────────

function storeAt(t0 = Date.now(), ttl = 3600) {
  let t = t0;
  const backend = createMemoryBackend({ now: () => t });
  const store = createRefreshStore({ backend, refreshTtlSeconds: ttl, now: () => t });
  return { store, backend, advance: (ms) => { t += ms; } };
}

test("a refresh token works once and is replaced", async () => {
  const { store } = storeAt();
  const first = await store.start({ sub: "u", clientId: "c" });
  assert.match(first.token, /^cgr1\./);
  const r1 = await store.rotate(first.token);
  assert.equal(r1.ok, true);
  assert.equal(r1.record.sub, "u");
  assert.notEqual(r1.token, first.token);
  const r2 = await store.rotate(r1.token);
  assert.equal(r2.ok, true, "the rotated token works");
});

test("presenting a used refresh token revokes the whole sign-in", async () => {
  const { store } = storeAt();
  const first = await store.start({ sub: "u", clientId: "c" });
  const r1 = await store.rotate(first.token);
  const replay = await store.rotate(first.token);
  assert.deepEqual(replay, { ok: false, reason: "reused" });
  const after = await store.rotate(r1.token);
  assert.equal(after.ok, false, "the newest token stops working too");
  assert.equal(await store.isLive(first.family), false);
});

test("two concurrent refreshes with one token: exactly one wins", async () => {
  const { store } = storeAt();
  const first = await store.start({ sub: "u", clientId: "c" });
  const results = await Promise.all([store.rotate(first.token), store.rotate(first.token)]);
  assert.equal(results.filter((r) => r.ok).length, 1);
});

test("unknown, malformed and expired tokens are invalid; nothing else is revoked", async () => {
  const { store, advance } = storeAt(Date.now(), 60);
  const live = await store.start({ sub: "u", clientId: "c" });
  assert.equal((await store.rotate("garbage")).reason, "invalid");
  const forged = `cgr1.${live.family}.${b64url(randomBytes(32))}`;
  assert.equal((await store.rotate(forged)).reason, "invalid", "a guessed token in a real family is invalid");
  assert.equal((await store.rotate(forged)).reason, "invalid", "and presenting it twice does not revoke the family");
  assert.equal(await store.isLive(live.family), true);
  advance(61_000);
  assert.equal((await store.rotate(live.token)).reason, "invalid");
});

test("the family slides on use, and never outlives the CloudGrid session", async () => {
  const t0 = Date.now();
  const { store, advance } = storeAt(t0, 100);
  let tok = (await store.start({ sub: "u", clientId: "c" })).token;
  for (let i = 0; i < 5; i++) {
    advance(80_000); // each use is inside the window, the total is past it
    const r = await store.rotate(tok);
    assert.equal(r.ok, true, `use ${i + 1} slides the window`);
    tok = r.token;
  }
  const capped = storeAt(t0, 100);
  const s = await capped.store.start({ sub: "u", clientId: "c", expiresAt: t0 + 30_000 });
  assert.equal(s.expiresIn, 30, "capped by the session expiry");
  capped.advance(31_000);
  assert.equal((await capped.store.rotate(s.token)).ok, false);
  assert.equal(await capped.store.start({ sub: "u", clientId: "c", expiresAt: t0 }), null, "an expired session starts nothing");
});

test("only hashes are stored", async () => {
  const seen = [];
  const inner = createMemoryBackend();
  const backend = new Proxy(inner, {
    get(target, prop) {
      const v = target[prop];
      return typeof v === "function" ? (...a) => { seen.push(a.join(" ")); return v(...a); } : v;
    },
  });
  const store = createRefreshStore({ backend, refreshTtlSeconds: 60 });
  const { token } = await store.start({ sub: "u", clientId: "c" });
  await store.rotate(token);
  const secret = token.split(".")[2];
  assert.ok(!seen.some((line) => line.includes(secret)), "the refresh token itself never reaches the backend");
});

// ── The Redis client, against a RESP server with the store's ACL ─────────────

const ALLOWED = new Set(["AUTH", "PING", "GET", "SET", "GETDEL", "DEL", "EXPIRE", "SELECT"]);
async function fakeRedis({ user = "mcp", pass = "pw" } = {}) {
  const data = new Map();
  const commands = [];
  const server = net.createServer((sock) => {
    let authed = false;
    let buf = Buffer.alloc(0);
    const reply = (s) => sock.write(s);
    const bulk = (v) => (v == null ? "$-1\r\n" : `$${Buffer.byteLength(v)}\r\n${v}\r\n`);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        // parse *N\r\n($len\r\nval\r\n)*
        const text = buf.toString("utf8");
        const m = /^\*(\d+)\r\n/.exec(text);
        if (!m) return;
        let off = m[0].length;
        const args = [];
        let complete = true;
        for (let i = 0; i < Number(m[1]); i++) {
          const lm = /^\$(\d+)\r\n/.exec(text.slice(off));
          if (!lm) { complete = false; break; }
          off += lm[0].length;
          const len = Number(lm[1]);
          if (text.length < off + len + 2) { complete = false; break; }
          args.push(text.slice(off, off + len));
          off += len + 2;
        }
        if (!complete) return;
        buf = Buffer.from(text.slice(off));
        const [cmd, ...rest] = args;
        const c = cmd.toUpperCase();
        commands.push(c);
        if (!ALLOWED.has(c)) { reply(`-NOPERM this user has no permissions to run the '${cmd}' command\r\n`); continue; }
        if (c === "AUTH") {
          authed = rest[0] === user && rest[1] === pass;
          reply(authed ? "+OK\r\n" : "-WRONGPASS invalid username-password pair\r\n");
          continue;
        }
        if (!authed) { reply("-NOAUTH Authentication required.\r\n"); continue; }
        if (rest[0] && !rest[0].startsWith("mcp:")) { reply("-NOPERM No permissions to access a key\r\n"); continue; }
        if (c === "PING") reply("+PONG\r\n");
        else if (c === "GET") reply(bulk(data.get(rest[0])));
        else if (c === "SET") { data.set(rest[0], rest[1]); reply("+OK\r\n"); }
        else if (c === "GETDEL") { const v = data.get(rest[0]); data.delete(rest[0]); reply(bulk(v)); }
        else if (c === "DEL") { let n = 0; for (const k of rest) if (data.delete(k)) n++; reply(`:${n}\r\n`); }
        else if (c === "EXPIRE") reply(`:${data.has(rest[0]) ? 1 : 0}\r\n`);
        else reply("+OK\r\n");
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port, commands, data };
}

test("the Redis client authenticates as the store user and runs the store with allowed commands only", async () => {
  const fake = await fakeRedis();
  const client = createRedisClient({ url: `redis://mcp@127.0.0.1:${fake.port}`, password: "pw" });
  try {
    assert.equal(await client.ping(), "PONG");
    const store = createRefreshStore({ backend: client, refreshTtlSeconds: 60 });
    const first = await store.start({ sub: "u", clientId: "c" });
    const r1 = await store.rotate(first.token);
    assert.equal(r1.ok, true);
    assert.equal((await store.rotate(first.token)).reason, "reused");
    assert.ok(fake.commands.every((c) => ALLOWED.has(c)), `only allowed commands: ${[...new Set(fake.commands)]}`);
    assert.ok([...fake.data.keys()].every((k) => k.startsWith("mcp:oauth:")));
  } finally {
    client.close();
    fake.server.close();
  }
});

test("a wrong password or an unreachable store is an error, never a silent pass", async () => {
  const fake = await fakeRedis();
  const bad = createRedisClient({ url: `redis://mcp@127.0.0.1:${fake.port}`, password: "nope" });
  await assert.rejects(bad.get("mcp:x"), /WRONGPASS/);
  bad.close();
  fake.server.close();
  const down = createRedisClient({ url: "redis://mcp@127.0.0.1:1", password: "pw", timeoutMs: 500 });
  const store = createRefreshStore({ backend: down, refreshTtlSeconds: 60 });
  await assert.rejects(store.rotate(`cgr1.${b64url(randomBytes(16))}.${b64url(randomBytes(32))}`));
  down.close();
});

// ── The token endpoint, end to end ───────────────────────────────────────────

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
function platformJwt() {
  const now = Math.floor(Date.now() / 1000);
  return `${b64url(JSON.stringify({ alg: "HS256" }))}.${b64url(JSON.stringify({ sub: "user-1", email: "u@example.com", iat: now, exp: now + 30 * 86400 }))}.${b64url(randomBytes(32))}`;
}
const SIGNIN = platformJwt();
const issued = []; // sessions the stub handed out
const signedOut = new Set(); // sessions the user signed out of
const api = createServer((req, res) => {
  const json = (s, b) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(b)); };
  if (req.url.startsWith("/auth/status")) {
    // A fresh session per sign-in, so each test's session has its own state.
    const jwt = issued.length === 0 ? SIGNIN : platformJwt();
    issued.push(jwt);
    return json(200, { status: "authenticated", jwt });
  }
  const bearer = String(req.headers.authorization || "").replace(/^Bearer /, "");
  const ok = issued.includes(bearer) && !signedOut.has(bearer);
  if (req.url === "/api/v2/users/me") return ok ? json(200, { user_id: "user-1" }) : json(401, { code: "AUTH_INVALID" });
  if (req.url.startsWith("/api/v2/grids")) return ok ? json(200, { grids: [] }) : json(401, { code: "AUTH_INVALID" });
  json(404, {});
});
await new Promise((r) => api.listen(0, "127.0.0.1", r));
const apiBase = `http://127.0.0.1:${api.address().port}`;

const reservation = createServer();
await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
const port = reservation.address().port;
await new Promise((r) => reservation.close(r));
const BASE = `http://127.0.0.1:${port}`;
let stderr = "";
const child = spawn(process.execPath, ["src/web.js"], {
  env: {
    PATH: process.env.PATH, PORT: String(port), MCP_PUBLIC_URL: BASE,
    MCP_TOKEN_SIGNING_KEYS: b64url(randomBytes(32)),
    MCP_OAUTH_HMAC_SECRET: "refresh-test-hmac-secret-0000000000000",
    MCP_REFRESH_STORE: "memory",
    CLOUDGRID_API_URL: apiBase, CLOUDGRID_PUBLIC_API_URL: apiBase, MCP_TRUSTED_SERVER_SECRET: "",
    NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1", HTTPS_PROXY: "", HTTP_PROXY: "",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => { stderr += c; });
for (let i = 0; i < 100; i++) {
  if (child.exitCode !== null) throw new Error(stderr);
  try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* starting */ }
  await sleep(50);
}
after(() => { child.kill("SIGTERM"); api.close(); });

const form = (body) => fetch(`${BASE}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });

async function signIn() {
  const { client_id } = await (await fetch(`${BASE}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [REDIRECT] }) })).json();
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const html = await (await fetch(`${BASE}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(client_id)}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256`)).text();
  const sid = html.match(/sid=([0-9a-f-]{36})/)[1];
  const poll = await (await fetch(`${BASE}/oauth/authorize/poll?sid=${sid}`)).json();
  const code = new URL(poll.redirect).searchParams.get("code");
  const tok = await form({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id });
  return { client_id, tok: await tok.json() };
}

async function listGrids(token) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` };
  const init = await fetch(`${BASE}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } } }) });
  const session = init.headers.get("mcp-session-id");
  await init.text();
  const r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { ...headers, "mcp-session-id": session }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "grid_list_grids", arguments: {} } }) });
  await r.text();
  return r.status;
}

test("metadata advertises the refresh grant", async () => {
  const as = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(as.grant_types_supported, ["authorization_code", "refresh_token"]);
});

test("code -> access + refresh (1 h); refresh rotates; the old refresh token replayed ends the sign-in", async () => {
  const { client_id, tok } = await signIn();
  assert.ok(tok.refresh_token, "a refresh token is issued");
  assert.equal(tok.expires_in, 3600, "short access token when refresh is on");
  assert.ok(!JSON.stringify(tok).includes(SIGNIN));

  const r1 = await (await form({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id })).json();
  assert.ok(r1.access_token && r1.refresh_token);
  assert.notEqual(r1.refresh_token, tok.refresh_token, "rotated");
  assert.notEqual(r1.access_token, tok.access_token);
  assert.equal(await listGrids(r1.access_token), 200, "the refreshed access token works");

  const replay = await form({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id });
  assert.equal(replay.status, 400);
  assert.equal((await replay.json()).error, "invalid_grant");
  assert.match(stderr, /reuse detected/);
  const afterReplay = await form({ grant_type: "refresh_token", refresh_token: r1.refresh_token, client_id });
  assert.equal(afterReplay.status, 400, "the newest refresh token is revoked with its family");
});

test("a refresh token presented by another client is refused and revoked", async () => {
  const { tok } = await signIn();
  const r = await form({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id: "someone-else" });
  assert.equal(r.status, 400);
});

test("refresh after a CloudGrid sign-out is refused and ends the sign-in", async () => {
  const { client_id, tok } = await signIn();
  signedOut.add(issued[issued.length - 1]);
  const r = await form({ grant_type: "refresh_token", refresh_token: tok.refresh_token, client_id });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "invalid_grant");
  assert.match(stderr, /signed out; its sign-in was revoked/);
});
