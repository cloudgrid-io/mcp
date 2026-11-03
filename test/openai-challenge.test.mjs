// OpenAI domain verification (#455): the hosted web edition serves
// GET /.well-known/openai-apps-challenge as exactly the MCP_OPENAI_APPS_CHALLENGE
// text (text/plain), with no sign-in and no MCP session, and 404s when the
// variable is unset or blank. Regression half: /healthz and the OAuth discovery
// next to it under /.well-known are unchanged.
// Run: node test/openai-challenge.test.mjs

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { challengeToken } from "../src/openai-challenge.js";

const SET_PORT = 8850;
const UNSET_PORT = 8851;
const BLANK_PORT = 8852;
const SET_BASE = `http://localhost:${SET_PORT}`;
const UNSET_BASE = `http://localhost:${UNSET_PORT}`;
const BLANK_BASE = `http://localhost:${BLANK_PORT}`;
const PATH = "/.well-known/openai-apps-challenge";
// A token-shaped test value; the configured value carries a trailing newline the
// way a Secret file or `echo` often does, which must not reach the body.
const TOKEN = "test-challenge-0123456789abcdef";

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

function serve(port, base, extraEnv) {
  const env = { ...process.env, PORT: String(port), MCP_PUBLIC_URL: base, ...extraEnv };
  if (!("MCP_OPENAI_APPS_CHALLENGE" in extraEnv)) delete env.MCP_OPENAI_APPS_CHALLENGE;
  return spawn("node", ["src/web.js"], { env, stdio: ["ignore", "ignore", "inherit"] });
}

const servers = [
  serve(SET_PORT, SET_BASE, { MCP_OPENAI_APPS_CHALLENGE: `${TOKEN}\n` }),
  serve(UNSET_PORT, UNSET_BASE, {}),
  serve(BLANK_PORT, BLANK_BASE, { MCP_OPENAI_APPS_CHALLENGE: "   " }),
];

try {
  check("set host healthy", await waitForHealth(SET_BASE));
  check("unset host healthy", await waitForHealth(UNSET_BASE));
  check("blank host healthy", await waitForHealth(BLANK_BASE));

  // ── Token configured ───────────────────────────────────────────────────────
  const r = await fetch(`${SET_BASE}${PATH}`);
  const body = await r.text();
  check("set → 200", r.status === 200);
  check("set → text/plain", (r.headers.get("content-type") || "").startsWith("text/plain"));
  check("set → body is exactly the token", body === TOKEN);
  check("set → nosniff", r.headers.get("x-content-type-options") === "nosniff");

  // No sign-in, no session: a request with a junk bearer and a foreign Origin
  // gets the same answer (the route sits outside the /mcp guards).
  const r2 = await fetch(`${SET_BASE}${PATH}`, {
    headers: { Authorization: "Bearer not-a-token", Origin: "https://example.com" },
  });
  check("set → needs no auth, ignores Origin", r2.status === 200 && (await r2.text()) === TOKEN);

  // Only GET serves it.
  const post = await fetch(`${SET_BASE}${PATH}`, { method: "POST" });
  check("set → POST is not served the token", post.status === 404 && (await post.text()) !== TOKEN);

  // ── Token unset or blank ───────────────────────────────────────────────────
  for (const [name, base] of [["unset", UNSET_BASE], ["blank", BLANK_BASE]]) {
    const u = await fetch(`${base}${PATH}`);
    const ub = await u.text();
    check(`${name} → 404`, u.status === 404);
    check(`${name} → body carries no token`, !ub.includes(TOKEN) && ub.trim() !== "");
  }

  // ── Regression: neighbours unchanged ──────────────────────────────────────
  for (const [name, base] of [["set", SET_BASE], ["unset", UNSET_BASE]]) {
    const h = await fetch(`${base}/healthz`);
    const hb = await h.json();
    check(`${name} /healthz still 200 {ok,edition}`, h.status === 200 && hb.ok === true && hb.edition === "web");
    const d = await fetch(`${base}/.well-known/oauth-authorization-server`);
    check(`${name} OAuth discovery still 200`, d.status === 200);
  }

  // ── Unit: token normalisation ─────────────────────────────────────────────
  check("challengeToken trims surrounding whitespace", challengeToken(`  ${TOKEN}\r\n`) === TOKEN);
  check("challengeToken(undefined) is empty", challengeToken(undefined) === "");
  check("challengeToken(blank) is empty", challengeToken(" \n ") === "");
} finally {
  for (const s of servers) s.kill();
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nopenai-challenge: all checks passed");
