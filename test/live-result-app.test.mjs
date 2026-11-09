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

import { readFileSync } from "node:fs";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { registerTools } from "../src/tools/register.js";
import { liveResultResourceMeta, withPreviewMeta } from "../src/tools/register.js";
import {
  readResult,
  headline,
  showPreview,
  updateMessage,
  visibilityArgs,
  visibilityPills,
  visibilityNote,
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
  // #473: the card marks the current choice from current_visibility, and only that one.
  const pills = visibilityPills(m);
  check("view: current visibility pill is marked pressed",
    pills.length === 2 && pills.find((p) => p.value === "private")?.pressed === true && pills.find((p) => p.value === "link")?.pressed === false);
  const unconfirmed = readResult({ ...live, structuredContent: { ...live.structuredContent, current_visibility: undefined } });
  check("view: no current_visibility → no pill marked", visibilityPills(unconfirmed).every((p) => p.pressed === false));
  // #482: the card always shows the current setting, and says so in words.
  check("view: current setting named under the pills", visibilityNote(m) === "Now: Only you.");
  check("view: unconfirmed → says not confirmed", visibilityNote(unconfirmed) === "Current setting not confirmed. Pick one to set it.");
  const withCurrent = (v) => readResult({ ...live, structuredContent: { ...live.structuredContent, current_visibility: v } });
  const legacy = visibilityPills(withCurrent("org"));
  const three = { ...live, structuredContent: { ...live.structuredContent, visibility_options: [
    { value: "private", label: "Only you" }, { value: "grid", label: "Everyone in your grid" }, { value: "link", label: "Anyone with the link" }] } };
  const legacyThree = visibilityPills(readResult({ ...three, structuredContent: { ...three.structuredContent, current_visibility: "org" } }));
  check("view: legacy org marks the grid pill", legacy.every((p) => p.value !== "org") && legacyThree.filter((p) => p.pressed).map((p) => p.value).join() === "grid");
  for (const [v, label] of [["public", "Anyone, findable by search"], ["authenticated", "Anyone with the link, sign-in required"], ["space", "Selected spaces"]]) {
    const ps = visibilityPills(withCurrent(v));
    const pressed = ps.filter((p) => p.pressed);
    check(`view: current ${v} (not an offered choice) → its own pill, the only one pressed`,
      ps.length === 3 && pressed.length === 1 && pressed[0].value === v && pressed[0].label === label);
    check(`view: current ${v} → named under the pills`, visibilityNote(withCurrent(v)) === `Now: ${label}.`);
  }
  check("view: an unknown current value → no extra pill, none pressed",
    visibilityPills(withCurrent("something-new")).length === 2 && visibilityPills(withCurrent("something-new")).every((p) => !p.pressed));
  // The built card wires the selection into the DOM: aria-pressed, a selected
  // class, a check mark, and the "Now:" line.
  const cardJs = readFileSync(new URL("../src/widgets/live-result/mcp-app.js", import.meta.url), "utf8");
  const cardCss = readFileSync(new URL("../src/widgets/live-result/mcp-app.css", import.meta.url), "utf8");
  const cardHtml = readFileSync(new URL("../src/widgets/live-result/mcp-app.html", import.meta.url), "utf8");
  check("card: pressed pill gets aria-pressed, the selected class, and a check mark",
    /setAttribute\("aria-pressed", String\(opt\.pressed\)\)/.test(cardJs) && /opt\.pressed \? "pill selected"/.test(cardJs) && /\\u2713/.test(cardJs));
  check("card: the Now line is rendered from visibilityNote", /visibilityNow\.textContent = visibilityNote\(model\)/.test(cardJs) && /id="visibility-now"/.test(cardHtml));
  check("card: the pressed pill has its own style", /\.pill\[aria-pressed="true"\][^}]*border-color/.test(cardCss));
  // #490: the card is styled only with the library's semantic tokens, and the
  // built card carries those tokens from @cloudgrid-io/ui for light and dark.
  const cssNoComments = cardCss.replace(/\/\*[\s\S]*?\*\//g, "");
  check("card CSS: no literal colours, only --cg-* tokens (#490)",
    !/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|light-dark\(/i.test(cssNoComments) && /var\(--cg-tertiary\)/.test(cssNoComments));
  const uiTokens = JSON.parse(readFileSync(new URL("../node_modules/@cloudgrid-io/ui/dist/tokens.json", import.meta.url), "utf8"));
  check("built card: light tokens come from the library's default scope",
    html.includes(`--cg-tertiary: ${uiTokens.scopes.default["--cg-tertiary"]};`) && html.includes(`--cg-surface-card: ${uiTokens.scopes.default["--cg-surface-card"]};`));
  check("built card: dark tokens come from the library's ink scope",
    /:root\[data-theme="dark"\] \{[^}]*--cg-text-primary: #ffffff;/.test(html) && html.includes(`--cg-text-primary: ${uiTokens.scopes.ink["--cg-text-primary"]};`));
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
  check("view: building → headline Plugging (#490)", headline(building) === "Plugging");
  check("view: building → no preview yet", showPreview(building) === false);
  check("view: check-deploy args carry entity_id, poll_url and grid",
    JSON.stringify(checkDeployArgs(building)) === JSON.stringify({ entity_id: "ent-1", poll_url: "https://api.example/p/1", grid: "g" }));
  // #489: the hosted inline create returns poll_url null, and ChatGPT opens a
  // new session per call, so the card must name the app itself.
  const noPoll = readResult({ ...live, structuredContent: { ...live.structuredContent, status: "building", poll_url: null } });
  check("view: no pollUrl → check-deploy sends entity_id and grid (#489)",
    JSON.stringify(checkDeployArgs(noPoll)) === JSON.stringify({ entity_id: "ent-1", grid: "g" }));
  const noId = readResult({ ...live, structuredContent: { url: "https://g1--g.cloudgrid.io", status: "building", grid: "g" } });
  check("view: no entity_id either → check-deploy sends the app url (#489)",
    JSON.stringify(checkDeployArgs(noId)) === JSON.stringify({ url: "https://g1--g.cloudgrid.io", grid: "g" }));
  check("view: still building → says plugging, not building (#490)",
    applyCheckDeploy(building, { structuredContent: { status: "building", live: false } }).note === "Still plugging. Check again in a few seconds.");
  check("card: no Building or Not live yet copy left in the card (#490)",
    !/Building|Not live yet|the build/.test(readFileSync(new URL("../src/widgets/live-result/mcp-app.js", import.meta.url), "utf8") +
      readFileSync(new URL("../src/widgets/live-result/mcp-app.html", import.meta.url), "utf8")));
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
  check("view: visibility args with no entity_id name the app url (#489)",
    JSON.stringify(visibilityArgs(noId, "grid")) === JSON.stringify({ visibility: "grid", url: "https://g1--g.cloudgrid.io", grid: "g" }));
}

console.log(failures ? `\n${failures} FAIL` : "\nAll live-result MCP App checks passed.");
process.exit(failures ? 1 : 0);
