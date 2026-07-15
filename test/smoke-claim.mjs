// Live test for identity drop + claim. Requires a signed-in CLI
// (~/.cloudgrid/credentials). Creates real artifacts:
//   - one owned inspiration in the org passed below (default e2e-bot)
//   - one anonymous drop that then gets claimed into the signed-in account
// Run from mcp-server: node test/smoke-claim.mjs [org-slug]

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const org = process.argv[2] || "e2e-bot";

const transport = new StdioClientTransport({ command: "node", args: ["src/index.js"] });
const client = new Client({ name: "cloudgrid-mcp-claim-smoke", version: "0.0.0" });

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

await client.connect(transport);

// 1. Identity publish — should land in the user's grid, owned.
const idDrop = await client.callTool({
  name: "grid_deploy",
  arguments: { html: "<h1>identity drop smoke</h1>", grid: org, filename: "id-smoke.html" },
});
const idText = idDrop.content?.[0]?.text ?? "";
console.log("--- identity publish ---\n" + idText);
check("identity publish succeeded", idDrop.isError !== true);
check(`identity publish landed in ${org}`, idText.includes(`${org}.cloudgrid.io`));

// 2. Anonymous publish — should return a Live guest URL and arm the claim.
const anon = await client.callTool({
  name: "grid_deploy",
  arguments: { html: "<h1>anon drop smoke</h1>", anon: true, filename: "anon-smoke.html" },
});
const anonText = anon.content?.[0]?.text ?? "";
console.log("--- anonymous drop ---\n" + anonText);
check("anonymous drop succeeded", anon.isError !== true);
check("anonymous drop is on guest", anonText.includes("guest.cloudgrid.io"));

// 3. Claim — uses the remembered claim token from step 2.
const claim = await client.callTool({ name: "grid_claim", arguments: {} });
const claimText = claim.content?.[0]?.text ?? "";
console.log("--- claim ---\n" + claimText);
check("claim succeeded", claim.isError !== true);
check("claim reports a claimed entity", /Claimed \d+, now yours/.test(claimText));

await client.close();

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll identity-drop + claim checks passed.");
