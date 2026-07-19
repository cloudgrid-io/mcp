// Regression test for the Claude Desktop .mcpb Electron-spawn bug (Task 30).
//
// Bug: runCloudgrid()'s bundled-CLI rung spawned `process.execPath` as if it
// were Node, with no env override. Under Electron MCP hosts (Claude Desktop
// runs extensions inside an Electron utility process) execPath is the host's
// Electron helper binary: the child boots as an Electron app and dies with
// FATAL "Unable to find helper app" (or hangs as a GUI app until the exec
// timeout). The rung then THREW instead of falling through, so the global-CLI
// and npx fallbacks were unreachable — every CLI-wrapping tool failed.
//
// The fix, asserted here against the real runCloudgrid via its deps seam
// (spy exec fn + fake bundled-CLI resolver; same pattern as
// windows-cli-resolution.test.mjs):
//   1. Every process.execPath spawn carries env ELECTRON_RUN_AS_NODE=1
//      (harmless under plain Node) and routes through src/cli-shim.mjs.
//   2. resolveNodeRuntime() never blindly trusts execPath: under Electron it
//      probes real Node binaries, and uses execPath-as-node only after a
//      verified run-as-node probe (Claude Desktop's runAsNode fuse is disabled,
//      so the probe fails there).
//   3. A runtime boot failure falls through to the fallback rungs; a genuine
//      CLI error still surfaces (no double execution).
//   4. Fallback rungs get a PATH augmented with the usual install locations
//      (the utility-process PATH is bare) and no ELECTRON_RUN_AS_NODE.
//
// On the pre-fix code these checks fail (no env override, no shim, no
// fall-through, runCloudgrid not even exported). Run:
//   node test/electron-spawn-env.test.mjs

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const { runCloudgrid, resolveNodeRuntime } = await import("../src/tools.js");
const { MIN_CLI_VERSION } = await import("../src/tools/constants.js");

const execFileAsync = promisify(execFile);
const CLI_SHIM = fileURLToPath(new URL("../src/cli-shim.mjs", import.meta.url));
const FAKE_ENTRY = "/fake/node_modules/@cloudgrid-io/cli/dist/index.js";
const IS_WIN = process.platform === "win32";
// A fixture CLI version that meets the current floor, derived from the floor
// itself so this test can never drift below it again (a bump to MIN_CLI_VERSION
// used to silently push the fixture under the floor, skipping the bundled rung
// and failing every "CLI is usable" assertion below).
const GOOD_VERSION = MIN_CLI_VERSION;

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// Records every exec call and answers via a caller-supplied handler.
function makeExecSpy(handler) {
  const calls = [];
  const spy = async (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    return handler(call);
  };
  spy.calls = calls;
  return spy;
}

const fakeResolveCli = () => ({ entry: FAKE_ENTRY, version: GOOD_VERSION });

function electronFatalError() {
  const err = new Error("Command failed");
  err.code = 1;
  err.stderr =
    "[0702/114529.335911:FATAL:electron/shell/app/electron_main_delegate_mac.mm:66] Unable to find helper app";
  return err;
}

// ── 1. The headline regression: execPath spawns carry ELECTRON_RUN_AS_NODE ───
{
  const exec = makeExecSpy(() => ({ stdout: "WHOAMI OK\n", stderr: "" }));
  const result = await runCloudgrid(["whoami"], {}, { exec, resolveCli: fakeResolveCli });
  const call = exec.calls[0];
  check("bundled rung: tool result comes from the spawned CLI", result === "WHOAMI OK");
  check("bundled rung: exactly one spawn (no fallback on success)", exec.calls.length === 1);
  check("bundled rung: spawns process.execPath on a plain-Node host", call?.command === process.execPath);
  check(
    "bundled rung: spawn env carries ELECTRON_RUN_AS_NODE=1 (THE regression)",
    call?.options?.env?.ELECTRON_RUN_AS_NODE === "1",
  );
  check(
    "bundled rung: spawn env inherits the parent env (spread, not replaced)",
    call?.options?.env?.PATH === process.env.PATH,
  );
  check("bundled rung: routes through cli-shim.mjs", call?.args?.[0] === CLI_SHIM);
  check(
    "bundled rung: shim gets the CLI entry, then the user args",
    call?.args?.[1] === FAKE_ENTRY && call?.args?.[2] === "whoami",
  );
  check("bundled rung: keeps the 10-minute exec timeout", call?.options?.timeout === 10 * 60 * 1000);
}

// ── 2. A genuine CLI error still surfaces (no fall-through double-execution) ─
{
  const exec = makeExecSpy(() => {
    const err = new Error("Command failed");
    err.code = 1;
    err.stderr = "Error: not logged in — run cloudgrid login";
    throw err;
  });
  let thrown = null;
  try {
    await runCloudgrid(["whoami"], {}, { exec, resolveCli: fakeResolveCli });
  } catch (err) {
    thrown = err;
  }
  check("CLI error: surfaces to the caller", thrown !== null && /not logged in/.test(thrown.message));
  check("CLI error: does NOT re-run the command on a fallback rung", exec.calls.length === 1);
}

// ── 3. Electron helper FATAL falls through to the global-CLI rung ────────────
{
  const exec = makeExecSpy(({ command, args }) => {
    if (command === process.execPath) throw electronFatalError();
    if (String(args[args.length - 1]).includes("--version")) return { stdout: `${GOOD_VERSION}\n`, stderr: "" };
    return { stdout: "GLOBAL OK\n", stderr: "" };
  });
  const result = await runCloudgrid(["whoami"], {}, { exec, resolveCli: fakeResolveCli });
  check("helper FATAL: falls through and the global CLI answers", result === "GLOBAL OK");
  const fallback = exec.calls.find((c) => c.command !== process.execPath);
  check(
    "helper FATAL: fallback env has no ELECTRON_RUN_AS_NODE",
    fallback && !("ELECTRON_RUN_AS_NODE" in fallback.options.env),
  );
  if (!IS_WIN) {
    check(
      "helper FATAL: fallback PATH is augmented with /usr/local/bin and /opt/homebrew/bin",
      fallback &&
        fallback.options.env.PATH.split(":").includes("/usr/local/bin") &&
        fallback.options.env.PATH.split(":").includes("/opt/homebrew/bin"),
    );
  }
}

// ── 4. No usable runtime at all: bundled rung is skipped, fallbacks run ───────
{
  const exec = makeExecSpy(({ args }) => {
    if (String(args[args.length - 1]).includes("--version")) return { stdout: `${GOOD_VERSION}\n`, stderr: "" };
    return { stdout: "GLOBAL OK\n", stderr: "" };
  });
  const result = await runCloudgrid(
    ["whoami"],
    {},
    { exec, resolveCli: fakeResolveCli, resolveRuntime: async () => null },
  );
  check("no runtime: global CLI answers", result === "GLOBAL OK");
  check(
    "no runtime: process.execPath is never spawned",
    exec.calls.every((c) => c.command !== process.execPath),
  );
}

// ── 5. No runtime + all fallbacks fail: the error names the real cause ───────
{
  const exec = makeExecSpy(() => {
    const err = new Error("spawn npx ENOENT");
    err.code = "ENOENT";
    throw err;
  });
  let thrown = null;
  try {
    await runCloudgrid(
      ["whoami"],
      {},
      { exec, resolveCli: fakeResolveCli, resolveRuntime: async () => null },
    );
  } catch (err) {
    thrown = err;
  }
  check(
    "total failure: error carries the no-Node-runtime hint, not just raw ENOENT",
    thrown !== null &&
      /No usable Node\.js runtime/.test(thrown.message) &&
      /ENOENT/.test(thrown.message),
  );
}

// ── 6. resolveNodeRuntime: Electron detection and probing ─────────────────────
const CLAUDE_EXEC_PATH =
  "/Applications/Claude.app/Contents/Frameworks/Claude Helper (Plugin).app/Contents/MacOS/Claude Helper (Plugin)";
const ELECTRON_DEPS = {
  execPath: CLAUDE_EXEC_PATH,
  versions: { electron: "43.0.0", node: "24.17.0" },
  platform: "darwin",
  env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  home: "/Users/dev",
  fsReaddir: () => [],
};

{
  // Plain Node host: execPath IS the runtime; nothing is spawned or probed.
  const exec = makeExecSpy(() => {
    throw new Error("must not spawn");
  });
  const rt = await resolveNodeRuntime({
    exec,
    execPath: "/usr/local/bin/node",
    versions: { node: "22.0.0" },
    platform: "darwin",
    env: {},
    home: "/Users/dev",
    fsExists: () => false,
    fsReaddir: () => [],
  });
  check(
    "runtime: plain-Node execPath is used directly, no probing",
    rt?.command === "/usr/local/bin/node" && rt?.kind === "exec-path" && exec.calls.length === 0,
  );
}

{
  // Claude Desktop shape, Homebrew Node installed: the real binary is found
  // and verified; execPath is never treated as Node.
  const exec = makeExecSpy(({ command, args }) => {
    if (command === "/opt/homebrew/bin/node" && args[0] === "-p") return { stdout: "v22.14.0\n" };
    throw electronFatalError();
  });
  const rt = await resolveNodeRuntime({
    ...ELECTRON_DEPS,
    exec,
    fsExists: (p) => p === "/opt/homebrew/bin/node",
  });
  check(
    "runtime: under Electron a probed real Node binary wins",
    rt?.command === "/opt/homebrew/bin/node" && rt?.kind === "system-node",
  );
  check(
    "runtime: Electron execPath is never spawned as Node without the env var",
    exec.calls.every((c) => c.command !== CLAUDE_EXEC_PATH || c.options?.env?.ELECTRON_RUN_AS_NODE === "1"),
  );
}

{
  // Claude Desktop shape, NO Node anywhere: the run-as-node probe FATALs
  // (fuse disabled) → no runtime. Old code would have spawned execPath anyway.
  const exec = makeExecSpy(() => {
    throw electronFatalError();
  });
  const rt = await resolveNodeRuntime({ ...ELECTRON_DEPS, exec, fsExists: () => false });
  check("runtime: Claude Desktop with no Node resolves to null (skip rung 1)", rt === null);
  const probe = exec.calls.find((c) => c.command === CLAUDE_EXEC_PATH);
  check(
    "runtime: the run-as-node probe itself carried ELECTRON_RUN_AS_NODE=1",
    probe?.options?.env?.ELECTRON_RUN_AS_NODE === "1",
  );
}

{
  // Vanilla Electron host with the runAsNode fuse ENABLED: the probe succeeds,
  // so execPath-as-node is a usable last resort.
  const exec = makeExecSpy(({ command, options }) => {
    if (command === CLAUDE_EXEC_PATH && options?.env?.ELECTRON_RUN_AS_NODE === "1")
      return { stdout: "v24.17.0\n" };
    throw electronFatalError();
  });
  const rt = await resolveNodeRuntime({ ...ELECTRON_DEPS, exec, fsExists: () => false });
  check(
    "runtime: fuse-enabled Electron falls back to execPath run-as-node",
    rt?.command === CLAUDE_EXEC_PATH && rt?.kind === "electron-run-as-node",
  );
}

{
  // Fake-success guard: a GUI boot that times out and exits 0 with empty
  // stdout must NOT pass the probe (this was a 10-minute hang + bogus "Done.").
  const exec = makeExecSpy(() => ({ stdout: "", stderr: "" }));
  const rt = await resolveNodeRuntime({ ...ELECTRON_DEPS, exec, fsExists: () => false });
  check("runtime: empty-stdout probe (timed-out GUI boot) is rejected", rt === null);
}

// ── 7. cli-shim.mjs end-to-end under real Node ────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "cloudgrid-shim-test-"));
  const fixture = join(dir, "fake-cli.mjs");
  writeFileSync(
    fixture,
    "console.log(JSON.stringify({ argv: process.argv, hasVar: 'ELECTRON_RUN_AS_NODE' in process.env }));\n",
  );
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [CLI_SHIM, fixture, "whoami", "--json"],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30_000 },
    );
    const seen = JSON.parse(stdout.trim());
    check(
      "shim: plain Node — CLI sees node-style argv [exec, entry, ...args]",
      seen.argv[1] === fixture &&
        seen.argv[2] === "whoami" &&
        seen.argv[3] === "--json" &&
        seen.argv.length === 4,
    );
    check("shim: strips ELECTRON_RUN_AS_NODE before the CLI runs", seen.hasVar === false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll Electron spawn-env checks passed.");
