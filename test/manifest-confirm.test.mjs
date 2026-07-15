// Offline test for manifest-aware confirm: a CREATE whose source already carries
// a cloudgrid.yaml is a pre-configured runtime app — grid_plug returns a
// structured needs_confirmation response instead of silently auto-creating, and
// proceeds only once confirm_new_app:true is passed.
// Run: node test/manifest-confirm.test.mjs
import assert from "node:assert/strict";
import { detectSourceManifest } from "../src/tools.js";

let failures = 0;
async function test(l, f) {
  try { await f(); console.log("ok   " + l); }
  catch (e) { failures++; console.log("FAIL " + l + "\n     " + e.message); }
}

const YAML = "name: vaad-budget\nservices:\n  web:\n    type: nextjs\n    path: /\nneeds:\n  database: true\n";

// ── B1: detectSourceManifest unit ───────────────────────────────────────────
await test("detects cloudgrid_yaml param", () => {
  const m = detectSourceManifest({ cloudgrid_yaml: YAML });
  assert.equal(m.name, "vaad-budget");
});
await test("detects a cloudgrid.yaml entry in artifact_files", () => {
  const m = detectSourceManifest({ artifact_files: [{ path: "cloudgrid.yaml", content: YAML }, { path: "app/page.js", content: "x" }] });
  assert.equal(m.name, "vaad-budget");
});
await test("returns null when no manifest present", () => {
  assert.equal(detectSourceManifest({ html: "<h1>hi</h1>" }), null);
  assert.equal(detectSourceManifest({ artifact_files: [{ path: "index.html", content: "x" }] }), null);
});
await test("detects a cloudgrid.yaml on disk for a path source", () => {
  // deps.readManifestFile lets the test inject disk content
  const m = detectSourceManifest({ path: "/tmp/app" }, { readManifestFile: (p) => p.endsWith("cloudgrid.yaml") ? YAML : null });
  assert.equal(m.name, "vaad-budget");
});

process.on("exit", () => { if (failures) process.exit(1); });
