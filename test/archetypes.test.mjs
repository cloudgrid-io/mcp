// Offline test for the two new runtime archetypes (0.12.0): api-service and
// ai-app. Both are DB-backed runtime builds (like app-with-data) authored in
// cloudgrid-io/skills and snapshotted into src/corpus/. Asserts, for each:
//   1. The workflow/template/example resolve via the REAL fetchCorpus seam AND
//      the REAL registered grid_get_template handler.
//   2. The intent shows up in the grid_start workflows menu.
//   3. The template is internally consistent: active canonical needs: (no active
//      requires:, never needs:+requires: together), correct service type, reads
//      the DB connection string LAZILY (never at module top level), no hardcoded
//      connection string / secret.
//   4. api-service: Node http on process.env.PORT || 8080, DATABASE_MONGODB_URL
//      || MONGODB_URL read inside a getter, a REST resource.
//   5. ai-app: @cloudgrid-io/runtime runtime.ai.chat({ model, messages }) (the
//      SDK auto-reads RUNTIME_GATEWAY_URL, no key) + persists the exchange to
//      Mongo; needs: { ai, database }.
//   6. GUARD: neither template declares needs: vector (blocked #1545) or a cron
//      service (blocked #1543).
// Run: node test/archetypes.test.mjs

import { fetchCorpus, registerTools } from "../src/tools.js";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CORPUS = fileURLToPath(new URL("../src/corpus/", import.meta.url));
const read = (rel) => readFileSync(CORPUS + rel, "utf-8");

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// A DB connection string read must be LAZY: no process.env.*_URL reference
// before the first function/arrow boundary (i.e. at module scope). A top-level
// read crashes node startup / fails `next build`.
function readsDbLazily(code) {
  const firstFn = code.search(/\bfunction\b|=>\s*{|=>\s*\(/);
  const beforeFn = firstFn === -1 ? code : code.slice(0, firstFn);
  const beforeFnCode = beforeFn
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  return !/process\.env\.(DATABASE_MONGODB_URL|MONGODB_URL)/.test(beforeFnCode);
}

// ── Fake MCP server: capture handlers by name ───────────────────────────────
function makeServer() {
  const handlers = {};
  return {
    handlers,
    registerTool(name, _config, handler) {
      handlers[name] = handler;
    },
    tool(name, _desc, _schema, _annotations, handler) {
      handlers[name] = handler;
    },
    registerResource() {},
  };
}
function makeCtx() {
  return {
    edition: "web",
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
    canOpenBrowser: false,
    getToken: async () => null,
    getActiveGrid: async () => null,
    saveToken: async () => ({}),
    savedLocationNote: () => "",
    trustedServer: null,
  };
}

const server = makeServer();
registerTools(server, makeCtx());
const start = await server.handlers.grid_start({});
const startStruct = start?.structuredContent ?? {};
const startText = start?.content?.[0]?.text ?? "";

function inStartMenu(name) {
  return (
    (Array.isArray(startStruct.workflows) && startStruct.workflows.some((w) => w.name === name)) ||
    new RegExp(name).test(startText)
  );
}

async function fetchResolves(kind, name) {
  const direct = fetchCorpus(kind, name);
  const viaHandler = await server.handlers.grid_get_template({ kind, name });
  const text = viaHandler?.content?.[0]?.text ?? "";
  return (
    typeof direct === "string" &&
    direct.length > 100 &&
    viaHandler?.isError !== true &&
    text.length > 100
  );
}

// ── api-service ──────────────────────────────────────────────────────────────
{
  const name = "api-service";
  const dir = `templates/${name}/`;
  check(`${name} workflow resolves (fetchCorpus + handler)`, await fetchResolves("workflow", name));
  check(`${name} template resolves (fetchCorpus + handler)`, await fetchResolves("template", name));
  check(`${name} example resolves (fetchCorpus + handler)`, await fetchResolves("example", name));
  check(`${name} appears in grid_start menu`, inStartMenu(name));

  const workflow = fetchCorpus("workflow", name);
  check(`${name} workflow fires on REST/API intent`, /REST API/.test(workflow) && /webhook receiver/.test(workflow));
  check(`${name} workflow gates hosted / local edition`, /hosted/i.test(workflow) && /local edition/i.test(workflow));
  check(`${name} workflow says runtime deploy is async / poll`, /async/i.test(workflow) && /poll/i.test(workflow));

  // Template layout: service code under services/api/, not the root.
  check(
    `${name} service code lives under services/api/`,
    existsSync(CORPUS + dir + "services/api/package.json") &&
      existsSync(CORPUS + dir + "services/api/src/index.js"),
  );
  check(
    `${name} does NOT keep service code at the template root`,
    !existsSync(CORPUS + dir + "package.json") && !existsSync(CORPUS + dir + "src/index.js"),
  );

  const yaml = read(dir + "cloudgrid.yaml");
  check(`${name} yaml has active needs: { database: true }`, /^needs:/m.test(yaml) && /database:\s*true/.test(yaml));
  check(`${name} yaml has NO active requires:`, !/^\s*requires:/m.test(yaml));
  check(`${name} yaml service type is node`, /type:\s*node/.test(yaml));
  // Active-only (the full-annotated cloudgrid.yaml lists vector/cron in COMMENTS as reference).
  const apiActiveVector = yaml.split("\n").some((l) => !l.trim().startsWith("#") && /^\s*vector:/.test(l));
  const apiActiveCron = yaml.split("\n").some((l) => !l.trim().startsWith("#") && /^\s*type:\s*cron/.test(l));
  check(`${name} yaml does NOT declare active needs: vector (blocked #1545)`, !apiActiveVector);
  check(`${name} yaml does NOT declare an active cron service (blocked #1543)`, !apiActiveCron);

  const server_js = read(dir + "services/api/src/index.js");
  check(`${name} server reads DATABASE_MONGODB_URL`, /process\.env\.DATABASE_MONGODB_URL/.test(server_js));
  check(`${name} server falls back to legacy MONGODB_URL`, /process\.env\.MONGODB_URL/.test(server_js));
  check(`${name} server reads the DB var LAZILY (not at module top level)`, readsDbLazily(server_js));
  check(`${name} server listens on process.env.PORT || 8080`, /process\.env\.PORT\s*\|\|\s*8080/.test(server_js));
  check(`${name} server serves a REST resource (GET/POST)`, /GET/.test(server_js) && /POST/.test(server_js));
  check(
    `${name} embeds NO real mongodb connection string`,
    !/mongodb(\+srv)?:\/\//.test(server_js),
  );
  check(
    `${name} embeds no obvious secret`,
    !/password\s*[:=]\s*["'][^"']+["']/i.test(server_js) && !/secret\s*[:=]\s*["'][^"']+["']/i.test(server_js),
  );
}

// ── ai-app ───────────────────────────────────────────────────────────────────
{
  const name = "ai-app";
  const dir = `templates/${name}/`;
  check(`${name} workflow resolves (fetchCorpus + handler)`, await fetchResolves("workflow", name));
  check(`${name} template resolves (fetchCorpus + handler)`, await fetchResolves("template", name));
  check(`${name} example resolves (fetchCorpus + handler)`, await fetchResolves("example", name));
  check(`${name} appears in grid_start menu`, inStartMenu(name));

  const workflow = fetchCorpus("workflow", name);
  check(`${name} workflow fires on chatbot / LLM intent`, /chatbot/.test(workflow) && /talks to an LLM/.test(workflow));
  check(`${name} workflow gates hosted / local edition`, /hosted/i.test(workflow) && /local edition/i.test(workflow));
  check(`${name} workflow says runtime deploy is async / poll`, /async/i.test(workflow) && /poll/i.test(workflow));

  // Template layout: app code under services/web/, not the root.
  check(
    `${name} app code lives under services/web/`,
    existsSync(CORPUS + dir + "services/web/package.json") &&
      existsSync(CORPUS + dir + "services/web/lib/db.js") &&
      existsSync(CORPUS + dir + "services/web/app/api/chat/route.js"),
  );
  check(
    `${name} does NOT keep app code at the template root`,
    !existsSync(CORPUS + dir + "package.json") && !existsSync(CORPUS + dir + "app/page.js"),
  );

  const yaml = read(dir + "cloudgrid.yaml");
  check(`${name} yaml has active needs: with ai: true`, /^needs:/m.test(yaml) && /ai:\s*true/.test(yaml));
  check(`${name} yaml has database: true`, /database:\s*true/.test(yaml));
  check(`${name} yaml has NO active requires:`, !/^\s*requires:/m.test(yaml));
  check(`${name} yaml service type is nextjs`, /type:\s*nextjs/.test(yaml));
  // GUARD: the RAG/vector variant is blocked (#1545) — vector must appear only in
  // a comment, never as an active `needs:` key. Assert no uncommented vector: line.
  const activeVector = yaml
    .split("\n")
    .some((l) => !l.trim().startsWith("#") && /^\s*vector:/.test(l));
  check(`${name} yaml does NOT declare active needs: vector (blocked #1545)`, !activeVector);
  check(`${name} yaml does NOT declare a cron service (blocked #1543)`, !/type:\s*cron/.test(yaml));

  const pkg = read(dir + "services/web/package.json");
  check(`${name} package.json depends on @cloudgrid-io/runtime (^1.0.3)`, /@cloudgrid-io\/runtime/.test(pkg) && !/@cloudgrid-io\/ai\b/.test(pkg));
  check(`${name} package.json depends on next + mongodb`, /"next"/.test(pkg) && /"mongodb"/.test(pkg));

  const route = read(dir + "services/web/app/api/chat/route.js");
  check(`${name} route imports runtime from @cloudgrid-io/runtime`, /import\s*\{\s*runtime\s*\}\s*from\s*["']@cloudgrid-io\/runtime["']/.test(route));
  check(`${name} route does NOT read the gateway env var (SDK auto-reads RUNTIME_GATEWAY_URL)`, !/process\.env\.\w*GATEWAY\w*/.test(route) && !/createClient/.test(route));
  check(`${name} route calls runtime.ai.chat({ ... })`, /runtime\.ai\.chat\(\s*\{/.test(route));
  check(`${name} route passes a model to chat`, /model:\s*["']claude-haiku["']/.test(route));
  check(`${name} route reads the reply from chat's { text } result`, /\{\s*text(\s*:\s*\w+)?\s*\}\s*=\s*await\s*runtime\.ai\.chat/.test(route));
  check(`${name} route persists to Mongo (insert)`, /insert(One|Many)\(/.test(route));
  check(`${name} route is force-dynamic`, /dynamic\s*=\s*["']force-dynamic["']/.test(route));

  const db = read(dir + "services/web/lib/db.js");
  check(`${name} db.js reads DATABASE_MONGODB_URL`, /process\.env\.DATABASE_MONGODB_URL/.test(db));
  check(`${name} db.js falls back to legacy MONGODB_URL`, /process\.env\.MONGODB_URL/.test(db));
  check(`${name} db.js reads the DB var LAZILY (not at module top level)`, readsDbLazily(db));

  // No hardcoded connection string / secret anywhere in the template's code.
  const codeBlob = route + "\n" + db + "\n" + read(dir + "services/web/app/page.js");
  check(`${name} embeds NO real mongodb connection string`, !/mongodb(\+srv)?:\/\//.test(codeBlob));
  check(`${name} does NOT set an AI API key`, !/apiKey/i.test(codeBlob) && !/runtime\.ai\.chat\([^)]*key/i.test(codeBlob));
}

// ── Example content sanity ───────────────────────────────────────────────────
{
  const apiEx = fetchCorpus("example", "api-service");
  check("api-service example uses services/api/ + lazy DATABASE_MONGODB_URL + needs:{database:true}",
    /services\/api\//.test(apiEx) && /process\.env\.DATABASE_MONGODB_URL/.test(apiEx) &&
    /needs:\s*\n\s*database:\s*true/.test(apiEx) && !/^\s*requires:/m.test(apiEx));

  const aiEx = fetchCorpus("example", "ai-app");
  check("ai-app example uses runtime.ai.chat + services/web/ + needs: ai+database",
    /runtime\.ai\.chat\(/.test(aiEx) && /@cloudgrid-io\/runtime/.test(aiEx) && !/@cloudgrid-io\/ai\b/.test(aiEx) &&
    /services\/web\//.test(aiEx) &&
    /ai:\s*true/.test(aiEx) && /database:\s*true/.test(aiEx) && !/^\s*requires:/m.test(aiEx));
}

if (failures > 0) {
  console.log(`\n${failures} archetypes check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll archetypes checks passed.");
