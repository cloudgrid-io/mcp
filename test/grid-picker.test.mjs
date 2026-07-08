// Offline unit test for grid-picker parity (Task 32 / 0.7.3): grid_plug asks
// "which grid?" on authed multi-grid CREATES. Drives the REAL registered tool
// handlers (via registerTools with a fake server) with a mocked API, and asserts:
//   1. authed + >1 grid + create + no grid  → grid_plug returns the picker, does NOT publish.
//   2. authed + >1 grid + explicit valid grid → grid_plug proceeds to that grid (publishes).
//   3. authed + >1 grid + EDIT (target_entity_id) → does NOT ask (publishes/edits).
//   4. single grid → proceeds; anon → proceeds (guest, no ask).
//   5. the inline `html` single-file path asks on >1 grid too; explicit grid proceeds.
//   6. resolveGridOrAsk unit decisions (matched / >1 / single / none).
// Run: node test/grid-picker.test.mjs

import { registerTools, resolveGridOrAsk } from "../src/tools.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// ── Fake MCP server: capture the registered tool handlers by name ───────────
function makeServer() {
  const handlers = {};
  return {
    handlers,
    registerTool(name, _config, handler) {
      handlers[name] = handler;
    },
    tool(name, _desc, _schema, _annotations, handler) {
      handlers[name] = handler;
    },
    registerResource() {},
  };
}

function makeCtx({ token = null, activeOrg = null, edition = "web" } = {}) {
  return {
    edition,
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
    canOpenBrowser: false,
    getToken: async () => token,
    getActiveGrid: async () => activeOrg,
    saveToken: async () => ({}),
    savedLocationNote: () => "",
    trustedServer: null,
  };
}

function handlersFor(ctxOpts) {
  const server = makeServer();
  registerTools(server, makeCtx(ctxOpts));
  return server.handlers;
}

// ── fetch mock ──────────────────────────────────────────────────────────────
// Serves GET /api/v2/orgs (the grid list) and POST /api/v2/plug (publish).
const calls = [];
let orgsReply = { orgs: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push({ url: u, method: opts.method || "GET" });
  if (u.includes("/api/v2/orgs")) {
    return new Response(JSON.stringify(orgsReply), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (u.includes("/api/v2/plug")) {
    return new Response(
      JSON.stringify({ entity_id: "ent_1", slug: "page", grid: "acme", url: "https://acme.cloudgrid.io/page", status: "created" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  // Any other endpoint (e.g. visibility upgrade) — succeed quietly.
  return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
};

const plugCalled = () => calls.some((c) => c.url.includes("/api/v2/plug"));
function resetCalls() { calls.length = 0; }

const TWO_GRIDS = { orgs: [
  { slug: "acme", name: "Acme", role: "owner", render_ready: true },
  { slug: "beta", name: "Beta", role: "member", render_ready: true },
] };
const ONE_GRID = { orgs: [{ slug: "acme", name: "Acme", role: "owner", render_ready: true }] };

const artifact = [{ path: "index.html", content: "<h1>hi</h1>" }];

try {
  // ── Case 1: plug + authed + >1 grid + create + no grid → picker, no publish ──
  {
    orgsReply = TWO_GRIDS;
    resetCalls();
    const h = handlersFor({ token: "jwt", edition: "web" });
    const res = await h.grid_plug({ artifact_files: artifact });
    const sc = res.structuredContent || {};
    check("plug multi-grid create → needs_grid picker", sc.needs_grid === true);
    check("plug picker keeps needs_org alias (widget compat)", sc.needs_org === true);
    check("plug picker carries grids[] and orgs[] alias", Array.isArray(sc.grids) && Array.isArray(sc.orgs) && sc.grids.length === 2);
    check("plug picker text says 'grid' not 'org'", /which grid/i.test(res.content?.[0]?.text || ""));
    check("plug multi-grid create did NOT publish", !plugCalled());
  }

  // ── Case 2: plug + >1 grid + explicit valid grid → proceeds (publishes) ──────
  {
    orgsReply = TWO_GRIDS;
    resetCalls();
    const h = handlersFor({ token: "jwt", edition: "web" });
    const res = await h.grid_plug({ artifact_files: artifact, grid: "beta" });
    check("plug explicit valid grid → published", plugCalled());
    check("plug explicit valid grid → no picker", !res.structuredContent?.needs_grid);
  }

  // ── Case 3: plug + >1 grid + EDIT (target_entity_id) → does NOT ask ──────────
  {
    orgsReply = TWO_GRIDS;
    resetCalls();
    const h = handlersFor({ token: "jwt", edition: "web" });
    const res = await h.grid_plug({ artifact_files: artifact, target_entity_id: "ent_1" });
    check("plug EDIT (target_entity_id) did NOT ask", !res.structuredContent?.needs_grid);
    check("plug EDIT (target_entity_id) proceeded to publish", plugCalled());
    // The orgs endpoint must not even be consulted for an edit.
    check("plug EDIT did not fetch the grid list", !calls.some((c) => c.url.includes("/api/v2/orgs")));
  }

  // ── Case 4a: plug + single grid → proceeds (no ask) ─────────────────────────
  {
    orgsReply = ONE_GRID;
    resetCalls();
    const h = handlersFor({ token: "jwt", edition: "web" });
    const res = await h.grid_plug({ artifact_files: artifact });
    check("plug single grid → published (no ask)", plugCalled() && !res.structuredContent?.needs_grid);
  }

  // ── Case 4b: plug + anon → proceeds (guest, no ask, no grid fetch) ───────────
  {
    orgsReply = TWO_GRIDS; // even with many grids, anon never asks
    resetCalls();
    const h = handlersFor({ token: "jwt", edition: "web" });
    const res = await h.grid_plug({ artifact_files: artifact, anon: true });
    check("plug anon → published, no ask", plugCalled() && !res.structuredContent?.needs_grid);
    check("plug anon did not fetch the grid list", !calls.some((c) => c.url.includes("/api/v2/orgs")));
  }

  // ── Case 4c: plug + single grid NOT ready → proceeds with a warning ─────────
  {
    orgsReply = { orgs: [{ slug: "acme", name: "Acme", role: "owner", render_ready: false }] };
    resetCalls();
    const h = handlersFor({ token: "jwt", edition: "web" });
    const res = await h.grid_plug({ artifact_files: artifact });
    check("plug single not-ready grid → still published", plugCalled());
    check("plug single not-ready grid → warns in text", /isn't fully set up|not fully set up|isn.t fully/i.test(res.content?.[0]?.text || ""));
  }

  // ── Case 5: plug with the inline `html` path also asks on >1 grid ───────────
  {
    orgsReply = TWO_GRIDS;
    resetCalls();
    const h = handlersFor({ token: "jwt", edition: "web" });
    const res = await h.grid_plug({ html: "<h1>hi</h1>" });
    const sc = res.structuredContent || {};
    check("plug html multi-grid create → still asks (needs_grid)", sc.needs_grid === true);
    check("plug html picker text says 'grid'", /which grid/i.test(res.content?.[0]?.text || ""));
    check("plug html multi-grid create did NOT publish", !plugCalled());
  }

  // ── Case 5b: plug html + explicit valid grid → proceeds (publishes) ──────────
  {
    orgsReply = TWO_GRIDS;
    resetCalls();
    const h = handlersFor({ token: "jwt", edition: "web" });
    const res = await h.grid_plug({ html: "<h1>hi</h1>", grid: "beta" });
    check("plug html explicit `grid` → published", plugCalled());
    check("plug html explicit `grid` → no picker", !res.structuredContent?.needs_grid);
  }

  // ── Case 6: resolveGridOrAsk unit decisions (deps seam) ─────────────────────
  {
    const ctx = makeCtx({ token: "jwt", activeOrg: "acme", edition: "web" });
    const twoGrids = async () => TWO_GRIDS.orgs;
    const oneGrid = async () => ONE_GRID.orgs;
    const noGrids = async () => [];

    const matched = await resolveGridOrAsk(ctx, { token: "jwt", suppliedGrid: "beta", edition: "web" }, { fetchUserOrgs: twoGrids });
    check("resolveGridOrAsk matched supplied grid → proceed", matched.proceed === true && matched.grid === "beta");

    const asks = await resolveGridOrAsk(ctx, { token: "jwt", suppliedGrid: undefined, edition: "web" }, { fetchUserOrgs: twoGrids });
    check("resolveGridOrAsk >1 grid no supply → picker", Boolean(asks.picker) && asks.picker.structured.needs_grid === true);
    check("resolveGridOrAsk picker sorts active grid first", asks.picker.structured.grids[0].slug === "acme");
    // Apps-SDK widget gate (0.16.1): with MCP_APPS_WIDGETS unset (default), the
    // picker must NOT set an openai/outputTemplate — the widgets render as a black
    // frame in ChatGPT, so the picker is text-first (structured text carries the
    // choice). The outputTemplate returns only when MCP_APPS_WIDGETS=1.
    check("resolveGridOrAsk picker omits outputTemplate meta by default (widget gate)", asks.picker.meta?.["openai/outputTemplate"] === undefined);

    const single = await resolveGridOrAsk(ctx, { token: "jwt", suppliedGrid: undefined, edition: "web" }, { fetchUserOrgs: oneGrid });
    check("resolveGridOrAsk single grid → single decision", single.single?.slug === "acme");

    const none = await resolveGridOrAsk(ctx, { token: "jwt", suppliedGrid: undefined, edition: "web" }, { fetchUserOrgs: noGrids });
    check("resolveGridOrAsk no grids → proceed (fall through)", none.proceed === true && none.grid === undefined);
  }
} finally {
  globalThis.fetch = realFetch;
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll grid-picker checks passed.");
