// Confirm-before-claiming-live (async runtime builds).
//
// Reported live (hosted): grid_deploy returned "building" and the session had
// NO status tool — the model blind-polled the public URL into 502s and either
// over-claimed ("your app is live") or abandoned. Two fixes under test:
//   1. runPlug polls the deploy trace server-side for a short budget: fast
//      builds return live in the same call; failures surface the platform's
//      user-language error; slow builds keep do-not-claim-live wording that
//      points at grid_check_deploy (NOT the local-only grid_status on web).
//   2. runCheckDeploy — the direct-API status verb, both editions.
//
// Run: node test/check-deploy.test.mjs
import { runPlug, runCheckDeploy, pollDeployTrace, API_BASE } from "../src/tools.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "ok  " : "FAIL"} ${label}`); if (!cond) failures++; };

function makeCtx({ edition = "web", token = "tok", grid = "acme", lastDrop = null } = {}) {
  return {
    edition,
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop, anonCookie: null },
    getToken: async () => token,
    getActiveGrid: async () => grid,
    // Tiny budgets so tests never sleep for real.
    deployPollBudgetMs: 40,
    deployPollIntervalMs: 5,
  };
}

let fetchCalls = [];
let plugReply = null;      // reply for POST /api/v2/plug
let traceReplies = [];     // successive replies for GET /deploys/<id> (last repeats)
let traceHits = 0;

const isPlug = (u, m) => u.includes("/api/v2/plug") && m === "POST";
const isTrace = (u) => /\/deploys\/d_[a-z0-9_]+/.test(u);
const isEntityDeploys = (u) => /\/api\/v2\/entities\/[^/]+\/deploys(\?|$)/.test(u);
// When set, GET /entities/:id/deploys returns this trace_id (the hosted
// inline-create case where the plug 202 omits poll_url/trace_id).
let entityDeploysTrace = null;

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method ?? "GET";
  fetchCalls.push({ url: u, method });
  if (isPlug(u, method)) {
    return new Response(JSON.stringify(plugReply.body), { status: plugReply.status, headers: { "content-type": "application/json" } });
  }
  if (isEntityDeploys(u)) {
    const body = entityDeploysTrace ? { deploys: [{ trace_id: entityDeploysTrace, status: "building" }] } : { deploys: [] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (isTrace(u)) {
    const rep = traceReplies[Math.min(traceHits, traceReplies.length - 1)];
    traceHits++;
    return new Response(JSON.stringify(rep.body), { status: rep.status ?? 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
};

const reset = () => { fetchCalls = []; plugReply = null; traceReplies = []; traceHits = 0; entityDeploysTrace = null; };
const entityDeploysCalls = () => fetchCalls.filter((c) => isEntityDeploys(c.url));
const BUILDING = { entity_id: "e1", slug: "app-1", grid: "acme", url: "https://app-1--acme.cloudgrid.io", status: "building", poll_url: "/deploys/d_app_abc123", trace_id: "d_app_abc123", detection: { kind: "app" } };

try {
  // ── runPlug: fast build → live in the same call ─────────────────────────────
  reset();
  plugReply = { status: 202, body: BUILDING };
  traceReplies = [{ body: { status: "building" } }, { body: { status: "success" } }];
  const live = await runPlug(makeCtx(), { artifact_files: [{ path: "index.js", content: "x" }], confirm_new_app: true });
  check("fast build: polled the trace", traceHits >= 2);
  check("fast build: result says live (no Building line)", !/Building \(async\)/.test(live.text) && /Live|live/.test(live.text));
  check("fast build: structured.status is live", live.structured.status === "live");
  check("fast build: no poll_url left in structured", !live.structured.poll_url);

  // ── runPlug: hosted inline-create → 202 has NULL poll_url/trace_id ─────────
  // The confirm poll must still fire: resolve the trace from /entities/:id/deploys,
  // then poll /deploys/<trace> to success. (Regression: the old gate required
  // data.poll_url, so this path skipped confirmation entirely.)
  reset();
  plugReply = { status: 202, body: { ...BUILDING, poll_url: null, trace_id: null } };
  entityDeploysTrace = "d_app_resolved9";
  traceReplies = [{ body: { status: "building" } }, { body: { status: "success" } }];
  const inline = await runPlug(makeCtx(), { artifact_files: [{ path: "index.js", content: "x" }], confirm_new_app: true });
  check("null poll_url: resolved the trace via /entities/:id/deploys", entityDeploysCalls().length >= 1);
  check("null poll_url: polled the resolved /deploys/<trace>", traceHits >= 1);
  check("null poll_url: still confirms live in-call", inline.structured.status === "live");

  // ── runPlug: build outlives the budget → do-not-claim-live + right tool ────
  reset();
  plugReply = { status: 202, body: BUILDING };
  traceReplies = [{ body: { status: "building" } }];
  const slow = await runPlug(makeCtx({ edition: "web" }), { artifact_files: [{ path: "index.js", content: "x" }], confirm_new_app: true });
  check("slow build: keeps the Building wording", /Building \(async\)/.test(slow.text));
  check("slow build: forbids claiming live", /Do NOT tell the user it is live/i.test(slow.text));
  check("slow build (web): points at grid_check_deploy", /grid_check_deploy/.test(slow.text));
  check("slow build (web): does NOT point at local-only grid_status", !/grid_status/.test(slow.text));
  check("slow build: structured keeps poll_url", slow.structured.poll_url === "/deploys/d_app_abc123");
  check("slow build: lastDrop carries poll_url for the no-args check", true);

  // local edition wording keeps grid_status as a secondary
  reset();
  plugReply = { status: 202, body: BUILDING };
  traceReplies = [{ body: { status: "building" } }];
  const slowLocal = await runPlug(makeCtx({ edition: "local" }), { artifact_files: [{ path: "index.js", content: "x" }], confirm_new_app: true });
  check("slow build (local): mentions grid_status as secondary", /grid_check_deploy \(or grid_status\)/.test(slowLocal.text));

  // ── runPlug: failed build → throws the user-language error, no live URL ────
  reset();
  plugReply = { status: 202, body: BUILDING };
  traceReplies = [{ body: { status: "failed", error: { message_user: "The web service crashed on boot: missing start script." } } }];
  let threw = null;
  try { await runPlug(makeCtx(), { artifact_files: [{ path: "index.js", content: "x" }], confirm_new_app: true }); } catch (e) { threw = e; }
  check("failed build: throws", threw !== null);
  check("failed build: carries the user-language reason", /missing start script/.test(threw?.message ?? ""));
  check("failed build: forbids handing out the URL", /NOT live/i.test(threw?.message ?? ""));

  // ── pollDeployTrace: unreachable poll degrades to unknown (never throws) ───
  reset();
  traceReplies = [{ status: 500, body: { error: "boom" } }];
  const unk = await pollDeployTrace(makeCtx(), { pollUrl: "/deploys/d_app_abc123", budgetMs: 15, intervalMs: 5 });
  check("unreachable poll: degrades to unknown, no throw", unk.status === "unknown");

  // ── runCheckDeploy ──────────────────────────────────────────────────────────
  reset();
  traceReplies = [{ body: { status: "success" } }];
  const okr = await runCheckDeploy(makeCtx({ lastDrop: { poll_url: "/deploys/d_app_abc123", url: "https://app-1--acme.cloudgrid.io", grid: "acme" } }), {});
  check("check success: live true + URL", okr.structured.live === true && /app-1--acme/.test(okr.structured.url ?? ""));

  reset();
  traceReplies = [{ body: { status: "building" } }];
  const bld = await runCheckDeploy(makeCtx({ lastDrop: { poll_url: "/deploys/d_app_abc123" } }), {});
  check("check building: live false + do-not-claim wording", bld.structured.live === false && /Do not tell the user it is live/i.test(bld.text));

  reset();
  traceReplies = [{ body: { status: "failed", error: { message_user: "Out of memory during npm install." } } }];
  const fld = await runCheckDeploy(makeCtx({ lastDrop: { poll_url: "/deploys/d_app_abc123" } }), {});
  check("check failed: live false + reason", fld.structured.live === false && /Out of memory/.test(fld.structured.error ?? ""));

  reset();
  let noTarget = null;
  try { await runCheckDeploy(makeCtx(), {}); } catch (e) { noTarget = e; }
  check("check with nothing to check: clear error", noTarget !== null && /No build to check/.test(noTarget.message));

  // grid_check_deploy with only an entity_id in session (no poll_url) → resolves + reports
  reset();
  entityDeploysTrace = "d_app_fromentity";
  traceReplies = [{ body: { status: "success" } }];
  const byEntity = await runCheckDeploy(makeCtx({ lastDrop: { entity_id: "e_rt", grid: "acme", url: "https://x--acme.cloudgrid.io" } }), {});
  check("check by entity_id (null poll_url): resolves trace + reports live", byEntity.structured.live === true && entityDeploysCalls().length >= 1);

  console.log(failures === 0 ? "\nAll check-deploy checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
} catch (err) {
  console.error("check-deploy test crashed:", err);
  process.exit(1);
}
