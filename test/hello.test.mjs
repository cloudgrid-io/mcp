// grid_hello — the ask-then-plug contract.
//
// Drives the REAL registered handler with a faked network, so nothing is ever
// deployed. The assertions that matter are the NEGATIVE ones: on the ask path
// and the signed-out path, no plug call may be made. A test that only checks
// the returned text passes even if the tool deployed something first.
import { registerTools } from "../src/tools/register.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "ok  " : "FAIL"} ${label}`); if (!cond) failures++; };

const realFetch = globalThis.fetch;
let calls = [];
function installFetch(replies) {
  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const form = opts.body instanceof FormData ? opts.body : null;
    calls.push({ url: String(url), method: opts.method || "GET", headers: opts.headers || {}, form });
    const next = replies.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status, headers: { "content-type": "application/json" },
    });
  };
}
const restoreFetch = () => { globalThis.fetch = realFetch; };
const plugPost = () => calls.find((c) => c.url.endsWith("/api/v2/plug") && c.method === "POST");
const gridsReply = (slugs) => ({
  status: 200,
  body: { grids: slugs.map((s) => ({ slug: s, name: s, role: "admin", render_ready: true })) },
});
const plugReplies = [
  { status: 200, body: { entity_id: "ent-h", slug: "hello-a1b2", grid: "g", kind: "inspiration" } },
  { status: 202, body: { entity_id: "ent-h", slug: "hello-a1b2", grid: "g", url: "https://g.cloudgrid.io/hello-a1b2", status: "live" } },
];

function makeCtx({ token = "jwt", edition = "local", activeGrid = null } = {}) {
  return {
    edition,
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
    canOpenBrowser: false,
    getToken: async () => token,
    getActiveGrid: async () => activeGrid,
    saveToken: async () => ({}),
    savedLocationNote: () => "",
    trustedServer: null,
    deployPollBudgetMs: 20,
    deployPollIntervalMs: 5,
  };
}
function handlerFor(ctx) {
  let handler = null;
  registerTools({
    registerTool: (name, _cfg, h) => { if (name === "grid_hello") handler = h; },
    tool: () => {}, registerResource: () => {},
  }, ctx);
  return handler;
}
const parse = (r) => r?.structuredContent ?? {};
const textOf = (r) => r?.content?.[0]?.text ?? "";

try {
  // ── 0. registered on BOTH editions (it sits above the CLI cut) ────────────
  for (const edition of ["local", "web"]) {
    check(`registered(${edition}): grid_hello exists`, typeof handlerFor(makeCtx({ edition })) === "function");
  }

  // ── 1. signed out → needs_auth, and NOTHING deployed ─────────────────────
  {
    installFetch([]);
    const res = await handlerFor(makeCtx({ token: null }))({});
    restoreFetch();
    check("signed out: returns needs_auth", parse(res).needs_auth === true);
    check("signed out: did NOT deploy", !plugPost());
    // The reply must offer only what grid_hello can do. The shared
    // AUTH_ASK_SIGNED_OUT promises a guest path via grid_plug + anon:true —
    // this tool has no `anon` param, so offering it strands the model.
    check("signed out: does NOT promise a guest/anon path", !/anon|guest/i.test(textOf(res)));
    check("signed out: does NOT redirect to grid_plug", !/grid_plug/.test(textOf(res)));
    check("signed out: names grid_login and re-calling grid_hello",
      /grid_login/.test(textOf(res)) && /grid_hello/.test(textOf(res)));
  }

  // ── 2. multi-grid, no grid → ASK, and NOTHING deployed ───────────────────
  for (const edition of ["local", "web"]) {
    installFetch([gridsReply(["michal-tests", "coolapps", "atomic"])]);
    const res = await handlerFor(makeCtx({ edition, activeGrid: "coolapps" }))({});
    restoreFetch();
    check(`ask(${edition}): returns needs_grid`, parse(res).needs_grid === true);
    check(`ask(${edition}): did NOT deploy`, !plugPost());
    check(`ask(${edition}): lists the grids to choose from`, /michal-tests/.test(textOf(res)) && /atomic/.test(textOf(res)));
  }

  // ── 3. explicit grid → plugs into THAT grid, not the active one ──────────
  {
    installFetch([gridsReply(["michal-tests", "coolapps"]), ...plugReplies.map((r) => ({ ...r }))]);
    const res = await handlerFor(makeCtx({ activeGrid: "coolapps" }))({ grid: "michal-tests" });
    restoreFetch();
    const hdr = plugPost()?.headers?.["X-CloudGrid-Grid"];
    check("explicit: deployed", Boolean(plugPost()));
    check("explicit: used michal-tests, NOT the active coolapps", hdr === "michal-tests");
    check("explicit: did not re-ask", parse(res).needs_grid !== true);
  }

  // ── 4. exactly one grid → plugs WITHOUT asking ───────────────────────────
  {
    installFetch([gridsReply(["michal-tests"]), ...plugReplies.map((r) => ({ ...r }))]);
    const res = await handlerFor(makeCtx({}))({});
    restoreFetch();
    check("single grid: did NOT ask", parse(res).needs_grid !== true);
    check("single grid: deployed into it", plugPost()?.headers?.["X-CloudGrid-Grid"] === "michal-tests");
  }

  // ── 5. the name is escaped — this page is published at a public URL ──────
  {
    installFetch([gridsReply(["michal-tests"]), ...plugReplies.map((r) => ({ ...r }))]);
    await handlerFor(makeCtx({}))({ name: '</title><script>alert(1)</script>' });
    restoreFetch();
    const sent = plugPost()?.form?.get("artifact");
    const body = typeof sent === "string" ? sent : (sent ? await sent.text() : "");
    check("escaping: no raw <script> reached the page", !/<script>alert/.test(body));
    check("escaping: the payload was escaped", /&lt;script&gt;/.test(body));
  }
} finally {
  restoreFetch();
}

console.log(failures === 0 ? "\nAll grid_hello checks passed (offline)." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
