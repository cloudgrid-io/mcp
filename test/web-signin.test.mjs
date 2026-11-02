// Sign-in on the hosted web edition (cloudgrid-io/cloudgrid#5783):
//   - access tokens are signed by this server, for this server, and checked for
//     signature, audience, issuer and expiry on every request;
//   - the account credential is never handed to the client;
//   - browsing tools work signed out, every other tool needs an account, and
//     each client is told to sign in the way it understands (authMode);
//   - a host alias answers for itself and accepts tokens from the primary host;
//   - a session token handed out by an older release still works while it lasts.
//
// The upstream API is a stub: it completes a sign-in, answers /users/me, and
// records every Authorization header it receives.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createTokenService, resolveSealKeys, resolveSigningKeys, generateSigningSeed } from "../src/mcp-tokens.js";
import { browserCookies } from "./helpers/browser.mjs";
import {
  authMode,
  callsProtectedTool,
  parseAuthModeOverrides,
  bearerChallenge,
  signInRequiredResult,
  PUBLIC_TOOLS,
} from "../src/web-auth.js";

const b64url = (b) => Buffer.from(b).toString("base64url");
const PROTOCOL = "2025-06-18";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

function platformJwt(sub = "user-1", ttl = 30 * 86400) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ sub, email: `${sub}@example.com`, name: sub, iat: now, exp: now + ttl }));
  return `${header}.${payload}.${b64url(randomBytes(32))}`;
}

// ── Unit: tokens ─────────────────────────────────────────────────────────────

const ISS = "https://mcp.example.test";
const AUD = `${ISS}/mcp`;

function service(seeds, opts = {}) {
  const { keys } = resolveSigningKeys({ MCP_TOKEN_SIGNING_KEYS: seeds.join(",") });
  return createTokenService({ keys, issuers: [ISS, "https://alias.example.test"], audiences: [AUD, "https://alias.example.test/mcp"], ...opts });
}

test("a token verifies, carries its audience, and seals the account credential", () => {
  const svc = service([generateSigningSeed()]);
  const grant = platformJwt();
  const { token, expiresIn } = svc.issue({ iss: ISS, aud: AUD, sub: "user-1", clientId: "c", grant, ttlSeconds: 3600 });
  assert.equal(expiresIn, 3600);
  const v = svc.verify(token);
  assert.equal(v.ok, true);
  assert.equal(v.claims.aud, AUD);
  assert.equal(v.claims.sub, "user-1");
  assert.equal(v.grant, grant);
  assert.ok(!token.includes(grant.split(".")[1]), "the credential is not readable inside the token");
  assert.ok(!JSON.stringify(v.claims).includes(grant), "the claims carry only the sealed form");
});

test("expired, foreign-audience, foreign-issuer, forged and tampered tokens are refused", () => {
  const seed = generateSigningSeed();
  let t = Date.now();
  const svc = service([seed], { now: () => t });
  const base = { iss: ISS, aud: AUD, sub: "u", clientId: "c", grant: platformJwt(), ttlSeconds: 60 };

  const { token } = svc.issue(base);
  t += 61_000;
  assert.equal(svc.verify(token).reason, "expired");
  t = Date.now();

  assert.equal(svc.verify(svc.issue({ ...base, aud: "https://other.example/mcp" }).token).reason, "wrong_audience");
  assert.equal(svc.verify(svc.issue({ ...base, iss: "https://other.example" }).token).reason, "wrong_issuer");

  const other = service([generateSigningSeed()]);
  assert.equal(svc.verify(other.issue(base).token).reason, "unknown_key", "a token from another key is refused");

  // Same kid, different signature: forge by swapping the payload.
  const good = svc.issue(base).token.split(".");
  const claims = JSON.parse(Buffer.from(good[1], "base64url").toString());
  claims.sub = "someone-else";
  const forged = `${good[0]}.${b64url(JSON.stringify(claims))}.${good[2]}`;
  assert.equal(svc.verify(forged).reason, "bad_signature");

  assert.equal(svc.verify(platformJwt()).reason, "not_ours", "a platform session token is not an access token");
  assert.equal(svc.verify("garbage").reason, "not_ours");
});

test("two keys at once: the old key verifies, the first key signs", () => {
  const oldSeed = generateSigningSeed();
  const newSeed = generateSigningSeed();
  const before = service([oldSeed]);
  const during = service([newSeed, oldSeed]);
  const base = { iss: ISS, aud: AUD, sub: "u", clientId: "c", grant: platformJwt(), ttlSeconds: 60 };
  const oldToken = before.issue(base).token;
  assert.equal(during.verify(oldToken).ok, true, "a token signed by the previous key still verifies");
  const newToken = during.issue(base).token;
  const kid = JSON.parse(Buffer.from(newToken.split(".")[0], "base64url").toString()).kid;
  assert.equal(kid, during.signingKid);
  assert.notEqual(kid, before.signingKid);
  assert.equal(service([oldSeed]).verify(newToken).reason, "unknown_key", "the old key alone does not know the new one");
});

test("a malformed signing key stops the boot", () => {
  assert.throws(() => resolveSigningKeys({ MCP_TOKEN_SIGNING_KEYS: "not-a-key" }), /entry 1/);
  assert.equal(resolveSigningKeys({}).ephemeral, true);
});

// ── Unit: per-client sign-in signal ──────────────────────────────────────────

test("authMode picks the signal from clientInfo", () => {
  assert.equal(authMode({ name: "Anthropic/ClaudeAI" }), "call");
  assert.equal(authMode({ name: "claude-ai" }), "call");
  assert.equal(authMode({ name: "openai-mcp" }), "call");
  for (const name of ["claude-code", "gemini-cli-mcp-client", "Visual Studio Code", "cursor-vscode", "copilot-studio", "", undefined]) {
    assert.equal(authMode({ name }), "connect", `${name} signs in at connect`);
  }
  assert.equal(authMode(undefined), "connect");
  const overrides = parseAuthModeOverrides("openai-mcp=tool-error, bad=nonsense, =x");
  assert.equal(authMode({ name: "openai-mcp" }, overrides), "tool-error");
  assert.equal(overrides.has("bad"), false);
});

test("only browsing tools are public; a batch with one protected call is protected", () => {
  assert.deepEqual([...PUBLIC_TOOLS].sort(), ["grid_get_app_source", "grid_get_template", "grid_start"]);
  const call = (name) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name } });
  assert.equal(callsProtectedTool(call("grid_start")), false);
  assert.equal(callsProtectedTool(call("grid_plug")), true);
  assert.equal(callsProtectedTool(call(undefined)), true);
  assert.equal(callsProtectedTool([call("grid_start"), call("grid_delete")]), true);
  assert.equal(callsProtectedTool({ jsonrpc: "2.0", id: 1, method: "tools/list" }), false);
});

test("the challenge names the metadata and the scope; the tool error carries it for ChatGPT", () => {
  const c = bearerChallenge("https://h.example/");
  assert.match(c, /^Bearer resource_metadata="https:\/\/h\.example\/\.well-known\/oauth-protected-resource", scope="cloudgrid"$/);
  assert.match(bearerChallenge("https://h.example", { error: "invalid_token" }), /error="invalid_token"/);
  const r = signInRequiredResult("https://h.example");
  assert.equal(r.isError, true);
  assert.match(r._meta["mcp/www_authenticate"][0], /resource_metadata=.*error="insufficient_scope"/);
});

// ── Integration ──────────────────────────────────────────────────────────────

const SEED = generateSigningSeed();
const LEGACY_GOOD = platformJwt("legacy-user");
const LEGACY_SIGNED_OUT = platformJwt("legacy-signed-out");
const SIGNIN_JWT = platformJwt("user-1");
const signedOut = new Set([LEGACY_SIGNED_OUT]); // sessions the API treats as signed out
const children = new Map(); // downstream child token -> parent session
const downstream = { enabled: true, status: 200 }; // status: what the exchange answers when enabled
const apiDown = { on: false }; // /users/me answers 500
const TRUSTED = "trusted-server-secret-for-tests";
// A session token minted after the 0.22 cutoff (a fresh CLI login, say).
function platformJwtIssuedAt(sub, iat) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ sub, email: `${sub}@example.com`, iat, exp: iat + 30 * 86400 }));
  return `${header}.${payload}.${b64url(randomBytes(32))}`;
}
const LEGACY_CUTOFF = Math.floor(Date.now() / 1000) + 5;
const TOO_NEW = platformJwtIssuedAt("new-cli-user", LEGACY_CUTOFF + 10);

async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return server.address().port;
}

const seenAuth = []; // every Authorization header the API received, by path
const api = createServer((req, res) => {
  const auth = req.headers.authorization || "";
  seenAuth.push({ path: req.url, auth });
  const json = (status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.url.startsWith("/auth/status")) return json(200, { status: "authenticated", jwt: SIGNIN_JWT });
  const raw = auth.replace(/^Bearer /, "");
  // A child token (from the downstream exchange) stands for its parent session.
  const bearer = children.get(raw) ?? raw;
  // Any session token this test minted is valid unless it was signed out.
  const sub = (() => { try { return JSON.parse(Buffer.from(bearer.split(".")[1], "base64url").toString()).sub; } catch { return null; } })();
  const valid = sub && !signedOut.has(bearer);
  if (req.url === "/api/v2/auth/token/downstream" && req.method === "POST") {
    if (!downstream.enabled) return json(404, {});
    if (downstream.status !== 200) return json(downstream.status, {});
    if (req.headers["x-cloudgrid-trusted-server-auth"] !== TRUSTED) return json(403, {});
    if (!valid || children.has(raw)) return json(401, { code: "AUTH_INVALID" });
    const child = `${b64url(JSON.stringify({ alg: "HS256" }))}.${b64url(JSON.stringify({ sub, email: `${sub}@example.com`, azp: "hosted-mcp", n: children.size }))}.${b64url(randomBytes(16))}`;
    children.set(child, bearer);
    return json(200, { access_token: child, expires_in: 3600 });
  }
  if (req.url === "/api/v2/users/me" && apiDown.on) return json(500, {});
  if (req.url === "/api/v2/users/me") {
    return valid ? json(200, { user_id: sub, email: `${sub}@example.com` }) : json(401, { error: "AUTH_INVALID" });
  }
  if (req.url.startsWith("/api/v2/grids")) {
    return valid ? json(200, { grids: [{ slug: "g1", name: "G1", role: "admin", render_ready: true }] }) : json(401, { code: "AUTH_INVALID" });
  }
  json(404, {});
});
const apiPort = await listen(api);
const apiBase = `http://127.0.0.1:${apiPort}`;

const reservation = createServer();
const port = await listen(reservation);
await new Promise((r) => reservation.close(r));
const BASE = `http://127.0.0.1:${port}`;
const ALIAS = `http://localhost:${port}`;
let stderr = "";
const child = spawn(process.execPath, ["src/web.js"], {
  env: {
    PATH: process.env.PATH,
    PORT: String(port),
    MCP_PUBLIC_URL: BASE,
    MCP_ALIAS_URLS: ALIAS,
    MCP_TOKEN_SIGNING_KEYS: SEED,
    MCP_OAUTH_HMAC_SECRET: "test-hmac-secret-web-signin-00000000000",
    MCP_AUTH_MODE_OVERRIDES: "tool-error-client=tool-error",
    MCP_LEGACY_TOKENS_ISSUED_BEFORE: String(LEGACY_CUTOFF),
    CLOUDGRID_API_URL: apiBase,
    CLOUDGRID_PUBLIC_API_URL: apiBase,
    MCP_TRUSTED_SERVER_SECRET: TRUSTED,
    NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1",
    HTTPS_PROXY: "", HTTP_PROXY: "", https_proxy: "", http_proxy: "",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => { stderr += c; });
for (let i = 0; i < 100; i++) {
  if (child.exitCode !== null) throw new Error(`web exited: ${stderr}`);
  try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* starting */ }
  await sleep(50);
}
after(async () => {
  child.kill("SIGTERM");
  await new Promise((r) => api.close(r));
});

// The client's view of the server's key, to mint expired / foreign tokens.
const clientSideTokens = createTokenService({
  keys: resolveSigningKeys({ MCP_TOKEN_SIGNING_KEYS: SEED }).keys,
  issuers: [BASE],
  audiences: [`${BASE}/mcp`],
});

async function rpc(body, { token, session, base = BASE, host } = {}) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (session) headers["mcp-session-id"] = session;
  if (host) headers.Host = host;
  const res = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  try { json = JSON.parse(dataLine ? dataLine.slice(6) : text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, json, session: res.headers.get("mcp-session-id") };
}

const init = (name) => ({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name, version: "1" } } });
const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
const call = (name, args = {}, id = 2) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

async function open(name, token) {
  const r = await rpc(init(name), { token });
  assert.equal(r.status, 200, `initialize for ${name}: ${r.status}`);
  await rpc(initialized, { token, session: r.session });
  return r.session;
}

async function signIn({ base = BASE } = {}) {
  const reg = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Claude" }),
  });
  assert.equal(reg.status, 201);
  const { client_id } = await reg.json();
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const page = await fetch(`${base}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(client_id)}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&state=s1`);
  assert.equal(page.status, 200);
  const sid = (await page.text()).match(/sid=([0-9a-f-]{36})/)?.[1];
  const poll = await (await fetch(`${base}/oauth/authorize/poll?sid=${sid}`, { headers: { Cookie: browserCookies(page, SIGNIN_JWT) } })).json();
  assert.equal(poll.status, "ready");
  const code = new URL(poll.redirect).searchParams.get("code");
  const tok = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id }),
  });
  assert.equal(tok.status, 200);
  return tok.json();
}

test("OAuth discovery is served on the primary host and answers for an alias as itself", async () => {
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json();
  assert.equal(prm.resource, `${BASE}/mcp`);
  const aliasPrm = await (await fetch(`${ALIAS}/.well-known/oauth-protected-resource`)).json();
  assert.equal(aliasPrm.resource, `${ALIAS}/mcp`);
  const as = await (await fetch(`${ALIAS}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.issuer, ALIAS);
});

test("Claude: browsing works signed out; a protected call gets 401 with the challenge and reaches nothing", async () => {
  const session = await open("Anthropic/ClaudeAI");
  const list = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { session });
  assert.equal(list.status, 200);
  const names = list.json.result.tools.map((t) => t.name);
  assert.ok(names.includes("grid_plug"));
  assert.ok(!names.includes("grid_login") && !names.includes("grid_login_status"), "no sign-in tools on the hosted edition");

  const start = await rpc(call("grid_start"), { session });
  assert.equal(start.status, 200);

  const before = seenAuth.length;
  const plug = await rpc(call("grid_list_grids"), { session });
  assert.equal(plug.status, 401);
  assert.match(plug.headers.get("www-authenticate"), /resource_metadata=".*\/\.well-known\/oauth-protected-resource", scope="cloudgrid"/);
  assert.equal(seenAuth.slice(before).filter((s) => s.path.startsWith("/api/v2/grids")).length, 0, "nothing reached the API");
});

test("a spoofed clientInfo does not unlock a protected call", async () => {
  const session = await open("Anthropic/ClaudeAI"); // claims to be Claude, sends no token
  const r = await rpc(call("grid_plug", { html: "<p>x</p>" }), { session });
  assert.equal(r.status, 401);
});

test("CLI, IDE and unknown clients get 401 at initialize", async () => {
  for (const name of ["claude-code", "cursor-vscode", "Visual Studio Code", "something-new"]) {
    const r = await rpc(init(name));
    assert.equal(r.status, 401, name);
    assert.match(r.headers.get("www-authenticate"), /scope="cloudgrid"/);
  }
});

test("tool-error mode answers a protected call with the sign-in tool error", async () => {
  const session = await open("tool-error-client");
  const r = await rpc(call("grid_list_grids"), { session });
  assert.equal(r.status, 200);
  assert.equal(r.json.result.isError, true);
  assert.match(r.json.result._meta["mcp/www_authenticate"][0], /resource_metadata=/);
});

test("the token endpoint returns this server's token, never the account credential; tools use the credential downstream", async () => {
  const tok = await signIn();
  assert.notEqual(tok.access_token, SIGNIN_JWT);
  assert.ok(!JSON.stringify(tok).includes(SIGNIN_JWT), "the account credential is not in the response");
  const header = JSON.parse(Buffer.from(tok.access_token.split(".")[0], "base64url").toString());
  assert.equal(header.alg, "EdDSA");
  assert.equal(tok.token_type, "Bearer");
  // No refresh store: a 30-day token, never past the session sealed in it.
  assert.ok(tok.expires_in > 29 * 86400 && tok.expires_in <= 30 * 86400, `expires_in=${tok.expires_in}`);
  assert.equal(tok.refresh_token, undefined, "no refresh store configured: no refresh token");

  const session = await open("claude-code", tok.access_token);
  const before = seenAuth.length;
  const r = await rpc(call("grid_list_grids"), { token: tok.access_token, session });
  assert.equal(r.status, 200);
  assert.ok(!r.json.result.isError, JSON.stringify(r.json.result));
  const downstreamCalls = seenAuth.slice(before).filter((s) => s.path.startsWith("/api/v2/grids"));
  assert.equal(downstreamCalls.length, 1);
  const sent = downstreamCalls[0].auth.replace(/^Bearer /, "");
  assert.notEqual(sent, tok.access_token, "the API never gets the MCP token");
  assert.notEqual(sent, SIGNIN_JWT, "nor the 30-day session: a scoped child token");
  assert.equal(children.get(sent), SIGNIN_JWT, "the child was minted from this sign-in's session");
});

test("expired, foreign-audience and forged tokens get 401 invalid_token on every path", async () => {
  const grant = SIGNIN_JWT;
  const expired = clientSideTokens.issue({ iss: BASE, aud: `${BASE}/mcp`, sub: "user-1", clientId: "c", grant, ttlSeconds: -10 }).token;
  const foreign = createTokenService({ keys: resolveSigningKeys({ MCP_TOKEN_SIGNING_KEYS: SEED }).keys, issuers: [BASE], audiences: ["https://elsewhere.example/mcp"] })
    .issue({ iss: BASE, aud: "https://elsewhere.example/mcp", sub: "user-1", clientId: "c", grant, ttlSeconds: 600 }).token;
  const forged = createTokenService({ keys: resolveSigningKeys({ MCP_TOKEN_SIGNING_KEYS: generateSigningSeed() }).keys, issuers: [BASE], audiences: [`${BASE}/mcp`] })
    .issue({ iss: BASE, aud: `${BASE}/mcp`, sub: "user-1", clientId: "c", grant, ttlSeconds: 600 }).token;
  const session = await open("Anthropic/ClaudeAI");
  for (const [label, token] of [["expired", expired], ["foreign audience", foreign], ["forged", forged]]) {
    for (const body of [init("Anthropic/ClaudeAI"), call("grid_start"), call("grid_plug", { html: "<p>x</p>" })]) {
      const r = await rpc(body, { token, session: body.method === "initialize" ? undefined : session });
      assert.equal(r.status, 401, `${label} on ${body.method} ${body.params?.name ?? ""}`);
      assert.match(r.headers.get("www-authenticate"), /error="invalid_token"/);
    }
    const sse = await fetch(`${BASE}/mcp`, { headers: { Accept: "text/event-stream", Authorization: `Bearer ${token}`, "mcp-session-id": session } });
    assert.equal(sse.status, 401, `${label} on GET /mcp`);
  }
});

test("a token issued on the alias works on the primary host, and the reverse", async () => {
  const aliasTok = await signIn({ base: ALIAS });
  const claims = JSON.parse(Buffer.from(aliasTok.access_token.split(".")[1], "base64url").toString());
  assert.equal(claims.aud, `${ALIAS}/mcp`);
  const s1 = await open("claude-code", aliasTok.access_token);
  assert.equal((await rpc(call("grid_list_grids"), { token: aliasTok.access_token, session: s1 })).status, 200);

  const primaryTok = await signIn();
  const r = await rpc(init("claude-code"), { token: primaryTok.access_token, base: ALIAS });
  assert.equal(r.status, 200);
});

test("a session token from before 0.22 still works while the API accepts it; a signed-out one gets 401", async () => {
  const session = await open("claude-code", LEGACY_GOOD);
  const r = await rpc(call("grid_list_grids"), { token: LEGACY_GOOD, session });
  assert.equal(r.status, 200);
  assert.ok(!r.json.result.isError);
  assert.match(stderr, /legacy connection/);

  const bad = await rpc(init("claude-code"), { token: LEGACY_SIGNED_OUT });
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get("www-authenticate"), /error="invalid_token"/);
});

test("grid_start states the signed-in account from the verified token (#317)", async () => {
  const token = clientSideTokens.issue({ iss: BASE, aud: `${BASE}/mcp`, sub: "user-1", clientId: "c", grant: SIGNIN_JWT, ttlSeconds: 600 }).token;
  const session = await open("claude-code", token);
  const r = await rpc(call("grid_start"), { token, session });
  assert.equal(r.status, 200);
  assert.equal(r.json.result.structuredContent.context.signed_in, true);
  assert.equal(r.json.result.structuredContent.context.email, "user-1@example.com");
  assert.match(r.json.result.content[0].text, /signed in to CloudGrid as user-1@example\.com/);
});

test("a session belongs to one account: another account's token on it gets 404", async () => {
  const mint = (sub) => clientSideTokens.issue({ iss: BASE, aud: `${BASE}/mcp`, sub, clientId: "c", grant: platformJwt(sub), ttlSeconds: 600 }).token;
  const a = mint("first-user");
  const b = mint("second-user");
  const session = await open("claude-code", a);
  const first = await rpc(call("grid_start"), { token: a, session });
  assert.equal(first.json.result.structuredContent.context.email, "first-user@example.com");
  const second = await rpc(call("grid_start"), { token: b, session });
  assert.equal(second.status, 404, "the other account cannot use this session");
  // The id may be rebuilt for whoever presents it next, but empty: nothing the
  // first account's session held carries over.
  const again = await rpc(call("grid_start"), { token: a, session });
  assert.equal(again.json.result.structuredContent.context.email, "first-user@example.com");
});

test("a session started signed out is bound when the user signs in", async () => {
  const session = await open("Anthropic/ClaudeAI");
  const mint = (sub) => clientSideTokens.issue({ iss: BASE, aud: `${BASE}/mcp`, sub, clientId: "c", grant: platformJwt(sub), ttlSeconds: 600 }).token;
  const a = mint("late-user");
  const r = await rpc(call("grid_list_grids"), { token: a, session });
  assert.equal(r.status, 200);
  assert.equal((await rpc(call("grid_start"), { token: mint("other-user"), session })).status, 404);
});

test("a signed-out CloudGrid session reaches the client as a 401, and the refused grant stays refused", async () => {
  const grant = platformJwt("logout-user");
  const token = clientSideTokens.issue({ iss: BASE, aud: `${BASE}/mcp`, sub: "logout-user", clientId: "c", grant, ttlSeconds: 600 }).token;
  const session = await open("claude-code", token);
  assert.equal((await rpc(call("grid_list_grids"), { token, session })).status, 200);
  signedOut.add(grant); // the user signs out in the Console
  // The tool call itself hits the API's 401 and marks the grant refused...
  await rpc(call("grid_list_grids", {}, 3), { token, session });
  // ...so the next request is a 401 the client acts on, not a tool reply.
  const next = await rpc(call("grid_start", {}, 4), { token, session });
  assert.equal(next.status, 401);
  assert.match(next.headers.get("www-authenticate"), /error="invalid_token"/);
  // A new session with the same token is refused too (the API says signed out).
  const fresh = await rpc(init("claude-code"), { token: clientSideTokens.issue({ iss: BASE, aud: `${BASE}/mcp`, sub: "logout-user", clientId: "c", grant, ttlSeconds: 600 }).token });
  assert.equal(fresh.status, 401);
});

test("a session token issued after the 0.22 cutoff is not a legacy connection", async () => {
  const r = await rpc(init("claude-code"), { token: TOO_NEW });
  assert.equal(r.status, 401);
  assert.match(r.headers.get("www-authenticate"), /error="invalid_token"/);
});

test("a hosted server with the OAuth secret but no signing key refuses to start", async () => {
  const c = spawn(process.execPath, ["src/web.js"], {
    env: { PATH: process.env.PATH, PORT: "0", MCP_OAUTH_HMAC_SECRET: "x".repeat(40), MCP_TOKEN_SIGNING_KEYS: "" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  c.stderr.on("data", (d) => { err += d; });
  const code = await new Promise((r) => c.on("exit", r));
  assert.equal(code, 1);
  assert.match(err, /Refusing to start/);
});

test("when the API does not offer the exchange yet, tool calls use the session itself", async () => {
  downstream.enabled = false;
  try {
    const grant = platformJwt("no-exchange-user");
    const token = clientSideTokens.issue({ iss: BASE, aud: `${BASE}/mcp`, sub: "no-exchange-user", clientId: "c", grant, ttlSeconds: 600 }).token;
    const session = await open("claude-code", token);
    const before = seenAuth.length;
    assert.equal((await rpc(call("grid_list_grids"), { token, session })).status, 200);
    const calls = seenAuth.slice(before).filter((x) => x.path.startsWith("/api/v2/grids"));
    assert.equal(calls[0].auth, `Bearer ${grant}`);
  } finally {
    downstream.enabled = true;
  }
});

test("a separate seal key, when configured, seals the session; the signing key alone cannot open it", () => {
  const seed = generateSigningSeed();
  const sealKey = generateSigningSeed();
  const keys = resolveSigningKeys({ MCP_TOKEN_SIGNING_KEYS: seed }).keys;
  const withSeal = createTokenService({ keys, sealKeys: resolveSealKeys({ MCP_TOKEN_SEAL_KEYS: sealKey }, keys), issuers: [ISS], audiences: [AUD] });
  const derivedOnly = createTokenService({ keys, sealKeys: resolveSealKeys({}, keys), issuers: [ISS], audiences: [AUD] });
  const grant = platformJwt();
  const { token } = withSeal.issue({ iss: ISS, aud: AUD, sub: "u", clientId: "c", grant, ttlSeconds: 60 });
  assert.equal(withSeal.verify(token).grant, grant);
  assert.equal(derivedOnly.verify(token).reason, "bad_grant", "the signing seed does not open it");
  assert.throws(() => resolveSealKeys({ MCP_TOKEN_SEAL_KEYS: "short" }, keys), /entry 1/);
});

test("a request with no token on a bound session does not run as that account", async () => {
  const grant = platformJwt("bound-user");
  const token = clientSideTokens.issue({ iss: BASE, aud: `${BASE}/mcp`, sub: "bound-user", clientId: "c", grant, ttlSeconds: 600 }).token;
  const session = await open("claude-code", token);
  assert.equal((await rpc(call("grid_start"), { token, session })).status, 200);
  const before = seenAuth.length;
  const anon = await rpc(call("grid_start", {}, 5), { session });
  assert.equal(anon.status, 401, "no token on a bound session is a 401, not the bound account");
  assert.match(anon.headers.get("www-authenticate"), /error="invalid_token"/);
  const prot = await rpc(call("grid_list_grids", {}, 6), { session });
  assert.equal(prot.status, 401);
  assert.equal(seenAuth.slice(before).filter((x) => x.auth).length, 0, "no API call carried a credential");
  const del = await fetch(`${BASE}/mcp`, { method: "DELETE", headers: { "mcp-session-id": session } });
  assert.equal(del.status, 401, "a token-less DELETE cannot end the session");
  assert.equal((await rpc(call("grid_start", {}, 7), { token, session })).status, 200, "the session is still there for its owner");
});

test("a failing downstream exchange (403/5xx) answers 503 and never sends the session", async () => {
  for (const status of [403, 500]) {
    downstream.status = status;
    try {
      const grant = platformJwt(`exchange-${status}`);
      const token = clientSideTokens.issue({ iss: BASE, aud: `${BASE}/mcp`, sub: `exchange-${status}`, clientId: "c", grant, ttlSeconds: 600 }).token;
      const before = seenAuth.length;
      const r = await rpc(init("claude-code"), { token });
      assert.equal(r.status, 503, `exchange ${status} -> 503`);
      assert.ok(!seenAuth.slice(before).some((x) => x.path.startsWith("/api/v2/grids")));
    } finally {
      downstream.status = 200;
    }
  }
});

test("when the API cannot check the session, an MCP token gets 503 like a legacy one (fail closed)", async () => {
  apiDown.on = true;
  try {
    const grant = platformJwt("outage-user");
    const token = clientSideTokens.issue({ iss: BASE, aud: `${BASE}/mcp`, sub: "outage-user", clientId: "c", grant, ttlSeconds: 600 }).token;
    assert.equal((await rpc(init("claude-code"), { token })).status, 503);
  } finally {
    apiDown.on = false;
  }
});

test("with no cutoff configured, no earlier session token is accepted (a restart cannot reopen it)", async () => {
  const reservation2 = createServer();
  const p2 = await listen(reservation2);
  await new Promise((r) => reservation2.close(r));
  const base2 = `http://127.0.0.1:${p2}`;
  const c2 = spawn(process.execPath, ["src/web.js"], {
    env: {
      PATH: process.env.PATH, PORT: String(p2), MCP_PUBLIC_URL: base2, MCP_TOKEN_SIGNING_KEYS: SEED,
      CLOUDGRID_API_URL: apiBase, CLOUDGRID_PUBLIC_API_URL: apiBase, MCP_TRUSTED_SERVER_SECRET: "",
      NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1", HTTPS_PROXY: "", HTTP_PROXY: "",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base2}/healthz`)).ok) break; } catch { /* starting */ } await sleep(50); }
    const r = await rpc(init("claude-code"), { token: LEGACY_GOOD, base: base2 });
    assert.equal(r.status, 401, "LEGACY_GOOD is valid at the API, but no cutoff means no legacy acceptance");
  } finally {
    c2.kill("SIGTERM");
  }
});

test("a server with a public MCP_PUBLIC_URL and no signing key refuses to start", async () => {
  const c = spawn(process.execPath, ["src/web.js"], {
    env: { PATH: process.env.PATH, PORT: "0", MCP_PUBLIC_URL: "https://mcp.example.test", MCP_TOKEN_SIGNING_KEYS: "" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const code = await new Promise((r) => c.on("exit", r));
  assert.equal(code, 1);
});

test("a 30-day access token is honoured late in its life", async () => {
  const grant = platformJwt("long-user"); // session valid for 30 days from now
  const issuedAgo = 29 * 86400 * 1000;
  const old = createTokenService({
    keys: resolveSigningKeys({ MCP_TOKEN_SIGNING_KEYS: SEED }).keys,
    issuers: [BASE], audiences: [`${BASE}/mcp`], now: () => Date.now() - issuedAgo,
  }).issue({ iss: BASE, aud: `${BASE}/mcp`, sub: "long-user", clientId: "c", grant, ttlSeconds: 30 * 86400 }).token;
  const session = await open("claude-code", old);
  assert.equal((await rpc(call("grid_list_grids"), { token: old, session })).status, 200, "day 29 of a 30-day token");
});

test("a Console sign-out reaches a 30-day token on the next call, within 30 s, with no tool error needed", async () => {
  const grant = platformJwt("signout-30d");
  const token = clientSideTokens.issue({ iss: BASE, aud: `${BASE}/mcp`, sub: "signout-30d", clientId: "c", grant, ttlSeconds: 30 * 86400 }).token;
  const session = await open("claude-code", token);
  assert.equal((await rpc(call("grid_start"), { token, session })).status, 200);
  signedOut.add(grant); // signed out in the Console; nothing on this server saw it
  await sleep(31_000); // the per-call check is cached for at most 30 s
  const next = await rpc(call("grid_start", {}, 9), { token, session });
  assert.equal(next.status, 401);
  assert.match(next.headers.get("www-authenticate"), /error="invalid_token"/);
});

test("MCP_ACCESS_TOKEN_TTL_S changes the lifetime of issued tokens", async () => {
  const reservation3 = createServer();
  const p3 = await listen(reservation3);
  await new Promise((r) => reservation3.close(r));
  const base3 = `http://127.0.0.1:${p3}`;
  const c3 = spawn(process.execPath, ["src/web.js"], {
    env: {
      PATH: process.env.PATH, PORT: String(p3), MCP_PUBLIC_URL: base3, MCP_TOKEN_SIGNING_KEYS: SEED,
      MCP_OAUTH_HMAC_SECRET: "ttl-test-hmac-secret-000000000000000000", MCP_ACCESS_TOKEN_TTL_S: "3600",
      CLOUDGRID_API_URL: apiBase, CLOUDGRID_PUBLIC_API_URL: apiBase, MCP_TRUSTED_SERVER_SECRET: "",
      NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1", HTTPS_PROXY: "", HTTP_PROXY: "",
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base3}/healthz`)).ok) break; } catch { /* starting */ } await sleep(50); }
    const tok = await signIn({ base: base3 });
    assert.equal(tok.expires_in, 3600);
  } finally {
    c3.kill("SIGTERM");
  }
});
