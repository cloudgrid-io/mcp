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
  "grid_get_template",
  "grid_report",
  "grid_pickup",
  "grid_fork",
  "grid_remix",
  "grid_download",
  "grid_get_app_source",
  "grid_login",
  "grid_login_status",
  "grid_visibility",
  "grid_check_deploy",
  "grid_list_grids",
  "grid_create_project",
  "grid_plug",
  "grid_view_logs",
  "grid_share",
  "grid_feedback",
  "grid_whoami",
  "grid_switch_grid",
  "grid_logout",
  "grid_status",
  "grid_info",
  "grid_get",
  "grid_describe_grid",
  "grid_edit_existing_app",
  "grid_rename",
  "grid_take_offline",
  "grid_delete",
  "grid_rollback_deploy",
  "grid_list_versions",
  "grid_set_env",
  "grid_set_secret",
  "grid_scaffold",
  "grid_diagnose",
  "grid_get_url",
  "grid_note",
];

// Kept aliases (0.20.8 alias diet): only the ones with real muscle memory
// survive; the rest were DROPPED (each alias schema was pure ListTools context
// weight). grid_set_sharing is a KEPT alias — the tool was re-renamed back to
// grid_visibility (2026-07-20 founder rename), old name kept for back-compat.
// grid_deploy is a KEPT alias — the tool was renamed to grid_plug (canonical
// verb); "deploy" survives as an intent keyword in grid_plug's description.
const ALIASES = [
  "grid_fetch",
  "grid_logs",
  "grid_set_sharing",
  "grid_deploy",
  "grid_copy_app",
  "grid_claim_anonymous_deploy",
  "grid_download_source",
];
// NOTE: grid_fork, grid_download, and grid_pickup were once dropped short
// aliases, but are now CANONICAL primary tools (copy/adopt verb rename) — so
// they are no longer in this list.
const DROPPED_ALIASES = [
  "grid_source", "grid_list", "grid_claim",
  "grid_init", "grid_env", "grid_secrets", "grid_rollback",
  "grid_versions", "grid_open", "grid_doctor", "grid_unplug", "grid_use",
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

check(`lists exactly ${GRIDCTL.length + ALIASES.length} tools (primaries + deprecated aliases)`,
  names.length === GRIDCTL.length + ALIASES.length);
for (const name of GRIDCTL) check(`exposes ${name}`, nameSet.has(name));
for (const name of ALIASES) {
  check(`exposes deprecated alias ${name}`, nameSet.has(name));
  const t = tools.find((x) => x.name === name);
  check(`${name} description marks it a deprecated alias`, /Deprecated alias of grid_/.test(t?.description ?? ""));
}
// 0.20.8 alias diet: the 16 dropped legacy aliases must NOT be advertised.
for (const name of DROPPED_ALIASES) {
  check(`dropped alias ${name} is no longer advertised`, !nameSet.has(name));
}

// 0.10.0: the deprecated cloudgrid_* aliases are GONE. No advertised tool name
// may start with cloudgrid_.
const cloudgridNames = names.filter((n) => n.startsWith("cloudgrid_"));
check(
  `no advertised tool name starts with cloudgrid_ (found: ${cloudgridNames.join(", ") || "none"})`,
  cloudgridNames.length === 0,
);

// Server instructions: the one orientation channel for hosts without hooks
// (observed live: without it, ChatGPT suggests GitHub Pages instead of the
// attached connector). Must be present and name the deploy flow.
const serverInstructions = client.getInstructions?.() ?? "";
check("server sends MCP instructions", serverInstructions.length > 50);
check("instructions claim the share-a-link intent", /share it with friends|make it live/.test(serverInstructions));
const deployDesc = tools.find((t) => t.name === "grid_plug")?.description ?? "";
check("grid_plug description claims share-with-friends phrases", /share it with friends/.test(deployDesc));

// grid_drop is GONE — folded into grid_plug (the one deploy/publish verb).
check("grid_drop is no longer advertised", !nameSet.has("grid_drop"));

// Voice guard (founder directive: the product noun is GRID). Walk every
// string a model actually receives — tool descriptions, every nested schema
// describe(), and the server instructions — and reject org-as-a-noun prose.
// API values/param names (`org`, org_slug, needs_org) are contract and exempt;
// this catches the phrasing classes that leaked three separate times.
const ORG_PROSE = /\b(?:your|active|the user's[\w' ]*?) org\b|\borg (?:name|membership|memberships)\b|\borg's\b|\bthe org is\b|\brole in the org\b|\borganization\b/i;
function* allDescriptions(node, path = "") {
  if (typeof node === "string") { yield [path, node]; return; }
  if (!node || typeof node !== "object") return;
  for (const [k, v] of Object.entries(node)) {
    if (k === "description" && typeof v === "string") yield [`${path}.${k}`, v];
    else if (typeof v === "object") yield* allDescriptions(v, `${path}.${k}`);
  }
}
{
  const voiceLeaks = [];
  for (const t of tools) {
    if (ORG_PROSE.test(t.description ?? "")) voiceLeaks.push(`${t.name}: description`);
    for (const [p, d] of allDescriptions(t.inputSchema, `${t.name}.input`)) if (ORG_PROSE.test(d)) voiceLeaks.push(p);
    for (const [p, d] of allDescriptions(t.outputSchema ?? {}, `${t.name}.output`)) if (ORG_PROSE.test(d)) voiceLeaks.push(p);
  }
  const instr = client.getInstructions?.() ?? "";
  if (ORG_PROSE.test(instr)) voiceLeaks.push("server instructions");
  check(
    `no org-as-a-noun prose reaches the model (found: ${voiceLeaks.slice(0, 5).join(", ") || "none"})`,
    voiceLeaks.length === 0,
  );
}

// Voice rule (founder directive #1637): the CLI verb is `grid` — only. No
// advertised tool description may teach the deprecated `cloudgrid <verb>`
// form (a Desktop model repeated "run cloudgrid plug" verbatim from one).
const cloudgridVerbLeaks = tools.filter((t) => /`?cloudgrid (?!\.ya?ml)[a-z-]+/.test(t.description ?? ""));
check(
  `no tool description teaches a "cloudgrid <verb>" (found: ${cloudgridVerbLeaks.map((t) => t.name).join(", ") || "none"})`,
  cloudgridVerbLeaks.length === 0,
);

// grid_plug is the unified direct-API create/re-plug verb (spec v2 §3) and the
// single deploy/publish verb — it absorbed the drop single-file publish via the
// inline `html` param. It was renamed from grid_deploy (canonical verb is now
// `plug`); grid_deploy is kept as a deprecated back-compat alias. Local edition:
// `html` + `path` + `artifact_files` + `target_entity_id`; the old CLI-wrap
// `target` param is gone.
const plugTool = tools.find((t) => t.name === "grid_plug");
const plugProps = plugTool?.inputSchema?.properties ?? {};
check("deploy has `html` single-file param (absorbed from drop)", "html" in plugProps);
check("deploy has `filename` param", "filename" in plugProps);
check("local deploy has `path` param", "path" in plugProps);
check("deploy has `artifact_files` param", "artifact_files" in plugProps);
check("deploy has `target_entity_id` param", "target_entity_id" in plugProps);
check("grid_plug is the primary tool (canonical verb)", nameSet.has("grid_plug"));
check("grid_deploy kept as deprecated alias of grid_plug", nameSet.has("grid_deploy") &&
  /Deprecated alias of grid_plug/.test(tools.find((t) => t.name === "grid_deploy")?.description ?? ""));
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

// grid_list resolves under its canonical name.
const orgsStatus = await client.callTool({ name: "grid_list", arguments: {} });
check("grid_list resolves (no method-not-found)", orgsStatus !== undefined);

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
