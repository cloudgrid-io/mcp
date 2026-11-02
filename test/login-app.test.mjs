// Offline unit test for grid_login.
//
// Since cloudgrid-io/cloudgrid#5783 the hosted (web) edition has NO sign-in tool:
// the AI tool's connector signs the user in (OAuth) when a tool needs an account.
// grid_login and grid_login_status stay on the local edition, text-first.
// What this pins:
//   1. web: no grid_login, no grid_login_status, no sign-in card resource
//   2. local: grid_login is text-first, carries the sign-in URL, no _meta.ui
//   3. local: neither the handler result nor anything else carries a credential
// Run: node test/login-app.test.mjs

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

// ── WEB edition: no sign-in tools ────────────────────────────────────────────
const web = inspect("web");
check("web: grid_login is not registered", !web.configs["grid_login"]);
check("web: grid_login_status is not registered", !web.configs["grid_login_status"]);
check("web: no grid-login card resource", !web.resources[GRID_LOGIN_APP_URI]);

// ── LOCAL edition: text-first, unchanged ─────────────────────────────────────
const local = inspect("local");
check("local: grid_login is registered", !!local.configs["grid_login"]);
check("local: grid_login_status is registered", !!local.configs["grid_login_status"]);
check("local: grid_login has NO _meta.ui (text-only path)", local.configs["grid_login"]?._meta?.ui == null);
check("local: no grid-login resource registered", !local.resources[GRID_LOGIN_APP_URI]);

const result = await local.handlers["grid_login"]();
const first = result?.content?.[0];
const url = result?.structuredContent?.login_url;
check("text-first: content[0] is text", first?.type === "text");
check("text-first: content[0] text carries the sign-in URL", typeof url === "string" && first?.text?.includes(url));
check("no token: handler result exposes no token/jwt field",
  !/\b(jwt|token|access_token|bearer)\b/i.test(JSON.stringify(result)));

console.log(failures ? `\n${failures} FAIL` : "\nAll grid_login MCP App checks passed.");
process.exit(failures ? 1 : 0);
