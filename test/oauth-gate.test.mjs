// OAuth-route gating test (M14): with MCP_REQUIRE_AUTH unset the OAuth discovery
// and registration routes 404 (anon host); with it set to "1" they 200 and carry
// the right issuer. /healthz is 200 in both postures.
// Run: node test/oauth-gate.test.mjs

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const ANON_PORT = 8830;
const AUTH_PORT = 8831;
const ANON_BASE = `http://localhost:${ANON_PORT}`;
const AUTH_BASE = `http://localhost:${AUTH_PORT}`;

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

async function waitForHealth(base) {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) return true;
    } catch {}
    await sleep(100);
  }
  return false;
}

const DISCOVERY_PATHS = [
  "/.well-known/oauth-authorization-server",
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
];

// ── Anon host (MCP_REQUIRE_AUTH unset) ──────────────────────────────────────────
const anon = spawn("node", ["src/web.js"], {
  env: { ...process.env, PORT: String(ANON_PORT), MCP_PUBLIC_URL: ANON_BASE },
  stdio: ["ignore", "ignore", "inherit"],
});

// ── Auth host (MCP_REQUIRE_AUTH=1) ──────────────────────────────────────────────
const auth = spawn("node", ["src/web.js"], {
  env: { ...process.env, PORT: String(AUTH_PORT), MCP_PUBLIC_URL: AUTH_BASE, MCP_REQUIRE_AUTH: "1" },
  stdio: ["ignore", "ignore", "inherit"],
});

try {
  check("anon host healthy", await waitForHealth(ANON_BASE));
  check("auth host healthy", await waitForHealth(AUTH_BASE));

  // Anon host: discovery routes must 404.
  for (const path of DISCOVERY_PATHS) {
    const r = await fetch(`${ANON_BASE}${path}`);
    check(`anon ${path} → 404`, r.status === 404);
  }

  // Anon host: /oauth/register must 404.
  const regAnon = await fetch(`${ANON_BASE}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://localhost:9/cb"] }),
  });
  check("anon /oauth/register → 404", regAnon.status === 404);

  // Auth host: discovery routes must 200 with the right issuer.
  const asm = await (await fetch(`${AUTH_BASE}/.well-known/oauth-authorization-server`)).json();
  check("auth AS metadata 200 with issuer", asm.issuer === AUTH_BASE);
  check("auth AS metadata has registration_endpoint", asm.registration_endpoint === `${AUTH_BASE}/oauth/register`);

  const prm = await (await fetch(`${AUTH_BASE}/.well-known/oauth-protected-resource`)).json();
  check("auth protected-resource 200", prm.resource === `${AUTH_BASE}/mcp`);

  // Auth host: /oauth/register must 201.
  const regAuth = await (
    await fetch(`${AUTH_BASE}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://localhost:9/cb"] }),
    })
  ).json();
  check("auth /oauth/register returns client_id", typeof regAuth.client_id === "string" && regAuth.client_id.length > 0);

  // /healthz must be 200 on BOTH.
  check("anon /healthz 200", (await fetch(`${ANON_BASE}/healthz`)).status === 200);
  check("auth /healthz 200", (await fetch(`${AUTH_BASE}/healthz`)).status === 200);
} finally {
  anon.kill("SIGKILL");
  auth.kill("SIGKILL");
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll OAuth-gate checks passed.");
