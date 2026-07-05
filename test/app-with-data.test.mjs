// Offline unit test for the app-with-data capability (0.9.0): the first runtime
// (DB-backed) build workflow in the corpus. Asserts the new workflow/template/
// example resolve via the REAL fetchCorpus seam and the REAL registered tool
// handlers, that the intent shows up in the gridctl_start menu, that the
// template is internally consistent (valid YAML shape, needs: {database: true},
// reads process.env.DATABASE_MONGODB_URL, no hardcoded connection string/secret), and
// that the PLAYBOOK carries the persistence rule and the workflow gates hosted.
// Run: node test/app-with-data.test.mjs

import { fetchCorpus, registerTools } from "../src/tools.js";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const TEMPLATE_DIR = fileURLToPath(
  new URL("../src/corpus/templates/app-with-data/", import.meta.url),
);
const read = (rel) => readFileSync(TEMPLATE_DIR + rel, "utf-8");

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
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

// ── 1. Corpus fetch resolves for all three kinds ────────────────────────────
const workflow = fetchCorpus("workflow", "app-with-data");
const template = fetchCorpus("template", "app-with-data");
const example = fetchCorpus("example", "app-with-data");
const troubleshooting = fetchCorpus("troubleshooting", "persistent-apps");

check("fetchCorpus workflow app-with-data resolves", typeof workflow === "string" && workflow.length > 100);
check("fetchCorpus template app-with-data resolves", typeof template === "string" && template.length > 100);
check("fetchCorpus example app-with-data resolves", typeof example === "string" && example.length > 100);
check("fetchCorpus troubleshooting persistent-apps resolves", typeof troubleshooting === "string" && troubleshooting.length > 100);

// ── 2. Workflow content: fires on persistence intent + gates hosted ─────────
check("workflow when: mentions SAVES/PERSISTS intent", /SAVES or PERSISTS/.test(workflow));
check("workflow mentions to-do list intent", /to-do list/.test(workflow));
check(
  "workflow gates hosted edition (edition check first)",
  /hosted/i.test(workflow) && /local edition/i.test(workflow) && /static/i.test(workflow),
);
check("workflow says runtime deploy is async / poll", /async/i.test(workflow) && /poll/i.test(workflow));
check("workflow tells the DB to be read from process.env.DATABASE_MONGODB_URL", /process\.env\.DATABASE_MONGODB_URL/.test(workflow));

// ── 3. Template internal consistency ─────────────────────────────────────────
// cloudgrid.yaml parses (as bundled in the template dir) and declares mongodb.
const yaml = fetchCorpus("template", "app-with-data"); // the index.md bundle
check("template declares needs: {database: true}", /needs:\s*\n\s*database:\s*true/.test(yaml));
check("template does NOT use active requires:", !/^\s*requires:/m.test(yaml));
check("template services.web is nextjs", /type:\s*nextjs/.test(yaml));

// DB code references the injected env var and hardcodes NO connection string.
check("template DB code reads process.env.DATABASE_MONGODB_URL", /process\.env\.DATABASE_MONGODB_URL/.test(template));
check(
  "template embeds NO real mongodb connection string",
  !/mongodb(\+srv)?:\/\//.test(template.replace(/`mongodb/g, "")),
);
check(
  "template embeds no obvious secret",
  !/password\s*[:=]\s*["'][^"']+["']/i.test(template) && !/secret\s*[:=]\s*["'][^"']+["']/i.test(template),
);
check("template has a clear unset guard", /DATABASE_MONGODB_URL is not set/.test(template));

// ── 3b. On-disk template layout: services/<name>/, lazy DB, requires-not-needs ─
// The deployable app code MUST live under services/web/ (path: is the URL mount,
// not the filesystem path). Root-level app files fail "Service directory not
// found: …/services/web". Verified live by the manager (Task 39 / analysis 37).
check(
  "template app code lives under services/web/",
  existsSync(TEMPLATE_DIR + "services/web/package.json") &&
    existsSync(TEMPLATE_DIR + "services/web/lib/db.js") &&
    existsSync(TEMPLATE_DIR + "services/web/app/page.js") &&
    existsSync(TEMPLATE_DIR + "services/web/app/api/todos/route.js"),
);
check(
  "template does NOT keep app code at the root",
  !existsSync(TEMPLATE_DIR + "package.json") &&
    !existsSync(TEMPLATE_DIR + "lib/db.js") &&
    !existsSync(TEMPLATE_DIR + "app/page.js"),
);

const yamlFile = read("cloudgrid.yaml");
check("cloudgrid.yaml uses active needs: (present)", /^needs:/m.test(yamlFile));
check(
  "cloudgrid.yaml does NOT use active requires: (canonical needs:, no deprecated alias)",
  !/^\s*requires:/m.test(yamlFile),
);
check("cloudgrid.yaml needs database: true", /needs:\s*\n\s*database:\s*true/.test(yamlFile));

// db.js must read the DB env var LAZILY — the reference must be inside a
// function, never at module top level (a top-level read fails `next build`).
const dbFile = read("services/web/lib/db.js");
check("services/web/lib/db.js references process.env.DATABASE_MONGODB_URL", /process\.env\.DATABASE_MONGODB_URL/.test(dbFile));
check("services/web/lib/db.js falls back to the legacy MONGODB_URL", /process\.env\.MONGODB_URL/.test(dbFile));
{
  // Strip comment lines, then flag any process.env.*_URL that appears before the
  // first function/arrow boundary (i.e. at module scope).
  const firstFn = dbFile.search(/\bfunction\b|=>\s*{|=>\s*\(/);
  const beforeFn = firstFn === -1 ? dbFile : dbFile.slice(0, firstFn);
  const beforeFnCode = beforeFn
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
  check(
    "services/web/lib/db.js does NOT read the DB connection string at module top level",
    !/process\.env\.(DATABASE_MONGODB_URL|MONGODB_URL)/.test(beforeFnCode),
  );
}

// ── 4. Example: same stack, richer ──────────────────────────────────────────
check("example reads process.env.DATABASE_MONGODB_URL", /process\.env\.DATABASE_MONGODB_URL/.test(example));
check("example declares active needs: {database: true}", /needs:\s*\n\s*database:\s*true/.test(example));
check("example uses the services/web/ layout", /services\/web\//.test(example));
check("example does NOT use active requires:", !/^\s*requires:/m.test(example));

// ── 5. Intent appears in gridctl_start menu + playbook rule ─────────────────
const server = makeServer();
registerTools(server, makeCtx());
const start = await server.handlers.gridctl_start({});
const startStruct = start?.structuredContent ?? {};
const startText = start?.content?.[0]?.text ?? "";

check(
  "gridctl_start lists the app-with-data workflow",
  (Array.isArray(startStruct.workflows) &&
    startStruct.workflows.some((w) => w.name === "app-with-data")) ||
    /app-with-data/.test(startText),
);
check(
  "gridctl_start playbook contains the persistence rule",
  /Persistence check/.test(startText) &&
    /app-with-data/.test(startText) &&
    /LOCAL edition/.test(startText),
);

// ── 6. gridctl_fetch handler returns the workflow/template/example content ──
const wfRes = await server.handlers.gridctl_fetch({ kind: "workflow", name: "app-with-data" });
const tplRes = await server.handlers.gridctl_fetch({ kind: "template", name: "app-with-data" });
const exRes = await server.handlers.gridctl_fetch({ kind: "example", name: "app-with-data" });
check("gridctl_fetch workflow app-with-data is not an error", wfRes?.isError !== true && (wfRes?.content?.[0]?.text ?? "").length > 100);
check("gridctl_fetch template app-with-data is not an error", tplRes?.isError !== true && (tplRes?.content?.[0]?.text ?? "").length > 100);
check("gridctl_fetch example app-with-data is not an error", exRes?.isError !== true && (exRes?.content?.[0]?.text ?? "").length > 100);

if (failures > 0) {
  console.log(`\n${failures} app-with-data check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll app-with-data checks passed.");
