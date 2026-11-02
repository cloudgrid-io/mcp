// Offline unit test for the live-result MCP App (cloudgrid-io/mcp#434).
//
// Claims under test:
//   1. web: grid_plug and grid_hello bind the card with the MCP Apps key
//      (`_meta.ui.resourceUri`) AND ChatGPT's alias (`openai/outputTemplate`);
//      the local edition binds nothing and registers no card resource.
//   2. the card resource is RESOURCE_MIME_TYPE, self-contained, and speaks the
//      standard bridge.
//   3. CSP: deny-by-default, stated explicitly. With MCP_PREVIEW_ORIGIN set to
//      a bare https origin, frameDomains is exactly that origin and nothing
//      else opens; any malformed value leaves the CSP closed.
//   4. the preview URL rides in the result `_meta`, never in the text or the
//      structured output, and only when configured.
//   5. text fallback: a plug result's content[0] text carries the live URL, and
//      it is byte-identical with the preview on or off.
//   6. the card's pure view logic (src/widgets/live-result/view.js).
// Blind spot: this does not render the card. The render is checked separately
// in a browser harness against the built HTML.
// Run: node test/live-result-app.test.mjs

import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { registerTools } from "../src/tools/register.js";
import { liveResultResourceMeta, withPreviewMeta } from "../src/tools/register.js";
import {
  readResult,
  headline,
  showPreview,
  updateMessage,
  visibilityArgs,
  checkDeployArgs,
  applyCheckDeploy,
  PREVIEW_META_KEY as VIEW_META_KEY,
} from "../src/widgets/live-result/view.js";
import { PREVIEW_META_KEY } from "../src/tools/constants.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "ok  " : "FAIL"} ${label}`); if (!cond) failures++; };

const URI = "ui://cloudgrid/live-result.html";
const ORIGIN = "https://preview.example.com";
const setOrigin = (v) => { if (v == null) delete process.env.MCP_PREVIEW_ORIGIN; else process.env.MCP_PREVIEW_ORIGIN = v; };

function inspect(edition, ctxExtra = {}) {
  const configs = {};
  const handlers = {};
  const resources = {};
  registerTools({
    registerTool(name, config, handler) { configs[name] = config; handlers[name] = handler; },
    tool() {},
    registerResource(name, uri, metadata, read) { resources[uri] = { name, metadata, read }; },
  }, {
    edition,
    canOpenBrowser: false,
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
    getToken: async () => "jwt",
    getActiveGrid: async () => null,
    saveToken: async () => ({}),
    savedLocationNote: () => "",
    trustedServer: null,
    deployPollBudgetMs: 20,
    deployPollIntervalMs: 5,
    ...ctxExtra,
  });
  return { configs, handlers, resources };
}

setOrigin(null);

// ── 1. bindings ──────────────────────────────────────────────────────────────
const web = inspect("web");
for (const tool of ["grid_plug", "grid_hello"]) {
  const m = web.configs[tool]?._meta ?? {};
  check(`web: ${tool} binds _meta.ui.resourceUri`, m.ui?.resourceUri === URI);
  check(`web: ${tool} binds openai/outputTemplate (ChatGPT alias)`, m["openai/outputTemplate"] === URI);
}
for (const tool of ["grid_visibility", "grid_check_deploy"]) {
  check(`web: ${tool} is callable from the card (openai/widgetAccessible)`,
    web.configs[tool]?._meta?.["openai/widgetAccessible"] === true);
}
const local = inspect("local");
for (const tool of ["grid_plug", "grid_hello"]) {
  check(`local: ${tool} binds no card`, local.configs[tool]?._meta == null);
}
check("local: no card resource registered", !local.resources[URI]);

// ── 2. resource ──────────────────────────────────────────────────────────────
const res = web.resources[URI];
check("web: card resource registered", !!res);
check("web: card resource mimeType is RESOURCE_MIME_TYPE", res?.metadata?.mimeType === RESOURCE_MIME_TYPE);
const item = (await res.read(new URL(URI)))?.contents?.[0];
const html = item?.text ?? "";
check("web: served content mimeType is RESOURCE_MIME_TYPE", item?.mimeType === RESOURCE_MIME_TYPE);
check("web: HTML is self-contained (no remote script, stylesheet, or src)",
  !/<script[^>]+src=/i.test(html) && !/<link[^>]+href=/i.test(html) && !/src=["']https?:/i.test(html));
check("web: HTML speaks the MCP Apps bridge", html.includes("ui/notifications/tool-result") && html.includes("ui/open-link"));
check("web: HTML carries the card actions", ["Open", "Copy link", "Update", "Who can open it"].every((t) => html.includes(t)));

// ── 3. CSP ───────────────────────────────────────────────────────────────────
{
  const csp = item?._meta?.ui?.csp;
  check("CSP default: declared explicitly", !!csp);
  check("CSP default: no connect, resource, or frame origin",
    csp?.connectDomains?.length === 0 && csp?.resourceDomains?.length === 0 && csp?.frameDomains?.length === 0);
  check("resource requests clipboardWrite for Copy link", !!item?._meta?.ui?.permissions?.clipboardWrite);

  setOrigin(ORIGIN);
  const on = (await res.read(new URL(URI)))?.contents?.[0]?._meta?.ui?.csp;
  check("CSP with preview origin: frameDomains is exactly that origin", JSON.stringify(on?.frameDomains) === JSON.stringify([ORIGIN]));
  check("CSP with preview origin: connect and resource stay closed", on?.connectDomains?.length === 0 && on?.resourceDomains?.length === 0);
  setOrigin(`${ORIGIN}/`);
  check("CSP: a trailing slash normalises to the bare origin",
    JSON.stringify(liveResultResourceMeta().ui.csp.frameDomains) === JSON.stringify([ORIGIN]));

  for (const bad of ["http://preview.example.com", "https://preview.example.com/app", "https://u:p@preview.example.com",
    "https://preview.example.com?x=1", "preview.example.com", "*", "https://*.example.com"]) {
    setOrigin(bad);
    check(`CSP: malformed origin ${JSON.stringify(bad)} leaves frames closed`, liveResultResourceMeta().ui.csp.frameDomains.length === 0);
  }
  setOrigin(null);
}

// ── 4. preview URL in result _meta ───────────────────────────────────────────
{
  const base = { text: "Your app is live: https://g.example/x", structured: { entity_id: "ent-1", url: "https://g.example/x" } };
  check("meta: off by default", withPreviewMeta({ edition: "web" }, base).meta == null);
  setOrigin(ORIGIN);
  const on = withPreviewMeta({ edition: "web" }, base);
  check("meta: on → <origin>/<entity_id> under the preview key", on.meta?.[PREVIEW_META_KEY] === `${ORIGIN}/ent-1`);
  check("meta: server and card agree on the key", PREVIEW_META_KEY === VIEW_META_KEY);
  check("meta: text and structured untouched", on.text === base.text && on.structured === base.structured);
  check("meta: local edition never adds it", withPreviewMeta({ edition: "local" }, base).meta == null);
  check("meta: no entity → none", withPreviewMeta({ edition: "web" }, { text: "x", structured: { needs_auth: true } }).meta == null);
  check("meta: odd entity id → none",
    withPreviewMeta({ edition: "web" }, { text: "x", structured: { entity_id: "../../evil" } }).meta == null);
  setOrigin(null);
}

// ── 5. text fallback, driving the real grid_hello handler on web ──────────────
{
  const realFetch = globalThis.fetch;
  const run = async () => {
    const replies = [
      { status: 200, body: { grids: [{ slug: "g", name: "g", role: "admin", render_ready: true }] } },
      { status: 200, body: { entity_id: "ent-h", slug: "hello-a1b2", grid: "g", kind: "inspiration" } },
      { status: 202, body: { entity_id: "ent-h", slug: "hello-a1b2", grid: "g", url: "https://g.cloudgrid.io/hello-a1b2", status: "live" } },
    ];
    globalThis.fetch = async () => {
      const next = replies.shift() ?? { status: 200, body: {} };
      return new Response(JSON.stringify(next.body), { status: next.status, headers: { "content-type": "application/json" } });
    };
    try {
      return await inspect("web").handlers["grid_hello"]({ grid: "g" });
    } finally {
      globalThis.fetch = realFetch;
    }
  };
  setOrigin(null);
  const off = await run();
  setOrigin(ORIGIN);
  const on = await run();
  setOrigin(null);
  const url = off?.structuredContent?.url;
  check("fallback: plug result has a URL", typeof url === "string" && url.startsWith("https://"));
  check("fallback: content[0] is text carrying the URL", off?.content?.[0]?.type === "text" && off.content[0].text.includes(url));
  check("fallback: no preview → no result _meta", off?._meta == null);
  check("fallback: preview on → result _meta carries the preview URL", on?._meta?.[PREVIEW_META_KEY] === `${ORIGIN}/ent-h`);
  check("fallback: text identical with preview on or off", on?.content?.[0]?.text === off?.content?.[0]?.text);
  check("fallback: preview URL never in the text or structured output",
    ![on?.content, on?.structuredContent].some((v) => JSON.stringify(v).split(/[\s"]+/).some((tok) => tok === on?._meta?.[PREVIEW_META_KEY])));
}

// ── 6. card view logic ───────────────────────────────────────────────────────
{
  const live = {
    content: [{ type: "text", text: "Your app is live: https://g.example/x" }],
    structuredContent: {
      entity_id: "ent-1", grid: "g", url: "https://g.example/x", status: "created",
      current_visibility: "private",
      visibility_options: [{ value: "private", label: "Only you" }, { value: "link", label: "Anyone with the link" }],
    },
    _meta: { [VIEW_META_KEY]: `${ORIGIN}/ent-1` },
  };
  const m = readResult(live);
  check("view: live result → model with url, entity, grid", m?.url === "https://g.example/x" && m.entityId === "ent-1" && m.grid === "g");
  check("view: live result → headline Live", headline(m) === "Live");
  check("view: live result with preview URL → preview shown", showPreview(m) === true);
  check("view: visibility options carried", m.visibilityOptions.length === 2 && m.visibility === "private");
  check("view: no preview meta → no preview", showPreview(readResult({ ...live, _meta: undefined })) === false);
  check("view: http preview URL is never framed",
    showPreview(readResult({ ...live, _meta: { [VIEW_META_KEY]: "http://preview.example.com/ent-1" } })) === false);

  for (const flag of ["needs_auth", "needs_grid", "needs_grid_create", "needs_confirmation"]) {
    check(`view: ${flag} → no card`, readResult({ content: [{ type: "text", text: "see https://x.example" }], structuredContent: { [flag]: true } }) === null);
  }
  check("view: error result → no card", readResult({ isError: true, content: [{ type: "text", text: "https://x.example" }] }) === null);
  check("view: URL read from text when structured has none",
    readResult({ content: [{ type: "text", text: "Live: https://g.example/y\nmore" }], structuredContent: {} })?.url === "https://g.example/y");

  const building = readResult({ ...live, structuredContent: { ...live.structuredContent, status: "building", poll_url: "https://api.example/p/1" } });
  check("view: building → headline Building", headline(building) === "Building");
  check("view: building → no preview yet", showPreview(building) === false);
  check("view: check-deploy args carry poll_url and grid",
    JSON.stringify(checkDeployArgs(building)) === JSON.stringify({ poll_url: "https://api.example/p/1", grid: "g" }));
  const done = applyCheckDeploy(building, { structuredContent: { status: "success", live: true, url: "https://g.example/x" } });
  check("view: check-deploy success → live, preview shown", done.model.status === "live" && showPreview(done.model) === true);
  check("view: check-deploy still building → stays building",
    applyCheckDeploy(building, { structuredContent: { status: "building", live: false } }).model.status === "building");
  check("view: check-deploy failed → says so", /failed/.test(applyCheckDeploy(building, { structuredContent: { status: "failed", live: false, error: "x" } }).note));

  check("view: updated status → headline Updated",
    headline(readResult({ ...live, structuredContent: { ...live.structuredContent, status: "updated" } })) === "Updated");

  const msg = updateMessage(m, "make the header blue");
  check("view: update message names the URL, the change, and target_entity_id",
    msg.startsWith("Update my app at https://g.example/x: make the header blue.") && msg.endsWith("target_entity_id ent-1."));
  check("view: update request ends as a sentence before the re-plug instruction", msg.includes("make the header blue. Re-plug"));
  check("view: empty update asks what to change", /Ask me what to change/.test(updateMessage(m, "  ")));
  check("view: visibility args scoped to this entity",
    JSON.stringify(visibilityArgs(m, "link")) === JSON.stringify({ visibility: "link", entity_id: "ent-1", grid: "g" }));
}

console.log(failures ? `\n${failures} FAIL` : "\nAll live-result MCP App checks passed.");
process.exit(failures ? 1 : 0);
