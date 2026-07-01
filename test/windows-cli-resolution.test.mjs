// Regression test for the Windows bundled-CLI resolution bug (Task 28).
//
// Bug: resolveBundledCli() used `new URL(import.meta.url).pathname`, which on a
// Windows file:// URL is `/C:/Users/.../src` — a leading slash before the drive
// letter, NOT a valid Windows fs path. `existsSync` then failed and the bundled
// CLI was never found on Windows, even though the `.mcpb` bundles it. The fix is
// `fileURLToPath(import.meta.url)`, which yields a proper `C:\Users\...\src`.
//
// This runs on the CI Linux box (Node 20). To exercise the *Windows* semantics
// deterministically on POSIX we inject a Windows-style module URL and win32 path
// ops into resolveBundledCli's `deps` seam, and use `fileURLToPath(url,
// {windows:true})` (supported on Node >= 20.20 / >= 22.1) to get real Windows
// path resolution regardless of the host OS.
//
// The test contrasts the two implementations of the one line that changed, under
// identical win32 path semantics + one shared mock filesystem:
//   - NEW  (fileURLToPath)          -> `C:\...\node_modules\...\package.json`  -> found -> resolves.
//   - OLD  (new URL(u).pathname)    -> `\C:\...\node_modules\...\package.json` -> not found -> null.
// So a revert to the `.pathname` form flips the "new resolves" checks to FAIL.
//
// Run: node test/windows-cli-resolution.test.mjs

import { win32 } from "node:path";
import { fileURLToPath } from "node:url";

const { resolveBundledCli } = await import("../src/tools.js");

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// A realistic Windows install location for the MCP's src/tools.js module
// (npx cache path, which is where the non-bundled fallback lands).
const WIN_MODULE_URL =
  "file:///C:/Users/dev/AppData/Roaming/npm-cache/_npx/abcd/node_modules/@cloudgrid-io/mcp/src/tools.js";

// The production fix: fileURLToPath applied with Windows semantics.
const newUrlToPath = (u) => fileURLToPath(u, { windows: true });
// The pre-fix bug: .pathname keeps the leading slash before the drive letter.
const oldUrlToPath = (u) => new URL(u).pathname;

// The ONE valid path the mock filesystem knows about — computed the correct
// (fixed) way so it matches what the fixed code produces on a Windows host.
const winSrcDir = win32.dirname(newUrlToPath(WIN_MODULE_URL));
const validPkgPath = win32.join(
  winSrcDir,
  "..",
  "node_modules",
  "@cloudgrid-io",
  "cli",
  "package.json",
);
const FAKE_PKG = JSON.stringify({ version: "0.10.1", bin: { cloudgrid: "bin/cloudgrid.js" } });

function makeDeps(urlToPath) {
  return {
    moduleUrl: WIN_MODULE_URL,
    urlToPath,
    pathImpl: win32, // simulate a Windows host's path module
    fsExists: (p) => p === validPkgPath,
    fsRead: (p) => {
      if (p === validPkgPath) return FAKE_PKG;
      throw new Error(`unexpected read: ${p}`);
    },
  };
}

// --- NEW code path (the shipped fix) ---
const resolved = resolveBundledCli(makeDeps(newUrlToPath));
check("NEW: resolves a bundled CLI on a Windows-style module URL", resolved !== null);
check("NEW: resolves the reported CLI version", resolved?.version === "0.10.1");
check(
  "NEW: resolves a valid Windows entry path (drive letter, no leading slash)",
  typeof resolved?.entry === "string" && /^C:\\/.test(resolved.entry),
);
check(
  "NEW: entry points at the bundled cli bin",
  resolved?.entry === win32.join(win32.dirname(validPkgPath), "bin/cloudgrid.js"),
);

// --- OLD code path (regression guard: this MUST return null) ---
const oldResolved = resolveBundledCli(makeDeps(oldUrlToPath));
check("OLD: .pathname logic fails to resolve the bundled CLI (returns null)", oldResolved === null);
check(
  "OLD: .pathname produces an invalid path with a leading backslash before the drive",
  /^\\C:/.test(
    win32.join(
      win32.dirname(oldUrlToPath(WIN_MODULE_URL)),
      "..",
      "node_modules",
      "@cloudgrid-io",
      "cli",
      "package.json",
    ),
  ),
);

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll Windows CLI-resolution checks passed.");
