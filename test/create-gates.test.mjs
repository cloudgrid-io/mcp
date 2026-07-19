// Create-path hard gates on grid_deploy (0.20.19):
//   - AUTH gate: a create with no token and no anon:true must return needs_auth
//     (sign-in vs anonymous) and NEVER silently ride the anon wire.
//   - GRID gate: an authed create with >1 grid and no chosen grid must return
//     needs_grid (the picker) instead of deploying.
//   - Bypasses: anon:true, an edit (target_entity_id), and a single-grid authed
//     create proceed without a gate.
// Drives the real registerTools handler via a fake MCP server + injected ctx.
//
// Run: node test/create-gates.test.mjs
import { registerTools } from "../src/tools.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "ok  " : "FAIL"} ${label}`); if (!cond) failures++; };

// Minimal server shim: capture the registered grid_deploy handler.
function captureDeploy(ctx) {
  let handler = null;
  const server = {
    registerTool: (name, _cfg, h) => { if (name === "grid_deploy") handler = h; },
    tool: () => {},
    registerResource: () => {},
  };
  registerTools(server, ctx);
  return handler;
}

// A ctx whose runPlug would THROW if reached — proves the gate short-circuits
// before any deploy. token/grids configurable; fetch mocked for grid listing.
function makeCtx({ token = null, grids = [] } = {}) {
  return {
    edition: "local",
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
    canOpenBrowser: false,
    getToken: async () => token,
    getActiveGrid: async () => (grids[0]?.slug ?? null),
    saveToken: async () => ({}),
    savedLocationNote: () => "",
    logger: null,
  };
}

const HTML = { html: "<h1>hi</h1>" };
const parse = (r) => r?.structuredContent ?? r?.structured ?? {};

const realFetch = globalThis.fetch;
globalThis.__PLUG_CALLS__ = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith("/api/v2/orgs")) {
    return new Response(JSON.stringify({ grids: globalThis.__GRIDS__ ?? [] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }
  if (u.includes("/api/v2/plug")) {
    globalThis.__PLUG_CALLS__++; // a deploy was attempted = the gate let it through
    return new Response(JSON.stringify({ entity_id: "e1", slug: "s1", url: "https://x", status: "live" }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};
const resetPlug = () => { globalThis.__PLUG_CALLS__ = 0; };

try {
  // ── AUTH gate: no token, no anon → needs_auth, no network ──
  {
    globalThis.__GRIDS__ = [];
    resetPlug();
    const h = captureDeploy(makeCtx({ token: null }));
    const res = await h(HTML);
    check("no-auth create did NOT deploy", globalThis.__PLUG_CALLS__ === 0);
    check("no-auth create returns needs_auth", parse(res).needs_auth === true);
    check("no-auth create offers sign-in AND anonymous", /grid_login/.test(res?.content?.[0]?.text ?? "") && /anon/i.test(res?.content?.[0]?.text ?? ""));
  }

  // ── AUTH gate bypass: anon:true proceeds (reaches the wire → our mock throws the sentinel) ──
  {
    globalThis.__GRIDS__ = [];
    resetPlug();
    const h = captureDeploy(makeCtx({ token: null }));
    await h({ ...HTML, anon: true });
    check("anon:true bypasses the auth gate (deploy attempted)", globalThis.__PLUG_CALLS__ === 1);
  }

  // ── GRID gate: authed, >1 grid, no grid → needs_grid, no deploy ──
  {
    globalThis.__GRIDS__ = [
      { slug: "grid-a", name: "A", role: "owner", render_ready: true },
      { slug: "grid-b", name: "B", role: "owner", render_ready: true },
    ];
    resetPlug();
    const h = captureDeploy(makeCtx({ token: "jwt" }));
    const res = await h(HTML);
    check("authed multi-grid create did NOT deploy", globalThis.__PLUG_CALLS__ === 0);
    check("authed multi-grid create returns needs_grid", parse(res).needs_grid === true);
  }

  // ── GRID gate bypass: explicit valid grid proceeds ──
  {
    globalThis.__GRIDS__ = [
      { slug: "grid-a", name: "A", role: "owner", render_ready: true },
      { slug: "grid-b", name: "B", role: "owner", render_ready: true },
    ];
    resetPlug();
    const h = captureDeploy(makeCtx({ token: "jwt" }));
    await h({ ...HTML, grid: "grid-a" });
    check("explicit valid grid bypasses the grid gate (deploy attempted)", globalThis.__PLUG_CALLS__ === 1);
  }

  // ── EDIT bypass: target_entity_id skips both gates ──
  {
    globalThis.__GRIDS__ = [];
    resetPlug();
    const h = captureDeploy(makeCtx({ token: "jwt" }));
    await h({ ...HTML, target_entity_id: "e1" });
    check("edit (target_entity_id) bypasses both gates (deploy attempted)", globalThis.__PLUG_CALLS__ === 1);
  }
} finally {
  globalThis.fetch = realFetch;
  delete globalThis.__GRIDS__;
  delete globalThis.__PLUG_CALLS__;
}

console.log(failures === 0 ? "\nAll create-gates checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
