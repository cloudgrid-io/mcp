// The post-sign-in half of the OAuth flow: /oauth/authorize/poll mints a code,
// /oauth/token exchanges it. Reported 2026-08-30 — ChatGPT web shows "Something
// went wrong with setting up the connection" AFTER the user signs in, which puts
// the failure here and nowhere earlier.
//
// Every earlier step was verified healthy against the live staging host by hand:
// discovery, registration, authorize, and an authenticated POST /mcp with a real
// JWT all succeed. What could not be driven by hand is this half — it needs a
// completed CloudGrid sign-in. So it is driven here, against a STUB upstream
// that answers /auth/status as an authenticated user would.
//
// The stub is the point: it lets the test walk the exact sequence ChatGPT walks,
// including the form-encoded token POST, without a browser or a real account.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const SECRET = "test-oauth-hmac-secret-token-exchange-000000";
// ChatGPT's real connector callback — the shape that matters for this bug.
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// A JWT the server can decode: only the payload is read (decodeJwt), never verified here.
function fakeJwt() {
  const payload = b64url(Buffer.from(JSON.stringify({ sub: "u1", email: "t@example.com", exp: Math.floor(Date.now() / 1000) + 3600 })));
  return `${b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })))}.${payload}.sig`;
}

async function listen(server, p = 0) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(p, "127.0.0.1", resolve); });
  return server.address().port;
}

// Stands in for api.cloudgrid.io: the user has completed sign-in.
async function startUpstream() {
  const jwt = fakeJwt();
  const server = createServer((req, res) => {
    if (req.url.startsWith("/auth/status")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "authenticated", jwt }));
      return;
    }
    res.writeHead(404).end();
  });
  const port = await listen(server);
  return { server, port, jwt, base: `http://127.0.0.1:${port}` };
}

async function startWeb(upstreamBase) {
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise((r) => reservation.close(r));
  const baseUrl = `http://127.0.0.1:${port}`;
  let stderr = "";
  const child = spawn(process.execPath, ["src/web.js"], {
    env: {
      PORT: String(port),
      MCP_PUBLIC_URL: baseUrl,
      MCP_REQUIRE_AUTH: "1",
      MCP_OAUTH_HMAC_SECRET: SECRET,
      CLOUDGRID_API_URL: upstreamBase,
      CLOUDGRID_PUBLIC_API_URL: upstreamBase,
      MCP_TRUSTED_SERVER_SECRET: "",
      NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1",
      HTTPS_PROXY: "", HTTP_PROXY: "", https_proxy: "", http_proxy: "",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => { stderr += c; });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`web exited: ${stderr}`);
    try { if ((await fetch(`${baseUrl}/healthz`)).ok) break; } catch { /* starting */ }
    await sleep(50);
  }
  return { child, baseUrl, stderr: () => stderr };
}

const upstream = await startUpstream();
const web = await startWeb(upstream.base);
after(async () => {
  web.child.kill("SIGTERM");
  await new Promise((r) => upstream.server.close(r));
});

// Walk the flow exactly as ChatGPT does, up to the point of holding a code.
async function codeInHand() {
  const reg = await fetch(`${web.baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  });
  assert.equal(reg.status, 201, "registration should succeed");
  const { client_id } = await reg.json();

  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const authorizeUrl =
    `${web.baseUrl}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(client_id)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}` +
    `&code_challenge_method=S256&state=st-1&scope=cloudgrid`;
  const page = await fetch(authorizeUrl);
  assert.equal(page.status, 200, "authorize should render the interstitial");
  const sid = (await page.text()).match(/sid=([0-9a-f-]{36})/)?.[1];
  assert.ok(sid, "interstitial should carry a poll sid");

  // The sign-in the user just completed.
  const poll = await (await fetch(`${web.baseUrl}/oauth/authorize/poll?sid=${sid}`)).json();
  assert.equal(poll.status, "ready", `poll should be ready once signed in: ${JSON.stringify(poll)}`);
  const code = new URL(poll.redirect).searchParams.get("code");
  assert.ok(code, "the redirect should carry an authorization code");
  return { client_id, code, verifier };
}

test("the code ChatGPT receives exchanges for an access token", async () => {
  const { client_id, code, verifier } = await codeInHand();
  const res = await fetch(`${web.baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id,
    }),
  });
  const body = await res.text();
  assert.equal(res.status, 200, `token exchange should succeed, got ${res.status}: ${body}`);
  const tok = JSON.parse(body);
  assert.equal(tok.token_type, "Bearer");
  assert.ok(tok.access_token, "an access token should come back");
});

// Each rejection must NAME its cause. Before this, all five returned a
// byte-identical {"error":"invalid_grant"} and logged nothing, which is why the
// reported failure could not be placed from either end.
async function exchange(mutate) {
  const { client_id, code, verifier } = await codeInHand();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: REDIRECT,
    client_id,
  });
  mutate(body);
  const res = await fetch(`${web.baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return { status: res.status, body: await res.json() };
}

test("a missing client_id says so instead of a bare invalid_grant", async () => {
  const { status, body } = await exchange((b) => b.delete("client_id"));
  assert.equal(status, 400);
  assert.match(body.error_description, /client_id is required/);
});

test("a mismatched redirect_uri names both values", async () => {
  const { status, body } = await exchange((b) => b.set("redirect_uri", `${REDIRECT}/`));
  assert.equal(status, 400);
  assert.match(body.error_description, /redirect_uri does not match/);
});

test("a missing code_verifier is distinguished from a wrong one", async () => {
  const { status, body } = await exchange((b) => b.delete("code_verifier"));
  assert.equal(status, 400);
  assert.match(body.error_description, /code_verifier is required/);
});

// Single-use is correct — but a client that retries the exchange (a dropped
// response, a backend retry) lands here, and "already exchanged" is the
// difference between a two-minute diagnosis and an unreadable one.
test("re-exchanging a used code says it was already exchanged", async () => {
  const { client_id, code, verifier } = await codeInHand();
  const form = () =>
    new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id });
  const post = () =>
    fetch(`${web.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form(),
    });
  assert.equal((await post()).status, 200, "first exchange should succeed");
  const second = await post();
  assert.equal(second.status, 400);
  assert.match((await second.json()).error_description, /already exchanged/);
});

// The client derives this URL from the resource (…/mcp). It answered 404 while
// the protected-resource twin answered 200 — an asymmetry, not a decision.
test("authorization-server metadata is served at the path-inserted URL too", async () => {
  const root = await fetch(`${web.baseUrl}/.well-known/oauth-authorization-server`);
  const nested = await fetch(`${web.baseUrl}/.well-known/oauth-authorization-server/mcp`);
  assert.equal(root.status, 200);
  assert.equal(nested.status, 200, "the path-inserted form must not 404");
  assert.deepEqual(await nested.json(), await root.json());
});
