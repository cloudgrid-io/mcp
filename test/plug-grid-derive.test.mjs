// Offline unit test for issue #296 — the edit path derives its grid, and no
// authed write path leaks an unactionable HTTP-header error to the model.
//
// The bug (observed in a real Claude web session): editing a live entity failed
// first try with
//   Plug failed (HTTP 400 GRID_HEADER_REQUIRED): Set the X-CloudGrid-Grid header…
// Two defects behind it:
//   A. runPlug's grid header came only from `grid` || ctx.getActiveGrid(). An
//      edit bypasses the grid picker (correctly), but nothing resolved the grid,
//      so on hosted (active-grid often unset) NO header was sent and the API
//      rejected the write.
//   B. The surfaced error named an HTTP header — which no MCP client can set —
//      so the model could not act on it.
//
// These are OFFLINE tests: fetch is mocked, so they prove the CLIENT behaviour:
//   1. An edit with NO `grid` and NO active grid derives the entity's home grid
//      (via the pickup contract) and sends it as X-CloudGrid-Grid on the /plug
//      POST — succeeds first try, no active-grid session state involved.
//   2. A grid-header 400 that still reaches the client is rewritten to name the
//      `grid` PARAMETER and contains neither "header" nor the internal code.
//   3. The rewrite is class-level: pull, collab, visibility and pickup all
//      rewrite it too (each with the parameter that tool actually exposes).
//   4. When a grid IS resolvable (active grid, or an explicit `grid`), no derive
//      round-trip happens — we only derive when nothing else determines it.
//
// What they do NOT prove (named so a reader knows the gap):
//   - That the LIVE API accepts the derived header and resolves the grid. That
//     is a server-side claim proven by the API repo's tests.
//
// Run: node test/plug-grid-derive.test.mjs

import { runPlug, runPull, runCollab, runVisibility, runPickup, rewriteGridHeaderError, isGridHeaderError } from "../src/tools/deploy.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

function makeCtx({ token = "jwt-x", edition = "web", activeGrid = null } = {}) {
  return {
    edition,
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
    canOpenBrowser: false,
    getToken: async () => token,
    getActiveGrid: async () => activeGrid,
    saveToken: async () => ({}),
    savedLocationNote: () => "",
    trustedServer: null,
    // Tiny poll budgets so the confirm-before-live poll never sleeps in tests.
    deployPollBudgetMs: 20,
    deployPollIntervalMs: 5,
  };
}

// fetch mock: record {url, method, headers, form, body}; reply from a queue.
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
  // ── 1. Edit, NO grid param, NO active grid → derive the grid, send the header ─
  // This is the exact #296 repro: a hosted edit by target_entity_id with no
  // active-grid session state. The fix resolves the entity's home grid from the
  // pickup contract and puts it on the /plug POST — first try, no 400.
  {
    installFetch([
      // derive: POST /entities/ent-abc/pickup → the entity's home grid
      { status: 200, body: { entity_id: "ent-abc", slug: "page", grid: "team-grid", kind: "inspiration" } },
      // the /plug re-plug itself
      { status: 202, body: { entity_id: "ent-abc", slug: "page", grid: "team-grid", url: "https://team-grid.cloudgrid.io/page", status: "live" } },
    ]);
    const out = await runPlug(
      makeCtx({ token: "jwt-e", edition: "web", activeGrid: null }),
      { html: "<h1>new title</h1>", target_entity_id: "ent-abc" },
    );
    restoreFetch();

    const derive = calls.find((c) => isPickup(c.url) && c.method === "POST");
    const post = plugPost();
    check("derive: resolves the entity's grid via POST /entities/ent-abc/pickup", Boolean(derive) && derive.url.endsWith("/api/v2/entities/ent-abc/pickup"));
    check("derive: /plug POST carries X-CloudGrid-Grid derived from the entity", post?.headers?.["X-CloudGrid-Grid"] === "team-grid");
    check("derive: X-CloudGrid-Org alias carried too", post?.headers?.["X-CloudGrid-Org"] === "team-grid");
    check("derive: the edit sends target_entity_id (an in-place re-plug)", post?.form?.get("target_entity_id") === "ent-abc");
    check("derive: succeeds first try (one /plug POST, live URL)", out.structured?.url === "https://team-grid.cloudgrid.io/page" && calls.filter((c) => c.url.endsWith("/api/v2/plug") && c.method === "POST").length === 1);
    check("derive: says Updated in place", /Updated in place/.test(out.text));
  }

  // ── 2. No derive round-trip when the grid is already resolvable ──────────────
  // (a) an explicit `grid` param → header from it, no pickup call.
  {
    installFetch([
      { status: 202, body: { entity_id: "ent-1", slug: "s", grid: "acme", url: "https://acme.cloudgrid.io/s", status: "live" } },
    ]);
    await runPlug(makeCtx({ token: "jwt-g", edition: "web", activeGrid: null }), { html: "<h1>x</h1>", target_entity_id: "ent-1", grid: "acme" });
    restoreFetch();
    check("explicit grid: no derive round-trip", !calls.some((c) => isPickup(c.url)));
    check("explicit grid: header comes from the param", plugPost()?.headers?.["X-CloudGrid-Grid"] === "acme");
  }
  // (b) an active grid → header from it, no pickup call.
  {
    installFetch([
      { status: 202, body: { entity_id: "ent-2", slug: "s", grid: "live-grid", url: "https://live-grid.cloudgrid.io/s", status: "live" } },
    ]);
    await runPlug(makeCtx({ token: "jwt-a", edition: "web", activeGrid: "live-grid" }), { html: "<h1>x</h1>", target_entity_id: "ent-2" });
    restoreFetch();
    check("active grid: no derive round-trip", !calls.some((c) => isPickup(c.url)));
    check("active grid: header comes from the active grid", plugPost()?.headers?.["X-CloudGrid-Grid"] === "live-grid");
  }

  // ── 3. A grid-header 400 that reaches the client → actionable, no "header" ───
  // Forced via a CREATE (multi-grid user, no grid resolvable) — the remaining
  // path that can still legitimately 400 with GRID_HEADER_REQUIRED once edits
  // derive their grid. The surfaced text must name the `grid` PARAMETER and must
  // NOT contain "header" (the code GRID_HEADER_REQUIRED contains "HEADER", so the
  // code must be dropped too).
  {
    installFetch([
      { status: 400, body: { error: { code: "GRID_HEADER_REQUIRED", message: "Set the X-CloudGrid-Grid header to choose which grid to write to." } } },
    ]);
    let threw = null;
    try {
      await runPlug(makeCtx({ token: "jwt-m", edition: "web", activeGrid: null }), { html: "<h1>create</h1>" });
    } catch (e) { threw = e; }
    restoreFetch();

    check("rewrite: threw an error", threw !== null);
    check("rewrite: names the `grid` parameter", /\bgrid\b[\s\S]*\bparameter\b/i.test(threw?.message ?? ""));
    check("rewrite: does NOT contain the word 'header'", !/header/i.test(threw?.message ?? ""));
    check("rewrite: does NOT contain the raw header name", !/X-CloudGrid-Grid/i.test(threw?.message ?? ""));
    check("rewrite: does NOT leak the internal code", !/GRID_HEADER_REQUIRED/.test(threw?.message ?? ""));
  }

  // ── 4. Class-level audit: every authed write path rewrites the same 400 ──────
  // pull
  {
    installFetch([{ status: 400, body: { error: { code: "GRID_HEADER_REQUIRED", message: "Set the X-CloudGrid-Grid header to choose which grid to write to." } } }]);
    let e = null;
    try { await runPull(makeCtx(), { entity_id: "ent-x" }); } catch (err) { e = err; }
    restoreFetch();
    check("pull: rewrites the header 400 to name the parameter", /\bgrid\b[\s\S]*\bparameter\b/i.test(e?.message ?? "") && !/header/i.test(e?.message ?? ""));
  }
  // collab
  {
    installFetch([{ status: 400, body: { error: { code: "GRID_HEADER_REQUIRED", message: "Set the X-CloudGrid-Grid header to choose which grid to write to." } } }]);
    let e = null;
    try { await runCollab(makeCtx(), { entity_id: "ent-x" }); } catch (err) { e = err; }
    restoreFetch();
    check("collab: rewrites the header 400 to name the parameter", /\bgrid\b[\s\S]*\bparameter\b/i.test(e?.message ?? "") && !/header/i.test(e?.message ?? ""));
  }
  // visibility
  {
    installFetch([{ status: 400, body: { error: { code: "GRID_HEADER_REQUIRED", message: "Set the X-CloudGrid-Grid header to choose which grid to write to." } } }]);
    let e = null;
    try { await runVisibility(makeCtx(), { target: "ent-x", visibility: "grid", kind: "inspiration" }); } catch (err) { e = err; }
    restoreFetch();
    check("visibility: rewrites the header 400 to name the parameter", /\bgrid\b[\s\S]*\bparameter\b/i.test(e?.message ?? "") && !/header/i.test(e?.message ?? ""));
  }
  // pickup — the destination param is into_org_slug, so the message names THAT.
  {
    installFetch([{ status: 400, body: { error: { code: "GRID_HEADER_REQUIRED", message: "Set the X-CloudGrid-Grid header to choose which grid to write to." } } }]);
    let e = null;
    try { await runPickup(makeCtx(), { id: "ent-x" }); } catch (err) { e = err; }
    restoreFetch();
    check("pickup: rewrites the header 400 (names into_org_slug, no 'header')", /into_org_slug/.test(e?.message ?? "") && !/header/i.test(e?.message ?? ""));
  }

  // ── 5. rewriteGridHeaderError / isGridHeaderError units ─────────────────────
  check("isGridHeaderError: matches by code", isGridHeaderError("GRID_HEADER_REQUIRED", "anything") === true);
  check("isGridHeaderError: matches by message", isGridHeaderError(null, "Set the X-CloudGrid-Grid header") === true);
  check("isGridHeaderError: unrelated message is not matched", isGridHeaderError("BAD_REQUEST", "entity_id is not a valid UUID") === false);
  check("rewrite: default param is `grid`", /`grid`/.test(rewriteGridHeaderError("Set the X-CloudGrid-Grid header")));
  check("rewrite: honors a custom param name", /`into_org_slug`/.test(rewriteGridHeaderError("Set the X-CloudGrid-Grid header", "into_org_slug")));
  check("rewrite: passes non-header messages through unchanged", rewriteGridHeaderError("entity_id is not a valid UUID") === "entity_id is not a valid UUID");
} finally {
  restoreFetch();
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll plug grid-derive checks passed (offline).");
