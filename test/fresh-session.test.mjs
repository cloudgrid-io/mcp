// Offline unit test for #489: tools that act on "the app plugged earlier"
// must work from a fresh MCP session. ChatGPT opens a new session for every
// tool call, so ctx.state.lastDrop is always empty there.
//
// grid_visibility, driven through the REAL registered handler with a mocked
// fetch:
//   1. entity_id with no lastDrop → PATCHes that entity's visibility.
//   2. the app url with no lastDrop → resolved to its entity, then PATCHed.
//   3. neither, no lastDrop → an error that names entity_id and the url, says
//      why, and what to do without them (never a dead end).
//   4. an entity_id for another app never borrows the session drop's kind.
// (grid_check_deploy and grid_get_app_source: test/check-deploy.test.mjs and
// test/source-fetch.test.mjs.)
//
// Run: node test/fresh-session.test.mjs

import { registerTools } from "../src/tools/register.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "ok  " : "FAIL"} ${label}`); if (!cond) failures++; };

function tools(lastDrop = null) {
  const handlers = {};
  registerTools({
    registerTool(name, _config, handler) { handlers[name] = handler; },
    tool() {},
    registerResource() {},
  }, {
    edition: "web",
    canOpenBrowser: false,
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop, anonCookie: null },
    getToken: async () => "jwt",
    getActiveGrid: async () => "acme",
    saveToken: async () => ({}),
    savedLocationNote: () => "",
    trustedServer: null,
  });
  return handlers;
}

let calls = [];
let pickupBody = null;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push({ url: u, method: opts.method ?? "GET", body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers || {} });
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (/\/api\/v2\/entities\/[^/]+\/pickup$/.test(u)) return pickupBody ? json(200, pickupBody) : json(404, { error: { code: "NOT_FOUND" } });
  if (/\/visibility$/.test(u) && opts.method === "PATCH") return json(200, { visibility: "grid", url: "https://acme.cloudgrid.io/page" });
  return json(404, {});
};
const reset = () => { calls = []; pickupBody = null; };
const patches = () => calls.filter((c) => c.method === "PATCH");
const text = (r) => r?.content?.find((c) => c.type === "text")?.text ?? "";

// 1. entity_id, no lastDrop
reset();
const byId = await tools()["grid_visibility"]({ visibility: "grid", entity_id: "e-page" });
check("entity_id, fresh session: not an error", !byId.isError);
check("entity_id, fresh session: PATCHes that entity's visibility",
  patches().length === 1 && patches()[0].url.includes("/entities/e-page/visibility") && patches()[0].body?.visibility === "grid");

// 2. url only, no lastDrop
reset();
pickupBody = { entity_id: "e-url", slug: "page", grid: "team", kind: "inspiration" };
const byUrl = await tools()["grid_visibility"]({ visibility: "grid", url: "https://team.cloudgrid.io/page" });
check("url, fresh session: not an error", !byUrl.isError);
check("url, fresh session: resolves the slug through the pickup contract",
  calls.some((c) => c.method === "POST" && c.url.endsWith("/entities/page/pickup")));
check("url, fresh session: PATCHes the resolved entity on its own surface, in its grid",
  patches().length === 1 && patches()[0].url.includes("/inspirations/e-url/visibility") && patches()[0].headers["X-CloudGrid-Grid"] === "team");

// 3. nothing to go on
reset();
const none = await tools()["grid_visibility"]({ visibility: "grid" });
check("no id, no url, fresh session: an error", none.isError === true);
check("no id, no url: names entity_id and the app url",
  /Pass entity_id \(from the earlier grid_plug result\) or the app's url to grid_visibility/.test(text(none)));
check("no id, no url: says why and what to do without them",
  /new session for every tool call/.test(text(none)) && /ask the user for the app's link/.test(text(none)));
check("no id, no url: no request sent", calls.length === 0);

// 4. a different entity never borrows the session drop's kind
reset();
await tools({ entity_id: "e-old", kind: "inspiration", grid: "acme" })["grid_visibility"]({ visibility: "grid", entity_id: "e-other" });
check("another entity_id: routes by its own kind (runtime first), not the session drop's",
  patches()[0]?.url.includes("/entities/e-other/visibility"));

// The session drop still serves a same-session caller (Claude keeps sessions).
reset();
await tools({ entity_id: "e-old", kind: "inspiration", grid: "acme" })["grid_visibility"]({ visibility: "grid" });
check("no args, session drop present: still uses it",
  patches().length === 1 && patches()[0].url.includes("/inspirations/e-old/visibility"));

console.log(failures ? `\n${failures} FAIL` : "\nAll fresh-session checks passed.");
process.exit(failures ? 1 : 0);
