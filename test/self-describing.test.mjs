// Offline test for self-describing templates + capability map (0.11.0).
//
// Any LLM should recognize a user request, pick the right template, and know its
// capabilities (Superpowers-style `when:` matching). Asserts:
//   1. Each of the 6 workflows carries the enriched frontmatter fields
//      (when / needs / deploy / editions / capabilities_note) and they parse.
//   2. grid_get_template("doc","capability-map") resolves and returns the index
//      (intent→template table + the full needs: vocabulary).
//   3. Each static template dir has a reference cloudgrid.yaml (type: static)
//      and an index.md that mentions it; the fillable HTML is still what
//      grid_get_template("template", …) returns (index.html wins — no regression).
//   4. app-with-data yaml declares the canonical active needs: {database: true}
//      and NO active requires: (the deprecated v1 alias).
//   5. GUARD: no template cloudgrid.yaml has an active needs: AND requires:
//      together (the validator rejects the combo).
//   6. The PLAYBOOK / grid_start points at the capability-map.
// Run: node test/self-describing.test.mjs

import { fetchCorpus, registerTools } from "../src/tools.js";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CORPUS = fileURLToPath(new URL("../src/corpus/", import.meta.url));
const read = (rel) => readFileSync(CORPUS + rel, "utf-8");

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// Parse the leading `---` YAML frontmatter of a corpus markdown file into a
// flat key→string map (single-line values, which is all these use).
function frontmatter(md) {
  const fm = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const out = {};
  for (const line of fm[1].split("\n")) {
    const m = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

// ── 1. Enriched workflow frontmatter ────────────────────────────────────────
const STATIC_WORKFLOWS = ["landing-page", "web-app", "dashboard", "report", "presentation"];
const ALL_WORKFLOWS = [...STATIC_WORKFLOWS, "app-with-data"];

for (const name of ALL_WORKFLOWS) {
  const md = fetchCorpus("workflow", name);
  check(`workflow ${name} resolves`, typeof md === "string" && md.length > 100);
  const fm = frontmatter(md);
  check(`workflow ${name} frontmatter parses`, !!fm);
  check(`workflow ${name} has when:`, !!fm && fm.when.length > 10);
  check(`workflow ${name} has needs:`, !!fm && fm.needs.length > 0);
  check(`workflow ${name} has deploy:`, !!fm && (fm.deploy === "inspiration" || fm.deploy === "runtime"));
  check(`workflow ${name} has editions:`, !!fm && (fm.editions === "all" || fm.editions === "local"));
  check(`workflow ${name} has capabilities_note:`, !!fm && fm.capabilities_note.length > 5);
}

// Static workflows: needs none, inspiration, all editions.
for (const name of STATIC_WORKFLOWS) {
  const fm = frontmatter(fetchCorpus("workflow", name));
  check(`workflow ${name} is static (needs: none, inspiration, all)`,
    fm.needs === "none" && fm.deploy === "inspiration" && fm.editions === "all");
}

// app-with-data: needs database, runtime, local edition; when: still fires on
// the persistence intent the app-with-data test relies on.
{
  const fm = frontmatter(fetchCorpus("workflow", "app-with-data"));
  check("app-with-data is persistent (needs: database, runtime, local)",
    fm.needs === "database" && fm.deploy === "runtime" && fm.editions === "local");
  check("app-with-data when: still fires on SAVES/PERSISTS + to-do list",
    /SAVES or PERSISTS/.test(fm.when) && /to-do list/.test(fm.when));
}

// ── 2. Capability map fetches as a doc ──────────────────────────────────────
{
  const cap = fetchCorpus("doc", "capability-map");
  check("grid_get_template(doc, capability-map) resolves", typeof cap === "string" && cap.length > 500);
  check("capability-map has the intent→template table", /Intent[\s\S]*Template[\s\S]*Deploy/.test(cap));
  check("capability-map lists all 6 templates",
    ["landing-page", "web-app", "dashboard", "report", "presentation", "app-with-data"]
      .every((t) => cap.includes(t)));
  check("capability-map documents the full needs: vocabulary (all 9)",
    ["database", "cache", "kv", "queue", "pubsub", "vector", "object_storage", "disk", "ai"]
      .every((n) => cap.includes(n)));
  check("capability-map notes cron is a service type, not a need", /cron/.test(cap) && /service type/i.test(cap));
  check("capability-map notes needs: injects (with #1527 historical note)", /#1527/.test(cap) && /[Tt]oday/.test(cap) && /[Ii]njects via `needs:`/.test(cap));
  check("capability-map states the static→inspiration / needs→runtime rule",
    /inspiration/i.test(cap) && /runtime/i.test(cap) && /local edition/i.test(cap));
}

// ── 3. Static template dirs: reference yaml + index.md; HTML still served ────
const STATIC_DIRS = ["landing-page", "web-app", "dashboard", "report", "deck"];
for (const dir of STATIC_DIRS) {
  const base = `templates/${dir}/`;
  check(`${dir} has a cloudgrid.yaml`, existsSync(CORPUS + base + "cloudgrid.yaml"));
  const yaml = read(base + "cloudgrid.yaml");
  check(`${dir} cloudgrid.yaml is type: static`, /type:\s*static/.test(yaml));
  check(`${dir} cloudgrid.yaml has the inspiration header comment`, /inspiration/i.test(yaml) && /grid_plug/.test(yaml));
  check(`${dir} cloudgrid.yaml has NO active needs:`, !/^\s*needs:/m.test(yaml));
  check(`${dir} cloudgrid.yaml has NO active requires:`, !/^\s*requires:/m.test(yaml));
  check(`${dir} has an index.md mentioning cloudgrid.yaml`,
    existsSync(CORPUS + base + "index.md") && /cloudgrid\.yaml/.test(read(base + "index.md")));
  // No regression: template fetch still returns the fillable HTML.
  const fetched = fetchCorpus("template", dir);
  check(`${dir} grid_get_template(template) still returns HTML (index.html wins)`,
    typeof fetched === "string" && fetched.trimStart().startsWith("<"));
}

// ── 4. app-with-data yaml: active canonical needs:, NO active requires: ──────
{
  const yaml = read("templates/app-with-data/cloudgrid.yaml");
  check("app-with-data yaml has active needs: {database: true}",
    /^needs:/m.test(yaml) && /database:\s*true/.test(yaml));
  check("app-with-data yaml has NO active requires: (deprecated v1 alias)", !/^\s*requires:/m.test(yaml));
}

// ── 5. GUARD: no template yaml has active needs: AND requires: together ──────
// The validator rejects the combination. Walk every cloudgrid.yaml under
// templates/ and assert at most one of the two is ACTIVE (uncommented).
function findTemplateYamls(dirRel) {
  const out = [];
  for (const name of readdirSync(CORPUS + dirRel)) {
    const rel = dirRel + name;
    const st = statSync(CORPUS + rel);
    if (st.isDirectory()) out.push(...findTemplateYamls(rel + "/"));
    else if (name === "cloudgrid.yaml") out.push(rel);
  }
  return out;
}
{
  const yamls = findTemplateYamls("templates/");
  check("found template cloudgrid.yaml files", yamls.length >= 6);
  for (const rel of yamls) {
    const yaml = read(rel);
    const activeNeeds = /^\s*needs:/m.test(yaml);
    const activeRequires = /^\s*requires:/m.test(yaml);
    check(`${rel} does NOT have active needs: AND requires: together`, !(activeNeeds && activeRequires));
  }
}

// ── 6. Playbook points at the capability-map ────────────────────────────────
function makeServer() {
  const handlers = {};
  return {
    handlers,
    registerTool(name, _c, h) { handlers[name] = h; },
    tool(name, _d, _s, _a, h) { handlers[name] = h; },
    registerResource() {},
  };
}
const ctx = {
  edition: "web",
  state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
  canOpenBrowser: false,
  getToken: async () => null,
  getActiveGrid: async () => null,
  saveToken: async () => ({}),
  savedLocationNote: () => "",
  trustedServer: null,
};
{
  const server = makeServer();
  registerTools(server, ctx);
  const start = await server.handlers.grid_start({});
  const startText = start?.content?.[0]?.text ?? "";
  check("grid_start playbook mentions the capability-map", /capability-map/.test(startText));
}

if (failures > 0) {
  console.log(`\n${failures} self-describing check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll self-describing checks passed.");
