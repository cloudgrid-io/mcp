#!/usr/bin/env node
// Cross-repo corpus drift check.
//
// The CloudGrid corpus lives twice by design: cloudgrid-io/mcp ships it inside
// the npm package (src/corpus/), and cloudgrid-io/skills ships it as plugin
// files (repo root). The twin trees MUST be byte-identical - drift means an
// agent gets different instructions depending on which channel it reads
// (2026-07: the skills copy silently taught dead tool names for a week).
//
// This script clones the sibling repo's main at depth 1 and diffs the twin
// trees strictly: any content difference OR one-sided file fails. Zero
// exceptions - if a difference is ever intentional, encode it here explicitly.
//
// Runs on push-to-main + daily cron (NOT on PRs: corpus changes land as
// paired PRs, and the first of a pair is legitimately ahead of the sibling).
//
// Exit 0 = in sync. Exit 1 = drift (differences listed).

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";

// Which repo are we running in? The skills repo has capability-map.md at the
// root; the mcp repo has it under src/corpus/.
const IN_SKILLS = existsSync("capability-map.md");
const SIBLING_URL = IN_SKILLS
  ? "https://github.com/cloudgrid-io/mcp.git"
  : "https://github.com/cloudgrid-io/skills.git";

const clone = mkdtempSync(join(tmpdir(), "corpus-sibling-"));
execFileSync("git", ["clone", "--depth", "1", "--branch", "main", SIBLING_URL, clone], {
  stdio: ["ignore", "ignore", "inherit"],
});

const localRoot = IN_SKILLS ? "." : "src/corpus";
const siblingRoot = IN_SKILLS ? join(clone, "src/corpus") : clone;

// The twin surface: two top-level docs + three directory trees.
const TWIN_FILES = ["capability-map.md", "cloudgrid-yaml.md"];
const TWIN_DIRS = ["workflows", "templates", "examples"];

function walk(dir, base) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p));
  }
  return out;
}

const problems = [];

function compareFile(rel) {
  const a = join(localRoot, rel);
  const b = join(siblingRoot, rel);
  const inA = existsSync(a);
  const inB = existsSync(b);
  if (!inA && !inB) return;
  if (!inA) return problems.push(`only in sibling: ${rel}`);
  if (!inB) return problems.push(`only in this repo: ${rel}`);
  if (!readFileSync(a).equals(readFileSync(b))) problems.push(`content differs: ${rel}`);
}

for (const f of TWIN_FILES) compareFile(f);
for (const d of TWIN_DIRS) {
  const aDir = join(localRoot, d);
  const bDir = join(siblingRoot, d);
  const rels = new Set([
    ...(existsSync(aDir) ? walk(aDir, localRoot) : []),
    ...(existsSync(bDir) ? walk(bDir, siblingRoot) : []),
  ]);
  for (const rel of [...rels].sort()) compareFile(rel);
}

if (problems.length) {
  console.error(`Corpus drift against ${SIBLING_URL} (main):`);
  for (const p of problems) console.error(`  DRIFT ${p}`);
  console.error(
    `\n${problems.length} drift(s). Fix by mirroring the change to the sibling repo ` +
      `(the twins must stay byte-identical).`,
  );
  process.exit(1);
}
console.log("Corpus twins in sync - no drift.");
