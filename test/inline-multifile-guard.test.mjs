// Offline test for the inline multi-file re-plug path (#311 / #315).
//
// A real user (natalys-grid) re-plugged a live app from Claude web with 5 text
// files + a cloudgrid.yaml declaring two services. The upload succeeded; the
// build died with raw, unactionable tar output:
//
//     gzip: stdin: not in gzip format
//     tar: Child returned status 1
//
// The corruption lived in the hosted server's source-tarball materialization
// (cloudgrid#2977), NOT in this client — the identical source plugged fine from
// the CLI. #312 gated that shape before upload while the server was broken.
// cloudgrid#2978 fixed the server-side defect and it was verified live, so #315
// LIFTED the gate: the inline re-plug now uploads like any other shape. This test:
//
//   1. RULES OUT client-side corruption — drives runPlug with her exact 5-file
//      shape (incl. UTF-8 multibyte + base64 binary) and proves every file's bytes
//      reach the wire byte-for-byte (no re-encode, lossless base64 round-trip).
//   2. Proves the LIFTED gate: her exact re-plug shape (hosted, multi-file,
//      services manifest, onto an existing entity) is NO LONGER refused — it
//      uploads, byte-exact, with the files on the wire.
//   3. Proves the previously-unaffected cases still work (single HTML re-plug, a
//      few text files with no service manifest, a static bundle, the local edition).
//   4. Proves the DEFENSE-IN-DEPTH rewrite still fires: a corrupt-archive build
//      failure is rewritten to an actionable CLI handoff (never raw tar), while a
//      genuine app build error keeps its real log tail.
//
// Run: node test/inline-multifile-guard.test.mjs

import {
  runPlug,
  runCheckDeploy,
  cliContinueHandoff,
  archiveCorruptionSignature,
} from "../src/tools.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

function makeCtx({ token = null, edition = "web", grid = null } = {}) {
  return {
    edition,
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
    canOpenBrowser: false,
    getToken: async () => token,
    getActiveGrid: async () => grid,
    saveToken: async () => ({}),
    savedLocationNote: () => "",
    trustedServer: null,
    deployPollBudgetMs: 20,
    deployPollIntervalMs: 5,
  };
}

// fetch mock: record calls, reply from a queue.
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
const lastFormCall = () => [...calls].reverse().find((c) => c.form);

// Her shape: a two-service manifest (node web + cron) + text files. One file
// carries UTF-8 multibyte + emoji to catch any UTF-8 re-encode; one is "binary"
// delivered base64 to catch a lossy base64 round-trip.
const MANIFEST = [
  "name: natalys-grid",
  "services:",
  "  web:",
  "    type: node",
  "    path: /",
  "  reminder:",
  "    type: cron",
  '    schedule: "0 9 * * *"',
  "",
].join("\n");
const INDEX_JS = "require('http').createServer((_,r)=>r.end('ok')).listen(process.env.PORT||3000)\n";
const UNICODE_TXT = "Réservé — naïve café ☕ 日本語 — αβγ — 🚀🚀\n".repeat(20);
const STYLE_CSS = "body{font-family:system-ui}\n".repeat(50);
const BINARY_BYTES = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);

const HER_FILES = [
  { path: "cloudgrid.yaml", content: MANIFEST },
  { path: "services/web/index.js", content: INDEX_JS },
  { path: "services/web/notes.txt", content: UNICODE_TXT },
  { path: "services/web/style.css", content: STYLE_CSS },
  { path: "services/web/logo.bin", content: BINARY_BYTES.toString("base64"), encoding: "base64" },
];

try {
  // ── 1. RULE OUT client-side corruption: byte-exact upload on the wire ───────
  // Create path with her 5-file shape. Every part's bytes must equal the caller's
  // input bytes — proving the encode/decode round-trip is lossless and nothing
  // re-encodes text as UTF-8 lossily. If the client mangled bytes, it would show
  // here; it does not.
  {
    const ctx = makeCtx({ token: "jwt-rt", edition: "web", grid: "natalys-grid" });
    replies = [
      { status: 202, body: { entity_id: "ent-create", slug: "natalys-grid", grid: "natalys-grid", url: "https://natalys-grid--natalys-grid.cloudgrid.io", status: "live", detection: { kind: "app" } } },
    ];
    await runPlug(ctx, {
      artifact_files: HER_FILES,
      hints: { kind: "app" },
      grid: "natalys-grid",
    });
    const form = lastFormCall().form;
    const parts = form.getAll("artifact");
    // Expected bytes per path (base64 → raw bytes; text → utf8 bytes).
    const expected = new Map(
      HER_FILES.map((f) => [f.path, Buffer.from(f.content, f.encoding === "base64" ? "base64" : "utf8")]),
    );
    let allExact = parts.length === HER_FILES.length;
    for (const p of parts) {
      const got = Buffer.from(await p.arrayBuffer());
      const want = expected.get(p.name);
      if (!want || !got.equals(want)) allExact = false;
    }
    check("client upload is BYTE-EXACT for all 5 files (rules out client corruption)", allExact);
    // Specifically the multibyte text and the binary blob survive intact.
    const uni = parts.find((p) => p.name === "services/web/notes.txt");
    const bin = parts.find((p) => p.name === "services/web/logo.bin");
    check("UTF-8 multibyte text round-trips byte-exact (no re-encode)",
      Buffer.from(await uni.arrayBuffer()).equals(Buffer.from(UNICODE_TXT, "utf8")));
    check("base64 'binary' file round-trips byte-exact (lossless decode)",
      Buffer.from(await bin.arrayBuffer()).equals(BINARY_BYTES));
    check("multi-file runtime CREATE uploads (issue #48 path works)",
      calls.some((c) => c.url.endsWith("/api/v2/plug") && c.method === "POST"));
  }

  // ── 2. LIFTED GATE: her RE-PLUG shape is no longer refused — it uploads ──────
  // #312 refused this exact shape (hosted, multi-file, services manifest, onto an
  // existing entity) BEFORE any network call. cloudgrid#2978 fixed the server and
  // #315 lifted the gate: the same call must now proceed to upload, byte-exact,
  // with the files on the wire — and NOT throw.
  {
    const ctx = makeCtx({ token: "jwt-rt", edition: "web", grid: "natalys-grid" });
    const before = calls.length;
    replies = [
      { status: 202, body: { entity_id: "4af8ca18-0ade-4e02-9a10-df667424d4c7", slug: "natalys-grid", grid: "natalys-grid", url: "https://natalys-grid--natalys-grid.cloudgrid.io", status: "live", detection: { kind: "app" } } },
    ];
    let err = null;
    let r = null;
    try {
      r = await runPlug(ctx, {
        artifact_files: HER_FILES,
        target_entity_id: "4af8ca18-0ade-4e02-9a10-df667424d4c7",
      });
    } catch (e) {
      err = e;
    }
    check("re-plug of her shape is NO LONGER refused (does not throw)", err === null);
    check("…it actually uploaded (a network call was made)", calls.length > before);
    const upload = lastFormCall();
    check("…the upload is a POST to the plug endpoint", !!upload && upload.method === "POST");
    // Every one of her 5 files reaches the wire byte-for-byte on the re-plug too.
    const parts = upload ? upload.form.getAll("artifact") : [];
    const expected = new Map(
      HER_FILES.map((f) => [f.path, Buffer.from(f.content, f.encoding === "base64" ? "base64" : "utf8")]),
    );
    let allExact = parts.length === HER_FILES.length;
    for (const p of parts) {
      const got = Buffer.from(await p.arrayBuffer());
      const want = expected.get(p.name);
      if (!want || !got.equals(want)) allExact = false;
    }
    check("…all 5 files reach the wire byte-exact on the re-plug", allExact);
    void r;
  }

  // ── 3. The previously-unaffected cases still work ───────────────────────────
  // (a) single HTML re-plug on hosted → passes straight through.
  {
    const ctx = makeCtx({ token: "jwt-h", edition: "web", grid: "acme" });
    replies = [
      { status: 202, body: { entity_id: "ent-h", slug: "page", grid: "acme", url: "https://acme.cloudgrid.io/page", status: "live" } },
    ];
    const r = await runPlug(ctx, { html: "<h1>v2</h1>", target_entity_id: "ent-h" });
    check("single HTML re-plug on hosted still works", r?.structured?.url === "https://acme.cloudgrid.io/page");
  }
  // (b) a few small TEXT files with NO service manifest.
  {
    const ctx = makeCtx({ token: "jwt-t", edition: "web", grid: "acme" });
    replies = [
      { status: 202, body: { entity_id: "ent-t", slug: "site", grid: "acme", url: "https://acme.cloudgrid.io/site", status: "live" } },
    ];
    const r = await runPlug(ctx, {
      artifact_files: [
        { path: "index.html", content: "<h1>hi</h1>" },
        { path: "about.html", content: "<h1>about</h1>" },
        { path: "style.css", content: "body{}" },
      ],
      target_entity_id: "ent-t",
    });
    check("multi-file re-plug with NO services manifest still works", r?.structured?.entity_id === "ent-t");
  }
  // (c) a cloudgrid.yaml with NO services block → static bundle.
  {
    const ctx = makeCtx({ token: "jwt-s", edition: "web", grid: "acme" });
    replies = [
      { status: 202, body: { entity_id: "ent-s", slug: "s", grid: "acme", url: "https://acme.cloudgrid.io/s", status: "live" } },
    ];
    const r = await runPlug(ctx, {
      artifact_files: [
        { path: "cloudgrid.yaml", content: "name: static-site\n" },
        { path: "index.html", content: "<h1>hi</h1>" },
      ],
      target_entity_id: "ent-s",
    });
    check("multi-file re-plug whose manifest declares NO services still works", r?.structured?.entity_id === "ent-s");
  }
  // (d) the SAME multi-file runtime re-plug on the LOCAL edition.
  {
    const ctx = makeCtx({ token: "jwt-l", edition: "local", grid: "natalys-grid" });
    replies = [
      { status: 202, body: { entity_id: "ent-l", slug: "natalys-grid", grid: "natalys-grid", url: "https://x", status: "live" } },
    ];
    const r = await runPlug(ctx, { artifact_files: HER_FILES, target_entity_id: "ent-l" });
    check("multi-file runtime re-plug on the LOCAL edition still works", r?.structured?.entity_id === "ent-l");
  }

  // ── 4. Defense in depth: corrupt-archive BUILD failure → actionable ─────────
  // The server-side defect is fixed, but the rewrite stays as defense in depth:
  // runPlug polls the deploy trace; a failed verdict carrying the exact tar/gzip
  // log must still be rewritten to the CLI handoff, never surfaced raw.
  {
    const ctx = makeCtx({ token: "jwt-b", edition: "web", grid: "acme" });
    ctx.getActiveGrid = async () => "acme";
    replies = [
      // /plug create → building + poll_url
      { status: 202, body: { entity_id: "ent-b", slug: "app", grid: "acme", url: "https://app--acme.cloudgrid.io", status: "building", poll_url: "https://api.cloudgrid.io/api/v2/deploys/tr-b", trace_id: "tr-b", detection: { kind: "app" } } },
      // deploy-trace poll → failed with the raw FETCHSOURCE tar output
      { status: 200, body: { status: "failed", error: { message_user: "Step #1 - \"FETCHSOURCE\": gzip: stdin: not in gzip format\ntar: Child returned status 1", build_log_excerpt: { text: "gzip: stdin: not in gzip format\ntar: Child returned status 1" } } } },
    ];
    let err = null;
    try {
      await runPlug(ctx, { artifact_files: [{ path: "index.js", content: INDEX_JS }, { path: "b.txt", content: "b" }], hints: { kind: "app" }, grid: "acme" });
    } catch (e) {
      err = e;
    }
    const m = err?.message ?? "";
    check("corrupt-archive build failure throws (URL not claimed live)", err !== null);
    check("…does NOT surface the raw tar/gzip output", !archiveCorruptionSignature(m));
    check("…names the CLI continue-path with the entity handle", /cli@latest pull/.test(m) && m.includes("acme/app"));
  }

  // A GENUINE app build error (missing dependency) KEEPS its real log tail — the
  // developer can act on that; only the corrupt-archive signature is rewritten.
  {
    const ctx = makeCtx({ token: "jwt-g", edition: "web", grid: "acme" });
    ctx.getActiveGrid = async () => "acme";
    replies = [
      { status: 202, body: { entity_id: "ent-g", slug: "app", grid: "acme", url: "https://app--acme.cloudgrid.io", status: "building", poll_url: "https://api.cloudgrid.io/api/v2/deploys/tr-g", trace_id: "tr-g", detection: { kind: "app" } } },
      { status: 200, body: { status: "failed", error: { message_user: "Build failed", build_log_excerpt: { text: "npm ERR! Cannot find module 'express'" } } } },
    ];
    let err = null;
    try {
      await runPlug(ctx, { artifact_files: [{ path: "index.js", content: INDEX_JS }, { path: "b.txt", content: "b" }], hints: { kind: "app" }, grid: "acme" });
    } catch (e) {
      err = e;
    }
    check("genuine app build error keeps its real log tail (not rewritten)",
      (err?.message ?? "").includes("Cannot find module 'express'"));
  }

  // ── runCheckDeploy: corrupt-archive verdict → actionable, no raw tar ────────
  {
    const ctx = makeCtx({ token: "jwt-c", edition: "web", grid: "acme" });
    ctx.getActiveGrid = async () => "acme";
    ctx.state.lastDrop = { entity_id: "ent-c", slug: "app", grid: "acme", url: "https://app--acme.cloudgrid.io", poll_url: "https://api.cloudgrid.io/api/v2/deploys/tr-c" };
    replies = [
      { status: 200, body: { status: "failed", error: { message_user: "gzip: stdin: not in gzip format", build_log_excerpt: { text: "gzip: stdin: not in gzip format\ntar: Child returned status 1" } } } },
    ];
    const r = await runCheckDeploy(ctx, {});
    check("grid_check_deploy: corrupt-archive → status failed", r.structured.status === "failed");
    check("grid_check_deploy: tags reason archive_corrupt", r.structured.reason === "archive_corrupt");
    check("grid_check_deploy: NO raw tar/gzip text in the message", !archiveCorruptionSignature(r.text));
    check("grid_check_deploy: names the CLI continue-path", /cli@latest pull/.test(r.text) && r.text.includes("acme/app"));
  }

  // ── archiveCorruptionSignature unit checks ──────────────────────────────────
  check("signature matches the exact production strings",
    archiveCorruptionSignature("gzip: stdin: not in gzip format\ntar: Child returned status 1"));
  check("signature matches a lone 'not in gzip format'", archiveCorruptionSignature("not in gzip format"));
  check("signature does NOT match a normal npm build error",
    !archiveCorruptionSignature("npm ERR! Cannot find module 'express'"));
  check("signature is empty-safe", !archiveCorruptionSignature("") && !archiveCorruptionSignature(undefined));

  // ── cliContinueHandoff unit checks ──────────────────────────────────────────
  check("handoff prefers grid/slug", cliContinueHandoff({ entityId: "e1", grid: "g", slug: "s" }).includes("pull g/s"));
  check("handoff falls back to the entity id", cliContinueHandoff({ entityId: "e1" }).includes("pull e1"));
  check("handoff always includes login + plug", (() => {
    const h = cliContinueHandoff({ entityId: "e1" });
    return h.includes("cli@latest login") && h.includes("cli@latest plug");
  })());
} finally {
  globalThis.fetch = realFetch;
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll inline multi-file re-plug checks passed (offline).");
