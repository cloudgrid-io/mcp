// Shared constants for the CloudGrid MCP server tools.
// Extracted verbatim from src/tools.js (refactor: split tools.js into modules).
// Note: import.meta.url-relative reads adjusted for the new location
// (../package.json -> ../../package.json, ./widgets/ -> ../widgets/).

import { readFileSync } from "node:fs";

export const API_BASE = (process.env.CLOUDGRID_API_URL || "https://api.cloudgrid.io").replace(
  /\/+$/,
  "",
);

// This MCP server's version — mirrors the CLI's cli_version in a report's origin.
// Read once from package.json; never throw (a report must never fail on this).
export const MCP_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf-8")).version;
  } catch {
    return "unknown";
  }
})();

// Anti-abuse cap — unauthenticated publishing is the primary abuse surface.
export const ANON_HTML_MAX_BYTES = 2_000_000;
// Product cap for authed inline plugs. The server accepts up to 150 MB
// (express.json body limit; nginx ingress allows 200m), so this guard is
// ~6x stricter by design — a normal page is well under 1 MB, and past
// 25 MB the right shape is a folder plug (multipart, see deploy.js:756).
export const AUTHED_HTML_MAX_BYTES = 25_000_000;
export const CONSOLE_URL = "https://console.cloudgrid.io/";

// The console link handed to a user AFTER a plug. When the grid slug is known it
// points at THAT grid (verified live: /home?grid=<slug> -> 200) instead of the
// bare root, so a user with more than one grid lands on the one they just
// plugged to (#355). Falls back to the root when the slug is unknown. The
// earlier code hardcoded the root on the belief that "there is no per-grid page"
// — that was wrong; only the /grids/<slug> form 404s, /home?grid= does not.
export function consoleGridUrl(slug) {
  return slug ? `${CONSOLE_URL}home?grid=${encodeURIComponent(slug)}` : CONSOLE_URL;
}

// Display labels for visibility values (two-axis model). The OPTIONS list is what
// the post-plug ask offers; the LABELS map also keeps legacy keys (org,
// authenticated, space) so an entity's CURRENT stored value still renders — do
// not offer those as choices.
export const VISIBILITY_OPTIONS = ["private", "grid", "link"];
export const VISIBILITY_LABELS = {
  private: "Only you",
  grid: "Everyone in your grid",
  link: "Anyone with the link",
  // display-only (legacy stored values / axis renderings):
  org: "Everyone in your grid",
  authenticated: "Anyone with the link, sign-in required",
  space: "Selected spaces",
  public: "Anyone, findable by search",
};

// ── Widget resources (ChatGPT Apps SDK, web edition only) ────────────────────
// The Apps-SDK UI widgets (openai/outputTemplate → a ui:// html resource) render
// as a broken black frame in ChatGPT today, hiding the plain-text result. Gate
// them behind an env flag, DEFAULT OFF, so the drop/plug result is text-first
// (the live URL is already the first line of the text content) and the widget is
// optional. Flip MCP_APPS_WIDGETS=1 in the platform manifest to re-enable once
// the widget HTML is verified to render. The resources stay registered either
// way (harmless when no tool references them via outputTemplate).
//
// 2026-08-31 (#308, corrected): the widgets targeted a RETIRED MIME. At DevDay
// (Oct 2025) ChatGPT's Apps SDK used `text/html+skybridge`, and #309 switched us
// to it. But the Apps SDK merged with MCP Apps into SEP-1865, ratified
// 2026-01-26, and OpenAI's CURRENT docs (developers.openai.com/apps-sdk
// build/custom-ux, deploy/troubleshooting) now specify `text/html;profile=mcp-app`
// — the same MIME Claude reads. skybridge is not mentioned anywhere in the
// current docs. So ChatGPT opened the iframe on our skybridge resource, could not
// recognise it, and never populated it — the empty frame over the text.
//
// The clincher: our own Claude sign-in card (#303) RENDERS, and it declares
// `text/html;profile=mcp-app`. The MIME that renders is the standard one; the one
// that does not is skybridge. The two hosts converged; the old separation was the
// defect. CHATGPT_WIDGET_MIME below now equals RESOURCE_MIME_TYPE by value. The
// widget bridge (window.openai.toolOutput / openExternal / callTool /
// ui/notifications/tool-result) is already current — verified against
// developers.openai.com/apps-sdk/reference — so only the MIME changes.
//
// The flag stays where the platform sets it; this only makes the resource the
// type ChatGPT now expects. Done is a card seen rendering in real ChatGPT.
export const APPS_WIDGETS_ENABLED = process.env.MCP_APPS_WIDGETS === "1";
// The mimeType ChatGPT's Apps-SDK renderer requires for a ui:// widget resource.
// Since SEP-1865 (2026-01-26) this EQUALS RESOURCE_MIME_TYPE (`text/html;profile=
// mcp-app`): both hosts now render the standard MCP-Apps MIME. The hosts stay
// separated by BINDING, not MIME — ChatGPT reads `openai/outputTemplate`, Claude
// reads `_meta.ui.resourceUri` — so sharing the MIME does not cross the paths.
export const CHATGPT_WIDGET_MIME = "text/html;profile=mcp-app";
export const LIVE_RESULT_URI = "ui://cloudgrid/live-result.html";
// URI/resource-name/filename stay `org-picker` — that's the stable contract the
// web card is registered under; only the JS identifier moves toward grid.
export const GRID_PICKER_URI = "ui://cloudgrid/org-picker.html";
export const LIVE_RESULT_HTML = readFileSync(new URL("../widgets/live-result.html", import.meta.url), "utf-8");
export const GRID_PICKER_HTML = readFileSync(new URL("../widgets/org-picker.html", import.meta.url), "utf-8");

// ── grid_login MCP App (SEP-1865, Claude web) ────────────────────────────────
// A SECOND, independent UI mechanism from the ChatGPT Apps-SDK widgets above.
// It is NOT gated behind MCP_APPS_WIDGETS: that flag controls only the
// openai/outputTemplate key ChatGPT reads, and it must stay exactly as it is.
// The login card binds via _meta.ui.resourceUri (the SEP-1865 key Claude reads),
// which ChatGPT ignores — so shipping it does not touch the ChatGPT path. A
// client without the UI extension ignores _meta.ui and still gets the text-first
// sign-in URL. The HTML is the self-contained bundle from
// scripts/build-login-widget.mjs (App class + card inlined; deny-by-default CSP).
export const GRID_LOGIN_APP_URI = "ui://grid-login/mcp-app.html";
export const GRID_LOGIN_APP_HTML = readFileSync(new URL("../widgets/grid-login.html", import.meta.url), "utf-8");

// The lazy npx fallback always fetches the LATEST published CLI, so the MCP is
// never left behind the platform's required CLI version (a pinned range went
// stale and the API then rejected it with "install the latest CLI").
export const CLI_NPX_PKG = "@cloudgrid-io/cli@latest";

// Minimum CLI version the MCP will USE if it finds one already installed. Below
// this, skip the local/global CLI and fall back to `npx @latest`. MUST stay at
// (or above) the platform's live floor (platform_settings.cli_compat, enforced
// server-side with HTTP 426) — a gate below the floor green-lights CLIs the API
// rejects on every call (issue #59). Bump this in lockstep with every floor
// raise (CLI release protocol checklist).
//
// 2026-07-30: raised 0.15.14 -> 0.15.26 so the MCP stops using stale local
// CLIs. Below the floor the MCP does NOT error — it skips that rung and runs
// `npx @cloudgrid-io/cli@latest`, so raising this makes MCP callers effectively
// run latest at the cost of an npx fetch on the first call. It does not and
// cannot force a direct CLI user to upgrade; that is the server-side floor
// (`platform_settings.cli_compat.min`, live at 0.15.2), which is a separate,
// user-breaking change.
export const MIN_CLI_VERSION = "0.15.26";

// Upload/create POST budget. The build itself is async (server returns 202 +
// poll_url); this bounds only the request→response, so a stalled server errors
// instead of hanging forever (the "getting stuck" bug). Generous by default;
// override with CLOUDGRID_PLUG_UPLOAD_TIMEOUT_MS.
export const PLUG_UPLOAD_TIMEOUT_MS = Number(process.env.CLOUDGRID_PLUG_UPLOAD_TIMEOUT_MS) || 120_000;

// Verb map for the drift guard: each CLI-wrapping tool's top-level verb(s).
// The drift-guard test imports this and asserts every verb exists in `cloudgrid --help`.
export const CLI_TOOL_VERBS = {
  // CLI 0.15.14 renamed the verb to `new` in --help (init remains a hidden
  // alias, which the tool argv still uses for old-CLI compat). The guard
  // checks the HELP listing, so it tracks the advertised name.
  grid_create_project:     ["new"],
  // grid_plug is NOT here: grid_plug is now a direct-API tool
  // (POST /api/v2/plug, spec v2 §3), not a CLI wrapper.
  grid_view_logs:     ["logs"],
  grid_share:    ["visibility"],
  grid_feedback: ["feedback"],
  grid_whoami:   ["whoami"],
  grid_switch_grid:      ["use"],
  grid_logout:   ["logout"],
  grid_status:   ["status"],
  grid_info:     ["info"],
  grid_get:          ["get"],
  grid_describe_grid: ["describe"],
  grid_edit_existing_app:        ["pull"],
  grid_rename:   ["rename"],
  grid_take_offline:   ["unplug"],
  grid_delete:   ["delete"],
  grid_rollback_deploy: ["rollback"],
  grid_list_versions: ["versions"],
  grid_set_env:      ["env"],
  grid_set_secret:  ["secrets"],
  grid_scaffold: ["scaffold"],
  grid_diagnose:   ["doctor"],
  grid_get_url:     ["open"],
};
