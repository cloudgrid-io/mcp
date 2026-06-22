// Smoke test: spawn the server over stdio with a real MCP client, list the tools,
// and call one read-only tool (cloudgrid_feedback) end to end through the CLI.
// Run from the mcp-server directory: node test/smoke.mjs
//
// Requires a logged-in cloudgrid CLI on $PATH. Exits non-zero on any failure.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED = [
  "cloudgrid_drop",
  "cloudgrid_claim",
  "cloudgrid_login",
  "cloudgrid_login_status",
  "cloudgrid_visibility",
  "cloudgrid_init",
  "cloudgrid_plug",
  "cloudgrid_logs",
  "cloudgrid_share",
  "cloudgrid_feedback",
  "cloudgrid_brain",
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

const res = await client.callTool({ name: "cloudgrid_feedback", arguments: { limit: 3 } });
const text = res.content?.[0]?.text ?? "";
check("cloudgrid_feedback returned without error", res.isError !== true);
check("cloudgrid_feedback returned text", text.length > 0);
console.log("--- feedback (first 200 chars) ---");
console.log(text.slice(0, 200));

await client.close();

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll smoke checks passed.");
