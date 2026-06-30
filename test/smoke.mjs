// Smoke test: spawn the server over stdio with a real MCP client, list the tools,
// and (locally) call one read-only tool (cloudgrid_feedback) end to end through the CLI.
// Run: node test/smoke.mjs
//
// The tool-list check always runs. The end-to-end CLI call is skipped when CI=true
// (the cloudgrid CLI is not available in CI runners).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED = [
  "cloudgrid_drop",
  "cloudgrid_claim",
  "cloudgrid_login",
  "cloudgrid_login_status",
  "cloudgrid_visibility",
  "cloudgrid_orgs",
  "cloudgrid_init",
  "cloudgrid_plug",
  "cloudgrid_logs",
  "cloudgrid_share",
  "cloudgrid_feedback",
  "cloudgrid_whoami",
  "cloudgrid_use",
  "cloudgrid_logout",
  "cloudgrid_status",
  "cloudgrid_info",
  "cloudgrid_grid",
  "cloudgrid_rename",
  "cloudgrid_unplug",
  "cloudgrid_delete",
  "cloudgrid_rollback",
  "cloudgrid_versions",
  "cloudgrid_env",
  "cloudgrid_secrets",
  "cloudgrid_scaffold",
  "cloudgrid_doctor",
  "cloudgrid_open",
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
const names = tools.map((t) => t.name).sort();
check(`lists ${EXPECTED.length} tools`, names.length === EXPECTED.length);
for (const name of EXPECTED) check(`exposes ${name}`, names.includes(name));

// Local edition: cloudgrid_drop must include the `path` parameter.
const dropTool = tools.find((t) => t.name === "cloudgrid_drop");
const dropProps = dropTool?.inputSchema?.properties ?? {};
check("local drop has `path` param", "path" in dropProps);
check("local drop has `html` param", "html" in dropProps);

// The end-to-end CLI call requires a logged-in cloudgrid CLI on $PATH.
// In CI the CLI is not installed, so skip this part.
if (!process.env.CI) {
  const res = await client.callTool({ name: "cloudgrid_whoami", arguments: {} });
  const text = res.content?.[0]?.text ?? "";
  check("cloudgrid_whoami returned without error", res.isError !== true);
  check("cloudgrid_whoami returned text", text.length > 0);
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
