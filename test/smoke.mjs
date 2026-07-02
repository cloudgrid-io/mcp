// Smoke test: spawn the server over stdio with a real MCP client, list the tools,
// and (locally) call one read-only tool (gridctl_whoami) end to end through the CLI.
// Run: node test/smoke.mjs
//
// The tool-list check always runs. The end-to-end CLI call is skipped when CI=true
// (the cloudgrid CLI is not available in CI runners).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// The canonical gridctl_* tool set (local edition). The two Agent Core tools
// (gridctl_start, gridctl_fetch) are gridctl_* from birth and have NO alias.
const GRIDCTL = [
  "gridctl_start",
  "gridctl_fetch",
  "gridctl_drop",
  "gridctl_claim",
  "gridctl_fork",
  "gridctl_download",
  "gridctl_login",
  "gridctl_login_status",
  "gridctl_visibility",
  "gridctl_orgs",
  "gridctl_init",
  "gridctl_plug",
  "gridctl_logs",
  "gridctl_share",
  "gridctl_feedback",
  "gridctl_whoami",
  "gridctl_use",
  "gridctl_logout",
  "gridctl_status",
  "gridctl_info",
  "gridctl_get",
  "gridctl_describe_grid",
  "gridctl_pickup",
  "gridctl_rename",
  "gridctl_unplug",
  "gridctl_delete",
  "gridctl_rollback",
  "gridctl_versions",
  "gridctl_env",
  "gridctl_secrets",
  "gridctl_scaffold",
  "gridctl_doctor",
  "gridctl_open",
];

// Deprecated cloudgrid_* aliases — every gridctl_* tool EXCEPT the two new
// Agent Core tools keeps its legacy name as an alias (same handler).
const ALIASES = GRIDCTL.filter((n) => n !== "gridctl_start" && n !== "gridctl_fetch").map((n) =>
  n.replace(/^gridctl_/, "cloudgrid_"),
);

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

const expected = [...GRIDCTL, ...ALIASES];
check(`lists ${expected.length} tools`, names.length === expected.length);
for (const name of GRIDCTL) check(`exposes ${name}`, nameSet.has(name));
for (const name of ALIASES) check(`exposes deprecated alias ${name}`, nameSet.has(name));

// Alias descriptions must point to the new name and NOT advertise cloudgrid_*.
const aliasDrop = tools.find((t) => t.name === "cloudgrid_drop");
check("cloudgrid_drop alias marked deprecated → gridctl_drop", (aliasDrop?.description ?? "").includes("(deprecated: use gridctl_drop)"));

// Local edition: gridctl_drop must include the `path` parameter, plus the
// unified-plug re-plug handles (entity_id / owner_token / fresh).
const dropTool = tools.find((t) => t.name === "gridctl_drop");
const dropProps = dropTool?.inputSchema?.properties ?? {};
check("local drop has `path` param", "path" in dropProps);
check("local drop has `html` param", "html" in dropProps);
check("drop has `entity_id` re-plug param", "entity_id" in dropProps);
check("drop has `owner_token` param", "owner_token" in dropProps);
check("drop description says re-drops update in place", (dropTool?.description ?? "").includes("in place"));

// gridctl_plug is the unified direct-API create/re-plug verb (spec v2 §3) —
// no longer a CLI wrapper. Local edition: `path` + `artifact_files` +
// `target_entity_id`; the old CLI-wrap `target` param is gone.
const plugTool = tools.find((t) => t.name === "gridctl_plug");
const plugProps = plugTool?.inputSchema?.properties ?? {};
check("local plug has `path` param", "path" in plugProps);
check("plug has `artifact_files` param", "artifact_files" in plugProps);
check("plug has `target_entity_id` param", "target_entity_id" in plugProps);
check("plug has `owner_token` param", "owner_token" in plugProps);
check("plug has `anon` param", "anon" in plugProps);
check("plug dropped the CLI-wrap `target` param", !("target" in plugProps));

// Agent Core: gridctl_start returns the playbook + presentation workflow; the
// alias and new tool resolve to the same handler.
const start = await client.callTool({ name: "gridctl_start", arguments: {} });
const startStruct = start.structuredContent ?? {};
check("gridctl_start returns a playbook", (startStruct.playbook ?? "").length > 100);
check(
  "gridctl_start lists the presentation workflow",
  Array.isArray(startStruct.workflows) && startStruct.workflows.some((w) => w.name === "presentation"),
);

// gridctl_fetch returns the deck template deterministically.
const fetched = await client.callTool({ name: "gridctl_fetch", arguments: { kind: "template", name: "deck" } });
const fetchedText = fetched.content?.[0]?.text ?? "";
check("gridctl_fetch returns deck template HTML", fetched.isError !== true && /<!doctype html/i.test(fetchedText));

// The deprecated alias resolves to the same handler as the new name.
const aliasStatus = await client.callTool({ name: "cloudgrid_orgs", arguments: {} });
check("deprecated alias cloudgrid_orgs resolves (no method-not-found)", aliasStatus !== undefined);

// The end-to-end CLI call requires a logged-in cloudgrid CLI on $PATH.
// In CI the CLI is not installed, so skip this part.
if (!process.env.CI) {
  const res = await client.callTool({ name: "gridctl_whoami", arguments: {} });
  const text = res.content?.[0]?.text ?? "";
  check("gridctl_whoami returned without error", res.isError !== true);
  check("gridctl_whoami returned text", text.length > 0);
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
