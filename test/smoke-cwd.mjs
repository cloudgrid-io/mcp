// Smoke test: cwd/path threading and non-interactive tools (0.7.0).
//
// gridctl_plug no longer wraps the CLI (it is the unified direct-API verb), so
// the old "plug with cwd" flow is replaced by:
//  1. gridctl_plug with `path` — the direct-API create reads the folder passed,
//     not the server's own CWD. (Skips gracefully on the platform-side
//     SCOPE_INVALID authed-create bug — see the note below — or a 429 cap.)
//  2. gridctl_init with `cwd` — proves cwd threading for the CLI-wrapping
//     tools: the CLI must write cloudgrid.yaml into the PASSED directory, not
//     process.cwd().
//  3. Omitting cwd defaults to process.cwd() (whoami).
//  4. Cleanup: unplug/delete whatever was registered.
//
// Run: node test/smoke-cwd.mjs
// Requires: logged-in cloudgrid CLI, org "atomic" provisioned.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";

const SUFFIX = Date.now().toString(36);
const TEST_DIR = `/tmp/mcp-cwd-${SUFFIX}`;
const ORG = "atomic";
const DEPLOY_TIMEOUT = 10 * 60 * 1000;

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

rmSync(TEST_DIR, { recursive: true, force: true });
mkdirSync(TEST_DIR, { recursive: true });
writeFileSync(
  `${TEST_DIR}/index.html`,
  `<!doctype html><html><head><title>MCP cwd test</title></head>` +
    `<body><h1>MCP cwd test</h1><p>Deployed via MCP with path param</p></body></html>\n`,
);

// Spawn the MCP server from the REPO ROOT (not TEST_DIR) to prove threading works.
const transport = new StdioClientTransport({
  command: "node",
  args: ["src/index.js"],
  cwd: process.cwd(),
});
const client = new Client({ name: "cwd-smoke", version: "0.0.0" });
await client.connect(transport);

let createdEntityId = null;
let createdSlug = null;
let initSlug = null;

try {
  // 1. gridctl_plug with `path` — direct-API create from the passed folder.
  console.log(`\n--- gridctl_plug path=${TEST_DIR} ---`);
  const plugRes = await client.callTool(
    { name: "gridctl_plug", arguments: { path: TEST_DIR, grid: ORG } },
    undefined,
    { timeout: DEPLOY_TIMEOUT },
  );
  const plugText = plugRes.content?.[0]?.text ?? "";
  console.log(plugText.slice(0, 400));
  if (/SCOPE_INVALID|scope=personal/.test(plugText)) {
    // Known platform-side bug: the authed drop-zone create path defaults to an
    // invalid (scope, visibility) combination and 400s. Not an MCP failure.
    console.log("skip plug-path create — platform SCOPE_INVALID on authed creates (known upstream bug)");
  } else if (/HTTP 429|daily anonymous/.test(plugText)) {
    console.log("skip plug-path create — rate-limited (429)");
  } else {
    check("plug from path succeeded", plugRes.isError !== true);
    const s = plugRes.structuredContent ?? {};
    check("plug returned a URL", typeof s.url === "string" && s.url.includes("cloudgrid.io"));
    check("plug returned the entity_id re-plug handle", typeof s.entity_id === "string");
    createdEntityId = s.entity_id ?? null;
    createdSlug = s.slug ?? null;
    if (s.url) {
      const resp = await fetch(s.url);
      check("live URL returns 200", resp.status === 200);
    }
  }

  // 2. gridctl_init with cwd — the CLI must write into the PASSED directory.
  console.log(`\n--- gridctl_init cwd=${TEST_DIR} (no deploy) ---`);
  initSlug = `mcp-cwd-${SUFFIX}`;
  const initRes = await client.callTool(
    { name: "gridctl_init", arguments: { kind: "app", name: initSlug, type: "static", org: ORG, dir: ".", cwd: TEST_DIR } },
    undefined,
    { timeout: DEPLOY_TIMEOUT },
  );
  const initText = initRes.content?.[0]?.text ?? "";
  console.log(initText.slice(0, 300));
  check("init with cwd succeeded", initRes.isError !== true);
  check("init wrote cloudgrid.yaml into the passed cwd", existsSync(`${TEST_DIR}/cloudgrid.yaml`));
  if (initRes.isError === true) initSlug = null;
  // A slug collision makes the CLI register under a suffixed name — clean THAT up.
  const renamed = initText.match(/using '([^']+)'/);
  if (renamed) initSlug = renamed[1];

  // 3. Omitting cwd defaults to process.cwd().
  console.log(`\n--- whoami (no cwd, should default) ---`);
  const whoRes = await client.callTool({ name: "gridctl_whoami", arguments: {} });
  check("whoami without cwd works", whoRes.isError !== true);
} finally {
  // Cleanup: remove whatever was registered/created.
  for (const [tool, name] of [
    ["gridctl_unplug", initSlug],
    ["gridctl_delete", createdSlug],
  ]) {
    if (!name) continue;
    console.log(`\n--- cleanup: ${tool} ${name} ---`);
    try {
      const r = await client.callTool(
        { name: tool, arguments: { name, confirm: true } },
        undefined,
        { timeout: DEPLOY_TIMEOUT },
      );
      console.log(r.content?.[0]?.text?.slice(0, 200) ?? "(no output)");
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
