// RFC 8707 Resource Indicators on the MCP OAuth surface (#329).
//
// The #329 evidence (staging v0.21.15): ChatGPT completes two full OAuth
// cycles, tokens are issued, and it then makes NO POST /mcp request at all.
// ChatGPT sends `resource=https://mcp-staging.cloudgrid.io/mcp` on
// /oauth/authorize and the server ignored it entirely — not read, not
// validated, not bound to the code. A client that audience-binds before use
// has grounds to refuse a token that carries no such binding.
//
// This proves the server now: (1) accepts and validates `resource` at
// /oauth/authorize against its own resource identifier (`${base}/mcp`, the
// value /.well-known/oauth-protected-resource returns), normalising trailing
// slash and scheme/host case per the MCP 2025-06-18 canonical-URI rules;
// (2) binds it to the code and re-validates at /oauth/token; (3) STILL accepts
// a request with NO `resource` (the Claude web / Claude Code compatibility
// guard — they work today and must keep working); (4) advertises the resource
// identifier in the AS metadata.
//
// Driven against a STUB upstream that answers /auth/status as a signed-in user
// would — the same harness the token-exchange and observability tests use.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const SECRET = "test-oauth-hmac-secret-resource-indicators-000";
const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function fakeJwt() {
  const payload = b64url(Buffer.from(JSON.stringify({ sub: "u1", email: "t@example.com", exp: Math.floor(Date.now() / 1000) + 3600 })));
  return `${b64url(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })))}.${payload}.sig`;
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
// This server's own resource identifier — the value the protected-resource
// metadata returns and the canonical URI a client must send as `resource`.
const RESOURCE = `${web.baseUrl}/mcp`;
after(async () => {
  web.child.kill("SIGTERM");
  await new Promise((r) => upstream.server.close(r));
});

async function register() {
  const reg = await fetch(`${web.baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  });
  assert.equal(reg.status, 201, "registration should succeed");
  return (await reg.json()).client_id;
}

// Drive register → authorize (with the given `resource`, or none when null) →
// poll. Returns the authorize Response plus, when the interstitial rendered,
// the sid/code/verifier needed to finish at the token endpoint.
async function authorize(resource) {
  const client_id = await register();
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  let url =
    `${web.baseUrl}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(client_id)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}` +
    `&code_challenge_method=S256&state=st-1&scope=cloudgrid`;
  if (resource !== null && resource !== undefined) url += `&resource=${encodeURIComponent(resource)}`;
  const page = await fetch(url);
  const text = await page.text();
  if (page.status !== 200) return { client_id, verifier, status: page.status, body: text };
  const sid = text.match(/sid=([0-9a-f-]{36})/)?.[1];
  const poll = await (await fetch(`${web.baseUrl}/oauth/authorize/poll?sid=${sid}`)).json();
  const code = poll.status === "ready" ? new URL(poll.redirect).searchParams.get("code") : null;
  return { client_id, verifier, status: page.status, sid, code };
}

async function token(fields) {
  const res = await fetch(`${web.baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  return { status: res.status, body: await res.json() };
}

// (1) A matching resource is accepted and its binding survives to the token
// endpoint: the code exchanges only when the token request repeats it.
test("authorize with a matching resource succeeds and the binding is recorded on the code", async () => {
  const { client_id, verifier, status, code } = await authorize(RESOURCE);
  assert.equal(status, 200, "authorize with the correct resource should render the interstitial");
  assert.ok(code, "a code should be issued");
  const { status: tstatus, body } = await token({
    grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id, resource: RESOURCE,
  });
  assert.equal(tstatus, 200, `token with the bound resource should succeed: ${JSON.stringify(body)}`);
  assert.equal(body.token_type, "Bearer");
});

// Canonical-URI equivalence (MCP 2025-06-18): uppercase scheme and a trailing
// slash denote the SAME resource and must be accepted, not rejected on a raw
// string compare.
test("authorize accepts a cosmetically different but equivalent resource URI", async () => {
  const equivalent = RESOURCE.replace(/^http/, "HTTP") + "/"; // uppercase scheme + trailing slash
  const { status, code } = await authorize(equivalent);
  assert.equal(status, 200, "an equivalent canonical URI must be accepted");
  assert.ok(code, "a code should be issued for the equivalent URI");
});

// (2) A resource that is NOT this server → invalid_target, no code issued.
test("authorize with a mismatched resource is refused as invalid_target and issues no code", async () => {
  const { status, body, sid, code } = await authorize("https://evil.example.com/mcp");
  assert.equal(status, 400, "a mismatched resource must not render the interstitial");
  assert.match(body, /invalid_target/, `the refusal must name invalid_target; got: ${body}`);
  assert.ok(!sid, "no interstitial (and so no poll sid) on a mismatched resource");
  assert.ok(!code, "no authorization code on a mismatched resource");
});

// (3) THE compatibility guard. Claude web / Claude Code work today and may not
// send `resource`; a MISSING resource MUST remain acceptable end to end.
test("authorize with NO resource still succeeds end to end (Claude compatibility)", async () => {
  const { client_id, verifier, status, code } = await authorize(null);
  assert.equal(status, 200, "a missing resource must still render the interstitial");
  assert.ok(code, "a code should be issued with no resource");
  const { status: tstatus, body } = await token({
    grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id,
  });
  assert.equal(tstatus, 200, `token with no resource should succeed: ${JSON.stringify(body)}`);
  assert.equal(body.token_type, "Bearer");
});

// (4) A token request whose resource differs from the one bound at authorize
// is refused as invalid_target and LOGGED via the denyToken path.
test("token with a resource that differs from the bound one is refused and logged", async () => {
  const before = web.stderr().length;
  const { client_id, verifier, code } = await authorize(RESOURCE);
  const { status, body } = await token({
    grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id,
    resource: "https://evil.example.com/mcp",
  });
  assert.equal(status, 400);
  assert.equal(body.error, "invalid_target", `expected invalid_target; got ${JSON.stringify(body)}`);
  for (let i = 0; i < 40 && !/token exchange refused/.test(web.stderr().slice(before)); i++) await sleep(25);
  assert.match(web.stderr().slice(before), /token exchange refused/, "the refusal must be logged via denyToken");
});

// (4b) The AS metadata advertises this server's resource identifier, so a
// client can discover the canonical `resource` value to send. RFC 8707 defines
// no metadata field; RFC 9728 §4 registers `protected_resources` for exactly
// this — a JSON array of the resource identifiers the AS issues tokens for.
test("authorization-server metadata advertises the resource identifier", async () => {
  const meta = await (await fetch(`${web.baseUrl}/.well-known/oauth-authorization-server`)).json();
  assert.ok(Array.isArray(meta.protected_resources), "protected_resources should be an array");
  assert.ok(meta.protected_resources.includes(RESOURCE), `metadata should list ${RESOURCE}; got ${JSON.stringify(meta.protected_resources)}`);
});
