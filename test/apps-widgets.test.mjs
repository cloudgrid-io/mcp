// Offline unit test for the Apps-SDK widget gate (0.16.1).
//
// The ChatGPT Apps-SDK UI widgets (openai/outputTemplate → a ui:// html
// resource) render as a broken black frame in ChatGPT, hiding the plain-text
// result. They are gated behind MCP_APPS_WIDGETS (DEFAULT OFF), so:
//   1. default (flag off) → gridctl_drop carries NO openai/outputTemplate (the
//      text-first result with the live URL is what renders — no black square).
//   2. the widget RESOURCES stay registered either way (harmless; ready for
//      re-enable once the widget HTML is fixed).
//   3. MCP_APPS_WIDGETS=1 → gridctl_drop DOES carry the outputTemplate (re-enabled).
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

// Fake server capturing tool CONFIGS (not just handlers) + registered resource URIs.
function inspect(ctxEdition = "web") {
  const configs = {};
  const resources = [];
  const server = {
    registerTool(name, config) { configs[name] = config; },
    tool() {},
    registerResource(_name, uri) { resources.push(uri); },
  };
  const ctx = { edition: ctxEdition, state: { lastDrop: null }, getToken: async () => null,
    getActiveGrid: async () => null };
  registerTools(server, ctx);
  return { configs, resources };
}

// 1 + 2: default (flag unset in this process) → no outputTemplate, resources still registered.
const { configs, resources } = inspect("web");
const dropTpl = configs["gridctl_drop"]?._meta?.["openai/outputTemplate"];
check("default: gridctl_drop has NO openai/outputTemplate (text-first, no black square)", dropTpl == null);
check("default: live-result widget resource is still registered", resources.includes(LIVE_RESULT_URI));

// 3: child process with the flag ON → outputTemplate present (widget re-enabled).
const child = `
import { registerTools } from ${JSON.stringify(TOOLS_URL)};
const configs = {};
registerTools({ registerTool:(n,c)=>{configs[n]=c;}, tool(){}, registerResource(){} },
  { edition:"web", state:{ lastDrop:null }, getToken:async()=>null, getActiveGrid:async()=>null });
process.stdout.write(String(configs["gridctl_drop"]?._meta?.["openai/outputTemplate"] ?? "none"));
`;
const out = execFileSync(process.execPath, ["--input-type=module", "-e", child],
  { env: { ...process.env, MCP_APPS_WIDGETS: "1" }, encoding: "utf-8" }).trim();
check("MCP_APPS_WIDGETS=1: gridctl_drop outputTemplate is restored", out === LIVE_RESULT_URI);

console.log(failures ? `\n${failures} FAIL` : "\nAll apps-widgets gate checks passed.");
process.exit(failures ? 1 : 0);
