// Docs edition smoke: spawn src/docs.js, connect with the MCP Streamable HTTP
// client, confirm the read-only toolset, and run sample documentation queries.
// Run from mcp-server: node test/smoke-docs.mjs

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 8766;
const BASE = `http://localhost:${PORT}`;

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const child = spawn("node", ["src/docs.js"], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "ignore", "inherit"],
});

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  return false;
}

let client;
try {
  check("server became healthy", await waitForHealth());

  // Verify healthz reports the docs edition.
  const hz = await (await fetch(`${BASE}/healthz`)).json();
  check("healthz reports docs edition", hz.edition === "docs");

  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
  client = new Client({ name: "cloudgrid-docs-smoke", version: "0.0.0" });
  await client.connect(transport);

  // ── tools/list ──────────────────────────────────────────────────────────────
  const toolList = (await client.listTools()).tools;
  const names = toolList.map((t) => t.name).sort();
  console.log("docs tools:", names.join(", "));

  // New gridctl_* doc tool names.
  check("exposes gridctl_search_docs", names.includes("gridctl_search_docs"));
  check("exposes gridctl_quickstart", names.includes("gridctl_quickstart"));
  // Deprecated aliases still resolve during migration.
  check("exposes deprecated alias search_cloudgrid_documentation", names.includes("search_cloudgrid_documentation"));
  check("exposes deprecated alias cloudgrid_quickstart_guide", names.includes("cloudgrid_quickstart_guide"));

  // Must NOT expose any write/auth/deploy tools — neither the new names, the
  // aliases, nor the Agent Core tools (the anon docs edition has no auth/deploy).
  for (const forbidden of [
    "cloudgrid_drop",
    "cloudgrid_login",
    "cloudgrid_init",
    "cloudgrid_plug",
    "cloudgrid_claim",
    "cloudgrid_secrets",
    "cloudgrid_delete",
    "gridctl_drop",
    "gridctl_login",
    "gridctl_plug",
    "gridctl_start",
    "gridctl_fetch",
  ]) {
    check(`does NOT expose ${forbidden}`, !names.includes(forbidden));
  }

  // ── search: "deploy a database app" ─────────────────────────────────────────
  const r1 = await client.callTool({
    name: "search_cloudgrid_documentation",
    arguments: { query: "deploy a database app" },
  });
  const t1 = r1.content?.[0]?.text ?? "";
  console.log("\n--- deploy a database app ---");
  console.log(t1.slice(0, 500));
  check("'deploy a database app' returns results", t1.includes("###") && !t1.includes("No documentation"));
  check("'deploy a database app' mentions deploy or plug", /deploy|plug/i.test(t1));

  // ── search: "add the MCP to Cursor" ─────────────────────────────────────────
  const r2 = await client.callTool({
    name: "search_cloudgrid_documentation",
    arguments: { query: "add the MCP to Cursor" },
  });
  const t2 = r2.content?.[0]?.text ?? "";
  console.log("\n--- add the MCP to Cursor ---");
  console.log(t2.slice(0, 500));
  check("'add the MCP to Cursor' returns results", t2.includes("###") && !t2.includes("No documentation"));
  check("'add the MCP to Cursor' mentions Cursor", t2.toLowerCase().includes("cursor"));

  // ── search: "what is drop" ──────────────────────────────────────────────────
  const r3 = await client.callTool({
    name: "search_cloudgrid_documentation",
    arguments: { query: "what is drop" },
  });
  const t3 = r3.content?.[0]?.text ?? "";
  console.log("\n--- what is drop ---");
  console.log(t3.slice(0, 500));
  check("'what is drop' returns results", t3.includes("###") && !t3.includes("No documentation"));
  check("'what is drop' mentions drop or artifact or URL", /drop|artifact|url/i.test(t3));

  // ── cloudgrid_quickstart_guide ──────────────────────────────────────────────
  const r4 = await client.callTool({
    name: "cloudgrid_quickstart_guide",
    arguments: {},
  });
  const t4 = r4.content?.[0]?.text ?? "";
  check("quickstart guide returns content", t4.length > 100);
  check("quickstart mentions the build-and-ship loop", /init|plug|logs|share|feedback/i.test(t4));
} finally {
  try {
    await client?.close();
  } catch {
    /* ignore */
  }
  child.kill("SIGKILL");
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll docs edition checks passed.");
