// Index page + favicon test: the hosted web edition serves a branded root page and
// a favicon on BOTH postures (anonymous-first and sign-in-required), the page's
// auth line is driven by MCP_REQUIRE_AUTH, and the OAuth interstitial declares the
// icon. Regression half: /healthz, POST /mcp's 401 challenge and the OAuth routes
// are unchanged by the new routes.
// Run: node test/index-favicon.test.mjs

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const ANON_PORT = 8840;
const AUTH_PORT = 8841;
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

const anon = spawn("node", ["src/web.js"], {
  env: { ...process.env, PORT: String(ANON_PORT), MCP_PUBLIC_URL: ANON_BASE },
  stdio: ["ignore", "ignore", "inherit"],
});

const auth = spawn("node", ["src/web.js"], {
  env: { ...process.env, PORT: String(AUTH_PORT), MCP_PUBLIC_URL: AUTH_BASE, MCP_REQUIRE_AUTH: "1" },
  stdio: ["ignore", "ignore", "inherit"],
});

try {
  check("anon host healthy", await waitForHealth(ANON_BASE));
  check("auth host healthy", await waitForHealth(AUTH_BASE));

  // ── The index page, both postures ────────────────────────────────────────────
  for (const [name, base] of [["anon", ANON_BASE], ["auth", AUTH_BASE]]) {
    const r = await fetch(`${base}/`);
    const html = await r.text();
    check(`${name} GET / → 200`, r.status === 200);
    check(`${name} GET / → text/html`, (r.headers.get("content-type") || "").includes("text/html"));
    check(`${name} / has a title`, /<title>[^<]+<\/title>/.test(html));
    check(`${name} / declares a PNG icon`, /<link rel="icon" type="image\/png" href="\/favicon\.png">/.test(html));
    check(`${name} / shows the MCP URL to paste`, html.includes(`${base}/mcp`));
    check(`${name} / links the docs`, html.includes("https://docs.cloudgrid.io"));
    check(`${name} / carries og:title`, /<meta property="og:title"/.test(html));
    check(`${name} / carries og:description`, /<meta property="og:description"/.test(html));
    check(`${name} / carries an absolute og:url`, html.includes(`<meta property="og:url" content="${base}/">`));
    check(`${name} / carries an absolute og:image`, html.includes(`content="${base}/favicon.png"`));
    check(`${name} / carries a twitter card`, /<meta name="twitter:card"/.test(html));
    // §23 voice: no exclamation marks in the copy. The doctype and any HTML
    // comments are markup, not copy, so they are stripped before the check —
    // everything that remains (body text plus the meta values an unfurl shows)
    // is read by a human.
    const copy = html.replace(/^<!doctype[^>]*>/i, "").replace(/<!--[\s\S]*?-->/g, "");
    check(`${name} / has no exclamation marks`, !copy.includes("!"));
    // Self-contained: no third-party origins (no analytics, no CDN fonts).
    check(`${name} / makes no external requests`, !/(src|href)="https?:\/\/(?!docs\.cloudgrid\.io)/.test(html));
  }

  // ── The auth line is posture-driven ──────────────────────────────────────────
  const anonHtml = await (await fetch(`${ANON_BASE}/`)).text();
  const authHtml = await (await fetch(`${AUTH_BASE}/`)).text();
  check("anon / says anonymous-first", anonHtml.includes("anonymous-first"));
  check("anon / does not claim sign-in is required", !anonHtml.includes("requires sign-in"));
  check("auth / says sign-in is required", authHtml.includes("requires sign-in"));
  check("auth / does not claim anonymous-first", !authHtml.includes("anonymous-first"));

  // ── The favicon, both postures ───────────────────────────────────────────────
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  for (const [name, base] of [["anon", ANON_BASE], ["auth", AUTH_BASE]]) {
    const png = await fetch(`${base}/favicon.png`);
    const pngBuf = Buffer.from(await png.arrayBuffer());
    check(`${name} /favicon.png → 200`, png.status === 200);
    check(`${name} /favicon.png → image/png`, (png.headers.get("content-type") || "").includes("image/png"));
    check(`${name} /favicon.png is real PNG bytes`, pngBuf.subarray(0, 4).equals(PNG_MAGIC));
    check(`${name} /favicon.png is non-empty`, pngBuf.length > 0);

    // Browsers request the legacy path unprompted when a document declares no
    // icon; it must answer with the same bytes rather than 404.
    const ico = await fetch(`${base}/favicon.ico`);
    const icoBuf = Buffer.from(await ico.arrayBuffer());
    check(`${name} /favicon.ico → 200`, ico.status === 200);
    check(`${name} /favicon.ico serves the same bytes`, icoBuf.equals(pngBuf));
  }

  // ── The OAuth problem page declares the icon (auth host only) ───────────────
  // #333 removed the sign-in interstitial: /oauth/authorize now redirects
  // straight to the CloudGrid sign-in and renders nothing. The only page this
  // bridge still renders is the one shown when a sign-in cannot be completed,
  // so that is where the icon declaration is checked now. Register a client and
  // drive the flow the way a real client does, then return from sign-in with a
  // session that does not exist.
  const reg = await fetch(`${AUTH_BASE}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://localhost:9/cb"] }),
  });
  const client = await reg.json();
  const q = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: "http://localhost:9/cb",
    response_type: "code",
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    state: "xyz",
  });
  const authz = await fetch(`${AUTH_BASE}/oauth/authorize?${q}`, { redirect: "manual" });
  check("authorize redirects to the sign-in and renders nothing", authz.status === 302);
  const problem = await fetch(
    `${AUTH_BASE}/oauth/authorize/complete?code=00000000-0000-4000-8000-000000000000`,
    { redirect: "manual" },
  );
  const problemHtml = await problem.text();
  check("the problem page renders", problem.status === 400 && problemHtml.includes("Connect CloudGrid"));
  check(
    "the problem page declares the PNG icon",
    /<link rel="icon" type="image\/png" href="\/favicon\.png">/.test(problemHtml),
  );

  // ── Regression: the new routes changed nothing else ──────────────────────────
  for (const [name, base] of [["anon", ANON_BASE], ["auth", AUTH_BASE]]) {
    const h = await fetch(`${base}/healthz`);
    const body = await h.json();
    check(`${name} /healthz still 200 {ok,edition}`, h.status === 200 && body.ok === true && body.edition === "web");
  }

  // The 401 challenge on the auth host is what triggers a client's OAuth connect.
  const mcp401 = await fetch(`${AUTH_BASE}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
  });
  check("auth POST /mcp still 401", mcp401.status === 401);
  check("auth POST /mcp still challenges", (mcp401.headers.get("www-authenticate") || "").startsWith("Bearer"));

  // The anon host still has no OAuth discovery surface.
  const disc = await fetch(`${ANON_BASE}/.well-known/oauth-authorization-server`);
  check("anon OAuth discovery still 404", disc.status === 404);

  // Unknown paths still 404 — the index route must not become a catch-all.
  const missing = await fetch(`${ANON_BASE}/not-a-real-path`);
  check("unknown path still 404", missing.status === 404);
} finally {
  anon.kill();
  auth.kill();
}

console.log(failures === 0 ? "\nAll index/favicon checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
