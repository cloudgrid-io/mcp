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
  // This client gets the per-call sign-in signal, so it can list tools and
  // browse signed out (#5783).
  env: { ...process.env, PORT: String(PORT), MCP_PUBLIC_URL: BASE, MCP_AUTH_MODE_OVERRIDES: "cloudgrid-mcp-web-smoke=call" },
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
  // New grid_* names (direct-API + Agent Core) on the web edition.
  for (const t of ["grid_plug", "grid_start", "grid_report"]) {
    check(`exposes ${t}`, names.includes(t));
  }
  // No sign-in tools on the hosted edition (#5783): the AI tool signs in.
  for (const t of ["grid_login", "grid_login_status"]) {
    check(`does not expose ${t}`, !names.includes(t));
  }
  // Tool-name cleanup: the canonical primary names are present (both editions).
  for (const nm of ["grid_get_template", "grid_get_app_source", "grid_list_grids", "grid_create_grid", "grid_pickup", "grid_pull", "grid_visibility", "grid_check_deploy"]) {
    check(`exposes ${nm}`, names.includes(nm));
  }
  // Retired copy/source verbs must NOT be advertised (CLI dropped fork/remix/download).
  for (const nm of ["grid_fork", "grid_remix", "grid_download"]) {
    check(`retired verb ${nm} is not advertised`, !names.includes(nm));
  }
  // ALL deprecated aliases are gone (founder directive 2026-07-22): canonical
  // names only, no redirect duplicates in ListTools.
  for (const nm of ["grid_fetch", "grid_set_sharing", "grid_deploy", "grid_copy_app", "grid_claim_anonymous_deploy", "grid_download_source"]) {
    check(`removed alias ${nm} is not advertised`, !names.includes(nm));
  }
  // Voice guard (web edition): no org-as-a-noun prose in anything the model sees.
  const ORG_PROSE_W = /\b(?:your|active|the user's[\w' ]*?) org\b|\borg (?:name|membership|memberships)\b|\borg's\b|\bthe org is\b|\brole in the org\b|\borganization\b/i;
  const webVoiceLeaks = toolList.filter((t) => ORG_PROSE_W.test(JSON.stringify([t.description, t.inputSchema, t.outputSchema])));
  check(`web: no org-as-a-noun prose (found: ${webVoiceLeaks.map((t) => t.name).join(", ") || "none"})`, webVoiceLeaks.length === 0);

  // 0.20.8 alias diet: dropped legacy aliases must NOT be advertised (web).
  for (const nm of ["grid_source", "grid_list", "grid_claim"]) {
    check(`dropped alias ${nm} is no longer advertised`, !names.includes(nm));
  }
  // Server instructions must reach web clients (ChatGPT/claude.ai orientation).
  // These anchors are load-bearing (observed live): losing one silently changes
  // model behavior on hosts where instructions are the ONLY orientation.
  const webInstructions = client.getInstructions?.() ?? "";
  check("web edition sends MCP instructions", webInstructions.length > 50);
  // #432: capability statements, no other product named, no preference wording
  // (test/served-text-policy.test.mjs holds the full guard).
  check("web instructions name no other hosting product", !/GitHub Pages|Netlify|Vercel/i.test(webInstructions));
  check("web instructions lead with what CloudGrid does", /^CloudGrid runs the user's web apps/.test(webInstructions));
  check("web instructions say what CloudGrid does not do", /What it does not do/.test(webInstructions));
  check("web instructions keep the share-a-link trigger phrases", /share it with friends/.test(webInstructions) && /make it live/.test(webInstructions));
  check("web instructions route multi-file apps via artifact_files (web has no path param)", /artifact_files/.test(webInstructions) && !/folder or \.zip/.test(webInstructions));
  check("web instructions name grid_start and end-with-URL", /grid_start/.test(webInstructions) && /live URL/.test(webInstructions));
  check("web instructions carry no call-first wording", !/call grid_start (once|first)/i.test(webInstructions));
  check("web instructions do not overclaim object storage", !/\bstorage\b(?! *\(| *disk)/.test(webInstructions.replace(/persistent disk/g, "")));

  // 0.10.0: the deprecated cloudgrid_* aliases are GONE. No advertised tool name
  // may start with cloudgrid_.
  const cloudgridNames = names.filter((n) => n.startsWith("cloudgrid_"));
  check(
    `no advertised tool name starts with cloudgrid_ (found: ${cloudgridNames.join(", ") || "none"})`,
    cloudgridNames.length === 0,
  );
  check("does NOT expose CLI-only grid_init", !names.includes("grid_init"));

  // grid_plug is the one deploy/publish verb on the web edition (spec v2 — the
  // unified direct-API create/re-plug verb): the inline `html` single-file path
  // + `artifact_files`, no local `path`. grid_drop is gone (folded in); the
  // canonical verb is `plug` — no grid_deploy alias (removed with all aliases).
  check("web does NOT expose grid_drop (folded into grid_plug)", !names.includes("grid_drop"));
  check("web exposes grid_plug (canonical), no grid_deploy",
    names.includes("grid_plug") && !names.includes("grid_deploy"));
  const plugTool = toolList.find((t) => t.name === "grid_plug");
  const plugProps = plugTool?.inputSchema?.properties ?? {};
  check("web deploy does NOT have `path` param", !("path" in plugProps));
  check("web deploy has `html` single-file param", "html" in plugProps);
  check("web deploy `html` desc mentions self-contained/inline", /self-contained|inline/i.test(plugProps.html?.description ?? ""));
  check("web deploy has `artifact_files` param", "artifact_files" in plugProps);
  check("web deploy has `target_entity_id` param", "target_entity_id" in plugProps);
  check("web deploy has `owner_token` param", "owner_token" in plugProps);

  // CREATE REQUIRES SIGN-IN (#395, #5783): a signed-out create over the real
  // HTTP transport is refused with HTTP 401 and a sign-in challenge before any
  // tool runs, so nothing can be published — even with anon: true.
  for (const attempt of ["first", "second"]) {
    let status = null;
    let published = false;
    try {
      const r = await client.callTool({ name: "grid_plug", arguments: { html: "<h1>web edition smoke</h1>", anon: true } });
      published = /https:\/\/[^\s"]*\.cloudgrid\.io\//.test(JSON.stringify(r)) || /\bLive:\s*https/i.test(r.content?.[0]?.text ?? "");
    } catch (err) {
      status = err?.code ?? (/(\b401\b)/.test(String(err?.message)) ? 401 : null);
      console.log(`--- web anon:true plug, ${attempt} call (expect 401) ---\n${err?.message}`);
    }
    check(`signed-out anon:true create, ${attempt} call: refused with 401`, status === 401);
    check(`signed-out anon:true create, ${attempt} call: nothing published`, !published);
  }

  // Browsing still works signed out.
  const start = await client.callTool({ name: "grid_start", arguments: {} });
  check("grid_start works signed out", !start.isError && /not signed in/.test(start.content?.[0]?.text ?? ""));
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
