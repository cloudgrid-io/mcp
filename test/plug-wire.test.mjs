// Offline unit test for the unified plug wire contract (0.7.0 / spec v2).
// Mocks global fetch and asserts EXACTLY what runDrop/runPlug put on the wire:
//   - create: no target_entity_id; anon create persists the owner_token.
//   - session re-drop: target_entity_id (+ owner_token on the anon wire, and NO
//     Authorization header) → the same entity is updated in place.
//   - authed re-drop: Authorization + target_entity_id + a cloudgrid.yaml part
//     (the authed update path requires one on the wire).
//   - fresh: true / explicit entity_id semantics; 409 EDIT_REJECTED surfaces an
//     error (never a silent create).
//   - url consumption: server `url` verbatim; client composition fallback only
//     when the server left it empty.
// Run: node test/plug-wire.test.mjs

import { runDrop, runPlug, resolvePlugUrl, parseManifestName } from "../src/tools.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

function makeCtx({ token = null, edition = "web" } = {}) {
  return {
    edition,
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
    canOpenBrowser: false,
    getToken: async () => token,
    getActiveGrid: async () => null,
    saveToken: async () => ({}),
    savedLocationNote: () => "",
    trustedServer: null,
  };
}

// fetch mock: record {url, headers, form}; reply from a queue.
const calls = [];
let replies = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const form = opts.body instanceof FormData ? opts.body : null;
  calls.push({ url: String(url), headers: opts.headers || {}, form, method: opts.method });
  const next = replies.shift() ?? { status: 200, body: {} };
  return new Response(JSON.stringify(next.body), {
    status: next.status,
    headers: { "content-type": "application/json", ...(next.headers || {}) },
  });
};

const lastCall = () => calls[calls.length - 1];
const formField = (name) => {
  const v = lastCall().form?.get(name);
  return typeof v === "string" ? v : v ? "<file>" : null;
};

try {
  // ── resolvePlugUrl: server url wins; composition is fallback-only ──────────
  check(
    "resolvePlugUrl prefers the server url",
    resolvePlugUrl({ url: "https://x--flat.cloudgrid.io", slug: "x", grid: "flat" }) ===
      "https://x--flat.cloudgrid.io",
  );
  check(
    "resolvePlugUrl falls back to client composition when url is empty",
    resolvePlugUrl({ url: "", slug: "s1", grid: null }) === "https://guest.cloudgrid.io/s1",
  );

  // ── anon create → session re-drop (owner-token wire) ───────────────────────
  const anonCtx = makeCtx();
  replies = [
    {
      status: 201,
      body: {
        entity_id: "ent-1",
        slug: "s1",
        grid: null,
        url: "https://guest.cloudgrid.io/s1",
        owner_token: "tok-A",
        claim_url: "https://console.cloudgrid.io/claim?token=tok-A",
        claim_message: "Sign in within 7 days.",
        status: "live",
      },
    },
  ];
  const c1 = await runDrop(anonCtx, { html: "<h1>v1</h1>", anonymous: true });
  check("anon create sends NO target_entity_id", formField("target_entity_id") === null);
  check("anon create sends NO owner_token", formField("owner_token") === null);
  check("anon create sends NO Authorization", !("Authorization" in lastCall().headers));
  check("anon create returns status created", c1.structured.status === "created");
  check("anon create surfaces entity_id", c1.structured.entity_id === "ent-1");
  check("anon create surfaces owner_token", c1.structured.owner_token === "tok-A");
  check("anon create persists the owner_token in state", anonCtx.state.lastDrop.owner_token === "tok-A");
  check("anon create arms the claim with the owner token", anonCtx.state.lastAnonClaim.token === "tok-A");

  replies = [
    {
      status: 201,
      body: {
        entity_id: "ent-1",
        slug: "s1",
        grid: "guest",
        url: "https://guest.cloudgrid.io/s1",
        owner_token: "tok-B",
        status: "live",
      },
    },
  ];
  const c2 = await runDrop(anonCtx, { html: "<h1>v2</h1>", anonymous: true });
  check("anon re-drop targets the SAME entity", formField("target_entity_id") === "ent-1");
  check("anon re-drop sends the owner_token form field", formField("owner_token") === "tok-A");
  check("anon re-drop sends NO Authorization header", !("Authorization" in lastCall().headers));
  check("anon re-drop reports status updated", c2.structured.status === "updated");
  check("anon re-drop keeps the URL", c2.structured.url === "https://guest.cloudgrid.io/s1");
  check("refreshed owner_token REPLACES the stored one", anonCtx.state.lastDrop.owner_token === "tok-B");
  check("refreshed owner_token also feeds the claim", anonCtx.state.lastAnonClaim.token === "tok-B");

  // fresh: true → back to create (no target).
  replies = [
    { status: 201, body: { entity_id: "ent-2", slug: "s2", grid: null, url: "https://guest.cloudgrid.io/s2", owner_token: "tok-C", status: "live" } },
  ];
  const c3 = await runDrop(anonCtx, { html: "<h1>v3</h1>", anonymous: true, fresh: true });
  check("fresh: true omits target_entity_id (real create)", formField("target_entity_id") === null);
  check("fresh: true returns a NEW entity", c3.structured.entity_id === "ent-2");

  // 409 EDIT_REJECTED on a re-drop → clear error, never a silent create.
  replies = [
    { status: 409, body: { error: { code: "EDIT_REJECTED", message: "This inspiration can no longer be edited in place." } } },
  ];
  let editErr = null;
  try {
    await runDrop(anonCtx, { html: "<h1>v4</h1>", anonymous: true });
  } catch (e) {
    editErr = e;
  }
  check("409 EDIT_REJECTED surfaces an error (no silent create)", editErr !== null);
  check("409 error suggests fresh: true", (editErr?.message ?? "").includes("fresh: true"));

  // Explicit entity_id with no way to authorize → client-side error, no call.
  const bareCtx = makeCtx();
  const callsBefore = calls.length;
  let bareErr = null;
  try {
    await runDrop(bareCtx, { html: "<h1>x</h1>", anonymous: true, entity_id: "ent-9" });
  } catch (e) {
    bareErr = e;
  }
  check("anon explicit entity_id without owner_token errors", bareErr !== null && (bareErr.message ?? "").includes("owner_token"));
  check("…and makes no network call", calls.length === callsBefore);

  // ── authed create → authed re-drop ─────────────────────────────────────────
  const authedCtx = makeCtx({ token: "jwt-1", edition: "local" });
  replies = [
    { status: 202, body: { entity_id: "ent-3", slug: "s3", grid: "atomic", url: "https://atomic.cloudgrid.io/s3", status: "live" } },
  ];
  const a1 = await runDrop(authedCtx, { html: "<h1>v1</h1>" });
  check("authed create sends Authorization", lastCall().headers.Authorization === "Bearer jwt-1");
  check("authed create sends NO target", formField("target_entity_id") === null);
  check("authed create sends NO cloudgrid.yaml part", lastCall().form?.get("cloudgrid.yaml") === null);
  check("authed create surfaces entity_id", a1.structured.entity_id === "ent-3");
  check("authed create carries no owner_token", !("owner_token" in a1.structured));

  replies = [
    { status: 202, body: { entity_id: "ent-3", slug: "s3", grid: "atomic", url: "https://atomic.cloudgrid.io/s3", status: "live" } },
  ];
  const a2 = await runDrop(authedCtx, { html: "<h1>v2</h1>" });
  check("authed re-drop targets the same entity", formField("target_entity_id") === "ent-3");
  check("authed re-drop keeps Authorization", lastCall().headers.Authorization === "Bearer jwt-1");
  check("authed re-drop attaches the required cloudgrid.yaml part", lastCall().form?.get("cloudgrid.yaml") !== null);
  check("authed re-drop reports updated + same URL", a2.structured.status === "updated" && a2.structured.url === "https://atomic.cloudgrid.io/s3");

  // Server url empty → client composition fallback.
  replies = [
    { status: 202, body: { entity_id: "ent-3", slug: "s3", grid: "atomic", url: "", status: "live", detection: { kind: "inspiration" } } },
  ];
  const a3 = await runDrop(authedCtx, { html: "<h1>v3</h1>", fresh: true });
  check("empty server url falls back to client composition", a3.structured.url === "https://atomic.cloudgrid.io/s3");

  // ── runPlug: artifact_files wire (hosted) ──────────────────────────────────
  const plugCtx = makeCtx();
  replies = [
    {
      status: 201,
      body: {
        entity_id: "ent-4", slug: "s4", grid: null, url: "https://guest.cloudgrid.io/s4",
        owner_token: "tok-P", claim_url: "https://console.cloudgrid.io/claim?token=tok-P", status: "live",
      },
    },
  ];
  const p1 = await runPlug(plugCtx, {
    artifact_files: [
      { path: "index.html", content: "<h1>hi</h1>" },
      { path: "img.png", content: Buffer.from("PNG").toString("base64"), encoding: "base64" },
    ],
    hints: { kind: "inspiration" },
  });
  {
    const parts = lastCall().form.getAll("artifact");
    check("plug create uploads every artifact_files entry", parts.length === 2);
    check("plug create decodes base64 entries", (await parts[1].arrayBuffer()).byteLength === 3);
    check("plug create sends the kind hint (create wire)", formField("kind_hint") === "inspiration");
    check("plug create sends no target", formField("target_entity_id") === null);
    check("plug returns the re-plug handle", p1.structured.entity_id === "ent-4" && p1.structured.owner_token === "tok-P");
  }

  // Anon re-plug via runPlug: explicit target + owner_token from session state.
  replies = [
    { status: 201, body: { entity_id: "ent-4", slug: "s4", grid: "guest", url: "https://guest.cloudgrid.io/s4", owner_token: "tok-Q", status: "live" } },
  ];
  const p2 = await runPlug(plugCtx, {
    artifact_files: [{ path: "index.html", content: "<h1>v2</h1>" }],
    target_entity_id: "ent-4",
  });
  check("plug anon re-plug sends target_entity_id", formField("target_entity_id") === "ent-4");
  check("plug anon re-plug recovers owner_token from session", formField("owner_token") === "tok-P");
  check("plug anon re-plug has NO Authorization", !("Authorization" in lastCall().headers));
  check("plug anon re-plug refreshes the stored token", plugCtx.state.lastDrop.owner_token === "tok-Q");
  check("plug re-plug keeps url + reports live status", p2.structured.url === "https://guest.cloudgrid.io/s4" && p2.structured.status === "live");

  // Authed re-plug via runPlug: yaml part required on the authed update wire.
  const plugAuthed = makeCtx({ token: "jwt-2", edition: "local" });
  replies = [
    { status: 202, body: { entity_id: "ent-5", slug: "s5", grid: "atomic", url: "https://atomic.cloudgrid.io/s5", status: "live" } },
  ];
  await runPlug(plugAuthed, {
    artifact_files: [{ path: "index.html", content: "<h1>v2</h1>" }],
    target_entity_id: "ent-5",
  });
  check("plug authed re-plug sends Authorization", lastCall().headers.Authorization === "Bearer jwt-2");
  check("plug authed re-plug attaches the cloudgrid.yaml part", lastCall().form.get("cloudgrid.yaml") !== null);
  check("plug authed re-plug sends no owner_token", formField("owner_token") === null);

  // Edit without any authorization → client-side error, no call.
  const plugBare = makeCtx();
  const before2 = calls.length;
  let plugErr = null;
  try {
    await runPlug(plugBare, {
      artifact_files: [{ path: "index.html", content: "x" }],
      target_entity_id: "ent-6",
    });
  } catch (e) {
    plugErr = e;
  }
  check("plug re-plug without auth/token errors client-side", plugErr !== null && calls.length === before2);

  // XOR guard.
  let xorErr = null;
  try {
    await runPlug(makeCtx({ edition: "local" }), {
      path: "/tmp/x",
      artifact_files: [{ path: "a", content: "b" }],
    });
  } catch (e) {
    xorErr = e;
  }
  check("plug rejects path + artifact_files together", xorErr !== null);

  // ── issue #48: artifact_files runtime create — payload alignment ────────────
  // A multi-service runtime create via inline artifact_files must send a
  // byte-equivalent /api/v2/plug bundle to the folder-walk path for the same
  // files: the cloudgrid.yaml manifest FIRST, as an octet-stream `artifact`
  // part, followed by the service files under their paths, plus the kind hints.
  {
    const manifest = "name: af-probe2\nservices:\n  web: {type: node, path: /}\nneeds: {database: true}\n";
    const pkg = '{"name":"web","main":"src/index.js"}';
    const idx = "require('http').createServer((_,r)=>r.end('ok')).listen(process.env.PORT||3000)";

    // Folder-walk reference: real dir with cloudgrid.yaml + services/web/*.
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "af48-"));
    writeFileSync(join(dir, "cloudgrid.yaml"), manifest);
    mkdirSync(join(dir, "services", "web", "src"), { recursive: true });
    writeFileSync(join(dir, "services", "web", "package.json"), pkg);
    writeFileSync(join(dir, "services", "web", "src", "index.js"), idx);

    const buildReply = () => [{
      status: 202,
      body: { entity_id: "ent-rt", slug: "af-probe2", grid: "cg", url: "https://af-probe2--cg.cloudgrid.io", status: "building", poll_url: "https://api.cloudgrid.io/api/v2/runtimes/ent-rt/status", trace_id: "tr-1" },
    }];

    const serializeArtifacts = async (form) => {
      const out = [];
      for (const f of form.getAll("artifact")) {
        out.push({ name: f.name, type: f.type, bytes: Buffer.from(await f.arrayBuffer()).toString("utf8") });
      }
      return out;
    };

    const folderCtx = makeCtx({ token: "jwt-rt", edition: "local" });
    folderCtx.getActiveGrid = async () => "cg";
    replies = buildReply();
    await runPlug(folderCtx, { path: dir, hints: { kind: "app" }, grid: "cg" });
    const folderArtifacts = await serializeArtifacts(lastCall().form);

    const inlineCtx = makeCtx({ token: "jwt-rt", edition: "web" });
    inlineCtx.getActiveGrid = async () => "cg";
    replies = buildReply();
    const rt = await runPlug(inlineCtx, {
      cloudgrid_yaml: manifest,
      artifact_files: [
        { path: "services/web/package.json", content: pkg },
        { path: "services/web/src/index.js", content: idx },
      ],
      hints: { kind: "app" },
      grid: "cg",
    });
    const inlineArtifacts = await serializeArtifacts(lastCall().form);

    check(
      "issue#48: artifact_files bundle == folder-walk bundle (same parts, order, bytes, type)",
      JSON.stringify(inlineArtifacts) === JSON.stringify(folderArtifacts),
    );
    check(
      "issue#48: cloudgrid.yaml is the FIRST artifact part on the inline create",
      inlineArtifacts[0]?.name === "cloudgrid.yaml",
    );
    check(
      "issue#48: manifest part is octet-stream (matches the folder walk)",
      inlineArtifacts[0]?.type === "application/octet-stream",
    );
    check("issue#48: kind hints still sent on the inline create", formField("kind_hint") === "app" && formField("hints_kind") === "app");

    // ── Honor the manifest name ──────────────────────────────────────────────
    check("issue#48: manifest name is sent as the name field", formField("name") === "af-probe2");
    check("issue#48: manifest name is sent as the slug field", formField("slug") === "af-probe2");

    // ── Accurate build status: building → NOT Live ────────────────────────────
    check("issue#48: building response reports status building", rt.structured.status === "building");
    check("issue#48: building response surfaces the poll_url", rt.structured.poll_url === "https://api.cloudgrid.io/api/v2/runtimes/ent-rt/status");
    check("issue#48: building result does NOT claim Live", !/^Live:/m.test(rt.text) && !/Live:/.test(rt.text));
    check("issue#48: building result says Building + points at poll", /Building \(async\)/.test(rt.text) && rt.text.includes("grid_status"));
    check("issue#48: building result uses the server (flat-arch) url", rt.text.includes("https://af-probe2--cg.cloudgrid.io"));

    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }

  // A dedupe guard: if the caller inlines a cloudgrid.yaml AND passes cloudgrid_yaml,
  // only ONE manifest part is sent (the cloudgrid_yaml wins, first, no duplicate).
  {
    const dupCtx = makeCtx({ token: "jwt-d", edition: "web" });
    dupCtx.getActiveGrid = async () => "cg";
    replies = [{ status: 202, body: { entity_id: "e", slug: "s", grid: "cg", url: "https://x", status: "live" } }];
    await runPlug(dupCtx, {
      cloudgrid_yaml: "name: only-once\n",
      artifact_files: [
        { path: "cloudgrid.yaml", content: "name: stale\n" },
        { path: "index.js", content: "x" },
      ],
      hints: { kind: "app" },
    });
    const names = lastCall().form.getAll("artifact").map((f) => f.name);
    check("issue#48: no duplicate cloudgrid.yaml part when both inlined + param", names.filter((n) => n === "cloudgrid.yaml").length === 1);
    check("issue#48: the cloudgrid_yaml param wins over an inlined stale manifest", formField("name") === "only-once");
  }

  // ── parseManifestName unit checks ──────────────────────────────────────────
  check("parseManifestName: top-level name", parseManifestName("name: foo\nservices: {}\n") === "foo");
  check("parseManifestName: quoted", parseManifestName('name: "bar baz"\n') === "bar baz");
  check("parseManifestName: strips inline comment", parseManifestName("name: qux # a comment\n") === "qux");
  check("parseManifestName: ignores nested name", parseManifestName("services:\n  web:\n    name: nested\n") === null);
  check("parseManifestName: absent → null", parseManifestName("services: {}\n") === null);
  check("parseManifestName: empty/undefined → null", parseManifestName("") === null && parseManifestName(undefined) === null);
} finally {
  globalThis.fetch = realFetch;
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll plug-wire contract checks passed (offline).");
