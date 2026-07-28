// grid_visibility — Decision 060 two-axis contract.
//
// BOTH realms now take the same realm-scoped PATCH with the same vocabulary:
//   runtimes:     PATCH /api/v2/entities/:id/visibility
//   inspirations: PATCH /api/v2/inspirations/:id/visibility
// Bodies: legacy modes ride { visibility: private|grid|link } (+ link_indexed /
// visibility_spaces); the axes ride { share_scope, external_access,
// require_signin?, visibility_spaces? }. `authenticated` is RETIRED — it maps
// to the axis body it equals (private + link + require_signin). `org` is
// rejected. `public` as a mode is an alias of `link`. `space` maps to
// inside: spaces and needs the `spaces` list.
//
// Run: node test/set-sharing.test.mjs
import { runVisibility } from "../src/tools.js";

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
const isInspirationVis = (u) => /\/api\/v2\/inspirations\/[^/]+\/visibility$/.test(u);

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
  // 1. Runtime agent, legacy mode → entities route, { visibility } body; no inspiration call.
  reset();
  replies.runtime = { status: 200, body: JSON.stringify({ url: "https://a.cloudgrid.io", visibility: "grid" }) };
  const r1 = await runVisibility(makeCtx({ kind: "agent", entity_id: "e_rt" }), { visibility: "grid" });
  check("runtime: hit the entities/:id/visibility route", runtimeCalls().length === 1);
  check("runtime: NO inspiration route call", inspirationCalls().length === 0);
  check("runtime: legacy body is { visibility: grid }", runtimeCalls()[0]?.body?.visibility === "grid");
  check("runtime: returns grid as the set visibility", r1.structured.visibility === "grid");

  // 2. 'org' is REJECTED up front — no wire call (matches the CLI).
  reset();
  let threwOrg = null;
  try { await runVisibility(makeCtx({ kind: "app", entity_id: "e_org" }), { visibility: "org" }); }
  catch (e) { threwOrg = e; }
  check("org: rejected with guidance to use grid", threwOrg !== null && /grid/.test(threwOrg.message));
  check("org: no wire call made", fetchCalls.length === 0);

  // 3. 'authenticated' is retired → maps to the AXIS body private+link+require_signin.
  reset();
  replies.runtime = { status: 200, body: JSON.stringify({ share_scope: "private", external_access: "link", require_signin: true }) };
  const r3 = await runVisibility(makeCtx({ entity_id: "e_auth" }), { visibility: "authenticated", kind: "app" });
  const b3 = runtimeCalls()[0]?.body;
  check("authenticated: sends the axis body it equals",
    b3?.share_scope === "private" && b3?.external_access === "link" && b3?.require_signin === true && b3?.visibility === undefined);
  check("authenticated: result surfaces the stored axes", r3.structured.external_access === "link" && r3.structured.require_signin === true);

  // 4. Inspiration realm: SAME vocabulary, realm-scoped /visibility path — no org mapping.
  reset();
  replies.inspiration = { status: 200, body: JSON.stringify({ url: "https://c.cloudgrid.io", visibility: "grid" }) };
  const r4 = await runVisibility(makeCtx({ kind: "inspiration", entity_id: "e_insp" }), { visibility: "grid" });
  check("inspiration: hit inspirations/:id/visibility", inspirationCalls().length === 1);
  check("inspiration: NO entities route call", runtimeCalls().length === 0);
  check("inspiration: sends grid AS grid (no org mapping)", inspirationCalls()[0]?.body?.visibility === "grid");
  check("inspiration: reports grid back", r4.structured.visibility === "grid");

  // 5. Unknown kind: runtime first, 404 → inspiration fallback with the same body.
  reset();
  replies.runtime = { status: 404, body: JSON.stringify({ error: { code: "NOT_FOUND", message: "Entity not found." } }) };
  replies.inspiration = { status: 200, body: JSON.stringify({ url: "https://d.cloudgrid.io", visibility: "grid" }) };
  await runVisibility(makeCtx({ entity_id: "e_unknown" }), { visibility: "grid" });
  check("unknown: runtime route tried first", runtimeCalls().length === 1);
  check("unknown: fell back to the inspiration route", inspirationCalls().length === 1);
  check("unknown: fallback used the SAME vocabulary (grid)", inspirationCalls()[0]?.body?.visibility === "grid");

  // 5b. NOT_A_RUNTIME also falls back.
  reset();
  replies.runtime = { status: 400, body: JSON.stringify({ error: { code: "NOT_A_RUNTIME", message: "This is an Inspiration, not a Runtime." } }) };
  replies.inspiration = { status: 200, body: JSON.stringify({ url: "https://d2.cloudgrid.io", visibility: "private" }) };
  await runVisibility(makeCtx({ entity_id: "e_not_rt" }), { visibility: "private" });
  check("NOT_A_RUNTIME: runtime tried then inspiration fallback", runtimeCalls().length === 1 && inspirationCalls().length === 1);

  // 6. Two-axis body: inside/outside (+spaces, require_signin) validated + sent as-is.
  reset();
  replies.runtime = { status: 200, body: JSON.stringify({ share_scope: "spaces", external_access: "none", visibility_spaces: ["design"] }) };
  const r6 = await runVisibility(makeCtx({ kind: "app", entity_id: "e_ax" }), { inside: "spaces", outside: "none", spaces: ["Design", "design"] });
  const b6 = runtimeCalls()[0]?.body;
  check("axes: sends share_scope/external_access", b6?.share_scope === "spaces" && b6?.external_access === "none");
  check("axes: spaces deduped + lowercased", Array.isArray(b6?.visibility_spaces) && b6.visibility_spaces.length === 1 && b6.visibility_spaces[0] === "design");
  check("axes: result carries the stored axes", r6.structured.share_scope === "spaces" && r6.structured.visibility_spaces?.[0] === "design");

  // 6b. Axis validation errors — no wire call.
  reset();
  let threwAx = null;
  try { await runVisibility(makeCtx({ kind: "app", entity_id: "e_ax2" }), { inside: "grid", outside: "none", require_signin: true }); }
  catch (e) { threwAx = e; }
  check("axes: require_signin without outside:link rejected up front", threwAx !== null && /require_signin/.test(threwAx.message) && fetchCalls.length === 0);
  reset();
  let threwAx2 = null;
  try { await runVisibility(makeCtx({ kind: "app", entity_id: "e_ax3" }), { inside: "spaces", outside: "none" }); }
  catch (e) { threwAx2 = e; }
  check("axes: inside:spaces without `spaces` rejected up front", threwAx2 !== null && /space/.test(threwAx2.message) && fetchCalls.length === 0);

  // 7. Legacy 'space' mode maps to the spaces axis body and needs the list.
  reset();
  replies.runtime = { status: 200, body: JSON.stringify({ share_scope: "spaces", external_access: "none", visibility_spaces: ["team"] }) };
  await runVisibility(makeCtx({ kind: "app", entity_id: "e_sp" }), { visibility: "space", spaces: ["team"] });
  const b7 = runtimeCalls()[0]?.body;
  check("space mode: sends { share_scope: spaces, external_access: none, visibility_spaces }",
    b7?.share_scope === "spaces" && b7?.external_access === "none" && b7?.visibility_spaces?.[0] === "team");
  reset();
  let threwSp = null;
  try { await runVisibility(makeCtx({ kind: "app", entity_id: "e_sp2" }), { visibility: "space" }); }
  catch (e) { threwSp = e; }
  check("space mode without `spaces` list: clear error, no wire call", threwSp !== null && fetchCalls.length === 0);

  // 8. link + indexed → link_indexed on the wire; 'public' mode aliases to link.
  reset();
  replies.runtime = { status: 200, body: JSON.stringify({ visibility: "link", link_indexed: true }) };
  await runVisibility(makeCtx({ kind: "app", entity_id: "e_l" }), { visibility: "public", indexed: true });
  const b8 = runtimeCalls()[0]?.body;
  check("public mode: aliases to link with link_indexed", b8?.visibility === "link" && b8?.link_indexed === true);

  // 9. A real runtime error (403) is NOT retried on the inspiration route.
  reset();
  replies.runtime = { status: 403, body: JSON.stringify({ error: { code: "NOT_OWNER", message: "nope" } }) };
  let threw9 = null;
  try { await runVisibility(makeCtx({ kind: "app", entity_id: "e_rt4" }), { visibility: "private" }); }
  catch (e) { threw9 = e; }
  check("403: propagates (throws)", threw9 !== null);
  check("403: NO inspiration fallback", inspirationCalls().length === 0);

  // 10. Axis response renders the two-axis sentence.
  reset();
  replies.runtime = { status: 200, body: JSON.stringify({ share_scope: "grid", external_access: "link", require_signin: true, url: "https://f.cloudgrid.io" }) };
  const r10 = await runVisibility(makeCtx({ kind: "app", entity_id: "e_txt" }), { inside: "grid", outside: "link", require_signin: true });
  check("axis result text names both axes", /inside the grid: everyone in the grid/.test(r10.text) && /signed-in accounts only/.test(r10.text));

  console.log(failures === 0 ? "\nAll set-sharing checks passed." : `\n${failures} set-sharing check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
} catch (err) {
  console.error("set-sharing test crashed:", err);
  process.exit(1);
}
