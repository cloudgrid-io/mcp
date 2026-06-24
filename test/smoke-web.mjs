// Web edition smoke: spawn src/web.js, connect with the MCP Streamable HTTP
// client, confirm the light toolset, and do an anonymous drop over HTTP.
// Run from mcp-server: node test/smoke-web.mjs

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 8765;
const BASE = `http://localhost:${PORT}`;

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const child = spawn("node", ["src/web.js"], {
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

  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`));
  client = new Client({ name: "cloudgrid-mcp-web-smoke", version: "0.0.0" });
  await client.connect(transport);

  const toolList = (await client.listTools()).tools;
  const names = toolList.map((t) => t.name).sort();
  console.log("web tools:", names.join(", "));
  for (const t of ["cloudgrid_drop", "cloudgrid_claim", "cloudgrid_login", "cloudgrid_login_status", "cloudgrid_visibility", "cloudgrid_orgs"]) {
    check(`exposes ${t}`, names.includes(t));
  }
  check("does NOT expose CLI-only cloudgrid_init", !names.includes("cloudgrid_init"));
  check("does NOT expose CLI-only cloudgrid_plug", !names.includes("cloudgrid_plug"));

  // FIX A: web edition drop must NOT have `path` in schema, must have `html`.
  // The schema exclusion is the primary defense; the SDK strips unknown
  // properties via zod, so the runtime guard in the handler is belt-and-
  // suspenders for raw HTTP callers.
  const dropTool = toolList.find((t) => t.name === "cloudgrid_drop");
  const dropProps = dropTool?.inputSchema?.properties ?? {};
  check("web drop does NOT have `path` param", !("path" in dropProps));
  check("web drop has `html` param", "html" in dropProps);
  check("web drop `html` desc mentions inline/standalone", (dropProps.html?.description ?? "").includes("standalone"));

  const drop = await client.callTool({
    name: "cloudgrid_drop",
    arguments: { html: "<h1>web edition smoke</h1>", anonymous: true },
  });
  const text = drop.content?.[0]?.text ?? "";
  console.log("--- web anonymous drop ---\n" + text);
  check("anonymous drop over HTTP returned a guest URL", text.includes("guest.cloudgrid.io"));
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
console.log("\nAll web edition checks passed.");
