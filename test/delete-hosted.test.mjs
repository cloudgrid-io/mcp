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

} finally {
  globalThis.fetch = realFetch;
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll delete-hosted checks passed (offline).");
