// Regression: grid_plug's client-side output-schema validation (MCP -32602).
//
// grid_plug declares ONE outputSchema but has THREE response modes:
//   1. plug result (entity_id/url/status/…)          — the happy path
//   2. grid-picker ask (needs_grid/needs_org/grids/orgs) — signed-in, >1 grid
//   3. CLI-fallback recovery (url/status/via)         — signed-in create fallback
// The MCP SDK renders the schema with additionalProperties:false and the CLIENT
// validates every result against it (Ajv, allErrors). Modes 2 and 3 used to carry
// undeclared keys, so the client threw:
//   "Structured content does not match the tool's output schema:
//    data must NOT have additional properties" (×4 for the picker's 4 keys).
// This test drives the picker mode through a real Client↔Server round-trip, and
// validates representative payloads for all three modes against the ACTUAL
// registered outputSchema.
//
// Run: node test/plug-output-schema.test.mjs
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { registerTools } from "../src/tools.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith("/api/v2/orgs")) {
    return new Response(JSON.stringify({
      grids: [
        { slug: "grid-a", name: "Grid A", role: "owner", render_ready: true },
        { slug: "grid-b", name: "Grid B", role: "owner", render_ready: true },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
};

function makeCtx() {
  return {
    edition: "web",
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
    canOpenBrowser: false,
    getToken: async () => "fake-jwt", // signed in → picker fires for >1 grid
    getActiveGrid: async () => "grid-a",
    saveToken: async () => ({}),
    savedLocationNote: () => "",
  };
}

try {
  const server = new McpServer({ name: "cloudgrid-mcp", version: "test" });
  registerTools(server, makeCtx());
  const client = new Client({ name: "plug-schema-test", version: "1.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await client.connect(clientT);

  // Discovery caches the per-tool output validator (as any real client does).
  const { tools } = await client.listTools();
  const plug = tools.find((t) => t.name === "grid_plug");
  check("grid_plug is registered with an outputSchema", Boolean(plug?.outputSchema));

  // ── Mode 2 (the reported bug): picker result must NOT throw -32602 ──────────
  let threwCode = null;
  let res = null;
  try {
    res = await client.callTool({
      name: "grid_plug",
      arguments: { html: "<h1>hi</h1>", hints: { kind: "inspiration" } },
    });
  } catch (err) {
    threwCode = err?.code ?? "throw";
    console.log("   unexpected throw:", err?.message);
  }
  check("picker result passes client output-schema validation (no -32602)", threwCode === null);
  check("picker result surfaces needs_grid + grids", Boolean(res?.structuredContent?.needs_grid) && Array.isArray(res?.structuredContent?.grids));

  // ── Validate all three modes against the ACTUAL registered schema ───────────
  const validate = new AjvJsonSchemaValidator().getValidator(plug.outputSchema);
  const gridItem = { slug: "grid-a", name: "Grid A", role: "owner", render_ready: true, is_active: true };

  const plugResult = { entity_id: "e1", slug: "s1", grid: null, url: "https://x", status: "created" };
  const pickerResult = { needs_grid: true, needs_org: true, grids: [gridItem], orgs: [gridItem] };
  const cliFallback = { url: "https://x", status: "created", via: "cli-fallback" };

  check("schema accepts the plug-result shape", validate(plugResult).valid);
  check("schema accepts the grid-picker shape", validate(pickerResult).valid);
  check("schema accepts the CLI-fallback shape (via)", validate(cliFallback).valid);

  // Negative control: a genuinely-unknown key is still rejected (schema stays tight).
  const bogus = { ...plugResult, totally_unknown_field: 1 };
  check("schema still rejects a genuinely-unknown key", validate(bogus).valid === false);

  await client.close();
  await server.close();
  globalThis.fetch = realFetch;

  console.log(failures === 0 ? "\nAll plug-output-schema checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
} catch (err) {
  console.error("plug-output-schema test crashed:", err);
  process.exit(1);
}
