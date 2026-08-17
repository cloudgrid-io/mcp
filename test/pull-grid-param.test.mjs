// Offline unit test for grid_pull's `grid` parameter — issue #247.
//
// The bug: grid_pull had no `grid` parameter, so on the hosted MCP transport
// (where no client can set HTTP headers) a multi-grid user hit a 400 with
// "Set the X-CloudGrid-Grid header to choose which grid to write to." — an
// unactionable error. The fix adds a `grid` parameter matching grid_pickup and
// grid_collab, and rewrites header-referencing errors into actionable text.
//
// These are OFFLINE tests: fetch is mocked, so they prove:
//   1. A supplied `grid` param sets the X-CloudGrid-Grid header on the wire.
//   2. Without `grid`, the header falls back to ctx.getActiveGrid().
//   3. A 400 mentioning X-CloudGrid-Grid is rewritten to name the `grid` param.
//   4. The tool surface (inputSchema) exposes the `grid` parameter.
//
// What they do NOT prove (named here so a reader knows the gap):
//   - That the LIVE API accepts the header and resolves the grid correctly.
//     That is a server-side claim proven by the API repo's tests.
//
// Run: node test/pull-grid-param.test.mjs

import { runPull } from "../src/tools/deploy.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// Await a call that is EXPECTED to succeed (return a result, not throw).
async function expectOk(label, promise) {
  try {
    return await promise;
  } catch (err) {
    check(`${label} (unexpectedly threw: ${err.message})`, false);
    return {};
  }
}

function makeCtx({ token = "tok", activeGrid = null } = {}) {
  return {
    edition: "web",
    state: {},
    getToken: async () => token,
    getActiveGrid: async () => activeGrid,
  };
}

// fetch mock: record every call; reply from a queue.
let calls = [];
let replies = [];
const realFetch = globalThis.fetch;
function installFetch(queue) {
  calls = [];
  replies = [...queue];
  globalThis.fetch = async (url, opts = {}) => {
    let body = null;
    try { body = opts.body ? JSON.parse(opts.body) : null; } catch { body = opts.body; }
    calls.push({ url: String(url), method: opts.method, headers: opts.headers || {}, body });
    const next = replies.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json", ...(next.headers || {}) },
    });
  };
}
const restoreFetch = () => { globalThis.fetch = realFetch; };

// ── 1. Supplied `grid` param sets the header on the wire ───────────────────
{
  installFetch([
    { status: 200, body: {
      entity_id: "ent-123", slug: "my-app", grid: "team-grid",
      url: "https://my-app--team-grid.cloudgrid.io",
      owner: { handle: "me", is_you: true },
      capabilities: { replug: true },
    } },
  ]);
  const out = await expectOk(
    "grid-param",
    runPull(makeCtx({ activeGrid: null }), { entity_id: "ent-123", grid: "team-grid" }),
  );
  restoreFetch();

  const c = calls[0];
  check("grid-param: X-CloudGrid-Grid header set from grid param", c.headers["X-CloudGrid-Grid"] === "team-grid");
  check("grid-param: X-CloudGrid-Org alias also set", c.headers["X-CloudGrid-Org"] === "team-grid");
  check("grid-param: call succeeded", out.structured?.entity_id === "ent-123");
}

// ── 2. `grid` param wins over ctx.getActiveGrid() ─────────────────────────
{
  installFetch([
    { status: 200, body: {
      entity_id: "ent-456", slug: "other-app", grid: "explicit-grid",
      owner: { handle: "me", is_you: true },
      capabilities: { replug: true },
    } },
  ]);
  const out = await expectOk(
    "grid-wins",
    runPull(makeCtx({ activeGrid: "session-grid" }), { entity_id: "ent-456", grid: "explicit-grid" }),
  );
  restoreFetch();

  const c = calls[0];
  check("grid-wins: explicit grid wins over active grid", c.headers["X-CloudGrid-Grid"] === "explicit-grid");
}

// ── 3. Without `grid`, falls back to ctx.getActiveGrid() ──────────────────
{
  installFetch([
    { status: 200, body: {
      entity_id: "ent-789", slug: "fallback-app", grid: "active-grid",
      owner: { handle: "me", is_you: true },
      capabilities: { replug: true },
    } },
  ]);
  await expectOk(
    "fallback",
    runPull(makeCtx({ activeGrid: "active-grid" }), { entity_id: "ent-789" }),
  );
  restoreFetch();

  const c = calls[0];
  check("fallback: uses active grid when no grid param", c.headers["X-CloudGrid-Grid"] === "active-grid");
}

// ── 4. No `grid` and no active grid: header is absent (the API decides) ───
{
  installFetch([
    { status: 200, body: {
      entity_id: "ent-solo", slug: "solo-app",
      owner: { handle: "me", is_you: true },
      capabilities: { replug: true },
    } },
  ]);
  await expectOk(
    "no-grid",
    runPull(makeCtx({ activeGrid: null }), { entity_id: "ent-solo" }),
  );
  restoreFetch();

  const c = calls[0];
  check("no-grid: no X-CloudGrid-Grid header when neither source", !("X-CloudGrid-Grid" in c.headers));
  check("no-grid: no X-CloudGrid-Org header either", !("X-CloudGrid-Org" in c.headers));
}

// ── 5. A 400 mentioning X-CloudGrid-Grid is rewritten to name the param ───
{
  installFetch([
    { status: 400, body: {
      error: { message: "Set the X-CloudGrid-Grid header to choose which grid to write to." },
    } },
  ]);
  let threw = null;
  try {
    await runPull(makeCtx({ activeGrid: null }), { entity_id: "ent-multi" });
  } catch (err) {
    threw = err;
  }
  restoreFetch();

  check("rewrite-400: threw an error", threw !== null);
  check(
    "rewrite-400: error names the `grid` parameter, not the HTTP header",
    /\bgrid\b.*\bparameter\b/i.test(threw?.message ?? ""),
  );
  check(
    "rewrite-400: error does NOT mention X-CloudGrid-Grid",
    !/X-CloudGrid-Grid/i.test(threw?.message ?? ""),
  );
}

// ── 6. A 400 NOT about headers passes through unchanged ───────────────────
{
  installFetch([
    { status: 400, body: {
      error: { message: "entity_id is not a valid UUID" },
    } },
  ]);
  let threw = null;
  try {
    await runPull(makeCtx({ activeGrid: "acme" }), { entity_id: "bad-id" });
  } catch (err) {
    threw = err;
  }
  restoreFetch();

  check("passthrough-400: threw an error", threw !== null);
  check("passthrough-400: original message preserved", /entity_id is not a valid UUID/.test(threw?.message ?? ""));
}

// ── 7. ORG_NOT_ACCESSIBLE returns server message + hint, not push-access advice
{
  installFetch([
    { status: 403, body: {
      error: {
        code: "ORG_NOT_ACCESSIBLE",
        message: "Grid 'teem-grid' is not accessible to this account.",
        details: [{ hint: "Available: team-grid, personal" }],
      },
    } },
  ]);
  const out = await expectOk(
    "org-not-accessible",
    runPull(makeCtx({ activeGrid: null }), { entity_id: "ent-typo", grid: "teem-grid" }),
  );
  restoreFetch();

  check("org-not-accessible: returns result (not throw)", out.text != null);
  check(
    "org-not-accessible: surfaces the server message",
    /teem-grid.*not accessible/i.test(out.text),
  );
  check(
    "org-not-accessible: surfaces the Available hint",
    /Available:.*team-grid/i.test(out.text),
  );
  check(
    "org-not-accessible: does NOT mention grid_collab",
    !/grid_collab/i.test(out.text),
  );
  check(
    "org-not-accessible: structured code is ORG_NOT_ACCESSIBLE",
    out.structured?.error?.code === "ORG_NOT_ACCESSIBLE",
  );
}

// ── 8. NO_ACTIVE_ORG routes to grid creation, not push-access advice ─────
{
  installFetch([
    { status: 403, body: {
      error: {
        code: "NO_ACTIVE_ORG",
        message: "This account has no active organization.",
      },
    } },
  ]);
  const out = await expectOk(
    "no-active-org",
    runPull(makeCtx({ activeGrid: null }), { entity_id: "ent-norg" }),
  );
  restoreFetch();

  check("no-active-org: returns result (not throw)", out.text != null);
  check(
    "no-active-org: mentions grid_create_grid",
    /grid_create_grid/i.test(out.text),
  );
  check(
    "no-active-org: sets needs_grid_create",
    out.structured?.needs_grid_create === true,
  );
  check(
    "no-active-org: does NOT mention grid_collab",
    !/grid_collab/i.test(out.text),
  );
}

// ── 8b. Dual-accept: NO_ACTIVE_GRID (the org→grid rename) routes identically ──
// The API already emits NO_ACTIVE_GRID alongside NO_ACTIVE_ORG (#2673). Without
// dual-accept the first-time-user "no grid" path silently darks on the new name.
{
  installFetch([
    { status: 403, body: {
      error: { code: "NO_ACTIVE_GRID", message: "This account has no active grid." },
    } },
  ]);
  const out = await expectOk(
    "no-active-grid",
    runPull(makeCtx({ activeGrid: null }), { entity_id: "ent-nogrid" }),
  );
  restoreFetch();

  check("no-active-grid: returns result (not throw)", out.text != null);
  check("no-active-grid: mentions grid_create_grid", /grid_create_grid/i.test(out.text));
  check("no-active-grid: sets needs_grid_create", out.structured?.needs_grid_create === true);
}

// ── 8c. Dual-accept: GRID_NOT_ACCESSIBLE routes like ORG_NOT_ACCESSIBLE ───────
{
  installFetch([
    { status: 403, body: {
      error: {
        code: "GRID_NOT_ACCESSIBLE",
        message: "Grid 'teem-grid' is not accessible to this account.",
        details: [{ hint: "Available: team-grid, personal" }],
      },
    } },
  ]);
  const out = await expectOk(
    "grid-not-accessible",
    runPull(makeCtx({ activeGrid: null }), { entity_id: "ent-typo2", grid: "teem-grid" }),
  );
  restoreFetch();

  check("grid-not-accessible: surfaces the server message", /teem-grid.*not accessible/i.test(out.text));
  check("grid-not-accessible: surfaces the Available hint", /Available:.*team-grid/i.test(out.text));
  check("grid-not-accessible: does NOT mention grid_collab", !/grid_collab/i.test(out.text));
  check(
    "grid-not-accessible: structured code echoes GRID_NOT_ACCESSIBLE",
    out.structured?.error?.code === "GRID_NOT_ACCESSIBLE",
  );
}

// ── 9. Tool surface exposes the `grid` parameter ──────────────────────────
{
  const transport = new StdioClientTransport({ command: "node", args: ["src/index.js"] });
  const client = new Client({ name: "pull-grid-test", version: "0.0.0" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  await client.close();

  const pull = tools.find((t) => t.name === "grid_pull");
  check("surface: grid_pull is a registered tool", pull != null);
  const props = pull?.inputSchema?.properties ?? {};
  check("surface: grid_pull has a `grid` parameter", "grid" in props);
  check(
    "surface: grid param description mentions multi-grid",
    /more than one grid/i.test(props.grid?.description ?? ""),
  );
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll grid_pull grid-param checks passed.");
