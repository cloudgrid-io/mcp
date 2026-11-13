// Every result branch of grid_plug, grid_hello and grid_check_deploy fits the
// output schema the tool advertises (#503). The SDK emits each outputSchema
// with additionalProperties false and the client rejects a result carrying an
// undeclared key (MCP -32602), so an undeclared key on any branch turns that
// branch into an error for the user.
//
// Each branch is driven through the real handler over a Client <-> Server
// pair (the client validates structuredContent the way a real host does), and
// the structuredContent is also validated directly against the advertised
// schema, so a failure names the offending keys.
//
// Run: node test/result-output-schema.test.mjs
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { registerTools } from "../src/tools.js";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${!cond && detail ? `\n     ${detail}` : ""}`);
  if (!cond) failures++;
};

// ── mocked API ─────────────────────────────────────────────────────────────
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let api = {};
const resetApi = () => {
  api = {
    grids: [{ slug: "acme", name: "Acme", role: "owner", render_ready: true }],
    gridsStatus: 200,
    plug: { status: 202, body: { entity_id: "e1", slug: "app-1", grid: "acme", url: "https://app-1--acme.cloudgrid.io", status: "building", poll_url: "/deploys/d_app_abc123", trace_id: "d_app_abc123", detection: { kind: "app" } } },
    trace: { status: "building" },
    entityDeploys: "d_app_abc123",
  };
};
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const method = opts.method ?? "GET";
  if (/\/api\/v2\/(grids|orgs)(\?|$)/.test(u) && method === "GET") return json({ grids: api.grids }, api.gridsStatus);
  if (u.includes("/api/v2/plug") && method === "POST") return json(api.plug.body, api.plug.status);
  if (/\/api\/v2\/entities\/[^/]+\/deploys/.test(u)) return json({ deploys: api.entityDeploys ? [{ trace_id: api.entityDeploys }] : [] });
  if (/\/deploys\/d_[a-z0-9_]+/.test(u)) return json(api.trace);
  if (/\/api\/v2\/entities\/[^/?]+(\?|$)/.test(u)) return json({ visibility: "public" });
  return json({}, 404);
};

// ── server + client per edition ────────────────────────────────────────────
async function connect(edition, { token = "tok", lastDrop = null } = {}) {
  const ctx = {
    edition,
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop, anonCookie: null },
    canOpenBrowser: false,
    getToken: async () => token,
    getActiveGrid: async () => "acme",
    saveToken: async () => ({}),
    savedLocationNote: () => "",
    deployPollBudgetMs: 30,
    deployPollIntervalMs: 5,
  };
  const server = new McpServer({ name: "cloudgrid-mcp", version: "test" });
  registerTools(server, ctx);
  const client = new Client({ name: "result-schema-test", version: "1.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  const { tools } = await client.listTools();
  const validators = Object.fromEntries(tools.filter((t) => t.outputSchema).map((t) => [t.name, new AjvJsonSchemaValidator().getValidator(t.outputSchema)]));
  return { client, server, validators, ctx };
}

// Run one branch: call through the client (which validates), then validate the
// structuredContent directly. `expect` checks the branch was really reached.
async function branch(conn, label, tool, args, expect) {
  let res = null;
  let err = null;
  try {
    res = await conn.client.callTool({ name: tool, arguments: args });
  } catch (e) {
    err = e;
  }
  check(`${label}: client accepts the result`, err === null, err?.message);
  const sc = res?.structuredContent;
  check(`${label}: reached the branch`, Boolean(sc) && expect(sc), JSON.stringify(sc));
  if (sc) {
    const v = conn.validators[tool](sc);
    check(`${label}: structuredContent fits the advertised schema`, v.valid, v.errorMessage);
  }
}

// Self-test: the validator rejects an undeclared key, so a pass means something.
{
  resetApi();
  const conn = await connect("web");
  const v = conn.validators.grid_check_deploy({ status: "failed", live: false, not_declared: 1 });
  check("self-test: the advertised schema rejects an undeclared key", v.valid === false);
  await conn.client.close();
  await conn.server.close();
}

const RUNTIME_FILES = [{ path: "index.js", content: "x" }];

for (const edition of ["web", "local"]) {
  const E = `[${edition}]`;

  // ── grid_check_deploy ────────────────────────────────────────────────────
  {
    resetApi();
    const conn = await connect(edition);
    const args = { entity_id: "e1", grid: "acme", url: "https://app-1--acme.cloudgrid.io" };

    api.trace = { status: "success" };
    await branch(conn, `${E} grid_check_deploy success`, "grid_check_deploy", args, (s) => s.live === true && s.console_url);

    api.trace = { status: "building" };
    await branch(conn, `${E} grid_check_deploy still building`, "grid_check_deploy", args, (s) => s.live === false && s.next?.tool === "grid_check_deploy");

    api.trace = { status: "failed", error: {
      message_user: "The build failed.",
      build_log_excerpt: { text: "npm ERR! missing script: start", console_url: "https://console.example/build/1" },
      suggested_fixes: [{ summary: "Add a start script." }],
    } };
    await branch(conn, `${E} grid_check_deploy failed`, "grid_check_deploy", args,
      (s) => s.status === "failed" && s.build_log_tail && s.suggested_fix && s.build_log_url && (edition !== "web" || s.source_recovery));

    api.trace = { status: "failed", error: { message_user: "The build failed.", build_log_excerpt: { text: "gzip: stdin: not in gzip format" } } };
    await branch(conn, `${E} grid_check_deploy failed archive_corrupt`, "grid_check_deploy", args,
      (s) => s.reason === "archive_corrupt" && (edition !== "web" || s.source_recovery));

    await conn.client.close();
    await conn.server.close();
  }

  // ── grid_plug ────────────────────────────────────────────────────────────
  {
    resetApi();
    const conn = await connect(edition);

    await branch(conn, `${E} grid_plug manifest confirm`, "grid_plug",
      { artifact_files: [{ path: "cloudgrid.yaml", content: "name: shop\nservices:\n  web:\n    type: node\nneeds:\n  database: true\n" }, ...RUNTIME_FILES] },
      (s) => s.needs_confirmation === true);

    api.trace = { status: "building" };
    await branch(conn, `${E} grid_plug building`, "grid_plug", { artifact_files: RUNTIME_FILES, confirm_new_app: true },
      (s) => s.status === "building" && s.next);

    api.trace = { status: "success" };
    await branch(conn, `${E} grid_plug runtime live`, "grid_plug", { artifact_files: RUNTIME_FILES, confirm_new_app: true },
      (s) => s.status === "live");

    api.plug = { status: 201, body: { entity_id: "e2", slug: "page-1", grid: "acme", url: "https://acme.cloudgrid.io/page-1", status: "created", detection: { kind: "inspiration" } } };
    await branch(conn, `${E} grid_plug page created`, "grid_plug", { html: "<!doctype html><h1>hi</h1>" },
      (s) => s.status === "created" && s.entity_id === "e2");

    await branch(conn, `${E} grid_plug page updated in place`, "grid_plug", { html: "<!doctype html><h1>hi</h1>", target_entity_id: "e2" },
      (s) => s.entity_id === "e2");

    api.grids = [{ slug: "acme", name: "Acme", role: "owner", render_ready: true }, { slug: "beta", name: "Beta", role: "member", render_ready: false }];
    await branch(conn, `${E} grid_plug grid picker`, "grid_plug", { html: "<!doctype html><h1>hi</h1>" }, (s) => s.needs_grid === true);

    api.grids = [];
    await branch(conn, `${E} grid_plug zero grids`, "grid_plug", { html: "<!doctype html><h1>hi</h1>" }, (s) => s.needs_grid_create === true);

    api.gridsStatus = 500;
    await branch(conn, `${E} grid_plug grid listing failed`, "grid_plug", { html: "<!doctype html><h1>hi</h1>" }, (s) => s.error === true);

    await conn.client.close();
    await conn.server.close();
  }

  // ── signed out ───────────────────────────────────────────────────────────
  {
    resetApi();
    const conn = await connect(edition, { token: null });
    await branch(conn, `${E} grid_plug signed out`, "grid_plug", { html: "<!doctype html><h1>hi</h1>" }, (s) => s.needs_auth === true);
    await branch(conn, `${E} grid_hello signed out`, "grid_hello", {}, (s) => s.needs_auth === true);
    await conn.client.close();
    await conn.server.close();
  }

  // ── grid_hello (a runPlug result) ────────────────────────────────────────
  {
    resetApi();
    api.plug = { status: 201, body: { entity_id: "e3", slug: "hello", grid: "acme", url: "https://acme.cloudgrid.io/hello", status: "created", detection: { kind: "inspiration" } } };
    const conn = await connect(edition);
    await branch(conn, `${E} grid_hello plugged`, "grid_hello", { grid: "acme" }, (s) => s.entity_id === "e3");
    api.grids = [{ slug: "acme", name: "Acme", role: "owner", render_ready: true }, { slug: "beta", name: "Beta", role: "member", render_ready: true }];
    await branch(conn, `${E} grid_hello grid picker`, "grid_hello", {}, (s) => s.needs_grid === true && Array.isArray(s.grids));
    await conn.client.close();
    await conn.server.close();
  }
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nresult-output-schema: all checks passed");
