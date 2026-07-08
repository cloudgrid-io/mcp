// Transport-OAuth smoke. Runs the FULL MCP-spec OAuth dance headlessly against a
// mock upstream CloudGrid (so no human sign-in is needed), then proves the issued
// Bearer becomes the MCP session's identity (the drop call carries it). Also
// checks the MCP_REQUIRE_AUTH=1 challenge. Run: node test/smoke-oauth.mjs

import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_PORT = 8794;
const MOCK_PORT = 8793;
const BASE = `http://localhost:${MCP_PORT}`;

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}
const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Fake CloudGrid JWT with a real exp claim.
const FAKE_JWT = `${b64url(Buffer.from(JSON.stringify({ alg: "HS256" })))}.${b64url(
  Buffer.from(JSON.stringify({ sub: "u_oauth", email: "oauth@example.com", exp: Math.floor(Date.now() / 1000) + 3600 })),
)}.sig`;

// ── Mock upstream CloudGrid: /auth/status + /api/v2/plug ───────────────────────
let statusCalls = 0;
let dropAuthHeader = null;
const dropBodies = [];
const mock = createServer((req, res) => {
  if (req.url.startsWith("/auth/status")) {
    statusCalls++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(statusCalls < 2 ? { status: "pending" } : { status: "authenticated", jwt: FAKE_JWT }));
    return;
  }
  if (req.url.startsWith("/api/v2/plug")) {
    dropAuthHeader = req.headers.authorization ?? null;
    let body = "";
    req.on("data", (c) => (body += c.toString("utf8")));
    req.on("end", () => {
      dropBodies.push(body);
      // Authed create → 202 with the unified-plug shape: slug + grid, no `url`
      // (the client composes the URL). Mirrors planAuthedCreatePlug's response.
      res.statusCode = 202;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        trace_id: null,
        deploy_event_id: null,
        status: "live",
        entity_id: "e-1",
        slug: "mock-1",
        grid: "e2e-bot",
        poll_url: null,
        detection: { kind: "inspiration", framework: "", confidence: 0.95, signals: ["html-document"] },
        forkable: true,
      }));
    });
    return;
  }
  res.statusCode = 404;
  res.end();
});
await new Promise((r) => mock.listen(MOCK_PORT, r));

const env = {
  ...process.env,
  PORT: String(MCP_PORT),
  MCP_PUBLIC_URL: BASE,
  CLOUDGRID_API_URL: `http://localhost:${MOCK_PORT}`,
  CLOUDGRID_PUBLIC_API_URL: `http://localhost:${MOCK_PORT}`,
};
const child = spawn("node", ["src/web.js"], { env, stdio: ["ignore", "ignore", "inherit"] });

let client;
try {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) break;
    } catch {}
    await sleep(100);
  }

  // 1. Discovery metadata.
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json();
  check("protected-resource metadata points at this AS", prm.authorization_servers?.[0] === BASE);
  const asm = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
  check("AS metadata has authorize/token/register", !!asm.authorization_endpoint && !!asm.token_endpoint && !!asm.registration_endpoint);

  // 2. Dynamic client registration.
  const reg = await (
    await fetch(`${BASE}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://localhost:9/cb"] }),
    })
  ).json();
  check("registration returns a client_id", typeof reg.client_id === "string" && reg.client_id.length > 0);

  // 3. Authorize (PKCE) → interstitial → poll → code.
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const authUrl = `${BASE}/oauth/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent("http://localhost:9/cb")}&state=st1&code_challenge=${challenge}&code_challenge_method=S256`;
  const page = await (await fetch(authUrl)).text();
  const sid = page.match(/poll\?sid=([0-9a-f-]+)/)?.[1];
  check("authorize renders the interstitial with a poll sid", !!sid);

  let redirect = null;
  for (let i = 0; i < 6 && !redirect; i++) {
    const p = await (await fetch(`${BASE}/oauth/authorize/poll?sid=${sid}`)).json();
    if (p.status === "ready") redirect = p.redirect;
    else await sleep(150);
  }
  check("poll bridges CloudGrid sign-in to a redirect with code+state", !!redirect && redirect.includes("code=") && redirect.includes("state=st1"));
  const code = new URL(redirect).searchParams.get("code");

  // 4. Token exchange — wrong verifier rejected, right verifier returns the JWT.
  const bad = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: "wrong", redirect_uri: "http://localhost:9/cb", client_id: reg.client_id }),
  });
  check("token rejects a bad PKCE verifier", bad.status === 400);
  // (the bad attempt must not have consumed the code — re-mint by repeating the dance if it did)
  const tok = await (
    await fetch(`${BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: "http://localhost:9/cb", client_id: reg.client_id }),
    })
  ).json();
  check("token exchange returns the CloudGrid JWT as access_token", tok.access_token === FAKE_JWT && tok.token_type === "Bearer");

  // 5. The Bearer becomes the MCP session identity: drop must carry it upstream.
  client = new Client({ name: "oauth-smoke", version: "0.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tok.access_token}` } },
    }),
  );
  const drop = await client.callTool({ name: "grid_drop", arguments: { html: "<h1>authed</h1>" } });
  check("authed drop reports Your app is live (web edition)", (drop.content?.[0]?.text ?? "").includes("Your app is live"));
  check("authed drop composed the live URL from slug + grid", (drop.content?.[0]?.text ?? "").includes("https://e2e-bot.cloudgrid.io/mock-1"));
  check("upstream drop received the OAuth Bearer", dropAuthHeader === `Bearer ${FAKE_JWT}`);

  // Each `/plug` drop is a fresh create (the unified plug is create-only — there
  // is no in-place redrop / `previous_id` on this path), so a second drop never
  // sends a `previous_id` part. The artifact part name is still `artifact`.
  await client.callTool({ name: "grid_drop", arguments: { html: "<h1>authed v2</h1>" } });
  check("second authed drop sends NO previous_id (plug is create-only)", dropBodies.length >= 2 && !dropBodies[1].includes('name="previous_id"'));
  check("drop sends the artifact part", dropBodies[0].includes('name="artifact"'));
  await client.close();
} finally {
  try {
    await client?.close();
  } catch {}
  child.kill("SIGKILL");
}

// 6. MCP_REQUIRE_AUTH=1 → 401 challenge with resource metadata.
const strict = spawn("node", ["src/web.js"], {
  env: { ...env, PORT: String(MCP_PORT + 1), MCP_PUBLIC_URL: `http://localhost:${MCP_PORT + 1}`, MCP_REQUIRE_AUTH: "1" },
  stdio: ["ignore", "ignore", "inherit"],
});
try {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`http://localhost:${MCP_PORT + 1}/healthz`)).ok) break;
    } catch {}
    await sleep(100);
  }
  const r = await fetch(`http://localhost:${MCP_PORT + 1}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "x", version: "0" } } }),
  });
  check("MCP_REQUIRE_AUTH: unauthenticated /mcp gets 401", r.status === 401);
  check("401 carries WWW-Authenticate resource metadata", (r.headers.get("www-authenticate") ?? "").includes("oauth-protected-resource"));
} finally {
  strict.kill("SIGKILL");
}
mock.close();

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll transport-OAuth checks passed.");
