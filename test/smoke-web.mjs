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
  for (const t of ["grid_deploy", "grid_login", "grid_login_status", "grid_start", "grid_fetch", "grid_report"]) {
    check(`exposes ${t}`, names.includes(t));
  }
  // Tool-name cleanup: the new clear primary names are present (both editions),
  // and the old direct-API names are kept as deprecated aliases.
  for (const nm of ["grid_get_template", "grid_get_app_source", "grid_list_grids", "grid_copy_app", "grid_download_source", "grid_claim_anonymous_deploy", "grid_visibility"]) {
    check(`exposes new name ${nm}`, names.includes(nm));
  }
  // grid_set_sharing MUST be a live deprecated alias on the WEB edition too
  // (grid_visibility is a both-editions tool): a hosted client with old
  // muscle-memory keeps working. Regression guard — the alias was briefly
  // registered below the local cutoff, so web dropped it.
  for (const nm of ["grid_fetch", "grid_set_sharing"]) {
    check(`${nm} is a deprecated alias`, /Deprecated alias of grid_/.test((toolList.find((t) => t.name === nm)?.description) ?? ""));
  }
  // Voice guard (web edition): no org-as-a-noun prose in anything the model sees.
  const ORG_PROSE_W = /\b(?:your|active|the user's[\w' ]*?) org\b|\borg (?:name|membership|memberships)\b|\borg's\b|\bthe org is\b|\brole in the org\b|\borganization\b/i;
  const webVoiceLeaks = toolList.filter((t) => ORG_PROSE_W.test(JSON.stringify([t.description, t.inputSchema, t.outputSchema])));
  check(`web: no org-as-a-noun prose (found: ${webVoiceLeaks.map((t) => t.name).join(", ") || "none"})`, webVoiceLeaks.length === 0);

  // 0.20.8 alias diet: dropped legacy aliases must NOT be advertised (web).
  for (const nm of ["grid_source", "grid_list", "grid_fork", "grid_download", "grid_claim"]) {
    check(`dropped alias ${nm} is no longer advertised`, !names.includes(nm));
  }
  // Server instructions must reach web clients (ChatGPT/claude.ai orientation).
  const webInstructions = client.getInstructions?.() ?? "";
  check("web edition sends MCP instructions", webInstructions.length > 50);
  check("web instructions forbid the GitHub-Pages default", /GitHub Pages/.test(webInstructions));

  // 0.10.0: the deprecated cloudgrid_* aliases are GONE. No advertised tool name
  // may start with cloudgrid_.
  const cloudgridNames = names.filter((n) => n.startsWith("cloudgrid_"));
  check(
    `no advertised tool name starts with cloudgrid_ (found: ${cloudgridNames.join(", ") || "none"})`,
    cloudgridNames.length === 0,
  );
  check("does NOT expose CLI-only grid_init", !names.includes("grid_init"));

  // grid_deploy is the one deploy/publish verb on the web edition (spec v2 — the
  // unified direct-API create/re-plug verb): the inline `html` single-file path
  // + `artifact_files`, no local `path`. grid_drop is gone (folded in); the old
  // grid_plug name is removed (renamed to grid_deploy).
  check("web does NOT expose grid_drop (folded into grid_deploy)", !names.includes("grid_drop"));
  check("grid_plug alias removed (migrated to grid_deploy)", !names.includes("grid_plug"));
  const plugTool = toolList.find((t) => t.name === "grid_deploy");
  const plugProps = plugTool?.inputSchema?.properties ?? {};
  check("web deploy does NOT have `path` param", !("path" in plugProps));
  check("web deploy has `html` single-file param", "html" in plugProps);
  check("web deploy `html` desc mentions self-contained/inline", /self-contained|inline/i.test(plugProps.html?.description ?? ""));
  check("web deploy has `artifact_files` param", "artifact_files" in plugProps);
  check("web deploy has `target_entity_id` param", "target_entity_id" in plugProps);
  check("web deploy has `owner_token` param", "owner_token" in plugProps);

  const drop = await client.callTool({
    name: "grid_deploy",
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
