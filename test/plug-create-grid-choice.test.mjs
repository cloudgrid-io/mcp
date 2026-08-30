// Offline unit test for issue #327 — a NEW grid_plug must not silently pick a
// grid, and the EDIT path's grid derivation must stay intact.
//
// The bug (founder report 2026-08-27): a new plug with no explicit `grid`
// silently reused a stale, weeks-old "active grid" and landed the entity in the
// wrong grid — never surfaced, never confirmed. The grid decides the URL, who
// can open the entity (grid-scoped visibility), the datastore tier, and the
// namespace, so guessing it is worse than asking.
//
// Two editions fail differently and both must be covered:
//   - LOCAL:  ctx.getActiveGrid() → a persisted slug. The create must NOT send
//             it as the X-CloudGrid-Grid header (that is the silent reuse).
//   - HOSTED: ctx.getActiveGrid() → null. The create sends nothing, so the API
//             picks a default silently — the grid-picker GATE (register.js
//             resolveGridOrAsk) must ask BEFORE runPlug is ever reached.
//
// The fix has two layers, both tested here:
//   1. runPlug (deploy.js): a CREATE resolves its grid from the explicit `grid`
//      param ONLY — never from getActiveGrid. An EDIT keeps the full #296/#301/
//      #316 derivation chain (explicit → active → URL host → entity lookup).
//   2. the gate (register.js): an authed multi-grid create with no grid returns
//      needs_grid on BOTH editions; a single-grid create proceeds (no pointless
//      question); an edit never asks.
//
// These are OFFLINE tests — fetch is mocked. They prove the CLIENT behaviour
// (which grid header the create sends, and which mode the gate returns). They do
// NOT prove the server honours the header (a server-side claim).
//
// Run: node test/plug-create-grid-choice.test.mjs

import { runPlug } from "../src/tools/deploy.js";
import { registerTools } from "../src/tools.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// ── runPlug harness (records outgoing calls; replies from a queue) ──────────
function makeCtx({ token = "jwt", edition = "local", activeGrid = null } = {}) {
  return {
    edition,
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
    canOpenBrowser: false,
    getToken: async () => token,
    getActiveGrid: async () => activeGrid,
    saveToken: async () => ({}),
    savedLocationNote: () => "",
    trustedServer: null,
    deployPollBudgetMs: 20,
    deployPollIntervalMs: 5,
  };
}

let calls = [];
let replies = [];
const realFetch = globalThis.fetch;
function installFetch(queue) {
  calls = [];
  replies = [...queue];
  globalThis.fetch = async (url, opts = {}) => {
    const form = opts.body instanceof FormData ? opts.body : null;
    let body = null;
    if (!form) { try { body = opts.body ? JSON.parse(opts.body) : null; } catch { body = opts.body; } }
    calls.push({ url: String(url), method: opts.method || "GET", headers: opts.headers || {}, form, body });
    const next = replies.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json", ...(next.headers || {}) },
    });
  };
}
const restoreFetch = () => { globalThis.fetch = realFetch; };
const isPickup = (u) => /\/api\/v2\/entities\/[^/]+\/pickup$/.test(u);
const plugPost = () => calls.find((c) => c.url.endsWith("/api/v2/plug") && c.method === "POST");

try {
  // ══ CREATE — the #327 core, at the runPlug layer, on BOTH editions ═════════
  //
  // A new plug (no target_entity_id) with NO explicit `grid` must NOT send the
  // active grid as the write header. This is the silent-reuse the founder hit.

  // ── LOCAL: a stale persisted active grid must NOT be sent on a create ───────
  {
    installFetch([
      { status: 201, body: { entity_id: "e1", slug: "s1", grid: "coolapps", url: "https://coolapps.cloudgrid.io/s1", status: "live" } },
    ]);
    await runPlug(
      makeCtx({ token: "jwt-l", edition: "local", activeGrid: "coolapps" }),
      { html: "<h1>new</h1>" },
    );
    restoreFetch();
    const post = plugPost();
    check("local create: does NOT send the stale active grid as X-CloudGrid-Grid",
      !post?.headers?.["X-CloudGrid-Grid"]);
    check("local create: does NOT send the stale active grid as X-CloudGrid-Org (alias)",
      !post?.headers?.["X-CloudGrid-Org"]);
    check("local create: never reaches getActiveGrid for the write (no silent pick)",
      post?.headers?.["X-CloudGrid-Grid"] !== "coolapps");
  }

  // ── LOCAL: an EXPLICIT grid on a create is honoured (the user's choice) ─────
  {
    installFetch([
      { status: 201, body: { entity_id: "e2", slug: "s2", grid: "michal-tests", url: "https://michal-tests.cloudgrid.io/s2", status: "live" } },
    ]);
    await runPlug(
      makeCtx({ token: "jwt-l2", edition: "local", activeGrid: "coolapps" }),
      { html: "<h1>new</h1>", grid: "michal-tests" },
    );
    restoreFetch();
    const post = plugPost();
    check("local create: an explicit grid IS sent as the write header", post?.headers?.["X-CloudGrid-Grid"] === "michal-tests");
    check("local create: the explicit grid wins over the stale active grid", post?.headers?.["X-CloudGrid-Grid"] !== "coolapps");
  }

  // ── HOSTED: getActiveGrid is null → the create sends no grid (unchanged),
  //    but the fix must not have introduced a silent pick here either ──────────
  {
    installFetch([
      { status: 201, body: { entity_id: "e3", slug: "s3", grid: "picked", url: "https://picked.cloudgrid.io/s3", status: "live" } },
    ]);
    await runPlug(
      makeCtx({ token: "jwt-h", edition: "web", activeGrid: null }),
      { html: "<h1>new</h1>" },
    );
    restoreFetch();
    check("hosted create: sends no grid header when none is chosen", !plugPost()?.headers?.["X-CloudGrid-Grid"]);
  }

  // ══ EDIT — the regression guard. Passes BEFORE and AFTER the change: the
  //    #296/#301/#316 derivation chain must remain intact and never ask. ═══════

  // ── EDIT: no grid, active grid set → derive from the active grid ────────────
  {
    installFetch([
      { status: 202, body: { entity_id: "ent-e", slug: "s", grid: "team-grid", url: "https://team-grid.cloudgrid.io/s", status: "live" } },
    ]);
    await runPlug(
      makeCtx({ token: "jwt-e", edition: "local", activeGrid: "team-grid" }),
      { html: "<h1>edit</h1>", target_entity_id: "ent-e" },
    );
    restoreFetch();
    check("edit guard: derives the grid from the active grid (no ask)", plugPost()?.headers?.["X-CloudGrid-Grid"] === "team-grid");
    check("edit guard: no pickup round-trip when active grid resolves it", !calls.some((c) => isPickup(c.url)));
  }

  // ── EDIT: no grid, no active grid, URL host → derive from the host ──────────
  {
    installFetch([
      { status: 202, body: { entity_id: "ent-u", slug: "page", grid: "hostgrid", url: "https://hostgrid.cloudgrid.io/page", status: "live" } },
    ]);
    await runPlug(
      makeCtx({ token: "jwt-u", edition: "web", activeGrid: null }),
      { html: "<h1>edit</h1>", target_entity_id: "ent-u", url: "https://hostgrid.cloudgrid.io/page" },
    );
    restoreFetch();
    check("edit guard: derives the grid from the URL host", plugPost()?.headers?.["X-CloudGrid-Grid"] === "hostgrid");
  }

  // ── EDIT: no grid, no active grid, no URL → derive via the entity pickup ────
  {
    installFetch([
      { status: 200, body: { entity_id: "ent-p", slug: "page", grid: "derived", kind: "inspiration" } },
      { status: 202, body: { entity_id: "ent-p", slug: "page", grid: "derived", url: "https://derived.cloudgrid.io/page", status: "live" } },
    ]);
    await runPlug(
      makeCtx({ token: "jwt-p", edition: "web", activeGrid: null }),
      { html: "<h1>edit</h1>", target_entity_id: "ent-p" },
    );
    restoreFetch();
    check("edit guard: derives the grid from the entity pickup when nothing else does", plugPost()?.headers?.["X-CloudGrid-Grid"] === "derived");
    check("edit guard: the entity-lookup round-trip happened (chain intact)", calls.some((c) => isPickup(c.url)));
  }

  // ══ GATE — register.js resolveGridOrAsk, driven through the real handler,
  //    proving the ASK fires on BOTH editions and single-grid is not asked. ═══
  function captureHandler(ctx) {
    let handler = null;
    const server = {
      registerTool: (name, _cfg, h) => { if (name === "grid_plug") handler = h; },
      tool: () => {},
      registerResource: () => {},
    };
    registerTools(server, ctx);
    return handler;
  }
  function gateCtx({ edition }) {
    return {
      edition,
      state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null, authChoiceOffered: false },
      canOpenBrowser: false,
      getToken: async () => "jwt",
      // LOCAL persists an active grid; HOSTED returns null (src/web.js:87).
      getActiveGrid: async () => (edition === "web" ? null : "coolapps"),
      saveToken: async () => ({}),
      savedLocationNote: () => "",
      logger: null,
    };
  }
  const parse = (r) => r?.structuredContent ?? r?.structured ?? {};
  const gridsFetch = (grids) => async (url) => {
    const u = String(url);
    if (u.endsWith("/api/v2/grids") || u.endsWith("/api/v2/orgs")) {
      return new Response(JSON.stringify({ grids }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.includes("/api/v2/plug")) {
      globalThis.__PLUGGED__ = true;
      return new Response(JSON.stringify({ entity_id: "e", slug: "s", url: "https://x", grid: "g", status: "live" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const MULTI = [
    { slug: "coolapps", name: "Cool", role: "owner", render_ready: true },
    { slug: "michal-tests", name: "Tests", role: "owner", render_ready: true },
  ];
  const ONE = [{ slug: "michal-tests", name: "Tests", role: "owner", render_ready: true }];

  for (const edition of ["local", "web"]) {
    // multi-grid, no grid → needs_grid (the ask), never a silent deploy
    globalThis.__PLUGGED__ = false;
    globalThis.fetch = gridsFetch(MULTI);
    let res = await captureHandler(gateCtx({ edition }))({ html: "<h1>hi</h1>" });
    restoreFetch();
    check(`gate(${edition}): multi-grid create returns needs_grid`, parse(res).needs_grid === true);
    check(`gate(${edition}): multi-grid create did NOT deploy`, globalThis.__PLUGGED__ !== true);
    check(`gate(${edition}): the ask surfaces the grid list to choose from`,
      Array.isArray(parse(res).grids) && parse(res).grids.length === 2);

    // single grid → proceeds, no pointless question
    globalThis.__PLUGGED__ = false;
    globalThis.fetch = gridsFetch(ONE);
    res = await captureHandler(gateCtx({ edition }))({ html: "<h1>hi</h1>" });
    restoreFetch();
    check(`gate(${edition}): single-grid create is NOT asked (deploys)`, globalThis.__PLUGGED__ === true);
    check(`gate(${edition}): single-grid create did not return needs_grid`, parse(res).needs_grid !== true);
  }
} finally {
  restoreFetch();
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll #327 create-grid-choice checks passed (offline).");
