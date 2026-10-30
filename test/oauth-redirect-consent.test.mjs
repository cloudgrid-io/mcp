// OAuth redirect URI rules and the authorize consent step.
//
// Registration accepts only `https:` redirect URIs, or `http:` on a loopback
// address, and refuses everything else with RFC 7591 `invalid_redirect_uri`.
// /oauth/authorize re-checks the rule (so a client_id signed before the rule
// existed cannot be used with a URI that breaks it), and its interstitial names
// the client and the host the browser returns to before sign-in starts. Every
// OAuth HTML response refuses framing, and interpolated values are escaped.
//
// Boots the connected edition as a child process, the same harness the other
// OAuth tests use. No upstream is needed: nothing here reaches sign-in.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const SECRET = "test-oauth-hmac-secret-redirect-consent-00000";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function listen(server, p = 0) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(p, "127.0.0.1", resolve); });
  return server.address().port;
}

async function startWeb() {
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
      CLOUDGRID_API_URL: "http://127.0.0.1:1",
      CLOUDGRID_PUBLIC_API_URL: "http://127.0.0.1:1",
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
  return { child, baseUrl };
}

const web = await startWeb();
after(() => { web.child.kill("SIGTERM"); });

async function register(body) {
  const res = await fetch(`${web.baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token_endpoint_auth_method: "none", ...body }),
  });
  return { status: res.status, body: await res.json() };
}

function authorizeUrl(client_id, redirect_uri) {
  const challenge = b64url(createHash("sha256").update(b64url(randomBytes(32))).digest());
  return (
    `${web.baseUrl}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(client_id)}` +
    `&redirect_uri=${encodeURIComponent(redirect_uri)}&code_challenge=${challenge}` +
    `&code_challenge_method=S256&state=st-1`
  );
}

async function authorize(client_id, redirect_uri) {
  const res = await fetch(authorizeUrl(client_id, redirect_uri), { redirect: "manual" });
  return { res, text: await res.text() };
}

// Mint a client_id directly under the test secret, bypassing registration —
// stands in for one signed before the redirect rules existed.
function legacyClientId(uris) {
  const payload = b64url(Buffer.from(JSON.stringify([...uris].sort()), "utf8"));
  const input = `cg1.${payload}`;
  return `${input}.${b64url(createHmac("sha256", SECRET).update(input).digest())}`;
}

const REFUSED = [
  ["javascript: scheme", "javascript:alert(1)"],
  ["data: scheme", "data:text/html,hello"],
  ["custom scheme", "myapp://oauth/callback"],
  ["http to a non-loopback host", "http://example.com/callback"],
  ["https with a fragment", "https://claude.ai/api/mcp/auth_callback#frag"],
  ["credentials in the URI", "https://claude.ai@example.com/callback"],
  ["relative URI", "/callback"],
];

for (const [label, uri] of REFUSED) {
  test(`register refuses a redirect URI: ${label}`, async () => {
    const { status, body } = await register({ redirect_uris: [uri] });
    assert.equal(status, 400);
    assert.equal(body.error, "invalid_redirect_uri");
    assert.ok(body.error_description, "names the reason");
    assert.equal(body.client_id, undefined, "no client_id is issued");
  });
}

test("register refuses the whole set when one URI breaks the rules", async () => {
  const { status, body } = await register({ redirect_uris: [CLAUDE_CALLBACK, "javascript:alert(1)"] });
  assert.equal(status, 400);
  assert.equal(body.error, "invalid_redirect_uri");
});

const ACCEPTED = [
  ["Claude callback (claude.ai)", CLAUDE_CALLBACK],
  ["Claude callback (claude.com)", "https://claude.com/api/mcp/auth_callback"],
  ["loopback 127.0.0.1", "http://127.0.0.1:43210/callback"],
  ["loopback [::1]", "http://[::1]:43210/callback"],
  ["loopback localhost", "http://localhost:9/cb"],
];

for (const [label, uri] of ACCEPTED) {
  test(`register accepts a redirect URI: ${label}, and authorize renders`, async () => {
    const { status, body } = await register({ redirect_uris: [uri] });
    assert.equal(status, 201);
    assert.ok(body.client_id);
    const { res, text } = await authorize(body.client_id, uri);
    assert.equal(res.status, 200);
    assert.match(text, /Connect CloudGrid/);
  });
}

test("authorize refuses a pre-existing client_id whose redirect URI breaks the rules", async () => {
  for (const uri of ["javascript:alert(1)", "myapp://cb", "http://example.com/cb"]) {
    const { res, text } = await authorize(legacyClientId([uri]), uri);
    assert.equal(res.status, 400, `${uri} must be refused`);
    assert.equal(res.headers.get("location"), null, "never redirected to");
    assert.doesNotMatch(text, /authorize\/poll/, "no sign-in session is started");
  }
});

test("authorize still accepts a pre-existing client_id with an allowed URI", async () => {
  const { res } = await authorize(legacyClientId([CLAUDE_CALLBACK]), CLAUDE_CALLBACK);
  assert.equal(res.status, 200);
});

test("the consent step names the client and the redirect host before sign-in", async () => {
  const { body } = await register({ redirect_uris: [CLAUDE_CALLBACK], client_name: "Claude" });
  assert.equal(body.client_name, "Claude");
  const { res, text } = await authorize(body.client_id, CLAUDE_CALLBACK);
  assert.equal(res.status, 200);
  assert.match(text, /<strong>Claude<\/strong> \(<strong>claude\.ai<\/strong>\) wants to connect to your CloudGrid account\./);
  assert.match(text, /After sign-in you will be returned to <strong>claude\.ai<\/strong>\./);
  assert.match(text, /Continue to sign in/);
  // Polling starts only on the user's click.
  assert.match(text, /addEventListener\("click"/);
  assert.doesNotMatch(text, /\n\s*tick\(\);\s*\n<\/script>/, "no poll on page load");
});

test("without a registered name the consent step says an application", async () => {
  const { body } = await register({ redirect_uris: [CLAUDE_CALLBACK] });
  const { text } = await authorize(body.client_id, CLAUDE_CALLBACK);
  assert.match(text, /An application at <strong>claude\.ai<\/strong> wants to connect/);
});

test("the consent page and OAuth error pages refuse framing", async () => {
  const { body } = await register({ redirect_uris: [CLAUDE_CALLBACK] });
  const ok = await authorize(body.client_id, CLAUDE_CALLBACK);
  const bad = await authorize("not-a-client", CLAUDE_CALLBACK);
  for (const { res } of [ok, bad]) {
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.match(res.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
  }
  assert.equal(bad.res.status, 400);
});

test("a hostile client_name is escaped on the consent page", async () => {
  const hostile = `</strong><script>alert(1)</script><img src=x onerror=alert(2)>"'&`;
  const { body } = await register({ redirect_uris: [CLAUDE_CALLBACK], client_name: hostile });
  const { text } = await authorize(body.client_id, CLAUDE_CALLBACK);
  assert.ok(!text.includes("<script>alert(1)"), "no raw script tag");
  assert.ok(!text.includes("<img src=x"), "no raw img tag");
  assert.ok(text.includes("&lt;/strong&gt;&lt;script&gt;alert(1)&lt;/script&gt;"), "name is HTML-escaped");
  assert.ok(text.includes("&quot;&#39;&amp;"), "quotes and ampersand are escaped");
  // Exactly one script element: the page's own.
  assert.equal((text.match(/<script/g) || []).length, 1);
});

test("a client_name is bounded and stripped of control characters", async () => {
  const { body } = await register({ redirect_uris: [CLAUDE_CALLBACK], client_name: `A\u0000B\nC${"x".repeat(500)}` });
  assert.ok(body.client_name.length <= 80);
  assert.ok(body.client_name.startsWith("A B C"));
});
