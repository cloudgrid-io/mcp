// Zip deploys (local edition): grid_deploy's `path` accepts a .zip archive.
//
// Because the platform's multi-file INSPIRATION create persists only the
// primary HTML (inline-create issue, 2026-07-17), a manifest-less multi-file
// zip must be shaped as a static RUNTIME project (synthesized cloudgrid.yaml,
// files under services/web/) so every file survives. These tests drive the
// real runPlug with a mocked fetch and assert the exact multipart artifacts.
//
// Run: node test/zip-deploy.test.mjs
import { zipSync } from "fflate";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runPlug } from "../src/tools.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

const enc = (s) => new TextEncoder().encode(s);
const PNG = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
));

function writeZip(name, entries) {
  const dir = mkdtempSync(join(tmpdir(), "zip-test-"));
  const p = join(dir, name);
  writeFileSync(p, Buffer.from(zipSync(entries)));
  return p;
}

function makeCtx() {
  return {
    edition: "local",
    state: {},
    canOpenBrowser: false,
    getToken: async () => "fake-jwt",
    getActiveGrid: async () => "test-grid",
    saveToken: async () => ({}),
    savedLocationNote: () => "",
  };
}

// Capture BOTH wires: the multipart form (inspiration path) and the CLI leg
// (zip projects: `grid init --here` + `grid plug` in the extracted dir). For
// the CLI leg the stub records the args + snapshots the project dir contents.
import { readdirSync, statSync } from "node:fs";
function snapshotDir(dir, base = dir, out = {}) {
  for (const nm of readdirSync(dir)) {
    const p = join(dir, nm);
    if (statSync(p).isDirectory()) snapshotDir(p, base, out);
    else out[p.slice(base.length + 1).replaceAll("\\", "/")] = readFileSync(p);
  }
  return out;
}
async function capturePlug(input) {
  let captured = null;
  const cliCalls = [];
  let projectFiles = null;
  const fetchImpl = async (url, opts) => {
    captured = opts.body; // FormData
    return new Response(
      JSON.stringify({ entity_id: "e1", slug: "s1", url: "https://x", status: "live" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const cliRun = async (args, opts) => {
    cliCalls.push({ args, cwd: opts?.cwd });
    if (args[0] === "init") return "Charged.\n  Slug:    zip-test-ab12\n";
    // snapshot at plug time: the manifest is stashed during init and restored
    // (with the assigned slug) before plug runs.
    projectFiles = snapshotDir(opts.cwd);
    return "  \u2713 Live.\n  Outlet: https://zip-test--test-grid.cloudgrid.io\n";
  };
  const res = await runPlug(makeCtx(), input, { fetchImpl, cliRun });
  const files = projectFiles ?? {};
  if (captured) {
    for (const [key, val] of captured.entries()) {
      if (val instanceof Blob) files[val.name ?? key] = Buffer.from(await val.arrayBuffer());
    }
  }
  return { res, form: captured, files, cliCalls };
}

try {
  // ── 1. Manifest-less multi-file zip → synthesized static-runtime wrapper ──
  {
    const zip = writeZip("my-gallery.zip", {
      "index.html": enc("<!doctype html><h1>gallery</h1><img src='img/pixel.png'>"),
      "img/pixel.png": PNG,
    });
    const { files } = await capturePlug({ path: zip, grid: "test-grid" });
    const names = Object.keys(files).sort();
    check("wrapper: uploads a synthesized cloudgrid.yaml", names.includes("cloudgrid.yaml"));
    check("wrapper: index under services/web/", names.includes("services/web/index.html"));
    check("wrapper: image under services/web/ (secondary file survives)", names.includes("services/web/img/pixel.png"));
    check("wrapper: image bytes intact", files["services/web/img/pixel.png"]?.equals(Buffer.from(PNG)));
    const yaml = files["cloudgrid.yaml"]?.toString() ?? "";
    check("wrapper: name is the init-assigned slug", /^name: zip-test-ab12$/m.test(yaml));
    check("wrapper: static service at /", /type: static/.test(yaml) && /path: \//.test(yaml));
  }

  // \u2500\u2500 1b. The zip project rides the CLI leg (init --here + plug), not the broken inline wire \u2500\u2500
  {
    const zip = writeZip("cli-leg.zip", {
      "index.html": enc("<h1>cli leg</h1>"),
      "img/pixel.png": PNG,
    });
    const { res, cliCalls } = await capturePlug({ path: zip, grid: "test-grid" });
    check("cli-leg: grid init app <name> --here --grid", cliCalls[0]?.args.join(" ") === "init app cli-leg --here --grid test-grid");
    check("cli-leg: grid plug runs in the project dir", cliCalls[1]?.args[0] === "plug" && Boolean(cliCalls[1]?.cwd));
    check("cli-leg: returns the live URL", res.structured?.url === "https://zip-test--test-grid.cloudgrid.io");
    check("cli-leg: via marker", res.structured?.via === "zip-cli");
  }

  // \u2500\u2500 1c. Single-page zip short-circuits to the instant inspiration wire \u2500\u2500
  {
    const zip = writeZip("one-pager.zip", { "index.html": enc("<!doctype html><h1>one pager</h1>") });
    const { form, cliCalls, files } = await capturePlug({ path: zip, grid: "test-grid" });
    check("one-pager: no CLI leg", cliCalls.length === 0);
    check("one-pager: rides the multipart html wire", Boolean(form));
    check("one-pager: content in index.html artifact", files["index.html"]?.toString().includes("one pager"));
  }

  // ── 2. html + zip-of-assets combo (the Desktop gallery flow) ──
  {
    const zip = writeZip("photos.zip", { "img/pixel.png": PNG });
    const { files } = await capturePlug({
      path: zip,
      html: "<!doctype html><html><body><h1>combo gallery</h1><img src='img/pixel.png'></body></html>",
      grid: "test-grid",
    });
    check("combo: generated html becomes services/web/index.html",
      files["services/web/index.html"]?.toString().includes("combo gallery"));
    check("combo: zip asset uploaded alongside", Boolean(files["services/web/img/pixel.png"]));
  }

  // ── 3. Zip with its own cloudgrid.yaml deploys verbatim ──
  {
    const zip = writeZip("proj.zip", {
      "cloudgrid.yaml": enc("name: own-proj\nservices:\n  web:\n    type: static\n    path: /\n"),
      "services/web/index.html": enc("<h1>own</h1>"),
    });
    const { files } = await capturePlug({ path: zip, grid: "test-grid" });
    check("own-manifest: manifest kept (name repointed to the assigned slug)",
      files["cloudgrid.yaml"]?.toString().includes("name: zip-test-ab12") && files["cloudgrid.yaml"]?.toString().includes("type: static"));
    check("own-manifest: no double services/web nesting",
      Boolean(files["services/web/index.html"]) && !files["services/web/services/web/index.html"]);
  }

  // ── 4. Single common root folder is stripped ──
  {
    const zip = writeZip("rooted.zip", {
      "site/index.html": enc("<h1>rooted</h1>"),
      "site/img/pixel.png": PNG,
    });
    const { files } = await capturePlug({ path: zip, grid: "test-grid" });
    check("root-strip: index lands at services/web/index.html", Boolean(files["services/web/index.html"]));
    check("root-strip: no site/ prefix survives", !Object.keys(files).some((n) => n.includes("site/")));
  }

  // ── 5. Guardrails ──
  {
    const slip = writeZip("evil.zip", { "../escape.html": enc("<h1>evil</h1>") });
    let threw = null;
    try { await capturePlug({ path: slip, grid: "test-grid" }); } catch (err) { threw = err.message; }
    check("zip-slip entry rejected", /outside the archive root/.test(threw ?? ""));
  }
  {
    const assets = writeZip("assets-only.zip", { "img/pixel.png": PNG });
    let threw = null;
    try { await capturePlug({ path: assets, grid: "test-grid" }); } catch (err) { threw = err.message; }
    check("assets-only zip without html errors with guidance", /no index\.html/.test(threw ?? ""));
  }
  {
    const withIndex = writeZip("has-index.zip", { "index.html": enc("<h1>a</h1>") });
    let threw = null;
    try { await capturePlug({ path: withIndex, html: "<h1>b</h1>", grid: "test-grid" }); } catch (err) { threw = err.message; }
    check("html + zip-with-index conflict errors", /already has an index\.html/.test(threw ?? ""));
  }
  {
    // Non-zip path + html must still be rejected (only the zip combo is legal).
    const dir = mkdtempSync(join(tmpdir(), "plain-dir-"));
    writeFileSync(join(dir, "a.txt"), "x");
    let threw = null;
    try { await capturePlug({ path: dir, html: "<h1>x</h1>", grid: "test-grid" }); } catch (err) { threw = err.message; }
    check("html + non-zip path still rejected", /exactly one source/.test(threw ?? ""));
  }

  console.log(failures === 0 ? "\nAll zip-deploy checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
} catch (err) {
  console.error("zip-deploy test crashed:", err);
  process.exit(1);
}
