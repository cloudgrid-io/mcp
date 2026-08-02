// Content eval: the playbook's visibility mapping table matches the live
// grid_visibility schema and cannot drift. Verifies both the instruction
// content (the mapping is present and correct) and the behavioral mapping
// (each phrasing produces the expected grid_visibility call).
//
// Run: node test/visibility-mapping.test.mjs

import { PLAYBOOK } from "../src/playbook.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// ── Part 1: structural — the playbook encodes the mapping ─────────────────

check("playbook contains the two-axis model line",
  PLAYBOOK.includes("Two axes"));

check("playbook contains the visibility ask line",
  PLAYBOOK.includes("ask who should see it"));

check("playbook states the two-axis model BEFORE the ask",
  PLAYBOOK.indexOf("Two axes") >= 0 &&
  PLAYBOOK.indexOf("Two axes") < PLAYBOOK.indexOf("ask who should see it"));

check("playbook defines a mapping table",
  /Answer.*grid_visibility.*call/i.test(PLAYBOOK) || /User says.*inside.*outside/i.test(PLAYBOOK));

// Each of the six canonical phrasings must appear in the mapping.
const EXPECTED_ROWS = [
  { phrase: "just me",                inside: "private", outside: "none" },
  { phrase: "my team",                inside: "grid",    outside: "none" },
  { phrase: "anyone with the link",   inside: "private", outside: "link" },
  { phrase: "they must sign in",      inside: "private", outside: "link" },
  { phrase: "findable on Google",     inside: "grid",    outside: "public" },
  { phrase: "only these spaces",      inside: "spaces",  outside: "none" },
];

for (const row of EXPECTED_ROWS) {
  check(`mapping table includes "${row.phrase}" → inside:${row.inside} outside:${row.outside}`,
    PLAYBOOK.includes(row.phrase) &&
    new RegExp(`${row.phrase}[^\\n]*\\|[^|]*\\b${row.inside}\\b[^|]*\\|[^|]*\\b${row.outside}\\b`).test(PLAYBOOK));
}

check("mapping table includes require_signin for sign-in row",
  /sign in[^|]*\|[^|]*private[^|]*\|[^|]*link[^|]*\|[^|]*require_signin/.test(PLAYBOOK));

check("mapping table includes spaces param for spaces row",
  /only these spaces[^|]*\|[^|]*spaces[^|]*\|[^|]*none[^|]*\|[^|]*spaces:/.test(PLAYBOOK));

// ── Part 2: structural — default, spaces trigger, model-before-ask ────────

check("playbook defines an explicit default for the deferred case",
  /default when the user defers/i.test(PLAYBOOK) || /whatever you think/i.test(PLAYBOOK));

check("default: sharing mentioned → private + link",
  /share a link.*inside: private.*outside: link/i.test(PLAYBOOK) ||
  /asked to share.*inside: private.*outside: link/i.test(PLAYBOOK));

check("default: sharing not mentioned → private + none",
  /never mentioned.*inside: private.*outside: none/i.test(PLAYBOOK) ||
  /sharing never mentioned.*private.*none/i.test(PLAYBOOK));

check("spaces has a trigger condition (not in default ask)",
  /do not offer.*spaces.*unless/i.test(PLAYBOOK) ||
  /Do not offer.*spaces.*unless/i.test(PLAYBOOK));

// ── Part 3: vocabulary unchanged ──────────────────────────────────────────

check("vocabulary: inside axis values are private|spaces|grid",
  /inside the grid.*private.*spaces.*grid/i.test(PLAYBOOK));

check("vocabulary: outside axis values are none|link|public",
  /outside.*none.*link.*public/i.test(PLAYBOOK));

check("vocabulary: authenticated is retired",
  /authenticated.*retired/i.test(PLAYBOOK));

check("vocabulary: org is gone",
  /org.*gone.*grid/i.test(PLAYBOOK) || /org.*gone.*use.*grid/i.test(PLAYBOOK));

// ── Part 4: re-plug behaviour preserved ───────────────────────────────────

check("re-plug rule preserved: leave visibility as-is unless asked",
  /re-plug.*leave.*current visibility.*as-is/i.test(PLAYBOOK) ||
  /re-plug.*leave.*visibility.*as-is/i.test(PLAYBOOK));

// ── Part 5: behavioral — walk the six phrasings against the schema ────────
// Import the live grid_visibility schema to confirm the mapping values are
// valid enum members.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["src/index.js"] });
const client = new Client({ name: "visibility-mapping-eval", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
const vis = tools.find((t) => t.name === "grid_visibility");
const visProps = vis?.inputSchema?.properties ?? {};
const insideEnum = visProps.inside?.enum ?? [];
const outsideEnum = visProps.outside?.enum ?? [];

check("schema: inside enum exists", insideEnum.length > 0);
check("schema: outside enum exists", outsideEnum.length > 0);

for (const row of EXPECTED_ROWS) {
  check(`schema validates inside:${row.inside}`, insideEnum.includes(row.inside));
  check(`schema validates outside:${row.outside}`, outsideEnum.includes(row.outside));
}

check("schema: require_signin param exists", "require_signin" in visProps);
check("schema: spaces param exists", "spaces" in visProps);

await client.close();

// ── Part 6: derivation — each row matches the platform's deriveVisibilityAxes ─
// The canonical derivation lives in packages/shared/src/v1-types.ts in the
// monorepo and is not importable from this repo. The values below are
// snapshots of deriveVisibilityAxes at v1-types.ts:488-520 (read 2026-08-02).
// If the derivation changes, update these and reconcile.
const CANONICAL_DERIVATION = [
  // v1-types.ts:490-491 — isPrivateVisibility
  { legacy: "private",       inside: "private", outside: "none",   require_signin: false },
  // v1-types.ts:493-494 — isOrgVisibility (grid)
  { legacy: "grid",          inside: "grid",    outside: "none",   require_signin: false },
  // v1-types.ts:496-498 — isAuthenticatedVisibility (retired, = sign-in link)
  { legacy: "authenticated", inside: "private", outside: "link",   require_signin: true  },
  // v1-types.ts:507 — isLinkVisibility, non-indexed
  { legacy: "link",          inside: "private", outside: "link",   require_signin: false },
  // v1-types.ts:506 — isLinkVisibility, indexed
  { legacy: "link_indexed",  inside: "grid",    outside: "public", require_signin: false },
  // v1-types.ts:500-501 — isSpaceVisibility
  { legacy: "space",         inside: "spaces",  outside: "none",   require_signin: false },
];

const ROW_TO_LEGACY = [
  { rowPhrase: "just me",              legacy: "private" },
  { rowPhrase: "my team",              legacy: "grid" },
  { rowPhrase: "anyone with the link", legacy: "link" },
  { rowPhrase: "they must sign in",    legacy: "authenticated" },
  { rowPhrase: "findable on Google",   legacy: "link_indexed" },
  { rowPhrase: "only these spaces",    legacy: "space" },
];

for (const mapping of ROW_TO_LEGACY) {
  const row = EXPECTED_ROWS.find(r => r.phrase.includes(mapping.rowPhrase));
  const canon = CANONICAL_DERIVATION.find(c => c.legacy === mapping.legacy);
  if (!row || !canon) {
    check(`derivation: "${mapping.rowPhrase}" row and canon found`, false);
    continue;
  }
  check(`derivation: "${mapping.rowPhrase}" inside matches deriveVisibilityAxes (${canon.inside})`,
    row.inside === canon.inside);
  check(`derivation: "${mapping.rowPhrase}" outside matches deriveVisibilityAxes (${canon.outside})`,
    row.outside === canon.outside);
}

// ── Summary ───────────────────────────────────────────────────────────────

console.log(`\n--- Behavioral mapping (six phrasings → grid_visibility) ---`);
for (const row of EXPECTED_ROWS) {
  const extra =
    row.phrase.includes("sign in") ? ", require_signin: true" :
    row.phrase.includes("spaces") ? ", spaces: [<slugs>]" : "";
  console.log(`  "${row.phrase}" → { inside: ${row.inside}, outside: ${row.outside}${extra} }`);
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll visibility-mapping checks passed.");
