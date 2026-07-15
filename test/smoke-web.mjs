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
  // New grid_* names (direct-API + Agent Core) on the authed web edition.
  for (const t of ["grid_claim", "grid_plug", "grid_fork", "grid_download", "grid_login", "grid_login_status", "grid_visibility", "grid_list", "grid_start", "grid_fetch", "grid_report"]) {
    check(`exposes ${t}`, names.includes(t));
  }
  // 0.10.0: the deprecated cloudgrid_* aliases are GONE. No advertised tool name
  // may start with cloudgrid_.
  const cloudgridNames = names.filter((n) => n.startsWith("cloudgrid_"));
  check(
    `no advertised tool name starts with cloudgrid_ (found: ${cloudgridNames.join(", ") || "none"})`,
    cloudgridNames.length === 0,
  );
  check("does NOT expose CLI-only grid_init", !names.includes("grid_init"));

  // grid_plug is the one deploy/share verb on the web edition (spec v2 — the
  // unified direct-API create/re-plug verb): the inline `html` single-file path
  // + `artifact_files`, no local `path`. grid_drop is gone (folded into plug).
  check("web does NOT expose grid_drop (folded into grid_plug)", !names.includes("grid_drop"));
  const plugTool = toolList.find((t) => t.name === "grid_plug");
  const plugProps = plugTool?.inputSchema?.properties ?? {};
  check("web plug does NOT have `path` param", !("path" in plugProps));
  check("web plug has `html` single-file param", "html" in plugProps);
  check("web plug `html` desc mentions self-contained/inline", /self-contained|inline/i.test(plugProps.html?.description ?? ""));
  check("web plug has `artifact_files` param", "artifact_files" in plugProps);
  check("web plug has `target_entity_id` param", "target_entity_id" in plugProps);
  check("web plug has `owner_token` param", "owner_token" in plugProps);

  const drop = await client.callTool({
    name: "grid_plug",
    arguments: { html: "<h1>web edition smoke</h1>", anon: true },
  });
  const text = drop.content?.[0]?.text ?? "";
  console.log("--- web anonymous plug (html) ---\n" + text);
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
