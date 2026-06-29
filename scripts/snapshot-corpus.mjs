#!/usr/bin/env node
// Snapshot the documentation corpus into src/corpus/.
//
// Reads markdown from the skills repo and connect docs, copies them into
// src/corpus/ so the docs edition bundles a self-contained corpus at build
// time. Re-run this script whenever the source docs change, then commit
// the updated snapshot.
//
// Usage:
//   node scripts/snapshot-corpus.mjs [--skills-dir <path>] [--connect-dir <path>]
//
// Defaults (sibling repos):
//   --skills-dir  ../skills     (cloudgrid-io/skills)
//   --connect-dir ../connect    (cloudgrid-connect-design)

import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const CORPUS = resolve(ROOT, "src/corpus");

// Parse --skills-dir and --connect-dir from argv.
const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? resolve(args[i + 1]) : resolve(ROOT, fallback);
}

const SKILLS = flag("--skills-dir", "../skills");
const CONNECT = flag("--connect-dir", "../connect");

mkdirSync(CORPUS, { recursive: true });

const copies = [
  // Top-level docs from cloudgrid-io/skills
  [`${SKILLS}/README.md`, "skills-readme.md"],
  [`${SKILLS}/USAGE.md`, "usage.md"],
  [`${SKILLS}/INSTALL.md`, "install.md"],
  [`${SKILLS}/COOKBOOK.md`, "cookbook.md"],
  [`${SKILLS}/INSTALL_FOR_AGENTS.md`, "install-for-agents.md"],
  // Individual skill docs
  [`${SKILLS}/skills/drop/SKILL.md`, "skill-drop.md"],
  [`${SKILLS}/skills/login/SKILL.md`, "skill-login.md"],
  [`${SKILLS}/skills/claim/SKILL.md`, "skill-claim.md"],
  [`${SKILLS}/skills/init/SKILL.md`, "skill-init.md"],
  [`${SKILLS}/skills/plug/SKILL.md`, "skill-plug.md"],
  [`${SKILLS}/skills/logs/SKILL.md`, "skill-logs.md"],
  [`${SKILLS}/skills/share/SKILL.md`, "skill-share.md"],
  [`${SKILLS}/skills/feedback/SKILL.md`, "skill-feedback.md"],
  [`${SKILLS}/skills/brain/SKILL.md`, "skill-brain.md"],
  // Connect / CLI docs
  [`${CONNECT}/docs/cli-README-draft.md`, "cli-reference.md"],
];

let ok = 0;
let skipped = 0;
for (const [src, dest] of copies) {
  if (!existsSync(src)) {
    console.log(`skip  ${src} (not found)`);
    skipped++;
    continue;
  }
  copyFileSync(src, resolve(CORPUS, dest));
  console.log(`copy  ${dest}`);
  ok++;
}

console.log(`\n${ok} file(s) copied, ${skipped} skipped. Corpus in src/corpus/.`);
