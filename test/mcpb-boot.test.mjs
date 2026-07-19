// Bundle-boot regression: build the .mcpb, extract it, and boot its entrypoint
// exactly as Claude Desktop does (node src/index.js over stdio) — then assert an
// initialize handshake returns.
//
// Why this exists: the .mcpb build used a hand-maintained file allowlist that
// shipped src/tools.js (the barrel) WITHOUT src/tools/*.js after the 0.20.12
// split. The bundle crashed on boot with ERR_MODULE_NOT_FOUND and Desktop
// showed "MCP CloudGrid could not connect" — invisible to every test because
// nothing exercised the built artifact. This test drives the real bundle.
//
// Run: node test/mcpb-boot.test.mjs
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "ok  " : "FAIL"} ${label}`); if (!cond) failures++; };

const work = mkdtempSync(join(tmpdir(), "mcpb-boot-"));
try {
  // 1. Build the bundle fresh.
  execFileSync("node", ["scripts/build-mcpb.mjs"], { cwd: root, stdio: "ignore" });
  const mcpb = join(root, "cloudgrid.mcpb");
  check("build produced cloudgrid.mcpb", existsSync(mcpb));

  // 2. Extract into a path WITH A SPACE (Desktop installs under
  //    ".../Claude Extensions/...") — catches unquoted-path bugs too.
  const dest = join(work, "Claude Extensions", "cloudgrid");
  mkdirSync(dest, { recursive: true }); // unzip -d won't create nested parents
  execFileSync("unzip", ["-qq", mcpb, "-d", dest]);
  check("bundle carries the split tool modules", existsSync(join(dest, "src/tools/constants.js")));
  check("bundle carries playbook.js", existsSync(join(dest, "src/playbook.js")));
  check("bundle carries the corpus", existsSync(join(dest, "src/corpus/playbook.md")));

  // 3. Boot the entrypoint over stdio and send an initialize request.
  const initReq = JSON.stringify({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mcpb-boot", version: "0" } },
  }) + "\n";

  const result = await new Promise((resolve) => {
    const child = spawn("node", ["src/index.js"], { cwd: dest, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const timer = setTimeout(() => { child.kill(); resolve({ out, err, timedOut: true }); }, 15000);
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes('"serverInfo"')) { clearTimeout(timer); child.kill(); resolve({ out, err }); }
    });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ out, err: err + String(e) }); });
    child.stdin.write(initReq);
  });

  check("no ERR_MODULE_NOT_FOUND on boot", !/ERR_MODULE_NOT_FOUND|Cannot find module/.test(result.err));
  check("initialize handshake returns serverInfo", /"serverInfo"/.test(result.out));
  if (failures) console.error("stderr:\n" + result.err.slice(0, 600));
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll mcpb-boot checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
