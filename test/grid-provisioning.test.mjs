// Offline tests for the zero-grid golden path (issue #235): create → the grid
// provisions in the background → the next grid_plug waits for readiness (bounded
// retry on 409 ORG_PROVISIONING) then deploys.
//
// Wire facts these tests pin (verified in the monorepo, cited in WORKER-REPORT):
//   - A brand-new grid (async org provisioning ON) returns HTTP 202 from
//     POST /api/v2/grids with { ...grid, status: "provisioning", poll_url }.
//   - Infra-dependent writes (POST /api/v2/plug is guarded by
//     requireGridProvisioned) return 409 ORG_PROVISIONING while provisioning,
//     with error.details[0].hint carrying either a remaining-time estimate
//     (retryable) or "Setup did not complete." (terminal / failed).
//   - There is NO read endpoint that reports provisioning readiness:
//     render_ready and /orgs/:slug/status.ready are both hardwired true under
//     the flat-arch decision. So the ONLY readiness signal is the write 409 —
//     which is why the wait lives in the plug retry loop, not a create-time poll.
//
// Run: node test/grid-provisioning.test.mjs

import { errorGuidance, runCreateGrid, runPlug } from "../src/tools.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// ── fetch mock (mirrors self-healing.test.mjs) ───────────────────────────────
function installFetch(replies) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const form = opts.body instanceof FormData ? opts.body : null;
    calls.push({ url: String(url), method: opts.method, headers: opts.headers || {}, form });
    const next = replies.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "content-type": "application/json", ...(next.headers || {}) },
    });
  };
  return calls;
}

function makeCtx({ token = "tok", edition = "local", activeGrid = null } = {}) {
  return {
    edition,
    // Tiny real budget/interval so the retry loop turns over in milliseconds:
    // real sleeps advance the wall clock the budget is measured against, so the
    // budget-expiry path fires deterministically after a handful of attempts.
    plugProvisionBudgetMs: 60,
    plugProvisionIntervalMs: 5,
    plugProvisionMaxMs: 12,
    state: { authChoiceOffered: true, lastAnonClaim: null, lastDrop: null, anonCookie: null },
    getToken: async () => token,
    getActiveGrid: async () => activeGrid,
    trustedServer: null,
  };
}

const ORG_PROVISIONING_BODY = {
  error: {
    code: "ORG_PROVISIONING",
    message: "This org is still finishing setup. Try again in a moment.",
    details: [{ field: "org", issue: "provisioning", hint: "Approximate remaining time: 20 seconds." }],
  },
};
const ORG_PROVISIONING_FAILED_BODY = {
  error: {
    code: "ORG_PROVISIONING",
    message: "This org is still finishing setup. Try again in a moment.",
    details: [{ field: "org", issue: "provisioning", hint: "Setup did not complete. Contact your CloudGrid admin to retry provisioning." }],
  },
};
const PLUG_SUCCESS_BODY = {
  entity_id: "e_1",
  slug: "my-app",
  grid: "my-grid",
  url: "https://my-grid.cloudgrid.io/my-app",
  status: "created",
  detection: { kind: "inspiration" },
};

const HTML = "<!doctype html><html><body>hi</body></html>";

await (async () => {
  // ── 1. errorGuidance maps 409 ORG_PROVISIONING to retry guidance, NOT the
  //       generic EDIT_REJECTED text a bare 409 used to get. ──────────────────
  const g = errorGuidance({ status: 409, code: "ORG_PROVISIONING", edition: "web", isEdit: false });
  check("errorGuidance(409 ORG_PROVISIONING) returns guidance", typeof g === "string" && g.length > 0);
  check("errorGuidance(409 ORG_PROVISIONING) is NOT the EDIT_REJECTED text", !/cannot be updated/i.test(g || ""));
  check("errorGuidance(409 ORG_PROVISIONING) says to retry grid_plug", /grid_plug/.test(g || "") && /wait|again|retry/i.test(g || ""));
  // A plain 409 (no code) still maps to EDIT_REJECTED — we did not break that.
  check("errorGuidance(409, no code) still EDIT_REJECTED", /cannot be updated/i.test(errorGuidance({ status: 409 }) || ""));

  // ── 2. create on a provisioning (202) grid: honest wait wording, and does
  //       NOT instruct an immediate re-call that would fail. ──────────────────
  installFetch([{ status: 202, body: { slug: "my-grid", name: "my-grid", status: "provisioning", poll_url: "/api/v2/orgs/my-grid/status" } }]);
  const created = await runCreateGrid(makeCtx(), { slug: "my-grid" });
  check("create(202) reports the grid was created", /created grid my-grid/i.test(created.text));
  check("create(202) sets structured.provisioning", created.structured?.provisioning === true);
  check("create(202) does NOT say 'Now re-call grid_plug with grid:'", !/now re-call grid_plug with grid:/i.test(created.text));
  check("create(202) sets the wait expectation (grid_plug waits for ready)", /wait|finish|setting up|provision/i.test(created.text) && /grid_plug|plug/i.test(created.text));

  // A synchronous-ready create (201, no provisioning block) keeps a plain
  // ready-to-plug message and no provisioning flag.
  installFetch([{ status: 201, body: { slug: "ready-grid", name: "ready-grid" } }]);
  const readyCreated = await runCreateGrid(makeCtx(), { slug: "ready-grid" });
  check("create(201 ready) has no provisioning flag", !readyCreated.structured?.provisioning);
  check("create(201 ready) points at grid_plug", /grid_plug|plug/i.test(readyCreated.text));

  // ── 3. plug on a provisioning grid: retries the 409, then succeeds. ────────
  const calls3 = installFetch([
    { status: 409, body: ORG_PROVISIONING_BODY },
    { status: 409, body: ORG_PROVISIONING_BODY },
    { status: 200, body: PLUG_SUCCESS_BODY },
  ]);
  const plugged = await runPlug(makeCtx(), { html: HTML, grid: "my-grid" });
  check("plug retries ORG_PROVISIONING then succeeds (3 POSTs)", calls3.filter((c) => /\/plug$/.test(c.url)).length === 3);
  check("plug returns the live URL after retrying", plugged.structured?.url === PLUG_SUCCESS_BODY.url);

  // ── 4. budget expiry: keeps 409ing → honest still-provisioning message,
  //       NOT the raw code and NOT EDIT_REJECTED. ─────────────────────────────
  const calls4 = installFetch(Array.from({ length: 50 }, () => ({ status: 409, body: ORG_PROVISIONING_BODY })));
  let expiryErr = null;
  try {
    await runPlug(makeCtx(), { html: HTML, grid: "my-grid" });
  } catch (e) {
    expiryErr = e;
  }
  check("plug budget-expiry throws", expiryErr instanceof Error);
  check("plug budget-expiry retried more than once", calls4.filter((c) => /\/plug$/.test(c.url)).length > 1);
  check("plug budget-expiry message is honest (still setting up / retry)", /still|provision|setting up|finish/i.test(expiryErr?.message || "") && /again|retry|wait/i.test(expiryErr?.message || ""));
  check("plug budget-expiry does NOT surface the raw code alone", !/^ORG_PROVISIONING$/.test(expiryErr?.message || ""));
  check("plug budget-expiry is NOT the EDIT_REJECTED text", !/cannot be updated/i.test(expiryErr?.message || ""));

  // ── 5. terminal 'failed' provisioning: does NOT retry, distinct message. ───
  const calls5 = installFetch(Array.from({ length: 50 }, () => ({ status: 409, body: ORG_PROVISIONING_FAILED_BODY })));
  let failedErr = null;
  try {
    await runPlug(makeCtx(), { html: HTML, grid: "my-grid" });
  } catch (e) {
    failedErr = e;
  }
  check("plug terminal-failed throws", failedErr instanceof Error);
  check("plug terminal-failed does NOT retry (exactly 1 POST)", calls5.filter((c) => /\/plug$/.test(c.url)).length === 1);
  check("plug terminal-failed message is distinct (did not finish / admin)", /did not (finish|complete)|recreat|admin/i.test(failedErr?.message || ""));
})();

// ── 6. BOTH provisioning codes are honoured (cloudgrid-io/cloudgrid#2673) ────
//
// The API is renaming ORG_PROVISIONING -> GRID_PROVISIONING as part of the
// org->grid retirement. mcp accepting both is what makes that rename safe to
// land without waiting for adoption: this package is published to npm, so
// installed copies keep matching whatever they shipped with.
//
// These assert the NEW name, which is the half that does not exist in
// production yet — the old name is covered by tests 1-5 above. If the new name
// is ever dropped, the API rename silently turns a retryable 409 into a hard
// plug failure against every brand-new grid.
{
  const gNew = errorGuidance({ status: 409, code: "GRID_PROVISIONING", edition: "web", isEdit: false });
  check("errorGuidance(409 GRID_PROVISIONING) returns guidance", typeof gNew === "string" && gNew.length > 0);
  check("errorGuidance(409 GRID_PROVISIONING) is NOT the EDIT_REJECTED text", !/cannot be updated/i.test(gNew || ""));
  check("errorGuidance(409 GRID_PROVISIONING) says to retry grid_plug", /grid_plug/.test(gNew || "") && /wait|again|retry/i.test(gNew || ""));

  const gOld = errorGuidance({ status: 409, code: "ORG_PROVISIONING", edition: "web", isEdit: false });
  check("both provisioning codes yield identical guidance", gNew === gOld);

  // The predicate must widen to the new NAME, not to every 409.
  const gEdit = errorGuidance({ status: 409, code: "EDIT_REJECTED", edition: "web", isEdit: true });
  check("a non-provisioning 409 is still EDIT_REJECTED", /cannot be updated/i.test(gEdit || ""));
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
