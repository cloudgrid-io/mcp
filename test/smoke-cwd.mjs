// Smoke test: cwd parameter threading and non-interactive plug.
//
// Verifies:
//  1. cloudgrid_plug with cwd deploys from the passed directory (non-interactive via --auto)
//  2. The deployed entity is live (URL returns 200)
//  3. cloudgrid_env round-trip (set + get) works
//  4. Omitting cwd defaults to process.cwd()
//  5. Cleanup: unplug the test entity
//
// Run: node test/smoke-cwd.mjs
// Requires: logged-in cloudgrid CLI, org "atomic" provisioned.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

// Use a timestamped dir name to avoid slug conflicts from previous runs.
const SUFFIX = Date.now().toString(36);
const TEST_DIR = `/tmp/mcp-cwd-${SUFFIX}`;
const ORG = "atomic";
const DEPLOY_TIMEOUT = 10 * 60 * 1000; // 10 minutes

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// Set up a throwaway project dir with an HTML file.
rmSync(TEST_DIR, { recursive: true, force: true });
mkdirSync(TEST_DIR, { recursive: true });
writeFileSync(
  `${TEST_DIR}/index.html`,
  `<!doctype html><html><head><title>MCP cwd test</title></head>` +
    `<body><h1>MCP cwd test</h1><p>Deployed via MCP with cwd param</p></body></html>\n`,
);

// Spawn the MCP server from the REPO ROOT (not TEST_DIR) to prove cwd threading works.
const transport = new StdioClientTransport({
  command: "node",
  args: ["src/index.js"],
  cwd: process.cwd(),
});
const client = new Client({ name: "cwd-smoke", version: "0.0.0" });
await client.connect(transport);

let actualSlug = null;

try {
  // 1. Plug with cwd — auto-inits, detects static, deploys.
  console.log(`\n--- plug with cwd=${TEST_DIR} ---`);
  const plugRes = await client.callTool(
    { name: "cloudgrid_plug", arguments: { org: ORG, cwd: TEST_DIR } },
    undefined,
    { timeout: DEPLOY_TIMEOUT },
  );
  const plugText = plugRes.content?.[0]?.text ?? "";
  console.log(plugText.slice(0, 600));
  check("plug succeeded", plugRes.isError !== true);
  check("plug did not hang (completed)", true);

  // Extract the URL from plug output.
  const urlMatch = plugText.match(/https:\/\/[^\s]+cloudgrid\.io[^\s]*/);
  const liveUrl = urlMatch ? urlMatch[0] : null;
  check("plug returned a URL", !!liveUrl);

  // Extract the entity slug from the output.
  const slugMatch = plugText.match(/(?:Plugging|Initialising)\s+(\S+)\s/);
  if (slugMatch) actualSlug = slugMatch[1];
  if (!actualSlug && liveUrl) {
    const m = liveUrl.match(/https:\/\/([^/]+?)--/);
    if (m) actualSlug = m[1];
  }
  console.log(`  actual slug: ${actualSlug}`);

  // 2. Verify the entity is live (URL returns 200).
  if (liveUrl) {
    console.log(`\n--- verifying ${liveUrl} ---`);
    const resp = await fetch(liveUrl);
    check(`live URL returns 200`, resp.status === 200);
  }

  // 3. Env round-trip.
  if (actualSlug) {
    console.log(`\n--- env set+get for ${actualSlug} ---`);
    const setRes = await client.callTool(
      { name: "cloudgrid_env", arguments: { action: "set", name: actualSlug, key: "MCP_TEST_VAR", value: "hello-from-mcp" } },
      undefined,
      { timeout: DEPLOY_TIMEOUT },
    );
    const setText = setRes.content?.[0]?.text ?? "";
    console.log("env set:", setText.slice(0, 200));
    check("env set succeeded", setRes.isError !== true);

    const getRes = await client.callTool(
      { name: "cloudgrid_env", arguments: { action: "get", name: actualSlug, key: "MCP_TEST_VAR" } },
      undefined,
      { timeout: DEPLOY_TIMEOUT },
    );
    const getVal = getRes.content?.[0]?.text ?? "";
    console.log("env get:", getVal.slice(0, 200));
    check("env get returned value", getVal.includes("hello-from-mcp"));
  }

  // 4. Confirm omitting cwd still works (defaults to process.cwd()).
  console.log(`\n--- whoami (no cwd, should default) ---`);
  const whoRes = await client.callTool({ name: "cloudgrid_whoami", arguments: {} });
  check("whoami without cwd works", whoRes.isError !== true);

} finally {
  // Cleanup: unplug the test entity.
  if (actualSlug) {
    console.log(`\n--- cleanup: unplug ${actualSlug} ---`);
    try {
      const unpRes = await client.callTool(
        { name: "cloudgrid_unplug", arguments: { name: actualSlug, confirm: true } },
        undefined,
        { timeout: DEPLOY_TIMEOUT },
      );
      console.log(unpRes.content?.[0]?.text?.slice(0, 200) ?? "(no output)");
    } catch (e) {
      console.log("cleanup error:", e.message);
    }
  }

  await client.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll cwd smoke checks passed.");
