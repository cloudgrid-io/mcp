// Observability for the MCP OAuth flow (#345). The flow was only observable on
// the paths it did NOT take: a refused token exchange logs (denyToken), but a
// SUCCESSFUL exchange and the /oauth/authorize arrival logged nothing, so "no
// log line" was ambiguous between "never arrived" and "worked silently". This
// motivated a real ChatGPT diagnosis on staging (#329) that had to infer the
// missing token exchange from the ABSENCE of an unrelated line.
//
// Three log points are added — authorize arrival, redirect handback, token
// success — and this test proves (1) all three appear, in order, on a good
// flow, and (2) the auth path leaks nothing: none of the code, the verifier,
// the code_challenge, the JWT, or the HMAC secret appears anywhere in stderr.
//
// The redaction test is the one that matters. It MUST be able to fail — logging
// any of those literals must turn it red — or it certifies the wrong thing.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

// A known secret and a known redirect, so the redaction test can assert the
// secret literal never reaches stderr.
const SECRET = "test-oauth-hmac-secret-observability-1234567890";
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function fakeJwt() {
  const payload = b64url(Buffer.from(JSON.stringify({ sub: "u1", email: "t@example.com", exp: Math.floor(Date.now() / 1000) + 3600 })));
  return `${b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })))}.${payload}.observability-signature-xyz`;
}

async function listen(server, p = 0) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(p, "127.0.0.1", resolve); });
  return server.address().port;
}

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

// Walk register → authorize → token exactly as ChatGPT does. Returns every
// secret-bearing literal so the redaction test can assert their absence.
async function fullFlow() {
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

  const poll = await (await fetch(`${web.baseUrl}/oauth/authorize/poll?sid=${sid}`)).json();
  assert.equal(poll.status, "ready", `poll should be ready once signed in: ${JSON.stringify(poll)}`);
  const code = new URL(poll.redirect).searchParams.get("code");
  assert.ok(code, "the redirect should carry an authorization code");

  const res = await fetch(`${web.baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id }),
  });
  assert.equal(res.status, 200, `token exchange should succeed: ${await res.clone().text()}`);
  const tok = await res.json();
  return { client_id, code, verifier, challenge, jwt: tok.access_token };
}

test("a successful connect logs authorize arrival, redirect handback and token success, in order", async () => {
  const before = web.stderr().length;
  await fullFlow();
  // Give the child's stderr a moment to flush into our buffer.
  for (let i = 0; i < 40 && !/token exchange succeeded/.test(web.stderr().slice(before)); i++) await sleep(25);
  const log = web.stderr().slice(before);

  const iArrival = log.indexOf("authorize request");
  const iRedirect = log.indexOf("redirect handed back");
  const iSuccess = log.indexOf("token exchange succeeded");

  assert.ok(iArrival >= 0, `authorize arrival should log; got:\n${log}`);
  assert.ok(iRedirect >= 0, `redirect handback should log; got:\n${log}`);
  assert.ok(iSuccess >= 0, `token success should log; got:\n${log}`);
  assert.ok(iArrival < iRedirect && iRedirect < iSuccess, `the three lines should appear in flow order; got:\n${log}`);

  // Arrival line reports SHAPE: presence of state, the PKCE method, redirect host.
  const arrivalLine = log.split("\n").find((l) => l.includes("authorize request"));
  assert.match(arrivalLine, /state=present/, "arrival should report state presence");
  assert.match(arrivalLine, /S256/, "arrival should report the PKCE method");
  assert.match(arrivalLine, /chatgpt\.com/, "arrival should report the redirect host");
});

// THE test. A full flow with a known code, verifier, challenge, secret and JWT;
// none of those literals may appear anywhere in stderr. Deliberately logging any
// one of them must turn this red — that is proven in the report by a red run.
test("no code, verifier, challenge, JWT or secret literal ever reaches stderr", async () => {
  const before = web.stderr().length;
  const { code, verifier, challenge, jwt } = await fullFlow();
  for (let i = 0; i < 40 && !/token exchange succeeded/.test(web.stderr().slice(before)); i++) await sleep(25);
  const log = web.stderr().slice(before);

  const forbidden = {
    "authorization code": code,
    "code_verifier": verifier,
    "code_challenge": challenge,
    "JWT / access token": jwt,
    "HMAC secret": SECRET,
  };
  for (const [name, literal] of Object.entries(forbidden)) {
    assert.ok(literal, `${name} literal should be defined for the redaction check`);
    assert.ok(!log.includes(literal), `${name} must NOT appear in stderr; got:\n${log}`);
  }
});
