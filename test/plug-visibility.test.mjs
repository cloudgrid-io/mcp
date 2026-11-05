// Offline test: the grid_plug result states who can open the page (#473).
//
// Claims under test:
//   1. a create whose plug response carries no visibility reads it back from
//      the API once and names it in BOTH the text and structured content
//      (current_visibility), with the grid_visibility hint.
//   2. the read-back routes by kind: an inspiration reads GET
//      /api/v2/inspirations/:id, an app reads GET /api/v2/runtimes/:id/card.
//   3. the two stored axes win over the legacy enum.
//   4. an unreadable visibility is never guessed: no current_visibility, and
//      the text says it is not confirmed.
//   5. an update states the current visibility too, without re-asking.
//   6. the live-result card gets current_visibility and marks that pill.
//   7. the same result on the local edition.
//   8. visibilityKeyFromRead folds every stored form to one label key.
// Run: node test/plug-visibility.test.mjs

import { runPlug, visibilityKeyFromRead } from "../src/tools.js";
import { readResult, visibilityPills } from "../src/widgets/live-result/view.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

function makeCtx({ token = "jwt-v", edition = "web" } = {}) {
  return {
    edition,
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
    canOpenBrowser: false,
    getToken: async () => token,
    getActiveGrid: async () => "acme",
    saveToken: async () => ({}),
    savedLocationNote: () => "",
    trustedServer: null,
    deployPollBudgetMs: 20,
    deployPollIntervalMs: 5,
  };
}

// fetch mock: route by URL so the plug POST and the read-back GET each get
// their own reply.
let calls = [];
let routes = {};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push({ url: u, method: opts.method || "GET", headers: opts.headers || {} });
  const key = Object.keys(routes).find((k) => u.includes(k));
  const r = key ? routes[key] : { status: 404, body: { error: { code: "NOT_FOUND" } } };
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
};
const reset = (r) => { calls = []; routes = r; };
const gets = (frag) => calls.filter((c) => c.method === "GET" && c.url.includes(frag));

const PAGE = { entity_id: "ent-p", slug: "p", grid: "acme", url: "https://acme.cloudgrid.io/p", status: "live", detection: { kind: "inspiration" } };

try {
  // ── 1. create, private page, visibility read back ────────────────────────
  reset({
    "/api/v2/plug": { status: 201, body: PAGE },
    "/api/v2/inspirations/ent-p": { status: 200, body: { entity_id: "ent-p", visibility: "private", share_scope: "private", external_access: "none" } },
  });
  const c = await runPlug(makeCtx(), { html: "<h1>private page</h1>" });
  check("create → reads the visibility back from the inspiration read", gets("/api/v2/inspirations/ent-p").length === 1);
  check("create → read-back carries the caller's session", gets("/api/v2/inspirations/ent-p")[0]?.headers.Authorization === "Bearer jwt-v");
  check("create → structured current_visibility is private", c.structured.current_visibility === "private");
  check("create → text names it", c.text.includes("Who can open it: Private: only you can open it. grid_visibility changes who can open it."));
  check("create → still asks the user, still offers the options",
    /ASK the user who should be able to open this/.test(c.text) && c.structured.visibility_options?.length === 3);
  check("create → never claims anyone with the link can open it", !/Who can open it: Link/.test(c.text));

  // ── 6. the card gets it and marks that pill ─────────────────────────────
  const model = readResult({ content: [{ type: "text", text: c.text }], structuredContent: c.structured });
  const pressed = visibilityPills(model).filter((p) => p.pressed).map((p) => p.value);
  check("card → current_visibility reaches the view model", model.visibility === "private");
  check("card → exactly the Only you pill is marked", pressed.length === 1 && pressed[0] === "private");

  // ── 1b. the plug response's own visibility wins; no extra read ──────────
  reset({ "/api/v2/plug": { status: 201, body: { ...PAGE, visibility: "link" } } });
  const own = await runPlug(makeCtx(), { html: "<h1>link page</h1>" });
  check("response visibility → no read-back", gets("/api/v2/inspirations/").length === 0);
  check("response visibility → used as reported", own.structured.current_visibility === "link" && own.text.includes("Link: anyone with the link can open it."));

  // ── 2. app create reads the runtime card ─────────────────────────────────
  reset({
    "/api/v2/plug": { status: 202, body: { entity_id: "ent-a", slug: "a", grid: "acme", url: "https://a.acme.cloudgrid.io", status: "live", detection: { kind: "app" } } },
    "/api/v2/runtimes/ent-a/card": { status: 200, body: { visibility: "grid", share_scope: "grid", external_access: "none" } },
  });
  const a = await runPlug(makeCtx(), { artifact_files: [{ path: "index.html", content: "<h1>x</h1>" }], hints: { kind: "app" } });
  check("app create → reads the runtime card, not the inspiration read",
    gets("/api/v2/runtimes/ent-a/card").length === 1 && gets("/api/v2/inspirations/").length === 0);
  check("app create → grid named in text + structured",
    a.structured.current_visibility === "grid" && a.text.includes("Grid: everyone in your grid can open it."));

  // ── 3. the stored axes win over the legacy enum ──────────────────────────
  reset({
    "/api/v2/plug": { status: 201, body: PAGE },
    "/api/v2/inspirations/ent-p": { status: 200, body: { visibility: "grid", share_scope: "private", external_access: "none" } },
  });
  const ax = await runPlug(makeCtx(), { html: "<h1>axes</h1>" });
  check("axes disagree with the enum → the axes win", ax.structured.current_visibility === "private");

  // ── 4. unreadable → not confirmed, never guessed ─────────────────────────
  reset({
    "/api/v2/plug": { status: 201, body: PAGE },
    "/api/v2/inspirations/ent-p": { status: 500, body: {} },
  });
  const u = await runPlug(makeCtx(), { html: "<h1>unknown</h1>" });
  check("read fails → no current_visibility", u.structured.current_visibility === undefined);
  check("read fails → text says not confirmed and points to grid_visibility",
    u.text.includes("Who can open it: not confirmed.") && /Do not tell the user who can open it; grid_visibility sets it\./.test(u.text));
  check("read fails → the plug still succeeds", /Your app is live/.test(u.text));
  check("read fails → card marks no pill",
    visibilityPills(readResult({ content: [{ type: "text", text: u.text }], structuredContent: u.structured })).every((p) => !p.pressed));

  reset({
    "/api/v2/plug": { status: 201, body: PAGE },
    "/api/v2/inspirations/ent-p": { status: 200, body: { visibility: "something-new" } },
  });
  const odd = await runPlug(makeCtx(), { html: "<h1>odd</h1>" });
  check("unknown stored value → not confirmed, not passed through", odd.structured.current_visibility === undefined && odd.text.includes("not confirmed"));

  // ── 5. update states it, does not re-ask ─────────────────────────────────
  reset({
    "/api/v2/plug": { status: 202, body: { entity_id: "ent-p", slug: "p", grid: "acme", url: "https://acme.cloudgrid.io/p", status: "live" } },
    "/api/v2/inspirations/ent-p": { status: 200, body: { visibility: "private" } },
  });
  const e = await runPlug(makeCtx(), { html: "<h1>v2</h1>", target_entity_id: "ent-p" });
  check("update → names the current visibility", e.structured.current_visibility === "private" && e.text.includes("Who can open it: Private: only you can open it."));
  check("update → does not re-ask or offer options", !/ASK the user/.test(e.text) && e.structured.visibility_options === undefined);

  // ── 7. local edition, same code path ─────────────────────────────────────
  reset({
    "/api/v2/plug": { status: 201, body: PAGE },
    "/api/v2/inspirations/ent-p": { status: 200, body: { visibility: "private" } },
  });
  const l = await runPlug(makeCtx({ edition: "local" }), { html: "<h1>local</h1>" });
  check("local edition → same visibility line", l.structured.current_visibility === "private" && l.text.includes("Who can open it: Private: only you can open it."));

  // ── 8. folding table ─────────────────────────────────────────────────────
  const fold = [
    [{ visibility: "org" }, "grid"],
    [{ visibility: "grid" }, "grid"],
    [{ visibility: "private" }, "private"],
    [{ visibility: "link" }, "link"],
    [{ visibility: "link-anonymous" }, "link"],
    [{ visibility: "link", link_indexed: true }, "public"],
    [{ visibility: "link-indexed" }, "public"],
    [{ visibility: "public" }, "public"],
    [{ visibility: "authenticated" }, "authenticated"],
    [{ visibility: "space" }, "space"],
    [{ share_scope: "private", external_access: "link", require_signin: true }, "authenticated"],
    [{ share_scope: "private", external_access: "link" }, "link"],
    [{ share_scope: "grid", external_access: "public" }, "public"],
    [{ share_scope: "spaces", external_access: "none" }, "space"],
    [{ share_scope: "grid", external_access: "link" }, null],
    [{}, null],
    [null, null],
  ];
  for (const [input, want] of fold) {
    check(`fold ${JSON.stringify(input)} → ${want}`, visibilityKeyFromRead(input) === want);
  }
} finally {
  globalThis.fetch = realFetch;
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll plug-visibility checks passed (offline).");
