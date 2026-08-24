// Offline unit test for the grid_login MCP App (SEP-1865 sign-in card, #302).
//
// Claim under test (the thing #287 got wrong by inference): on the WEB edition,
// grid_login binds a UI resource via _meta.ui.resourceUri and serves a
// self-contained card resource — WITHOUT disturbing the text-first result, the
// ChatGPT path, or leaking a token into the widget.
//
// These are necessary-but-NOT-sufficient (per the issue): the render itself is
// proven separately against the ext-apps basic-host. What this pins:
//   1. web: grid_login declares _meta.ui.resourceUri === ui://grid-login/mcp-app.html
//   2. web: that resource is registered with RESOURCE_MIME_TYPE and serves the
//      self-contained HTML (no remote script/style, real App bridge, no window.openai)
//   3. text-first: the handler's content[0] is text and carries the sign-in URL
//   4. local edition: NO _meta.ui on the tool and NO resource — text-only, unchanged
//   5. no token: neither the handler result nor the widget HTML carries a credential
//   6. ChatGPT untouched: grid_login carries no openai/outputTemplate
// Run: node test/login-app.test.mjs

import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { registerTools } from "../src/tools.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const GRID_LOGIN_APP_URI = "ui://grid-login/mcp-app.html";

// checkApiConnectivity() does a live fetch; the handler swallows a non-cert
// failure and proceeds to build the URL. Stub fetch so the test is fully offline
// and deterministic.
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });

function inspect(edition) {
  const configs = {};
  const handlers = {};
  const resources = {}; // uri -> { name, metadata, read }
  const server = {
    registerTool(name, config, handler) { configs[name] = config; handlers[name] = handler; },
    tool() {},
    registerResource(name, uri, metadata, read) { resources[uri] = { name, metadata, read }; },
  };
  const ctx = {
    edition,
    canOpenBrowser: false,
    state: {},
    saveToken: async () => ({ email: "a@b.co" }),
    savedLocationNote: () => "",
    getToken: async () => null,
    getActiveGrid: async () => null,
  };
  registerTools(server, ctx);
  return { configs, handlers, resources };
}

// ── WEB edition ──────────────────────────────────────────────────────────────
const web = inspect("web");
const loginCfg = web.configs["grid_login"];

check("web: grid_login declares _meta.ui.resourceUri",
  loginCfg?._meta?.ui?.resourceUri === GRID_LOGIN_APP_URI);
check("web: grid_login carries NO openai/outputTemplate (ChatGPT path untouched)",
  loginCfg?._meta?.["openai/outputTemplate"] == null);

const res = web.resources[GRID_LOGIN_APP_URI];
check("web: the ui://grid-login resource is registered", !!res);
check("web: resource mimeType defaults to RESOURCE_MIME_TYPE via registerAppResource",
  res?.metadata?.mimeType === RESOURCE_MIME_TYPE);

let html = "";
if (res) {
  const read = await res.read(new URL(GRID_LOGIN_APP_URI));
  const item = read?.contents?.[0];
  html = item?.text ?? "";
  check("web: resource content mimeType is RESOURCE_MIME_TYPE", item?.mimeType === RESOURCE_MIME_TYPE);
  check("web: resource serves the card HTML", html.includes("Sign in to CloudGrid"));
  check("web: HTML is self-contained (no remote <script src>/<link href>)",
    !/<script[^>]+src=/i.test(html) && !/<link[^>]+href=/i.test(html) && !/src=["']https?:/i.test(html));
  check("web: uses the ext-apps App bridge, NOT window.openai",
    !html.includes("window.openai"));
}

// ── Text-first + no token (drive the real handler) ────────────────────────────
const result = await web.handlers["grid_login"]();
const first = result?.content?.[0];
const url = result?.structuredContent?.login_url;
check("text-first: content[0] is text", first?.type === "text");
check("text-first: content[0] text carries the sign-in URL", typeof url === "string" && first?.text?.includes(url));

// No credential anywhere the widget can see it. The handler result has only a
// login_url + guidance text; the widget HTML must contain no token/jwt literal.
const resultJson = JSON.stringify(result);
check("no token: handler result exposes no token/jwt field",
  !/\b(jwt|token|access_token|bearer)\b/i.test(resultJson));
check("no token: widget HTML embeds no credential literal",
  !/eyJ[A-Za-z0-9_-]{10,}/.test(html)); // no JWT-shaped literal baked in

// ── LOCAL edition: text-only, unchanged ───────────────────────────────────────
const local = inspect("local");
check("local: grid_login has NO _meta.ui (text-only path unchanged)",
  local.configs["grid_login"]?._meta?.ui == null);
check("local: no grid-login resource registered", !local.resources[GRID_LOGIN_APP_URI]);

console.log(failures ? `\n${failures} FAIL` : "\nAll grid_login MCP App checks passed.");
process.exit(failures ? 1 : 0);
