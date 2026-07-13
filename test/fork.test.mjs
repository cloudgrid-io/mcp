// grid_fork kind-awareness (Decision 044 §4). The runtime fork route rejects a
// non-runtime with `400 NOT_A_RUNTIME`; runFork must then retry the inspiration
// route — mirroring the CLI `fork` command. Regression for the reported bug
// "fork works for runtimes only, not inspirations" (the MCP hardcoded the
// runtime route with no fallback).
//
// Run: node test/fork.test.mjs
import { runFork, API_BASE } from "../src/tools.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

function makeCtx({ token = "tok", grid = "acme" } = {}) {
  return {
    edition: "web",
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
    getToken: async () => token,
    getActiveGrid: async () => grid,
  };
}

let fetchCalls = [];
// route replies: { runtime: {status, body}, inspiration: {status, body} }
let replies = {};

const isRuntimeFork = (u) => /\/api\/v2\/runtimes\/[^/]+\/fork$/.test(u);
const isInspirationFork = (u) => /\/api\/v2\/inspirations\/[^/]+\/fork$/.test(u);

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  fetchCalls.push({ url: u, method: opts.method });
  const r = isRuntimeFork(u) ? replies.runtime : isInspirationFork(u) ? replies.inspiration : null;
  const rep = r ?? { status: 404, body: JSON.stringify({ error: { code: "NOT_FOUND", message: "no route" } }) };
  return new Response(String(rep.body), { status: rep.status, headers: { "content-type": "application/json" } });
};

const reset = () => { fetchCalls = []; replies = {}; };
const runtimeCalls = () => fetchCalls.filter((c) => isRuntimeFork(c.url));
const inspirationCalls = () => fetchCalls.filter((c) => isInspirationFork(c.url));

try {
  // ── 1. Inspiration: runtime route 400 NOT_A_RUNTIME → retry inspiration route ─
  reset();
  replies.runtime = { status: 400, body: JSON.stringify({ error: { code: "NOT_A_RUNTIME", message: "This is an Inspiration, not a Runtime." } }) };
  replies.inspiration = { status: 200, body: JSON.stringify({ entity_id: "e_insp", name: "my-remix", kind: "inspiration", grid_slug: "acme", forked_from: "src_insp" }) };
  const insp = await runFork(makeCtx(), { id: "src_insp", name: "my-remix" });
  check("inspiration: runtime route was tried first", runtimeCalls().length === 1);
  check("inspiration: fell back to the inspiration route", inspirationCalls().length === 1);
  check("inspiration: returns the inspiration fork result", insp.structured.entity_id === "e_insp" && insp.structured.kind === "inspiration");

  // ── 2. Runtime: runtime route 200 → NO inspiration fallback ─────────────────
  reset();
  replies.runtime = { status: 200, body: JSON.stringify({ entity_id: "e_rt", name: "my-app", kind: "app", grid_slug: "acme", forked_from: "src_rt", forked_from_version_id: "v1" }) };
  const rt = await runFork(makeCtx(), { id: "src_rt", into_org_slug: "acme", source_version_id: "v1" });
  check("runtime: runtime route hit", runtimeCalls().length === 1);
  check("runtime: NO inspiration route call", inspirationCalls().length === 0);
  check("runtime: returns the runtime fork result", rt.structured.entity_id === "e_rt" && rt.structured.kind === "app");

  // ── 3. A non-NOT_A_RUNTIME runtime error is NOT retried on the inspiration route
  reset();
  replies.runtime = { status: 403, body: JSON.stringify({ error: { code: "NOT_AUTHORIZED", message: "nope" } }) };
  let threw = false;
  try { await runFork(makeCtx(), { id: "src_x" }); } catch { threw = true; }
  check("other error: propagates (throws)", threw);
  check("other error: NO inspiration fallback", inspirationCalls().length === 0);

  console.log(failures === 0 ? "\nAll fork checks passed." : `\n${failures} fork check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
} catch (err) {
  console.error("fork test crashed:", err);
  process.exit(1);
}
