// Tool annotations gate (cloudgrid-io/cloudgrid#2302).
//
// Directory reviews read every tool's title and safety hints: the Claude
// connector directory requires a `title` and the applicable `readOnlyHint` /
// `destructiveHint`; the ChatGPT directory requires `readOnlyHint`,
// `destructiveHint` and `openWorldHint` as explicit booleans on every tool.
// test:tool-titles-and-vocab checks titles on the local edition only, so a new
// tool could ship without hints, or the hosted edition could drift, with CI
// green. This test closes that:
//
//   1. Both editions: every registered tool has a non-empty title and all three
//      hints as explicit booleans, and no tool is both read-only and destructive.
//   2. Hosted edition: the hints match the reviewed table below, tool by tool,
//      and the hosted tool set is exactly the table's. Changing a hint, or
//      adding a hosted tool, means editing the table, which review then sees.
//   3. Self-test: the checker is run against broken fixtures first, so a green
//      run proves each rule can fail.
//
// Run: node test/tool-annotations.test.mjs

import { registerTools } from "../src/tools.js";

let failures = 0;
function check(label, cond, detail = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${!cond && detail ? `\n     ${detail}` : ""}`);
  if (!cond) failures++;
}

const HINTS = ["readOnlyHint", "destructiveHint", "openWorldHint"];

// Returns a list of problems for one tool config; empty means it passes.
export function annotationProblems(name, cfg) {
  const problems = [];
  if (typeof cfg?.title !== "string" || cfg.title.trim() === "") problems.push(`${name}: no title`);
  const a = cfg?.annotations;
  if (!a || typeof a !== "object") {
    problems.push(`${name}: no annotations`);
    return problems;
  }
  for (const h of HINTS) {
    if (typeof a[h] !== "boolean") problems.push(`${name}: ${h} is not an explicit boolean`);
  }
  if (a.readOnlyHint === true && a.destructiveHint === true) {
    problems.push(`${name}: readOnlyHint and destructiveHint are both true`);
  }
  return problems;
}

// The reviewed hints for every hosted tool: [readOnly, destructive, openWorld].
// Sign-in on the hosted edition goes through the AI tool, so grid_login and
// grid_login_status are local-only and absent here.
// Reasons, for the reviewer notes:
// - read-only: the tool changes nothing (lookups, status, source fetch).
// - destructive: grid_plug can replace a live app in place; grid_visibility can
//   narrow who reaches a live app; grid_delete archives one.
// - closed world: grid_start and grid_get_template read only the bundled corpus
//   and the session; every other tool calls the CloudGrid API, and what it
//   publishes or reads can be public.
const HOSTED = {
  grid_start: [true, false, false],
  grid_get_template: [true, false, false],
  grid_get_app_source: [true, false, true],
  grid_list_grids: [true, false, true],
  grid_check_deploy: [true, false, true],
  grid_create_grid: [false, false, true],
  grid_plug: [false, true, true],
  grid_hello: [false, false, true],
  grid_visibility: [false, true, true],
  grid_collab: [false, false, true],
  grid_pickup: [false, false, true],
  grid_pull: [false, false, true],
  grid_delete: [false, true, true],
  grid_note: [false, false, true],
  grid_report: [false, false, true],
};

function capture(edition) {
  const configs = {};
  const server = {
    registerTool: (name, cfg) => { configs[name] = cfg; },
    tool: () => {},
    registerResource: () => {},
  };
  registerTools(server, {
    edition,
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
    canOpenBrowser: false,
    getToken: async () => null,
    getActiveGrid: async () => null,
    saveToken: async () => ({}),
    savedLocationNote: () => "",
    logger: null,
  });
  return configs;
}

// ── 3. self-test first: each rule rejects a broken fixture ──────────────────
{
  const good = { title: "T", annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } };
  check("self-test: a complete config passes", annotationProblems("x", good).length === 0);
  check("self-test: a missing title fails", annotationProblems("x", { ...good, title: " " }).length === 1);
  check("self-test: missing annotations fail", annotationProblems("x", { title: "T" }).length === 1);
  for (const h of HINTS) {
    const a = { ...good.annotations };
    delete a[h];
    check(`self-test: a missing ${h} fails`, annotationProblems("x", { title: "T", annotations: a }).length === 1);
  }
  check(
    "self-test: a string hint fails",
    annotationProblems("x", { title: "T", annotations: { ...good.annotations, openWorldHint: "false" } }).length === 1,
  );
  check(
    "self-test: read-only and destructive together fails",
    annotationProblems("x", { title: "T", annotations: { readOnlyHint: true, destructiveHint: true, openWorldHint: true } }).length === 1,
  );
}

// ── 1. both editions: title + three explicit hints on every tool ────────────
const editions = { web: capture("web"), local: capture("local") };
for (const [edition, configs] of Object.entries(editions)) {
  const names = Object.keys(configs);
  const min = edition === "web" ? 15 : 17;
  check(`[${edition}] tools registered (${names.length})`, names.length >= min);
  const problems = names.flatMap((n) => annotationProblems(n, configs[n]));
  check(`[${edition}] every tool has a title and all three hints`, problems.length === 0, problems.join("; "));
}

// ── 2. hosted edition: hints match the reviewed table ───────────────────────
{
  const web = editions.web;
  const got = Object.keys(web).sort();
  const want = Object.keys(HOSTED).sort();
  check(
    `hosted tool set is exactly the reviewed table (${want.length})`,
    JSON.stringify(got) === JSON.stringify(want),
    `extra: ${got.filter((n) => !want.includes(n)).join(", ") || "none"}; missing: ${want.filter((n) => !got.includes(n)).join(", ") || "none"}`,
  );
  for (const [name, [ro, de, ow]] of Object.entries(HOSTED)) {
    const a = web[name]?.annotations ?? {};
    check(
      `hosted ${name}: readOnly=${ro} destructive=${de} openWorld=${ow}`,
      a.readOnlyHint === ro && a.destructiveHint === de && a.openWorldHint === ow,
      `declared readOnly=${a.readOnlyHint} destructive=${a.destructiveHint} openWorld=${a.openWorldHint}`,
    );
  }
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll tool-annotations checks passed.");
