// Sign-in completes only in the browser that started it (cloudgrid-io/cloudgrid#5785),
// a browser already signed in to CloudGrid approves with one click, and the
// consent page shows a client's self-declared name only for known AI-tool hosts.
//
// The stub API completes a device sign-in with a known session, the session a
// browser that finished the sign-in would now hold as `cloudgrid_session`.

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { shownClientName } from "../src/oauth.js";
import { TEST_SIGNING_SEED } from "./helpers/mcp-tokens.mjs";

const b64url = (b) => Buffer.from(b).toString("base64url");
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

function platformJwt(sub) {
  const now = Math.floor(Date.now() / 1000);
  return `${b64url(JSON.stringify({ alg: "HS256" }))}.${b64url(JSON.stringify({ sub, email: `${sub}@example.com`, iat: now, exp: now + 86400 }))}.${b64url(randomBytes(16))}`;
}

let nextSignIn = platformJwt("victim");
let statusCalls = 0;
const valid = new Set();
const api = createServer((req, res) => {
  const json = (s, b) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(b)); };
  if (req.url.startsWith("/auth/status")) {
    statusCalls++;
    valid.add(nextSignIn);
    return json(200, { status: "authenticated", jwt: nextSignIn });
  }
  const bearer = String(req.headers.authorization || "").replace(/^Bearer /, "");
  if (req.url === "/api/v2/users/me") {
    if (!valid.has(bearer)) return json(401, { code: "AUTH_INVALID" });
    const sub = JSON.parse(Buffer.from(bearer.split(".")[1], "base64url").toString()).sub;
    return json(200, { user_id: sub, email: `${sub}@example.com` });
  }
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
    MCP_TOKEN_SIGNING_KEYS: TEST_SIGNING_SEED,
    MCP_OAUTH_HMAC_SECRET: "same-browser-test-hmac-secret-000000000",
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

async function register(redirect = REDIRECT, name = "Claude") {
  const r = await fetch(`${BASE}/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ redirect_uris: [redirect], client_name: name }) });
  return (await r.json()).client_id;
}

// Open /oauth/authorize as a browser holding `cookies` (the CloudGrid session,
// if any). Returns the page, its sid and form token, and this browser's binding cookie.
async function openAuthorize({ session = null, redirect = REDIRECT, name = "Claude" } = {}) {
  const client_id = await register(redirect, name);
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const res = await fetch(
    `${BASE}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(client_id)}&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${challenge}&code_challenge_method=S256&state=st`,
    { headers: session ? { Cookie: `cloudgrid_session=${session}` } : {} },
  );
  const html = await res.text();
  const bind = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  return {
    client_id, verifier, html, bind,
    setCookie: (res.headers.getSetCookie?.() ?? []).join(" | "),
    sid: html.match(/sid=([0-9a-f-]{36})/)?.[1] ?? html.match(/name="sid" value="([0-9a-f-]{36})"/)?.[1],
    formToken: html.match(/name="form_token" value="([^"]+)"/)?.[1],
  };
}
const poll = async (sid, cookie) => (await fetch(`${BASE}/oauth/authorize/poll?sid=${sid}`, { headers: cookie ? { Cookie: cookie } : {} })).json();

test("the binding cookie is host-only and HttpOnly", async () => {
  const a = await openAuthorize();
  assert.match(a.setCookie, /cg_mcp_authorize=/);
  assert.match(a.setCookie, /HttpOnly/i);
  assert.doesNotMatch(a.setCookie, /Domain=/i);
});

test("the same browser completes the sign-in", async () => {
  nextSignIn = platformJwt("same-browser");
  const a = await openAuthorize();
  const r = await poll(a.sid, `${a.bind}; cloudgrid_session=${nextSignIn}`);
  assert.equal(r.status, "ready");
  assert.ok(new URL(r.redirect).searchParams.get("code"));
});

test("a sign-in finished in another browser cannot complete the flow (#5785)", async () => {
  nextSignIn = platformJwt("victim-2");
  const attacker = await openAuthorize();
  // The attacker's own browser: its binding cookie, but no (or its own) CloudGrid session.
  const r1 = await poll(attacker.sid, `${attacker.bind}; cloudgrid_session=${platformJwt("attacker")}`);
  assert.equal(r1.status, "pending", "no code while the session is not in this browser");
  await sleep(1100);
  const r2 = await poll(attacker.sid, attacker.bind);
  assert.equal(r2.status, "pending");
  assert.ok(!JSON.stringify(r2).includes("code="));
  // The victim's browser has the session but not the attacker's binding cookie.
  const r3 = await poll(attacker.sid, `cloudgrid_session=${nextSignIn}`);
  assert.equal(r3.status, "expired", "a poll without this browser's binding cookie gets nothing");
  // After the grace period the attempt ends.
  await sleep(15_500);
  const r4 = await poll(attacker.sid, attacker.bind);
  assert.equal(r4.status, "other_browser");
  const r5 = await poll(attacker.sid, `${attacker.bind}; cloudgrid_session=${nextSignIn}`);
  assert.equal(r5.status, "expired", "and it stays ended");
});

test("the poll reaches the API at most once a second", async () => {
  nextSignIn = platformJwt("rate");
  const a = await openAuthorize();
  const before = statusCalls;
  await Promise.all([poll(a.sid, a.bind), poll(a.sid, a.bind), poll(a.sid, a.bind)]);
  assert.equal(statusCalls - before, 1);
});

test("a browser already signed in approves with one click", async () => {
  const session = platformJwt("signed-in");
  valid.add(session);
  const a = await openAuthorize({ session });
  assert.match(a.html, /Signed in to CloudGrid as <strong>signed-in@example\.com<\/strong>/);
  assert.match(a.html, /Use a different account/);
  const approve = (headers, body) =>
    fetch(`${BASE}/oauth/authorize/approve`, {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(body),
    });
  const cookie = `${a.bind}; cloudgrid_session=${session}`;
  // Refused: from another site, without the form token, without the binding cookie.
  assert.equal((await approve({ Cookie: cookie, "Sec-Fetch-Site": "cross-site" }, { sid: a.sid, form_token: a.formToken })).status, 403);
  assert.equal((await approve({ Cookie: cookie, Origin: "https://evil.example" }, { sid: a.sid, form_token: a.formToken })).status, 403);
  assert.equal((await approve({ Cookie: cookie, "Sec-Fetch-Site": "same-origin" }, { sid: a.sid, form_token: "wrong" })).status, 400);
  assert.equal((await approve({ Cookie: `cloudgrid_session=${session}`, "Sec-Fetch-Site": "same-origin" }, { sid: a.sid, form_token: a.formToken })).status, 400);
  // Accepted: same origin, binding cookie, form token, a session the API accepts.
  const ok = await approve({ Cookie: cookie, "Sec-Fetch-Site": "same-origin", Origin: BASE }, { sid: a.sid, form_token: a.formToken });
  assert.equal(ok.status, 302);
  const code = new URL(ok.headers.get("location")).searchParams.get("code");
  const tok = await fetch(`${BASE}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: a.verifier, redirect_uri: REDIRECT, client_id: a.client_id }),
  });
  assert.equal(tok.status, 200);
});

test("a cookie the API does not accept gets the normal sign-in, not Allow", async () => {
  const a = await openAuthorize({ session: platformJwt("forged-or-signed-out") });
  assert.doesNotMatch(a.html, /Signed in to CloudGrid as/);
  assert.match(a.html, /Continue to sign in/);
});

test("a client's own name is shown only for known AI-tool hosts", async () => {
  assert.equal(shownClientName("Claude", "https://claude.ai/api/mcp/auth_callback"), "Claude");
  assert.equal(shownClientName("ChatGPT", "https://chatgpt.com/connector_platform_oauth_redirect"), "ChatGPT");
  assert.equal(shownClientName("Local", "http://127.0.0.1:3333/cb"), "Local");
  assert.equal(shownClientName("Claude", "https://claude.ai.evil.example/cb"), "");
  const page = await openAuthorize({ redirect: "https://claude.ai.evil.example/cb", name: "Claude" });
  assert.doesNotMatch(page.html, /<strong>Claude<\/strong>/);
  assert.match(page.html, /An application at <strong>claude\.ai\.evil\.example<\/strong>/);
});
