// Smoke test: spawn the server over stdio with a real MCP client, list the tools,
// and (locally) call one read-only tool (grid_whoami) end to end through the CLI.
// Run: node test/smoke.mjs
//
// The tool-list check always runs. The end-to-end CLI call is skipped when CI=true
// (the cloudgrid CLI is not available in CI runners).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The canonical grid_* tool set (local edition). As of 0.10.0 these are the
// ONLY advertised names — the deprecated cloudgrid_* aliases were removed.
const GRIDCTL = [
  "grid_start",
  "grid_fetch",
  "grid_report",
  "grid_claim",
  "grid_fork",
  "grid_download",
  "grid_source",
  "grid_login",
  "grid_login_status",
  "grid_visibility",
  "grid_orgs",
  "grid_init",
  "grid_plug",
  "grid_logs",
  "grid_share",
  "grid_feedback",
  "grid_whoami",
  "grid_use",
  "grid_logout",
  "grid_status",
  "grid_info",
  "grid_get",
  "grid_describe_grid",
  "grid_pickup",
  "grid_rename",
  "grid_unplug",
  "grid_delete",
  "grid_rollback",
  "grid_versions",
  "grid_env",
  "grid_secrets",
  "grid_scaffold",
  "grid_doctor",
  "grid_open",
];

const transport = new StdioClientTransport({ command: "node", args: ["src/index.js"] });
const client = new Client({ name: "cloudgrid-mcp-smoke", version: "0.0.0" });

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
const nameSet = new Set(names);

check(`lists exactly ${GRIDCTL.length} tools`, names.length === GRIDCTL.length);
for (const name of GRIDCTL) check(`exposes ${name}`, nameSet.has(name));

// 0.10.0: the deprecated cloudgrid_* aliases are GONE. No advertised tool name
// may start with cloudgrid_.
const cloudgridNames = names.filter((n) => n.startsWith("cloudgrid_"));
check(
  `no advertised tool name starts with cloudgrid_ (found: ${cloudgridNames.join(", ") || "none"})`,
  cloudgridNames.length === 0,
);

// grid_drop is GONE — folded into grid_plug (the one deploy/share verb).
check("grid_drop is no longer advertised", !nameSet.has("grid_drop"));

// grid_plug is the unified direct-API create/re-plug verb (spec v2 §3) and now
// the single deploy/share verb — it absorbed the drop single-file publish via
// the inline `html` param. Local edition: `html` + `path` + `artifact_files` +
// `target_entity_id`; the old CLI-wrap `target` param is gone.
const plugTool = tools.find((t) => t.name === "grid_plug");
const plugProps = plugTool?.inputSchema?.properties ?? {};
check("plug has `html` single-file param (absorbed from drop)", "html" in plugProps);
check("plug has `filename` param", "filename" in plugProps);
check("local plug has `path` param", "path" in plugProps);
check("plug has `artifact_files` param", "artifact_files" in plugProps);
check("plug has `target_entity_id` param", "target_entity_id" in plugProps);
check("plug has `owner_token` param", "owner_token" in plugProps);
check("plug has `anon` param", "anon" in plugProps);
check("plug dropped the CLI-wrap `target` param", !("target" in plugProps));
check("plug description routes the share/publish intent", /share|publish|send/i.test(plugTool?.description ?? ""));

// Agent Core: grid_start returns the playbook + presentation workflow.
const start = await client.callTool({ name: "grid_start", arguments: {} });
const startStruct = start.structuredContent ?? {};
check("grid_start returns a playbook", (startStruct.playbook ?? "").length > 100);
check(
  "grid_start lists the presentation workflow",
  Array.isArray(startStruct.workflows) && startStruct.workflows.some((w) => w.name === "presentation"),
);

// grid_fetch returns the deck template deterministically.
const fetched = await client.callTool({ name: "grid_fetch", arguments: { kind: "template", name: "deck" } });
const fetchedText = fetched.content?.[0]?.text ?? "";
check("grid_fetch returns deck template HTML", fetched.isError !== true && /<!doctype html/i.test(fetchedText));

// grid_orgs resolves under its canonical name.
const orgsStatus = await client.callTool({ name: "grid_orgs", arguments: {} });
check("grid_orgs resolves (no method-not-found)", orgsStatus !== undefined);

// The end-to-end CLI call requires a logged-in cloudgrid CLI on $PATH.
// In CI the CLI is not installed, so skip this part.
if (!process.env.CI) {
  const res = await client.callTool({ name: "grid_whoami", arguments: {} });
  const text = res.content?.[0]?.text ?? "";
  check("grid_whoami returned without error", res.isError !== true);
  check("grid_whoami returned text", text.length > 0);
  console.log("--- whoami ---");
  console.log(text.slice(0, 200));
} else {
  console.log("skip end-to-end CLI call (CI, no CLI)");
}

await client.close();

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll smoke checks passed.");
