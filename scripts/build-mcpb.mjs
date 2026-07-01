#!/usr/bin/env node
// scripts/build-mcpb.mjs — build the CloudGrid .mcpb desktop extension
//
// Creates a staging directory, copies source + production node_modules,
// then packs into cloudgrid.mcpb via @anthropic-ai/mcpb.
//
// Why staging? `mcpb pack` respects the repo's .gitignore when run inside
// a git work-tree, which excludes node_modules. A staging dir outside the
// repo avoids this and gives us full control over what ships in the bundle.

import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const manifestPath = join(root, "manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

// ── Sync version from package.json → manifest.json ──────────────────────
if (manifest.version !== pkg.version) {
  console.log(`manifest version ${manifest.version} → ${pkg.version}`);
  manifest.version = pkg.version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

// ── Stage ───────────────────────────────────────────────────────────────
const stage = join(tmpdir(), `cloudgrid-mcpb-${Date.now()}`);
console.log(`\n— stage → ${stage}`);
mkdirSync(stage, { recursive: true });

const copy = (rel) => cpSync(join(root, rel), join(stage, rel), { recursive: true });

copy("manifest.json");
copy("package.json");
copy("package-lock.json");
copy("LICENSE");
copy("src/index.js");
copy("src/auth.js");
copy("src/tools.js");
copy("src/widgets");
copy("src/corpus"); // gridctl_fetch reads the bundled corpus (workflows/templates/examples/docs)
copy("assets/cloudgrid-icon-512.png");

// Install production deps (clean, no dev deps, no scripts to avoid side-effects)
console.log("\n— npm ci --omit=dev");
execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], {
  cwd: stage,
  stdio: "inherit",
});

// The CLI is no longer a normal dependency (keeps npx installs light), but the
// .mcpb must be offline-complete — install it explicitly into the staging area.
console.log("\n— npm install @cloudgrid-io/cli (bundle for .mcpb)");
execFileSync("npm", ["install", "--no-save", "@cloudgrid-io/cli@~0.10.1", "--ignore-scripts"], {
  cwd: stage,
  stdio: "inherit",
});

// Write .mcpbignore for the staging dir (exclude lockfile, npm cache)
writeFileSync(
  join(stage, ".mcpbignore"),
  ["package-lock.json", "node_modules/.package-lock.json", ".mcpbignore"].join(
    "\n"
  ) + "\n"
);

const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const run = (args, cwd = stage) =>
  execFileSync(npx, args, { cwd, stdio: "inherit" });

// ── Validate ────────────────────────────────────────────────────────────
console.log("\n— validate manifest");
run(["-y", "@anthropic-ai/mcpb", "validate", "manifest.json"]);

// ── Pack ────────────────────────────────────────────────────────────────
const out = "cloudgrid.mcpb";
const outAbs = join(root, out);
console.log(`\n— pack → ${out}`);
run(["-y", "@anthropic-ai/mcpb", "pack", ".", outAbs]);

// ── Cleanup ─────────────────────────────────────────────────────────────
rmSync(stage, { recursive: true, force: true });

// ── Report ──────────────────────────────────────────────────────────────
const { size } = statSync(outAbs);
const mb = (size / 1024 / 1024).toFixed(1);
console.log(`\n✓ ${out}  ${mb} MB`);
