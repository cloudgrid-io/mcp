// Live drop smoke test: spawn the server, call grid_deploy with inline HTML,
// confirm a live URL comes back, then fetch that URL and confirm it serves.
// This creates a REAL anonymous inspiration (7-day auto-expiry), so it is kept
// out of `npm run smoke`. Run on demand: node test/smoke-drop.mjs
//
// No login needed — that is the point.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["src/index.js"] });
const client = new Client({ name: "cloudgrid-mcp-drop-smoke", version: "0.0.0" });

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

await client.connect(transport);

const html = "<h1>Dropped from the MCP smoke test</h1><p>No login. No CLI.</p>";
const res = await client.callTool({ name: "grid_deploy", arguments: { html, anon: true } });
const text = res.content?.[0]?.text ?? "";
console.log("--- tool output ---\n" + text);

check("drop returned without error", res.isError !== true);
const match = text.match(/Live:\s*(https:\/\/\S+)/);
check("drop returned a Live URL", !!match);

if (match) {
  const url = match[1];
  const page = await fetch(url);
  const body = await page.text();
  check(`shared URL serves (HTTP ${page.status})`, page.ok);
  check("served page references the artifact", body.toLowerCase().includes("<iframe") || body.includes("smoke test"));
}

await client.close();

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll drop smoke checks passed. (The drop auto-expires in 7 days.)");
