// Offline unit test for the hosted grid_delete path (#343).
// Mocks fetch and verifies runDelete resolves + archives an inspiration,
// rejects without confirm, and errors on lookup failure.
// Run: node test/delete-hosted.test.mjs

import { runDelete } from "../src/tools/deploy.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

function makeCtx({ token = "jwt-1" } = {}) {
  return {
    edition: "web",
    state: {},
    getToken: async () => token,
  };
}

const realFetch = globalThis.fetch;
let fetchCalls = [];
let fetchReplies = [];
globalThis.fetch = async (url, opts = {}) => {
  fetchCalls.push({ url: String(url), method: opts.method || "GET", headers: opts.headers || {} });
  const next = fetchReplies.shift() ?? { status: 200, body: {} };
  return new Response(JSON.stringify(next.body), {
    status: next.status,
    headers: { "content-type": "application/json" },
  });
};

try {
  // ── confirm guard ──────────────────────────────────────────────────────────
  {
    let err = null;
    try { await runDelete(makeCtx(), { name: "my-page", grid: "acme" }); } catch (e) { err = e; }
    check("rejects without confirm: true", err !== null && /confirm/i.test(err.message));
  }

  // ── auth guard ─────────────────────────────────────────────────────────────
  {
    let err = null;
    try { await runDelete(makeCtx({ token: null }), { name: "my-page", grid: "acme", confirm: true }); } catch (e) { err = e; }
    check("rejects without sign-in", err !== null && /not signed in/i.test(err.message));
  }

  // ── grid required ──────────────────────────────────────────────────────────
  {
    let err = null;
    try { await runDelete(makeCtx(), { name: "my-page", confirm: true }); } catch (e) { err = e; }
    check("rejects without grid", err !== null && /grid.*required/i.test(err.message));
  }

  // ── successful deletion ────────────────────────────────────────────────────
  {
    fetchCalls = [];
    fetchReplies = [
      { status: 200, body: { id: "ent-42", slug: "my-page", kind: "inspiration" } },
      { status: 200, body: { ok: true } },
    ];
    const result = await runDelete(makeCtx(), { name: "my-page", grid: "acme", confirm: true });
    check("lookup call hits /api/v2/inspirations/my-page", fetchCalls[0]?.url.includes("/api/v2/inspirations/my-page"));
    check("lookup carries Authorization header", fetchCalls[0]?.headers?.Authorization === "Bearer jwt-1");
    check("lookup carries grid header", fetchCalls[0]?.headers?.["X-CloudGrid-Grid"] === "acme");
    check("delete call uses DELETE method", fetchCalls[1]?.method === "DELETE");
    check("delete call hits /api/v2/inspirations/ent-42", fetchCalls[1]?.url.includes("/api/v2/inspirations/ent-42"));
    check("result reports deleted", result.structured.deleted === true);
    check("result includes entity_id", result.structured.entity_id === "ent-42");
    check("result text mentions the slug", result.text.includes("my-page"));
    check("result text names the grid", result.text.includes("acme"));
  }

  // ── 404 on lookup ──────────────────────────────────────────────────────────
  {
    fetchCalls = [];
    fetchReplies = [
      { status: 404, body: { error: { code: "NOT_FOUND", message: "not found" } } },
    ];
    let err = null;
    try { await runDelete(makeCtx(), { name: "nope", grid: "acme", confirm: true }); } catch (e) { err = e; }
    check("404 lookup throws descriptive error", err !== null && /no inspiration found/i.test(err.message));
  }

  // ── delete API failure ─────────────────────────────────────────────────────
  {
    fetchCalls = [];
    fetchReplies = [
      { status: 200, body: { id: "ent-99", slug: "fail-me" } },
      { status: 403, body: { error: { message: "forbidden" } } },
    ];
    let err = null;
    try { await runDelete(makeCtx(), { name: "fail-me", grid: "acme", confirm: true }); } catch (e) { err = e; }
    check("delete failure throws with HTTP status", err !== null && /403/.test(err.message));
  }

  // ── resolveGridOrAsk: multi-grid returns picker (no deletion) ────────────
  {
    const { resolveGridOrAsk } = await import("../src/tools/deploy.js");
    const multiGridCtx = {
      edition: "web",
      state: {},
      getToken: async () => "jwt-1",
      getActiveGrid: async () => "alpha",
    };
    const twoGrids = [
      { slug: "alpha", name: "Alpha", role: "owner", render_ready: true },
      { slug: "beta", name: "Beta", role: "owner", render_ready: true },
    ];
    fetchCalls = [];
    const decision = await resolveGridOrAsk(multiGridCtx, {
      token: "jwt-1",
      suppliedGrid: undefined,
      edition: "web",
    }, { fetchUserOrgs: async () => twoGrids });

    check("multi-grid: returns picker", decision.picker != null);
    check("multi-grid: picker has needs_grid", decision.picker?.structured?.needs_grid === true);
    check("multi-grid: picker lists grids", decision.picker?.structured?.grids?.length === 2);
    check("multi-grid: no fetch to delete API", fetchCalls.length === 0);
  }

  // ── resolveGridOrAsk: single grid proceeds ────────────────────────────────
  {
    const { resolveGridOrAsk } = await import("../src/tools/deploy.js");
    const singleGridCtx = {
      edition: "web",
      state: {},
      getToken: async () => "jwt-1",
      getActiveGrid: async () => "only-grid",
    };
    const oneGrid = [
      { slug: "only-grid", name: "Only Grid", role: "owner", render_ready: true },
    ];
    const decision = await resolveGridOrAsk(singleGridCtx, {
      token: "jwt-1",
      suppliedGrid: undefined,
      edition: "web",
    }, { fetchUserOrgs: async () => oneGrid });

    check("single-grid: no picker", decision.picker == null);
    check("single-grid: returns single", decision.single != null);
    check("single-grid: single slug is correct", decision.single?.slug === "only-grid");
  }

  // ── handler-level: multi-grid returns picker, does NOT call delete ─────────
  {
    const { registerTools } = await import("../src/tools/register.js");
    const handlers = {};
    const fakeServer = {
      registerTool(name, _config, handler) { handlers[name] = handler; },
      tool(name, _desc, _schema, _annotations, handler) { handlers[name] = handler; },
      registerResource() {},
    };
    const twoGrids = [
      { slug: "alpha", name: "Alpha", role: "owner", render_ready: true },
      { slug: "beta", name: "Beta", role: "owner", render_ready: true },
    ];
    // Mock fetch so fetchUserOrgs returns our two grids
    fetchCalls = [];
    fetchReplies = [
      { status: 200, body: twoGrids },
    ];
    const handlerCtx = {
      edition: "web",
      state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
      canOpenBrowser: false,
      getToken: async () => "jwt-1",
      getActiveGrid: async () => "alpha",
    };
    registerTools(fakeServer, handlerCtx);
    check("handler-level: grid_delete registered", handlers.grid_delete != null);

    const result = await handlers.grid_delete({ name: "my-page", confirm: true });
    const structured = result?.structuredContent;
    check("handler-level multi-grid: returns needs_grid picker", structured?.needs_grid === true);
    check("handler-level multi-grid: picker text mentions grid choice", result?.content?.[0]?.text?.includes("Which grid"));
    // Only one fetch call (fetchUserOrgs), no delete API calls
    check("handler-level multi-grid: no delete API call", fetchCalls.length === 1);
  }

  // ── handler-level: single grid proceeds to deletion ────────────────────────
  {
    const { registerTools } = await import("../src/tools/register.js");
    const handlers = {};
    const fakeServer = {
      registerTool(name, _config, handler) { handlers[name] = handler; },
      tool(name, _desc, _schema, _annotations, handler) { handlers[name] = handler; },
      registerResource() {},
    };
    fetchCalls = [];
    fetchReplies = [
      // fetchUserOrgs returns a single grid
      { status: 200, body: [{ slug: "solo", name: "Solo Grid", role: "owner", render_ready: true }] },
      // lookup entity
      { status: 200, body: { id: "ent-77", slug: "doomed-page", kind: "inspiration" } },
      // delete
      { status: 200, body: { ok: true } },
    ];
    const handlerCtx = {
      edition: "web",
      state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
      canOpenBrowser: false,
      getToken: async () => "jwt-1",
      getActiveGrid: async () => "solo",
    };
    registerTools(fakeServer, handlerCtx);

    const result = await handlers.grid_delete({ name: "doomed-page", confirm: true });
    const text = result?.content?.[0]?.text ?? "";
    const structured = result?.structuredContent;
    check("handler-level single-grid: deletion proceeds", structured?.deleted === true || text.includes("doomed-page"));
    // Should have 3 fetch calls: listGrids, lookup, delete
    check("handler-level single-grid: 3 fetch calls (list + lookup + delete)", fetchCalls.length === 3);
    check("handler-level single-grid: delete call uses grid 'solo'",
      fetchCalls[2]?.headers?.["X-CloudGrid-Grid"] === "solo");
  }

} finally {
  globalThis.fetch = realFetch;
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll delete-hosted checks passed (offline).");
