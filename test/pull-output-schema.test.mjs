// Regression: grid_pull's client-side output-schema validation (MCP -32602).
//
// grid_pull declares ONE outputSchema but FOUR response modes:
//   1. pull result (entity_id/slug/grid/url/…)                 — the happy path
//   2. ORG_NOT_ACCESSIBLE (error: { code })                    — bad grid slug
//   3. NO_ACTIVE_ORG (needs_grid_create)                       — zero-grid user
//   4. no-push-access (can_edit: false, access: "view_only")   — view-only
// The MCP SDK renders the schema with additionalProperties:false and the CLIENT
// validates every result against it. Undeclared keys cause:
//   "Structured content does not match the tool's output schema" (-32602).
// This test validates representative payloads for all four modes against the
// ACTUAL registered outputSchema.
//
// Run: node test/pull-output-schema.test.mjs
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
globalThis.fetch = async () =>
  new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

function makeCtx() {
  return {
    edition: "web",
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
    canOpenBrowser: false,
    getToken: async () => "fake-jwt",
    getActiveGrid: async () => "grid-a",
    saveToken: async () => ({}),
    savedLocationNote: () => "",
  };
}

try {
  const server = new McpServer({ name: "cloudgrid-mcp", version: "test" });
  registerTools(server, makeCtx());
  const client = new Client({ name: "pull-schema-test", version: "1.0.0" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  await client.connect(clientT);

  const { tools } = await client.listTools();
  const pull = tools.find((t) => t.name === "grid_pull");
  check("grid_pull is registered with an outputSchema", Boolean(pull?.outputSchema));

  const validate = new AjvJsonSchemaValidator().getValidator(pull.outputSchema);

  const pullResult = { entity_id: "e1", slug: "s1", grid: "g1", url: "https://x", owner_is_you: true, can_edit: true };
  const orgNotAccessible = { error: { code: "ORG_NOT_ACCESSIBLE" } };
  const needsGridCreate = { needs_grid_create: true };
  const viewOnly = { can_edit: false, owner_is_you: false, access: "view_only" };

  check("schema accepts the pull-result shape", validate(pullResult).valid);
  check("schema accepts the ORG_NOT_ACCESSIBLE shape", validate(orgNotAccessible).valid);
  check("schema accepts the needs_grid_create shape", validate(needsGridCreate).valid);
  check("schema accepts the view-only shape (access)", validate(viewOnly).valid);

  const bogus = { ...pullResult, totally_unknown_field: 1 };
  check("schema still rejects a genuinely-unknown key", validate(bogus).valid === false);

  await client.close();
  await server.close();
  globalThis.fetch = realFetch;

  console.log(failures === 0 ? "\nAll pull-output-schema checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
} catch (err) {
  console.error("pull-output-schema test crashed:", err);
  process.exit(1);
}
