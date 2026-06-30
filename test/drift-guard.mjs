// Drift guard: assert every CLI-wrapping tool's top-level verb exists in the
// installed CLI. Catches CLI verb renames/removals at PR time instead of in prod.
//
// Run:  node test/drift-guard.mjs
//
// Requires the cloudgrid CLI on $PATH or reachable via npx.
// The test parses `cloudgrid --help` and checks that every top-level verb
// referenced by CLI_TOOL_VERBS appears in the Commands list.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CLI_TOOL_VERBS } from "../src/tools.js";

const execFileAsync = promisify(execFile);

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// ── Resolve the CLI ─────────────────────────────────────────────────────────
// Always use the pinned version via npx to guarantee the test runs against the
// same CLI version the MCP is tested against — not whatever is on $PATH.

const CLI_PIN = "@cloudgrid-io/cli@~0.10.1";

async function getHelpText() {
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const { stdout } = await execFileAsync(
    npx,
    ["-y", CLI_PIN, "--help"],
    { timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] },
  );
  return stdout;
}

// ── Parse the Commands section from --help ──────────────────────────────────

function parseVerbs(helpText) {
  // Each command line in the help starts with exactly two spaces then the verb:
  //   init [options] [kind] [name]          Set up the current folder, ...
  // Continuation lines are indented much further (40+ spaces). We only match
  // lines starting with exactly "  " followed by a word character.
  const verbs = new Set();
  let inCommands = false;
  for (const line of helpText.split("\n")) {
    if (/^\s*Commands:/.test(line)) {
      inCommands = true;
      continue;
    }
    if (!inCommands) continue;
    // Command lines start with exactly 2 spaces, then the verb name.
    const m = line.match(/^  (\w[\w-]*)/);
    if (m) verbs.add(m[1]);
  }
  return verbs;
}

// ── Run the guard ───────────────────────────────────────────────────────────

console.log("drift-guard: fetching cloudgrid --help …");
const helpText = await getHelpText();
const availableVerbs = parseVerbs(helpText);

console.log(`drift-guard: CLI exposes ${availableVerbs.size} top-level verbs`);
check("parsed at least 20 verbs", availableVerbs.size >= 20);

const toolEntries = Object.entries(CLI_TOOL_VERBS);
console.log(`drift-guard: checking ${toolEntries.length} CLI-wrapping tools …\n`);

for (const [tool, verbs] of toolEntries) {
  for (const verb of verbs) {
    check(`${tool} → "${verb}" exists in CLI`, availableVerbs.has(verb));
  }
}

console.log("");

if (failures > 0) {
  console.log(`${failures} drift-guard check(s) FAILED.`);
  console.log("A CLI verb referenced by the MCP is missing from `cloudgrid --help`.");
  console.log("Either the CLI removed/renamed the verb, or CLI_TOOL_VERBS in src/tools.js needs updating.");
  process.exit(1);
}
console.log("All drift-guard checks passed.");
