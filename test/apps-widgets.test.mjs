// Offline unit test for the Apps-SDK widget gate (0.16.1).
//
// The ChatGPT Apps-SDK UI widgets (openai/outputTemplate → a ui:// html
// resource) render as a broken black frame in ChatGPT, hiding the plain-text
// result. They are gated behind MCP_APPS_WIDGETS (DEFAULT OFF), so:
//   1. default (flag off) → grid_plug carries NO openai/outputTemplate (the
//      text-first result with the live URL is what renders — no black square).
//   2. the widget RESOURCES stay registered either way (harmless; ready for
//      re-enable once the widget HTML is fixed).
//   3. MCP_APPS_WIDGETS=1 → grid_plug DOES carry the outputTemplate (re-enabled).
// Run: node test/apps-widgets.test.mjs

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { registerTools } from "../src/tools.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const TOOLS_URL = new URL("../src/tools.js", import.meta.url).href;
const LIVE_RESULT_URI = "ui://cloudgrid/live-result.html";
const GRID_PICKER_URI = "ui://cloudgrid/org-picker.html";
// #308: the ChatGPT Apps-SDK renderer requires this exact resource mimeType
// (verified against OpenAI's shipped example servers). It is NOT the MCP-Apps /
// Claude MIME `text/html;profile=mcp-app` — the mismatch was the black frame.
const SKYBRIDGE_MIME = "text/html+skybridge";
const CLAUDE_MIME = "text/html;profile=mcp-app";

// Fake server capturing tool CONFIGS + full resource registrations (config
// mimeType AND the read-callback contents), so the test observes the actual
// wire shape, not just that a resource exists.
function inspect(ctxEdition = "web") {
  const configs = {};
  const resources = [];
  const capture = (uri, config, reader) => resources.push({ uri, config, reader });
  const server = {
    registerTool(name, config) { configs[name] = config; },
    tool() {},
    registerResource(_name, uri, config, reader) { capture(uri, config, reader); },
  };
  const ctx = { edition: ctxEdition, state: { lastDrop: null }, getToken: async () => null,
    getActiveGrid: async () => null };
  registerTools(server, ctx);
  return { configs, resources };
}
const resByUri = (resources, uri) => resources.find((r) => r.uri === uri);

// 1 + 2: default (flag unset in this process) → no outputTemplate, resources still registered.
const { configs, resources } = inspect("web");
const plugTpl = configs["grid_plug"]?._meta?.["openai/outputTemplate"];
check("default: grid_plug has NO openai/outputTemplate (text-first, no black square)", plugTpl == null);
check("default: live-result widget resource is still registered", !!resByUri(resources, LIVE_RESULT_URI));

// #308 contract: BOTH ChatGPT widgets declare the skybridge MIME at registration
// AND in their served contents — this is what fixes the black frame.
for (const uri of [LIVE_RESULT_URI, GRID_PICKER_URI]) {
  const r = resByUri(resources, uri);
  check(`#308: ${uri} config mimeType is ${SKYBRIDGE_MIME}`, r?.config?.mimeType === SKYBRIDGE_MIME);
  const contents = (await r?.reader?.())?.contents?.[0];
  check(`#308: ${uri} served content mimeType is ${SKYBRIDGE_MIME}`, contents?.mimeType === SKYBRIDGE_MIME);
  check(`#308: ${uri} does NOT serve the Claude MIME (independence)`, contents?.mimeType !== CLAUDE_MIME);
}

// #308: grid_visibility is marked widgetAccessible so the widget's callTool works.
check("#308: grid_visibility carries openai/widgetAccessible", configs["grid_visibility"]?._meta?.["openai/widgetAccessible"] === true);

// 3: child process with the flag ON → outputTemplate present (widget re-enabled).
const child = `
import { registerTools } from ${JSON.stringify(TOOLS_URL)};
const configs = {};
registerTools({ registerTool:(n,c)=>{configs[n]=c;}, tool(){}, registerResource(){} },
  { edition:"web", state:{ lastDrop:null }, getToken:async()=>null, getActiveGrid:async()=>null });
const m = configs["grid_plug"]?._meta ?? {};
process.stdout.write(JSON.stringify({ tpl: m["openai/outputTemplate"] ?? null, ui: m.ui ?? null }));
`;
const out = execFileSync(process.execPath, ["--input-type=module", "-e", child],
  { env: { ...process.env, MCP_APPS_WIDGETS: "1" }, encoding: "utf-8" }).trim();
const flagOn = JSON.parse(out);
check("MCP_APPS_WIDGETS=1: grid_plug outputTemplate is restored", flagOn.tpl === LIVE_RESULT_URI);
// #308/#303 independence: even with the flag ON, grid_plug must NOT carry the
// Claude `ui.resourceUri` key — the live-result resource is skybridge-typed and
// Claude cannot render it; carrying it would regress the Claude path.
check("MCP_APPS_WIDGETS=1: grid_plug carries NO Claude ui.resourceUri (independence)", flagOn.ui == null);

console.log(failures ? `\n${failures} FAIL` : "\nAll apps-widgets gate checks passed.");
process.exit(failures ? 1 : 0);
