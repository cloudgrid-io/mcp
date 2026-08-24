// Create-path hard gates on grid_plug (0.20.19):
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

// Minimal server shim: capture the registered grid_plug handler.
function captureDeploy(ctx) {
  let handler = null;
  const server = {
    registerTool: (name, _cfg, h) => { if (name === "grid_plug") handler = h; },
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
  if ((u.endsWith("/api/v2/grids") || u.endsWith("/api/v2/orgs"))) {
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

    // #298: the ask reads as a designed thing, not a paragraph at the model.
    const askText = res?.content?.[0]?.text ?? "";
    check("#298: user-facing text is separated from the model-directed steps", /\(assistant:/.test(askText));
    check("#298: both options present and evenly weighted (two `- ` bullets)", (askText.match(/^\s*- /gm) || []).length === 2);
    check("#298: guest option is not framed as a lesser fallback", /guest/i.test(askText) && !/fallback/i.test(askText));
    check("#298: §23 voice — no emoji, no exclamation marks", !/[!]/.test(askText) && !/\p{Extended_Pictographic}/u.test(askText));
    check("#298: no retired vocabulary (no 'deploy'/'org')", !/\bdeploy\b/i.test(askText) && !/\borg\b/i.test(askText));
    check("#298: model-directed 'stop and wait' lives in the assistant line, not the user text", /\(assistant:[^)]*[Ss]top/.test(askText));
  }

  // ── AUTH gate is NOT model-bypassable (field bug 2026-07-26, Claude web):
  //    the FIRST unauthenticated create in a session returns needs_auth EVEN
  //    with anon:true — the model cannot self-serve a silent guest publish.
  //    After the ask was surfaced (same session state), anon:true proceeds. ──
  {
    globalThis.__GRIDS__ = [];
    resetPlug();
    const ctx = makeCtx({ token: null });
    const h = captureDeploy(ctx);
    const first = await h({ ...HTML, anon: true });
    check("first anon:true create is still gated (no deploy)", globalThis.__PLUG_CALLS__ === 0);
    check("first anon:true create returns needs_auth", parse(first).needs_auth === true);
    check("gate marks the session (authChoiceOffered)", ctx.state.authChoiceOffered === true);
    await h({ ...HTML, anon: true });
    check("anon:true AFTER the ask proceeds (deploy attempted)", globalThis.__PLUG_CALLS__ === 1);
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

  // ── ZERO-GRID gate: signed in but member of no grid → needs_grid_create,
  //    never a silent 403 NO_ACTIVE_ORG dead end (field bug 2026-07-27: the
  //    model sent a first-time user to the console to create a grid by hand). ──
  {
    globalThis.__GRIDS__ = [];
    resetPlug();
    const h = captureDeploy(makeCtx({ token: "jwt" }));
    const res = await h(HTML);
    check("authed zero-grid create did NOT deploy", globalThis.__PLUG_CALLS__ === 0);
    check("authed zero-grid create returns needs_grid_create", parse(res).needs_grid_create === true);
    check("zero-grid ask routes to grid_create_grid, not the console",
      /grid_create_grid/.test(res?.content?.[0]?.text ?? "") && !/console\.cloudgrid\.io/.test(res?.content?.[0]?.text ?? ""));
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
