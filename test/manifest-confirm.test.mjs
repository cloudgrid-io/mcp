// Offline test for manifest-aware confirm: a CREATE whose source already carries
// a cloudgrid.yaml is a pre-configured runtime app — grid_plug returns a
// structured needs_confirmation response instead of silently auto-creating, and
// proceeds only once confirm_new_app:true is passed.
// Run: node test/manifest-confirm.test.mjs
import assert from "node:assert/strict";
import { detectSourceManifest, registerTools } from "../src/tools.js";

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
await test("scopes services/needs to their own blocks (needs children are not services)", () => {
  const m = detectSourceManifest({ cloudgrid_yaml: YAML });
  assert.deepEqual(m.services, ["web"]);
  assert.deepEqual(m.needs, ["database"]);
});
await test("ignores a NESTED cloudgrid.yaml (only a ROOT entry is a runtime manifest)", () => {
  // The server builds from the ROOT cloudgrid.yaml; a nested one (e.g. under a
  // service dir) is not a root runtime manifest, so it must not trigger confirm.
  assert.equal(detectSourceManifest({ artifact_files: [{ path: "services/web/cloudgrid.yaml", content: YAML }] }), null);
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

// ── B2: confirm gate in the grid_plug create branch ─────────────────────────
// Fake MCP server: capture registered handlers by name (mirrors grid-picker test).
function makeServer() {
  const handlers = {};
  return {
    handlers,
    registerTool(name, _config, handler) { handlers[name] = handler; },
    tool(name, _desc, _schema, _annotations, handler) { handlers[name] = handler; },
    registerResource() {},
  };
}
function makeCtx({ token = null, activeOrg = null, edition = "web" } = {}) {
  return {
    edition,
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
    canOpenBrowser: false,
    getToken: async () => token,
    getActiveGrid: async () => activeOrg,
    saveToken: async () => ({}),
    savedLocationNote: () => "",
    trustedServer: null,
  };
}

const realFetch = globalThis.fetch;
const orgsReply = { orgs: [{ slug: "atomic", name: "Atomic", role: "owner", render_ready: true }] };
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push({ url: u, method: opts.method || "GET" });
  if (u.includes("/api/v2/orgs")) {
    return new Response(JSON.stringify(orgsReply), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (u.includes("/api/v2/plug")) {
    return new Response(
      JSON.stringify({ entity_id: "ent_1", slug: "vaad-budget", grid: "atomic", url: "https://atomic.cloudgrid.io/vaad-budget", status: "building" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
};

try {
  await test("create with a cloudgrid.yaml + no confirm returns needs_confirmation, does NOT publish", async () => {
    calls.length = 0;
    const server = makeServer();
    registerTools(server, makeCtx({ token: "jwt", activeOrg: "atomic", edition: "web" }));
    const res = await server.handlers.grid_plug({ artifact_files: [{ path: "cloudgrid.yaml", content: YAML }, { path: "app/page.js", content: "x" }] });
    assert.equal(res.structuredContent?.needs_confirmation, true);
    assert.equal(res.structuredContent?.manifest_detected, true);
    assert.match(res.content[0].text, /vaad-budget|new .*app|confirm_new_app/i);
    assert.ok(!calls.some((c) => c.url.includes("/api/v2/plug")), "must not publish before confirmation");
  });

  await test("grid+slug re-plug handle does NOT trigger the new-app confirm", async () => {
    // grid_plug also re-plugs via the grid+slug handle (replug_handle), resolved
    // inside runPlug. A create-shaped call carrying both must be treated like an
    // edit — the manifest gate must NOT short-circuit even with a cloudgrid.yaml.
    calls.length = 0;
    const server = makeServer();
    registerTools(server, makeCtx({ token: "jwt", activeOrg: "atomic", edition: "web" }));
    const res = await server.handlers.grid_plug({ grid: "atomic", slug: "vaad-budget", artifact_files: [{ path: "cloudgrid.yaml", content: YAML }] });
    assert.notEqual(res.structuredContent?.needs_confirmation, true);
    assert.ok(calls.some((c) => c.url.includes("/api/v2/plug")), "should publish (re-plug), not gate");
  });

  await test("create with confirm_new_app: true proceeds past the gate", async () => {
    // with confirm_new_app true, the manifest gate must NOT short-circuit — it
    // proceeds to the publish path. Single grid → no grid-picker either.
    calls.length = 0;
    const server = makeServer();
    registerTools(server, makeCtx({ token: "jwt", activeOrg: "atomic", edition: "web" }));
    const res = await server.handlers.grid_plug({ confirm_new_app: true, grid: "atomic", artifact_files: [{ path: "cloudgrid.yaml", content: YAML }] });
    assert.notEqual(res.structuredContent?.needs_confirmation, true);
    assert.ok(calls.some((c) => c.url.includes("/api/v2/plug")), "should publish once confirmed");
  });
} finally {
  globalThis.fetch = realFetch;
}

process.on("exit", () => { if (failures) process.exit(1); });
