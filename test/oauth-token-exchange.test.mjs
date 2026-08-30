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
// ChatGPT's real connector callback. Used where the SHAPE matters, and never
// followed — a test must not put a request on the public internet.
const CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
// The client redirect the chain tests actually follow: a local sink, so the
// whole authorize -> sign-in -> complete -> client chain terminates in-process.
let REDIRECT = null;

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
    if (req.url.startsWith("/auth/login")) {
      // Stands in for the console sign-in: the user signs in, and CloudGrid
      // hands the browser to return_url with the same session code.
      const u = new URL(req.url, "http://x");
      const ret = u.searchParams.get("return_url");
      const code = u.searchParams.get("code");
      res.writeHead(302, { Location: `${ret}?code=${encodeURIComponent(code)}` });
      res.end();
      return;
    }
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

// The client's callback. Terminates the redirect chain locally.
const sink = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("client callback reached");
});
const sinkPort = await listen(sink);
REDIRECT = `http://127.0.0.1:${sinkPort}/connector/callback`;

const upstream = await startUpstream();
const web = await startWeb(upstream.base);
after(async () => {
  web.child.kill("SIGTERM");
  await new Promise((r) => upstream.server.close(r));
  await new Promise((r) => sink.close(r));
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
  // No page is rendered anywhere on this path: authorize redirects to the
  // CloudGrid sign-in, the sign-in redirects back, and the completion endpoint
  // redirects to the client. Following it end to end is the test.
  const landed = await fetch(authorizeUrl, { redirect: "follow" });
  assert.equal(landed.status, 200, "the chain should end at the client redirect");
  const code = new URL(landed.url).searchParams.get("code");
  assert.ok(code, `the chain should end carrying an authorization code (ended at ${landed.url})`);
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

// Present but WRONG is a different branch from absent, and it carries a
// different message. Reviewer caught that the body claimed all five causes were
// covered while these two had no test.
test("a client_id that is present but wrong is distinguished from a missing one", async () => {
  const other = await fetch(`${web.baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  });
  const { client_id: otherId } = await other.json();
  const { status, body } = await exchange((b) => b.set("client_id", `${otherId}-not-the-one`));
  assert.equal(status, 400);
  assert.match(body.error_description, /client_id does not match/);
  assert.doesNotMatch(body.error_description, /required/, "a wrong client_id is not a missing one");
});

test("a code_verifier that is present but wrong fails PKCE, not the required check", async () => {
  const { status, body } = await exchange((b) => b.set("code_verifier", "a-verifier-that-is-not-the-one"));
  assert.equal(status, 400);
  assert.match(body.error_description, /PKCE verification failed/);
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


// The shape ChatGPT actually sends. Asserted on the Location header rather than
// followed, so nothing leaves the machine.
test("authorize redirects to the CloudGrid sign-in and renders no page of its own", async () => {
  const reg = await fetch(`${web.baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CHATGPT_REDIRECT] }),
  });
  const { client_id } = await reg.json();
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const res = await fetch(
    `${web.baseUrl}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(client_id)}` +
      `&redirect_uri=${encodeURIComponent(CHATGPT_REDIRECT)}&code_challenge=${challenge}` +
      `&code_challenge_method=S256&state=st&scope=cloudgrid`,
    { redirect: "manual" },
  );
  assert.equal(res.status, 302, "authorize must redirect, not render an interstitial");
  const location = res.headers.get("location");
  assert.match(location, /\/auth\/login\?/, "it should go to the CloudGrid sign-in");
  assert.match(location, /return_url=/, "and carry a return_url so the browser comes back");
  assert.match(location, /source=mcp/);
  // The allowlist is an exact-string match, so the return_url must be bare.
  const returnUrl = decodeURIComponent(new URL(location).searchParams.get("return_url"));
  assert.equal(returnUrl, `${web.baseUrl}/oauth/authorize/complete`);
  assert.ok(!returnUrl.includes("?"), "return_url must carry no query of its own");
});

test("a rejected client still never reaches the sign-in", async () => {
  const res = await fetch(
    `${web.baseUrl}/oauth/authorize?response_type=code&client_id=cg1.forged.forged` +
      `&redirect_uri=${encodeURIComponent(CHATGPT_REDIRECT)}&code_challenge=x&code_challenge_method=S256`,
    { redirect: "manual" },
  );
  assert.equal(res.status, 400, "a forged client_id must be refused before any redirect");
});

test("returning from sign-in with an unknown session shows a page, not a redirect", async () => {
  const res = await fetch(`${web.baseUrl}/oauth/authorize/complete?code=00000000-0000-4000-8000-000000000000`, {
    redirect: "manual",
  });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /took too long|already been completed|already completed/i);
});
