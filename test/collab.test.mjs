// Offline unit test for grid_collab's handler (runCollab) — issue #253.
//
// The CLAIM grid_collab makes to the user is: "you now have push access to the
// SAME live entity you do not own." Two ways that ships broken (per the brief):
//
//   1. It silently FORKS. A collab that mints a new entity with forked_from
//      lineage recreates #242's defect in the code. The fork route is
//      POST /runtimes/:id/remix (that is grid_pickup's job); the collab route is
//      POST /entities/:id/collab, which grants a collaborator on the SAME entity
//      and returns capabilities.replug=true (proven server-side by the API repo's
//      mcp-verb-contract-pickup.test.ts: `/collab` → same entity_id, replug true,
//      no forked_from). So every test below asserts the wire hit `/entities/:id/collab`
//      and NEVER `/remix`, the returned entity_id equals the target, and the
//      structured output carries NO forked_from.
//
//   2. It dead-ends on 403. The request-access flow is the feature: a policy
//      denial (NOT_ALLOWLISTED / PICKUP_DISABLED) must turn into
//      POST /entities/:id/collab-requests, not a bare permission error. Tests
//      assert the second call is made and the user is told to wait for approval.
//
// These are OFFLINE tests: fetch is mocked, so they prove runCollab's WIRE and
// its interpretation of the server contract. What they DELIBERATELY DO NOT prove
// (named here per the brief's "name what your tests would miss"):
//   - That the LIVE server actually grants write to a non-owned entity. That is a
//     server-side claim, proven in the API repo (mcp-verb-contract-pickup.test.ts
//     `/collab` case + entity-collab-requests.test.ts). A true end-to-end proof
//     needs two real accounts against a live API; the MCP repo has no such harness
//     (every test here mocks fetch), so it is out of scope for this file.
//   - The policy GATE itself ('off' actually 403s, allowlist admits only listed
//     users). That gate lives and is tested server-side; here we simulate its 403s
//     and assert the CLIENT does the right thing with them. We do NOT add any
//     bypass — the tool has no flag that skips the gate.
//
// Run: node test/collab.test.mjs

import { runCollab } from "../src/tools/deploy.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// Await a call that is EXPECTED to succeed (return a result, not throw). If it
// throws, that IS the failure — record it as a clean FAIL and return {} so the
// remaining checks in the block still run, instead of crashing the whole file
// with a stack trace. This is what makes a "dead-ends on 403" regression legible
// (it prints "FAIL: <label> threw" for every request-flow assertion) rather than
// aborting at the first one.
async function expectOk(label, promise) {
  try {
    return await promise;
  } catch (err) {
    check(`${label} (unexpectedly threw: ${err.message})`, false);
    return {};
  }
}

function makeCtx({ token = "tok", grid = "acme" } = {}) {
  return {
    edition: "web",
    state: {},
    getToken: async () => token,
    getActiveGrid: async () => grid,
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

// A collab call must NEVER touch the fork route. This is the anti-#242 guard.
function assertNoForkRoute(label) {
  const forked = calls.filter((c) => /\/remix\b/.test(c.url) || /\/runtimes\//.test(c.url));
  check(`${label}: no fork/remix route was called`, forked.length === 0);
}

// ── Happy path: a non-owner is granted collaborator on the SAME entity ───────
{
  installFetch([
    { status: 200, body: {
      entity_id: "ent-123", slug: "nebula-prism", grid: "acme",
      url: "https://acme.cloudgrid.io/nebula-prism",
      owner: { handle: "someone-else", is_you: false },
      capabilities: { replug: true, fork: true },
    } },
  ]);
  const out = await expectOk("happy", runCollab(makeCtx(), { entity_id: "acme/nebula-prism" }));
  restoreFetch();

  const c = calls[0];
  check("happy: POST hits /api/v2/entities/<target>/collab", /\/api\/v2\/entities\/acme%2Fnebula-prism\/collab$/.test(c.url) && c.method === "POST");
  check("happy: sends bearer auth", c.headers.Authorization === "Bearer tok");
  assertNoForkRoute("happy");
  check("happy: only ONE call (grant recorded, nothing fetched)", calls.length === 1);
  check("happy: structured.can_edit true (push access granted)", out.structured?.can_edit === true);
  check("happy: structured.entity_id is the SAME entity, not a new one", out.structured?.entity_id === "ent-123");
  check("happy: structured carries NO forked_from (not a fork)", !("forked_from" in (out.structured ?? {})));
  check("happy: owner_is_you false", out.structured?.owner_is_you === false);
  check("happy: text names collaborator push access", /collaborator|push access/i.test(out.text ?? ""));
  check("happy: text points at grid_pull to get the code", /grid_pull/i.test(out.text ?? ""));
  check("happy: not an error", !out.isError);
}

// ── Owner calling collab on their own entity: nothing to grant ───────────────
{
  installFetch([
    { status: 200, body: {
      entity_id: "ent-own", slug: "my-app", grid: "acme",
      owner: { handle: "me", is_you: true },
      capabilities: { replug: true, fork: true },
    } },
  ]);
  const out = await expectOk("owner", runCollab(makeCtx(), { entity_id: "ent-own" }));
  restoreFetch();
  assertNoForkRoute("owner");
  check("owner: owner_is_you true", out.structured?.owner_is_you === true);
  check("owner: text says it's yours and points at grid_pull", /yours/i.test(out.text ?? "") && /grid_pull/i.test(out.text ?? ""));
}

// ── Viewable but no push access → offer the fork, don't claim a grant ─────────
{
  installFetch([
    { status: 200, body: {
      entity_id: "ent-view", slug: "read-only", grid: "acme",
      owner: { handle: "someone-else", is_you: false },
      capabilities: { replug: false, fork: true, reason: "view_only" },
    } },
  ]);
  const out = await expectOk("view-only", runCollab(makeCtx(), { entity_id: "ent-view" }));
  restoreFetch();
  assertNoForkRoute("view-only");
  check("view-only: can_edit false", out.structured?.can_edit === false);
  check("view-only: offers grid_pickup (a fork) as the alternative", /grid_pickup/i.test(out.text ?? ""));
}

// ── 403 policy denial (NOT_ALLOWLISTED) → request access, not a dead end ──────
{
  installFetch([
    { status: 403, body: { error: { code: "NOT_ALLOWLISTED", message: "not on the list" } } },
    { status: 201, body: { request: { request_id: "req-1", status: "requested" } } },
  ]);
  const out = await expectOk("403-allowlist", runCollab(makeCtx(), { entity_id: "acme/gated-app" }));
  restoreFetch();

  check("403-allowlist: made TWO calls (collab, then collab-requests)", calls.length === 2);
  check("403-allowlist: 1st call is the collab join", /\/entities\/acme%2Fgated-app\/collab$/.test(calls[0]?.url));
  check("403-allowlist: 2nd call POSTs collab-requests", /\/entities\/acme%2Fgated-app\/collab-requests$/.test(calls[1]?.url) && calls[1]?.method === "POST");
  assertNoForkRoute("403-allowlist");
  check("403-allowlist: structured.access_requested true", out.structured?.access_requested === true);
  check("403-allowlist: text says the owner was asked / will approve", /asked|request|approve/i.test(out.text ?? ""));
  check("403-allowlist: not an error (a request is a success outcome)", !out.isError);
}

// ── 403 policy denial (PICKUP_DISABLED = collab_policy 'off') → request ───────
{
  installFetch([
    { status: 403, body: { error: { code: "PICKUP_DISABLED", message: "collab off" } } },
    { status: 201, body: { request: { request_id: "req-2", status: "requested" } } },
  ]);
  const out = await expectOk("403-off", runCollab(makeCtx(), { entity_id: "ent-off" }));
  restoreFetch();
  check("403-off: request-access flow fired (2 calls)", calls.length === 2 && /collab-requests$/.test(calls[1]?.url));
  check("403-off: access_requested true", out.structured?.access_requested === true);
}

// ── 403 that is NOT a policy denial (NOT_A_GRID_MEMBER) → do NOT request ──────
// The request flow is scoped to policy denials. A grid-boundary 403 is a
// different problem (you must be invited to the grid); converting it to a
// collab-request would be wrong and would spam the owner.
{
  installFetch([
    { status: 403, body: { error: { code: "NOT_A_GRID_MEMBER", message: "ask the grid owner to invite you" } } },
  ]);
  let out, threw = false;
  try { out = await runCollab(makeCtx(), { entity_id: "other-grid/app" }); }
  catch { threw = true; }
  restoreFetch();
  check("not-a-member: did NOT POST collab-requests", !calls.some((c) => /collab-requests/.test(c.url)));
  check("not-a-member: surfaced as an error/guidance, not a silent request", threw || out?.isError || /invite|member/i.test(out?.text ?? ""));
}

// ── entity-not-found → clear error, no fork, no request ──────────────────────
{
  installFetch([
    { status: 404, body: { error: { code: "RUNTIME_NOT_FOUND", message: "no runtime with that id" } } },
  ]);
  let out, threw = false;
  try { out = await runCollab(makeCtx(), { entity_id: "acme/ghost" }); }
  catch { threw = true; }
  restoreFetch();
  assertNoForkRoute("not-found");
  check("not-found: did NOT POST collab-requests", !calls.some((c) => /collab-requests/.test(c.url)));
  check("not-found: surfaced as an error", threw || out?.isError === true);
}

// ── already-a-collaborator → idempotent 200 (server returns replug even under a
//    restrictive policy because an existing grant trumps it). No error, no fork,
//    no request. The MCP tool cannot and need not distinguish first-join from
//    re-join; both are a granted collaborator on the SAME entity. ──────────────
{
  installFetch([
    { status: 200, body: {
      entity_id: "ent-rejoin", slug: "shared-app", grid: "acme",
      owner: { handle: "someone-else", is_you: false },
      capabilities: { replug: true, fork: true },
    } },
  ]);
  const out = await expectOk("re-join", runCollab(makeCtx(), { entity_id: "ent-rejoin" }));
  restoreFetch();
  check("re-join: single idempotent call, no request", calls.length === 1 && !calls.some((c) => /collab-requests/.test(c.url)));
  check("re-join: can_edit true, same entity", out.structured?.can_edit === true && out.structured?.entity_id === "ent-rejoin");
  assertNoForkRoute("re-join");
}

// ── COLLAB_REQUEST_EXISTS on the request → tell them it's pending ────────────
{
  installFetch([
    { status: 403, body: { error: { code: "NOT_ALLOWLISTED" } } },
    { status: 409, body: { error: { code: "COLLAB_REQUEST_EXISTS", message: "already asked" } } },
  ]);
  const out = await expectOk("req-exists", runCollab(makeCtx(), { entity_id: "ent-pending" }));
  restoreFetch();
  check("req-exists: not an error, tells user the ask is pending", !out.isError && /already asked|pending|hasn't decided|waiting/i.test(out.text ?? ""));
  check("req-exists: request_pending true", out.structured?.request_pending === true);
}

// ── COLLAB_ALREADY_ALLOWED race → tell them to just collab again ─────────────
{
  installFetch([
    { status: 403, body: { error: { code: "NOT_ALLOWLISTED" } } },
    { status: 409, body: { error: { code: "COLLAB_ALREADY_ALLOWED", message: "you already have access" } } },
  ]);
  const out = await expectOk("already-allowed", runCollab(makeCtx(), { entity_id: "ent-race" }));
  restoreFetch();
  check("already-allowed: tells the user they can join now", !out.isError && /already have access|try again|grid_collab/i.test(out.text ?? ""));
}

// ── not signed in → refuse before any network call ───────────────────────────
{
  installFetch([]);
  let threw = false;
  try { await runCollab(makeCtx({ token: null }), { entity_id: "ent-x" }); }
  catch { threw = true; }
  restoreFetch();
  check("no-auth: refuses with an error and makes no call", threw && calls.length === 0);
}

// ── missing entity_id → clear error, no call ─────────────────────────────────
{
  installFetch([]);
  let threw = false;
  try { await runCollab(makeCtx(), {}); }
  catch { threw = true; }
  restoreFetch();
  check("no-target: refuses with an error and makes no call", threw && calls.length === 0);
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll grid_collab checks passed.");
