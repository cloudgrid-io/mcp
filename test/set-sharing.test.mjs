// grid_visibility kind-awareness. Reported bug: setting visibility on a runtime
// app/agent failed with "handles inspirations, not runtime agents" because
// runVisibility hardcoded PATCH /api/v2/inspirations/:id for every entity.
//
// The platform has two surfaces with two vocabularies:
//   - inspirations: PATCH /api/v2/inspirations/:id      { private|space|authenticated|org|link }
//   - runtimes:     PATCH /api/v2/entities/:id/visibility { private|authenticated|grid|link }
// runVisibility must route by kind and map the whole-grid word (org<->grid).
// Mirrors runFork: runtime route first when kind is unknown, fall back to the
// inspiration route on 404 NOT_FOUND.
//
// Run: node test/set-sharing.test.mjs
import { runVisibility, API_BASE } from "../src/tools.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

function makeCtx({ token = "tok", grid = "acme", kind = null, entity_id = null } = {}) {
  return {
    edition: "web",
    state: { lastDrop: entity_id ? { entity_id, kind } : null },
    getToken: async () => token,
    getActiveGrid: async () => grid,
  };
}

let fetchCalls = [];
let replies = {}; // { runtime: {status, body}, inspiration: {status, body} }

const isRuntimeVis = (u) => /\/api\/v2\/entities\/[^/]+\/visibility$/.test(u);
const isInspirationVis = (u) => /\/api\/v2\/inspirations\/[^/]+$/.test(u);

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  let body = null;
  try { body = JSON.parse(opts.body); } catch { /* ignore */ }
  fetchCalls.push({ url: u, method: opts.method, body });
  const r = isRuntimeVis(u) ? replies.runtime : isInspirationVis(u) ? replies.inspiration : null;
  const rep = r ?? { status: 404, body: JSON.stringify({ error: { code: "NOT_FOUND", message: "no route" } }) };
  return new Response(String(rep.body), { status: rep.status, headers: { "content-type": "application/json" } });
};

const reset = () => { fetchCalls = []; replies = {}; };
const runtimeCalls = () => fetchCalls.filter((c) => isRuntimeVis(c.url));
const inspirationCalls = () => fetchCalls.filter((c) => isInspirationVis(c.url));

try {
  // 1. Runtime agent (kind from session) → entities route, org mapped to grid, NO inspiration call.
  reset();
  replies.runtime = { status: 200, body: JSON.stringify({ url: "https://a.cloudgrid.io" }) };
  const r1 = await runVisibility(makeCtx({ kind: "agent", entity_id: "e_rt" }), { visibility: "org" });
  check("runtime: hit the entities/:id/visibility route", runtimeCalls().length === 1);
  check("runtime: NO inspiration route call", inspirationCalls().length === 0);
  check("runtime: whole-grid 'org' was mapped to 'grid' on the wire", runtimeCalls()[0]?.body?.visibility === "grid");
  check("runtime: returns grid as the set visibility", r1.structured.visibility === "grid");

  // 2. Runtime app, explicit kind param, plain value passes through unchanged.
  reset();
  replies.runtime = { status: 200, body: JSON.stringify({ url: "https://b.cloudgrid.io" }) };
  await runVisibility(makeCtx({ entity_id: "e_rt2" }), { visibility: "authenticated", kind: "app" });
  check("runtime(explicit kind): entities route used", runtimeCalls().length === 1 && inspirationCalls().length === 0);
  check("runtime(explicit kind): 'authenticated' passed through", runtimeCalls()[0]?.body?.visibility === "authenticated");

  // 3. Inspiration (kind from session) → inspirations route, grid mapped to org.
  reset();
  replies.inspiration = { status: 200, body: JSON.stringify({ url: "https://c.cloudgrid.io" }) };
  const r3 = await runVisibility(makeCtx({ kind: "inspiration", entity_id: "e_insp" }), { visibility: "grid" });
  check("inspiration: hit the inspirations/:id route", inspirationCalls().length === 1);
  check("inspiration: NO entities route call", runtimeCalls().length === 0);
  check("inspiration: 'grid' was mapped to 'org' on the wire", inspirationCalls()[0]?.body?.visibility === "org");
  check("inspiration: reports 'grid' back to the user", r3.structured.visibility === "grid");

  // 4. Unknown kind: try runtime first, 404 → fall back to inspiration route.
  reset();
  replies.runtime = { status: 404, body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Entity not found." } }) };
  replies.inspiration = { status: 200, body: JSON.stringify({ url: "https://d.cloudgrid.io" }) };
  await runVisibility(makeCtx({ entity_id: "e_unknown" }), { visibility: "grid" });
  check("unknown: runtime route tried first", runtimeCalls().length === 1);
  check("unknown: fell back to the inspiration route", inspirationCalls().length === 1);
  check("unknown: fallback used the inspiration vocab (org)", inspirationCalls()[0]?.body?.visibility === "org");

  // 4b. Unknown kind: runtime route replies 400 NOT_A_RUNTIME → fall back too.
  reset();
  replies.runtime = { status: 400, body: JSON.stringify({ error: { code: "NOT_A_RUNTIME", message: "This is an Inspiration, not a Runtime." } }) };
  replies.inspiration = { status: 200, body: JSON.stringify({ url: "https://d2.cloudgrid.io" }) };
  await runVisibility(makeCtx({ entity_id: "e_not_rt" }), { visibility: "private" });
  check("NOT_A_RUNTIME: runtime tried then inspiration fallback", runtimeCalls().length === 1 && inspirationCalls().length === 1);

  // 5. 'space' is inspiration-only → never touches the runtime route.
  reset();
  replies.inspiration = { status: 200, body: JSON.stringify({ url: "https://e.cloudgrid.io" }) };
  await runVisibility(makeCtx({ entity_id: "e_space" }), { visibility: "space" });
  check("space: inspiration route only", inspirationCalls().length === 1 && runtimeCalls().length === 0);

  // 6. 'space' on a runtime is a clear up-front error, no wire call.
  reset();
  let threw6 = null;
  try { await runVisibility(makeCtx({ kind: "app", entity_id: "e_rt3" }), { visibility: "space" }); }
  catch (e) { threw6 = e; }
  check("space+runtime: throws a clear error", threw6 !== null && /space/i.test(threw6.message));
  check("space+runtime: no wire call made", fetchCalls.length === 0);

  // 7. A real runtime error (403) is NOT retried on the inspiration route.
  reset();
  replies.runtime = { status: 403, body: JSON.stringify({ error: { code: "NOT_OWNER", message: "nope" } }) };
  let threw7 = null;
  try { await runVisibility(makeCtx({ kind: "app", entity_id: "e_rt4" }), { visibility: "private" }); }
  catch (e) { threw7 = e; }
  check("403: propagates (throws)", threw7 !== null);
  check("403: NO inspiration fallback", inspirationCalls().length === 0);

  console.log(failures === 0 ? "\nAll set-sharing checks passed." : `\n${failures} set-sharing check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
} catch (err) {
  console.error("set-sharing test crashed:", err);
  process.exit(1);
}
