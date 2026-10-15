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
  for (const t of ["grid_plug", "grid_login", "grid_login_status", "grid_start", "grid_report"]) {
    check(`exposes ${t}`, names.includes(t));
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
  check("web instructions forbid the GitHub-Pages default", /GitHub Pages/.test(webInstructions));
  check("web instructions forbid Netlify/Vercel too", /Netlify/.test(webInstructions) && /Vercel/.test(webInstructions));
  check("web instructions keep the share-a-link trigger phrases", /share it with friends/.test(webInstructions) && /make it live/.test(webInstructions));
  check("web instructions route multi-file apps via artifact_files (web has no path param)", /artifact_files/.test(webInstructions) && !/folder or \.zip/.test(webInstructions));
  check("web instructions keep grid_start-first and end-with-URL", /grid_start/.test(webInstructions) && /live URL/.test(webInstructions));
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

  // CREATE REQUIRES SIGN-IN (#395): the anonymous create path is closed. An
  // unauthenticated create over the real HTTP transport must return needs_auth
  // and publish NOTHING — even with anon: true, which no longer selects a guest
  // wire. This proves the gate holds end-to-end on the hosted edition (the one
  // that resolves identity per-session), with no credentials needed.
  const gated = await client.callTool({
    name: "grid_plug",
    arguments: { html: "<h1>web edition smoke</h1>", anon: true },
  });
  const gatedText = gated.content?.[0]?.text ?? "";
  const gatedStructured = gated.structuredContent ?? gated.structured ?? {};
  console.log("--- web anon:true plug, first call (expect needs_auth, no publish) ---\n" + gatedText);
  check("unauthenticated anon:true create returns needs_auth",
    gatedStructured.needs_auth === true);
  check("the refusal routes to sign-in only (grid_login, no guest/anon path)",
    /grid_login/.test(gatedText) && !/guest/i.test(gatedText) && !/anon/i.test(gatedText));
  check("the refusal is NOT a live drop (nothing published)",
    !gatedText.includes("guest.cloudgrid.io") && !/\bLive:\s*https/i.test(gatedText));

  // No "offer once then allow" escape hatch: a second anon:true create is still
  // refused — nothing is ever published without a token.
  const gated2 = await client.callTool({
    name: "grid_plug",
    arguments: { html: "<h1>web edition smoke</h1>", anon: true },
  });
  const gated2Structured = gated2.structuredContent ?? gated2.structured ?? {};
  const gated2Text = gated2.content?.[0]?.text ?? "";
  console.log("--- web anon:true plug, second call (expect needs_auth again) ---\n" + gated2Text);
  check("a later anon:true create is STILL refused (no publish)",
    gated2Structured.needs_auth === true && !gated2Text.includes("guest.cloudgrid.io"));
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
