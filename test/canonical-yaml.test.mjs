// Offline test for the canonical cloudgrid.yaml reference doc (0.11.1).
//
// The MCP/agents/builders fetch one practically-complete cloudgrid.yaml schema so
// they author the manifest correctly. Asserts:
//   1. gridctl_fetch("doc","cloudgrid-yaml") resolves (via fetchCorpus AND the real
//      gridctl_fetch handler) and returns substantial content.
//   2. The doc carries the full needs: vocabulary (all 9) + the injected env var
//      names, at least one full example, and the requires-vs-needs caveat.
//   3. The DB example uses an ACTIVE requires: [mongodb] and only a COMMENTED
//      canonical needs: — never an active needs:+requires: together (validator
//      rejects the combo). This is the guard, extended from the Task-41 guard.
//   4. The header cites the upstream canonical + a keep-in-sync note, and the doc
//      cross-links the capability-map.
//   5. Wiring: the gridctl_start PLAYBOOK points at the reference; capability-map
//      cross-links back to cloudgrid-yaml.
// Run: node test/canonical-yaml.test.mjs

import { fetchCorpus, registerTools } from "../src/tools.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CORPUS = fileURLToPath(new URL("../src/corpus/", import.meta.url));
const read = (rel) => readFileSync(CORPUS + rel, "utf-8");

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// ── 1. The doc fetches as a top-level `doc` (same mechanism as capability-map) ─
const doc = fetchCorpus("doc", "cloudgrid-yaml");
check("gridctl_fetch(doc, cloudgrid-yaml) resolves", typeof doc === "string" && doc.length > 2000);

// ── 2. Needs vocabulary + injected env vars + a full example ─────────────────
check("doc documents the full needs: vocabulary (all 9)",
  ["database", "cache", "kv", "queue", "pubsub", "vector", "object_storage", "disk", "ai"]
    .every((n) => doc.includes(n)));
check("doc lists the injected env var names",
  ["DATABASE_MONGODB_URL", "CACHE_REDIS_URL", "VECTOR_PGVECTOR_URL", "AI_GATEWAY_URL", "DISK_PATH"]
    .every((v) => doc.includes(v)));
check("doc notes the legacy injected aliases (today via requires:)",
  doc.includes("MONGODB_URL") && doc.includes("REDIS_URL"));
check("doc lists the always-injected vars",
  ["PORT", "APP_NAME", "SERVICE_NAME", "NODE_ENV"].every((v) => doc.includes(v)));
check("doc has the full annotated (kitchen-sink) example",
  /kitchen sink/i.test(doc) && /custom_domains/.test(doc) && /depends_on/.test(doc));
check("doc has the service-types table (node/nextjs/python/static/cron)",
  ["node", "nextjs", "python", "static", "cron"].every((t) => doc.includes(t)));
check("doc has minimal examples (static + node + nextjs + agent/cron)",
  /type:\s*static/.test(doc) && /type:\s*node/.test(doc) && /type:\s*nextjs/.test(doc) && /type:\s*cron/.test(doc));
check("doc has validation rules (name charset, one service at /, reserved env, depends_on)",
  /\^\[a-z\]/.test(doc) && /Only one service can\s+claim/.test(doc) &&
  /[Rr]eserved/.test(doc) && /circular/.test(doc));

// ── 2b. The requires-vs-needs caveat box ─────────────────────────────────────
check("doc has the requires-vs-needs caveat referencing #1527",
  /#1527/.test(doc) && /requires:/.test(doc) && /needs:/.test(doc));
check("doc caveat: use requires: [mongodb] / [redis] today",
  /requires:\s*\[mongodb\]/.test(doc) && /requires:\s*\[redis\]/.test(doc));
check("doc caveat: needs: and requires: together are rejected",
  /(reject|one or the other)/i.test(doc));
check("doc caveat: static → inspiration (gridctl_drop) / services: → runtime",
  /inspiration/i.test(doc) && /gridctl_drop/.test(doc) && /runtime/i.test(doc) && /local edition/i.test(doc));

// ── 3. GUARD: the DB example uses active requires: + only a COMMENTED needs: ──
// Extract fenced code blocks and, for the ones that are cloudgrid.yaml manifests,
// assert no block has BOTH an active needs: AND an active requires: (validator
// rejects the combo). A commented `# needs:` alongside an active requires: is OK.
const codeBlocks = [...doc.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1]);
check("doc contains yaml code blocks", codeBlocks.length >= 4);

// The DB example: active requires: [mongodb], commented canonical needs:.
const dbBlock = codeBlocks.find((b) => /requires:/.test(b) && /-\s*mongodb/.test(b));
check("doc has a DB example with active requires: [mongodb]",
  !!dbBlock && /^requires:/m.test(dbBlock) && /-\s*mongodb/.test(dbBlock));
check("doc DB example has NO active needs: (only a comment)",
  !!dbBlock && !/^\s*needs:/m.test(dbBlock));
check("doc DB example SHOWS the canonical needs: as a comment",
  !!dbBlock && /#\s*needs:/.test(dbBlock) && /database:\s*true/.test(dbBlock));

// The guard: no single yaml manifest block shows active needs: AND requires:.
// (The annotated kitchen-sink block shows an active `needs:` but NO `requires:`,
// so it passes; the DB block shows an active `requires:` but no active `needs:`.)
for (const [i, block] of codeBlocks.entries()) {
  const activeNeeds = /^\s*needs:/m.test(block);
  const activeRequires = /^\s*requires:/m.test(block);
  check(`doc yaml block #${i + 1} does NOT have active needs: AND requires: together`,
    !(activeNeeds && activeRequires));
}

// ── 4. Header cites the canonical source + cross-links capability-map ────────
check("doc header cites the canonical cloudgrid-yaml-reference.md",
  /cloudgrid-yaml-reference\.md/.test(doc));
check("doc header has a keep-in-sync note", /keep in sync/i.test(doc));
check("doc cross-links the capability-map", /capability-map/.test(doc));

// ── 5. Wiring: PLAYBOOK points at the reference; capability-map links back ───
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
  const start = await server.handlers.gridctl_start({});
  const startText = start?.content?.[0]?.text ?? "";
  check("gridctl_start playbook points at the cloudgrid-yaml reference",
    /cloudgrid-yaml/.test(startText));

  // The real gridctl_fetch handler resolves the doc too (not just fetchCorpus).
  const fetched = await server.handlers.gridctl_fetch({ kind: "doc", name: "cloudgrid-yaml" });
  const fetchedText = fetched?.content?.[0]?.text ?? "";
  check("gridctl_fetch handler returns the cloudgrid-yaml doc",
    fetchedText.length > 2000 && /#1527/.test(fetchedText));
}
check("capability-map cross-links cloudgrid-yaml",
  /cloudgrid-yaml/.test(read("capability-map.md")));

if (failures > 0) {
  console.log(`\n${failures} canonical-yaml check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll canonical-yaml checks passed.");
