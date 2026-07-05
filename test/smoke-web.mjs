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
  // New gridctl_* names (direct-API + Agent Core) on the authed web edition.
  for (const t of ["gridctl_drop", "gridctl_claim", "gridctl_plug", "gridctl_fork", "gridctl_download", "gridctl_login", "gridctl_login_status", "gridctl_visibility", "gridctl_orgs", "gridctl_start", "gridctl_fetch", "gridctl_report"]) {
    check(`exposes ${t}`, names.includes(t));
  }
  // 0.10.0: the deprecated cloudgrid_* aliases are GONE. No advertised tool name
  // may start with cloudgrid_.
  const cloudgridNames = names.filter((n) => n.startsWith("cloudgrid_"));
  check(
    `no advertised tool name starts with cloudgrid_ (found: ${cloudgridNames.join(", ") || "none"})`,
    cloudgridNames.length === 0,
  );
  check("does NOT expose CLI-only gridctl_init", !names.includes("gridctl_init"));

  // gridctl_plug is on the web edition now (spec v2 — the unified direct-API
  // create/re-plug verb): artifact_files only, no local `path`.
  const plugTool = toolList.find((t) => t.name === "gridctl_plug");
  const plugProps = plugTool?.inputSchema?.properties ?? {};
  check("web plug does NOT have `path` param", !("path" in plugProps));
  check("web plug has `artifact_files` param", "artifact_files" in plugProps);
  check("web plug has `target_entity_id` param", "target_entity_id" in plugProps);
  check("web plug has `owner_token` param", "owner_token" in plugProps);

  // FIX A: web edition drop must NOT have `path` in schema, must have `html`.
  // The schema exclusion is the primary defense; the SDK strips unknown
  // properties via zod, so the runtime guard in the handler is belt-and-
  // suspenders for raw HTTP callers.
  const dropTool = toolList.find((t) => t.name === "gridctl_drop");
  const dropProps = dropTool?.inputSchema?.properties ?? {};
  check("web drop does NOT have `path` param", !("path" in dropProps));
  check("web drop has `html` param", "html" in dropProps);
  check("web drop `html` desc mentions inline/standalone", (dropProps.html?.description ?? "").includes("standalone"));

  const drop = await client.callTool({
    name: "gridctl_drop",
    arguments: { html: "<h1>web edition smoke</h1>", anonymous: true },
  });
  const text = drop.content?.[0]?.text ?? "";
  console.log("--- web anonymous drop ---\n" + text);
  // A 429 means the shared anonymous-drop quota is exhausted — a platform rate
  // limit, not a broken drop. Skip (don't false-fail) so CI isn't gated on quota;
  // any OTHER outcome (401, wrong URL, error) still fails the guest-URL check —
  // preserving the signal that caught the /drop/auto regression in Task 27.
  if (/HTTP 429|daily anonymous-drop limit|reached the daily/i.test(text)) {
    console.log("skip anonymous drop over HTTP — rate-limited (429), not a functional failure");
  } else {
    check("anonymous drop over HTTP returned a guest URL", text.includes("guest.cloudgrid.io"));
  }
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
