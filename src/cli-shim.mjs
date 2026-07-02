#!/usr/bin/env node
// cli-shim.mjs — runs the bundled CloudGrid CLI as a child of the MCP server.
//
//   <runtime> cli-shim.mjs <cli-entry> [cli args...]
//
// Why the MCP server spawns this shim instead of the CLI entry directly:
//
// Under Electron MCP hosts (Claude Desktop runs extensions inside an Electron
// utility process) `process.execPath` is the host's Electron binary, not Node.
// The server spawns the CLI with ELECTRON_RUN_AS_NODE=1 so an Electron runtime
// boots as Node — but that mode still exposes `process.versions.electron`, and
// commander (the CLI's argument parser) detects it: with `process.defaultApp`
// undefined it reads user arguments from `argv.slice(1)`, so the CLI entry path
// itself would be parsed as the command ("error: unknown command '/…/cli/dist/
// index.js'"). Under plain Node commander reads `argv.slice(2)` instead. This
// shim rewrites process.argv so BOTH slicings see exactly the user arguments,
// then imports the real CLI entry in-process.
//
// It also strips ELECTRON_RUN_AS_NODE from the environment: the variable has
// done its job once this file is executing, and letting it leak further would
// break anything Electron-based the CLI spawns later (e.g. a browser opened
// for `cloudgrid login` would silently boot as a headless Node process).

import { pathToFileURL } from "node:url";

delete process.env.ELECTRON_RUN_AS_NODE;

const [, , entry, ...args] = process.argv;
if (!entry) {
  console.error("cli-shim: missing CLI entry path");
  process.exit(2);
}

if (process.versions?.electron && !process.defaultApp) {
  // Electron-as-Node: commander takes user args from argv.slice(1) — the entry
  // path must NOT appear there.
  process.argv = [process.argv[0], ...args];
} else {
  // Plain Node: commander takes the script path from argv[1] and user args
  // from argv.slice(2) — the standard `node script.js args...` shape.
  process.argv = [process.argv[0], entry, ...args];
}

try {
  await import(pathToFileURL(entry).href);
} catch (err) {
  console.error(err?.stack || String(err));
  process.exit(1);
}
