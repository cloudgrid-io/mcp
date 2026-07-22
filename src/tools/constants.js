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

export const ANON_HTML_MAX_BYTES = 2_000_000;
// Signed-in inline drops get a larger cap than the anonymous 2MB. Kept
// conservative — it must stay ≤ the platform's single-artifact byte limit.
// TODO(platform-confirm): confirm the server's single-artifact limit (the
// folder-plug path uses PLUG_MAX_TOTAL_BYTES = 100MB, but the single-artifact
// inline limit is not yet confirmed) and raise this to match.
export const AUTHED_HTML_MAX_BYTES = 25_000_000;
export const CONSOLE_URL = "https://console.cloudgrid.io/";

export const VISIBILITY_LABELS = {
  private: "Only you",
  org: "Your grid",
  authenticated: "Anyone signed in",
  space: "A space",
  link: "Anyone with the link",
};

// ── Widget resources (ChatGPT Apps SDK, web edition only) ────────────────────
// The Apps-SDK UI widgets (openai/outputTemplate → a ui:// html resource) render
// as a broken black frame in ChatGPT today, hiding the plain-text result. Gate
// them behind an env flag, DEFAULT OFF, so the drop/plug result is text-first
// (the live URL is already the first line of the text content) and the widget is
// optional. Flip MCP_APPS_WIDGETS=1 in the platform manifest to re-enable once
// the widget HTML is verified to render. The resources stay registered either
// way (harmless when no tool references them via outputTemplate).
export const APPS_WIDGETS_ENABLED = process.env.MCP_APPS_WIDGETS === "1";
export const LIVE_RESULT_URI = "ui://cloudgrid/live-result.html";
// URI/resource-name/filename stay `org-picker` — that's the stable contract the
// web card is registered under; only the JS identifier moves toward grid.
export const GRID_PICKER_URI = "ui://cloudgrid/org-picker.html";
export const LIVE_RESULT_HTML = readFileSync(new URL("../widgets/live-result.html", import.meta.url), "utf-8");
export const GRID_PICKER_HTML = readFileSync(new URL("../widgets/org-picker.html", import.meta.url), "utf-8");
export const WIDGET_CSP = {
  connectDomains: ["https://*.cloudgrid.io"],
  resourceDomains: ["https://*.cloudgrid.io"],
};

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
export const MIN_CLI_VERSION = "0.15.14";

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
  grid_edit_existing_app:        ["pickup"],
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
