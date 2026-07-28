#!/usr/bin/env node
// Corpus edition-safety guard.
//
// The corpus is served on BOTH the local and hosted MCP editions, but only 14
// tool names exist on both. Any other `grid_*` name in corpus prose causes a
// hosted agent to call a tool it does not have.
//
// This script extracts every `grid_[a-z_]+` token from the corpus surface and
// fails if any is NOT in the shared allowlist.
//
// To regenerate the allowlist: boot the web edition
//   (EDITION=web node src/index.js), call tools/list, collect tool names.
//   Or: read src/tools/register.js up to the
//   `if (ctx.edition !== "local") return;` gate — every `grid_*` name before
//   that line is shared.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const SHARED = new Set([
  "grid_check_deploy",
  "grid_create_grid",
  "grid_get_app_source",
  "grid_get_template",
  "grid_list_grids",
  "grid_login",
  "grid_login_status",
  "grid_note",
  "grid_pickup",
  "grid_plug",
  "grid_pull",
  "grid_report",
  "grid_start",
  "grid_visibility",
]);

const CORPUS_ROOT = "src/corpus";

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".md")) out.push(p);
  }
  return out;
}

const files = walk(CORPUS_ROOT);
const RE = /\bgrid_[a-z_]+\b/g;
const violations = [];

for (const file of files) {
  const content = readFileSync(file, "utf8");
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let m;
    while ((m = RE.exec(lines[i])) !== null) {
      const name = m[0];
      if (!SHARED.has(name)) {
        violations.push({ file: relative(".", file), line: i + 1, name });
      }
    }
  }
}

if (violations.length) {
  console.error("Corpus edition-safety violation: non-shared tool names in corpus prose.\n");
  console.error("The corpus is served on both editions. Only the 14 shared tool names");
  console.error("may appear as bare grid_* tokens. Use CLI text (`grid <verb>`) for local-only");
  console.error("commands, or mark them explicitly as local MCP only.\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  ${v.name}`);
  }
  console.error(`\n${violations.length} violation(s).`);
  process.exit(1);
}

console.log(`Corpus edition-safety: ${files.length} files scanned, all tool names are shared-14.`);
