// Login smoke test: spawn the server, call gridctl_login (browser suppressed),
// confirm a sign-in URL comes back, then call gridctl_login_status and confirm
// it reports "still waiting" (we cannot complete a real Google login headlessly).
// Run: node test/smoke-login.mjs

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["src/index.js"],
  env: { ...process.env, CLOUDGRID_NO_BROWSER: "1" }, // do not pop a browser during the test
});
const client = new Client({ name: "cloudgrid-mcp-login-smoke", version: "0.0.0" });

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

await client.connect(transport);

const tools = (await client.listTools()).tools.map((t) => t.name);
check("exposes gridctl_login", tools.includes("gridctl_login"));
check("exposes gridctl_login_status", tools.includes("gridctl_login_status"));

const start = await client.callTool({ name: "gridctl_login", arguments: {} });
const startText = start.content?.[0]?.text ?? "";
console.log("--- login output ---\n" + startText);
const m = startText.match(/(https:\/\/\S*\/auth\/login\?code=[0-9a-f-]+)/);
check("login returns an /auth/login?code= URL", !!m);

const status = await client.callTool({ name: "gridctl_login_status", arguments: {} });
const statusText = status.content?.[0]?.text ?? "";
console.log("--- status output ---\n" + statusText);
check("status reports pending (not errored)", status.isError !== true && /waiting/i.test(statusText));

await client.close();

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll login smoke checks passed. (Full sign-in needs a human at the Google screen.)");
