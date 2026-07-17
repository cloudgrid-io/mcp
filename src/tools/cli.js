// CLI resolution/exec plumbing (bundled/global/npx fallback) for the local edition.
// Extracted verbatim from src/tools.js (refactor: split tools.js into modules).
// Note: the cli-shim.mjs URL is adjusted for the new location (./ -> ../).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { basename, dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { CLI_NPX_PKG, MIN_CLI_VERSION } from "./constants.js";
import { ok, fail } from "./util.js";

const execFileAsync = promisify(execFile);

// ── CLI wrapping (local edition only) ──────────────────────────────────────────

// Resolve and validate a caller-supplied working directory. Returns the resolved
// absolute path, or process.cwd() when omitted.
function resolveCwd(cwd) {
  if (cwd === undefined || cwd === null || cwd === "") return undefined; // let execFile default
  const abs = resolve(cwd);
  if (!existsSync(abs)) {
    throw new Error(`Directory does not exist: ${abs}`);
  }
  if (!statSync(abs).isDirectory()) {
    throw new Error(`Not a directory: ${abs}`);
  }
  return abs;
}

// Simple semver comparison: true when `version` >= MIN_CLI_VERSION.
function meetsMinVersion(version) {
  if (!version) return false;
  const parse = (s) => s.replace(/^v/, "").split(".").map((p) => parseInt(p, 10) || 0);
  const v = parse(version);
  const m = parse(MIN_CLI_VERSION);
  for (let i = 0; i < 3; i++) {
    if ((v[i] || 0) > (m[i] || 0)) return true;
    if ((v[i] || 0) < (m[i] || 0)) return false;
  }
  return true;
}

// Resolve the bundled CLI from this package's OWN node_modules only — never
// walk up to parent directories (which may contain stale CLI versions).
// Returns { entry, version } or null.
//
// `fileURLToPath` (not `new URL(url).pathname`) is required for Windows: on a
// Windows `file://` URL, `.pathname` is `/C:/Users/.../src` — a leading slash
// before the drive letter, which is NOT a valid fs path, so `existsSync` fails
// and the bundled CLI is never found even though the `.mcpb` bundles it.
// `fileURLToPath` yields a proper `C:\Users\...\src`. macOS/Linux are unaffected.
//
// The `deps` seam (moduleUrl + path/fs impls) exists ONLY so the Windows-URL
// regression test can drive the win32 code path deterministically on a POSIX CI
// box. Production always uses the real `import.meta.url` and host path/fs.
export function resolveBundledCli(deps = {}) {
  const {
    moduleUrl = import.meta.url,
    urlToPath = fileURLToPath,
    pathImpl = { dirname, join },
    fsExists = existsSync,
    fsRead = readFileSync,
  } = deps;
  try {
    const srcDir = pathImpl.dirname(urlToPath(moduleUrl));
    const pkgPath = pathImpl.join(srcDir, "..", "node_modules", "@cloudgrid-io", "cli", "package.json");
    if (!fsExists(pkgPath)) return null;
    const pkg = JSON.parse(fsRead(pkgPath, "utf-8"));
    const bin = pkg.bin && pkg.bin.cloudgrid;
    if (!bin) return null;
    return { entry: pathImpl.join(pathImpl.dirname(pkgPath), bin), version: pkg.version || null };
  } catch {
    return null;
  }
}

// Windows `.cmd`/`.bat` shims (cloudgrid.cmd, npx.cmd) cannot be launched by
// `execFile` without a shell — modern patched Node (CVE-2024-27980) rejects it
// with EINVAL, and even where it doesn't, ENOENT results because the bare name
// resolves to a `.cmd`. On win32 we route those through `cmd.exe /d /s /c` with
// an explicitly quoted command line so args with spaces/quotes stay intact.
// macOS/Linux never take this branch — they keep the plain execFile path.
const IS_WIN = process.platform === "win32";

// Quote a single Windows command-line token for cmd.exe. Wrap in double quotes,
// escape embedded quotes/backslash-before-quote per Windows argv rules, and also
// caret-escape cmd.exe metacharacters so nothing is interpreted by the shell.
function winQuoteArg(arg) {
  const s = String(arg);
  // Escape backslashes that precede a quote, then the quotes themselves.
  let inner = s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  inner = `"${inner}"`;
  // Caret-escape cmd.exe special chars (they live outside the quoted-arg parsing).
  return inner.replace(/[()%!^"<>&|]/g, "^$&");
}

// execFile a command that may be a Windows `.cmd` shim, safely on every OS.
function execMaybeCmd(command, args, options, exec = execFileAsync) {
  if (!IS_WIN) return exec(command, args, options);
  const line = [command, ...args].map(winQuoteArg).join(" ");
  return exec(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

// ── Electron-safe Node runtime resolution ─────────────────────────────────────
//
// Claude Desktop (and other Electron MCP hosts) run this server inside an
// Electron utility process, so `process.execPath` is the host's Electron helper
// binary — NOT a Node interpreter. Spawning it as if it were Node either dies
// with FATAL "Unable to find helper app" (Claude Desktop's helper binary) or
// boots a GUI Electron app that hangs until the exec timeout and then reports a
// fake success. ELECTRON_RUN_AS_NODE=1 only helps when the host's Electron
// build keeps the runAsNode fuse enabled — Claude Desktop's does NOT (verified:
// the helper FATALs identically with the variable set). So the bundled-CLI rung
// must (a) never blindly spawn process.execPath under Electron, (b) prefer a
// real Node binary probed from common install locations (the utility process
// PATH is a bare /usr/bin:/bin:/usr/sbin:/sbin on macOS), and (c) use
// execPath-as-node only after a quick verified run-as-node probe.

const CLI_SHIM = fileURLToPath(new URL("../cli-shim.mjs", import.meta.url));

const NO_NODE_HINT =
  "No usable Node.js runtime found for spawning the CloudGrid CLI (this MCP " +
  "host runs on Electron, whose binary cannot execute Node scripts). Install " +
  "Node.js (https://nodejs.org) or the CloudGrid CLI (npm install -g " +
  "@cloudgrid-io/cli) and try again.";

// True when `execPath` is a real Node interpreter we can hand a script to.
function execPathIsRealNode({ execPath, versions, platform }) {
  if (versions?.electron) return false;
  const name = basename(execPath).toLowerCase();
  return platform === "win32" ? name === "node.exe" || name === "node" : name === "node";
}

// Pick the highest semver-looking entry of a directory (nvm/fnm version dirs).
function highestVersionEntry(dir, fsReaddir) {
  try {
    const versions = fsReaddir(dir)
      .filter((d) => /^v?\d+\.\d+\.\d+$/.test(d))
      .sort((a, b) => {
        const pa = a.replace(/^v/, "").split(".").map(Number);
        const pb = b.replace(/^v/, "").split(".").map(Number);
        return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
      });
    return versions.pop() || null;
  } catch {
    return null;
  }
}

// Candidate real-Node binaries, most likely first. GUI-launched Electron hosts
// get a bare PATH, so fixed install locations and version-manager dirs are
// probed explicitly.
function listNodeCandidates({ platform, env, home, fsReaddir }) {
  const out = [];
  const binName = platform === "win32" ? "node.exe" : "node";
  for (const dir of (env.PATH || "").split(platform === "win32" ? ";" : ":")) {
    if (dir) out.push(join(dir, binName));
  }
  if (platform === "win32") {
    for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
      if (base) out.push(join(base, "nodejs", "node.exe"));
    }
    if (env.NVM_SYMLINK) out.push(join(env.NVM_SYMLINK, "node.exe"));
    if (env.LOCALAPPDATA) out.push(join(env.LOCALAPPDATA, "Volta", "bin", "node.exe"));
    return out;
  }
  out.push("/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node", "/opt/local/bin/node");
  if (home) {
    out.push(join(home, ".volta", "bin", "node"));
    const nvmVersions = join(env.NVM_DIR || join(home, ".nvm"), "versions", "node");
    const nvmBest = highestVersionEntry(nvmVersions, fsReaddir);
    if (nvmBest) out.push(join(nvmVersions, nvmBest, "bin", "node"));
    for (const base of [
      env.FNM_DIR,
      join(home, ".local", "share", "fnm"),
      join(home, "Library", "Application Support", "fnm"),
      join(home, ".fnm"),
    ]) {
      if (!base) continue;
      out.push(join(base, "aliases", "default", "bin", "node"));
      const fnmVersions = join(base, "node-versions");
      const fnmBest = highestVersionEntry(fnmVersions, fsReaddir);
      if (fnmBest) out.push(join(fnmVersions, fnmBest, "installation", "bin", "node"));
    }
  }
  return out;
}

// Verify a candidate actually behaves like Node (guards against broken shims
// and against Electron's fake-success mode where a timed-out GUI boot exits 0).
async function verifyNodeRuns(exec, command, env) {
  try {
    const { stdout } = await exec(command, ["-p", "process.version"], {
      timeout: 5_000,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return /^v\d+\./.test(String(stdout).trim());
  } catch {
    return false;
  }
}

// Resolve the Node runtime used to spawn the bundled CLI. Returns
// { command, kind } or null when no usable runtime exists.
//
// The `deps` seam exists ONLY so the Electron regression tests can drive the
// Electron code paths deterministically on a plain-Node CI box. Production
// (runCloudgrid) only ever injects the real spawner, so the result is memoized.
let runtimeCache; // undefined = not yet resolved; null = resolved to "none"
export async function resolveNodeRuntime(deps = {}) {
  // Cache unless the environment itself is simulated (`exec` is just the
  // spawner) — probing spawns children, and the answer cannot change within
  // one server process.
  const cacheable = Object.keys(deps).every((k) => k === "exec");
  if (cacheable && runtimeCache !== undefined) return runtimeCache;
  const {
    exec = execFileAsync,
    execPath = process.execPath,
    versions = process.versions,
    platform = process.platform,
    env = process.env,
    home = homedir(),
    fsExists = existsSync,
    fsReaddir = readdirSync,
  } = deps;

  let result = null;
  if (execPathIsRealNode({ execPath, versions, platform })) {
    result = { command: execPath, kind: "exec-path" };
  } else {
    // 1. A real Node binary somewhere on this machine.
    for (const candidate of listNodeCandidates({ platform, env, home, fsReaddir })) {
      if (!fsExists(candidate)) continue;
      if (await verifyNodeRuns(exec, candidate, env)) {
        result = { command: candidate, kind: "system-node" };
        break;
      }
    }
    // 2. Last resort: execPath with ELECTRON_RUN_AS_NODE — only if a quick
    //    probe proves the host's runAsNode fuse is enabled (Claude Desktop's
    //    is not; vanilla Electron's is).
    if (!result) {
      const probeEnv = { ...env, ELECTRON_RUN_AS_NODE: "1" };
      if (await verifyNodeRuns(exec, execPath, probeEnv)) {
        result = { command: execPath, kind: "electron-run-as-node" };
      }
    }
  }
  if (cacheable) runtimeCache = result;
  return result;
}

// A step-1 error that means "the runtime never ran the CLI" (fall through to
// the global-CLI/npx rungs) as opposed to "the CLI ran and reported an error"
// (surface it).
function isRuntimeBootFailure(err) {
  if (!err) return false;
  if (err.code === "ENOENT" || err.code === "EACCES") return true;
  const text = `${err.stderr || ""}\n${err.message || ""}`;
  return text.includes("Unable to find helper app") || /FATAL:.*electron/i.test(text);
}

// Environment for the global-CLI and npx fallback rungs. GUI-launched Electron
// hosts hand utility processes a bare PATH (macOS: /usr/bin:/bin:/usr/sbin:/sbin)
// that misses Homebrew/npm bin dirs, so `cloudgrid`/`npx` would be ENOENT even
// when installed — append the usual install locations. ELECTRON_RUN_AS_NODE is
// stripped so it cannot leak through a real-node CLI into anything it spawns.
function pathAugmentedEnv(env = process.env, platform = process.platform, home = homedir()) {
  const out = { ...env };
  delete out.ELECTRON_RUN_AS_NODE;
  if (platform === "win32") return out;
  const extras = ["/usr/local/bin", "/opt/homebrew/bin", join(home, ".volta", "bin"), join(home, ".local", "bin")];
  const parts = (out.PATH || "").split(":").filter(Boolean);
  for (const dir of extras) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  out.PATH = parts.join(":");
  return out;
}

// The `deps` seam mirrors resolveBundledCli's: it exists ONLY so regression
// tests can spy the exec calls and simulate Electron hosts deterministically.
// Production always calls this with no deps.
export async function runCloudgrid(args, opts = {}, deps = {}) {
  const {
    exec = execFileAsync,
    resolveCli = resolveBundledCli,
    resolveRuntime = resolveNodeRuntime,
  } = deps;
  const cwd = resolveCwd(opts.cwd);
  const execOpts = {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
    stdio: ["ignore", "pipe", "pipe"],
    ...(cwd ? { cwd } : {}),
  };
  // PATH-augmented, ELECTRON_RUN_AS_NODE-free env for the fallback rungs.
  const fallbackEnv = pathAugmentedEnv();
  // Set when the bundled CLI had to be skipped for lack of a Node runtime, so
  // the final error names the real cause instead of a raw npx/Electron error.
  let runtimeHint = null;

  const extract = (err) => {
    const detail = [err && err.stdout, err && err.stderr, err && err.message]
      .filter(Boolean)
      .join("\n")
      .trim();
    return new Error(detail || "cloudgrid command failed");
  };

  // 1. Bundled CLI — own node_modules only, version-gated. Runs via
  //    cli-shim.mjs under a verified Node runtime (see resolveNodeRuntime):
  //    process.execPath is NOT assumed to be Node, because under Electron MCP
  //    hosts (Claude Desktop) it is the host's Electron helper binary.
  //    ELECTRON_RUN_AS_NODE=1 makes an Electron runtime boot as Node and is
  //    ignored by plain Node; the shim strips it again before the CLI runs and
  //    fixes commander's Electron argv slicing.
  const bundled = resolveCli();
  if (bundled && meetsMinVersion(bundled.version)) {
    const runtime = await resolveRuntime({ exec });
    if (runtime) {
      try {
        const { stdout, stderr } = await exec(
          runtime.command,
          [CLI_SHIM, bundled.entry, ...args],
          { ...execOpts, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
        );
        return (stdout || stderr || "").trim() || "Done.";
      } catch (err) {
        // A CLI-reported error surfaces; a runtime that failed to boot falls
        // through to the global-CLI/npx rungs instead of killing the chain.
        if (!isRuntimeBootFailure(err)) throw extract(err);
        console.error(
          `cloudgrid-mcp: bundled CLI spawn failed (${err?.code || "runtime boot failure"}); trying global CLI, then npx`,
        );
      }
    } else {
      runtimeHint = NO_NODE_HINT;
      console.error(`cloudgrid-mcp: ${NO_NODE_HINT} Trying global CLI, then npx.`);
    }
  } else if (bundled) {
    console.error(
      `cloudgrid-mcp: bundled CLI ${bundled.version} < ${MIN_CLI_VERSION}, skipping`,
    );
  }

  // 2. Global `cloudgrid` on PATH — version-gated.
  //    On Windows the bin is `cloudgrid.cmd`; run it via cmd.exe (execMaybeCmd).
  {
    const globalBin = IS_WIN ? "cloudgrid.cmd" : "cloudgrid";
    let useGlobal = false;
    try {
      const { stdout: vOut } = await execMaybeCmd(
        globalBin,
        ["--version"],
        {
          timeout: 5_000,
          stdio: ["ignore", "pipe", "pipe"],
          env: fallbackEnv,
        },
        exec,
      );
      const ver = vOut.trim().match(/(\d+\.\d+\.\d+)/)?.[1];
      if (meetsMinVersion(ver)) {
        useGlobal = true;
      } else {
        console.error(
          `cloudgrid-mcp: global CLI ${ver || vOut.trim()} < ${MIN_CLI_VERSION}, skipping`,
        );
      }
    } catch {
      // Not on PATH or --version failed — skip
    }
    if (useGlobal) {
      try {
        const { stdout, stderr } = await execMaybeCmd(
          globalBin,
          args,
          { ...execOpts, env: fallbackEnv },
          exec,
        );
        return (stdout || stderr || "").trim() || "Done.";
      } catch (err) {
        throw extract(err);
      }
    }
  }

  // 3. Lazy fetch: npx -y @cloudgrid-io/cli@<pinned> <args>
  //    One-time download; npx caches it for subsequent invocations.
  //    On Windows this is `npx.cmd`, run via cmd.exe (execMaybeCmd) so patched
  //    Node doesn't EINVAL on the `.cmd` shim.
  console.error("cloudgrid-mcp: fetching the CloudGrid CLI (first use)…");
  const npx = IS_WIN ? "npx.cmd" : "npx";
  try {
    const { stdout, stderr } = await execMaybeCmd(
      npx,
      ["-y", CLI_NPX_PKG, ...args],
      { ...execOpts, env: fallbackEnv },
      exec,
    );
    return (stdout || stderr || "").trim() || "Done.";
  } catch (err) {
    const failure = extract(err);
    if (runtimeHint) failure.message = `${runtimeHint}\n\n${failure.message}`;
    throw failure;
  }
}

export function cliTool(buildArgs, { cwdParam = false } = {}) {
  return async (input) => {
    try {
      const params = input || {};
      const opts = {};
      if (cwdParam) {
        // Accept cwd, directory, or dir as the working-directory override.
        opts.cwd = params.cwd ?? params.directory ?? params.dir;
      }
      return ok(await runCloudgrid(buildArgs(params), opts));
    } catch (err) {
      return fail(err.message);
    }
  };
}

export function tryOpenBrowser(url) {
  if (process.env.CLOUDGRID_NO_BROWSER === "1") return;
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  // Strip ELECTRON_RUN_AS_NODE (present when the server itself runs under
  // Electron-as-Node) so an Electron-based browser doesn't boot as a headless
  // Node process instead of opening a window.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    execFile(cmd, [url], { env }, () => {});
  } catch {
    // ignore — the URL is returned to the user anyway
  }
}
