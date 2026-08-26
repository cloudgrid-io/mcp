// Offline test for #311 — inline multi-file re-plug corrupts the archive.
//
// A real user (natalys-grid) re-plugged a live app from Claude web with 5 text
// files + a cloudgrid.yaml declaring two services. The upload succeeded; the
// build died with raw, unactionable tar output:
//
//     gzip: stdin: not in gzip format
//     tar: Child returned status 1
//
// The identical source plugged fine from the CLI. This test:
//
//   1. RULES OUT client-side corruption — drives runPlug with her exact 5-file
//      shape (incl. UTF-8 multibyte + base64 binary) on the CREATE path and
//      proves every file's bytes reach the wire byte-for-byte (no re-encode,
//      lossless base64 round-trip). The corruption is created downstream of this
//      process; the client upload is byte-exact.
//   2. Proves the PRE-UPLOAD GATE fires on her re-plug shape (hosted, multi-file,
//      services manifest) BEFORE any network call, with an actionable CLI handoff
//      naming the real entity handle — and NO raw tar text.
//   3. Proves the gate does NOT touch the cases that work today: a single HTML
//      re-plug, a few small text files with no service manifest, a create, and
//      the local edition.
//   4. Proves a corrupt-archive BUILD failure that slips past the gate is
//      rewritten to the same actionable handoff (never raw tar), while a genuine
//      app build error keeps its real log tail.
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
  // Create path (NOT gated) with her 5-file shape. Every part's bytes must equal
  // the caller's input bytes — proving the encode/decode round-trip is lossless
  // and nothing re-encodes text as UTF-8 lossily. If the client mangled bytes,
  // it would show here; it does not.
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
    check("multi-file runtime CREATE is NOT gated (issue #48 path still works)",
      calls.some((c) => c.url.endsWith("/api/v2/plug") && c.method === "POST"));
  }

  // ── 2. GATE fires on her RE-PLUG shape, before any network call ─────────────
  {
    const ctx = makeCtx({ token: "jwt-rt", edition: "web", grid: "natalys-grid" });
    const before = calls.length;
    let err = null;
    try {
      await runPlug(ctx, {
        artifact_files: HER_FILES,
        target_entity_id: "4af8ca18-0ade-4e02-9a10-df667424d4c7",
      });
    } catch (e) {
      err = e;
    }
    const m = err?.message ?? "";
    check("re-plug of her shape is REFUSED (throws)", err !== null);
    check("…BEFORE any network call (nothing uploaded)", calls.length === before);
    check("…names the two services it detected", /services: web, reminder/.test(m));
    check("…substitutes the real entity id into the CLI handoff",
      m.includes("4af8ca18-0ade-4e02-9a10-df667424d4c7"));
    check("…hands over the CLI pull + plug commands", /cli@latest pull/.test(m) && /cli@latest plug/.test(m));
    check("…contains NO raw tar/gzip build output", !archiveCorruptionSignature(m));
  }

  // Grid+slug handle → the handoff prefers the human-readable grid/slug target.
  {
    const ctx = makeCtx({ token: "jwt-rt", edition: "local", grid: "natalys-grid" });
    // local? no — the gate is web-only. Use web + a grid/slug re-plug handle.
    const web = makeCtx({ token: "jwt-rt", edition: "web", grid: "natalys-grid" });
    replies = [
      // pickup resolve: grid+slug → an existing multi-file entity
      { status: 200, body: { entity_id: "ent-gs", slug: "reminders", grid: "natalys-grid", kind: "app", capabilities: { replug: true }, replug_handle: { target_entity_id: "ent-gs", grid: "natalys-grid", slug: "reminders" } } },
    ];
    let err = null;
    try {
      await runPlug(web, { artifact_files: HER_FILES, grid: "natalys-grid", slug: "reminders" });
    } catch (e) {
      err = e;
    }
    check("grid+slug re-plug handle is gated too", err !== null);
    check("…handoff uses the human-readable grid/slug pull target",
      (err?.message ?? "").includes("pull natalys-grid/reminders"));
    void ctx;
  }

  // ── 3. GATE does NOT touch the working cases ────────────────────────────────
  // (a) single HTML re-plug on hosted → passes straight through.
  {
    const ctx = makeCtx({ token: "jwt-h", edition: "web", grid: "acme" });
    replies = [
      { status: 202, body: { entity_id: "ent-h", slug: "page", grid: "acme", url: "https://acme.cloudgrid.io/page", status: "live" } },
    ];
    const r = await runPlug(ctx, { html: "<h1>v2</h1>", target_entity_id: "ent-h" });
    check("single HTML re-plug on hosted is NOT gated", r?.structured?.url === "https://acme.cloudgrid.io/page");
  }
  // (b) a few small TEXT files with NO service manifest → not gated.
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
    check("multi-file re-plug with NO services manifest is NOT gated", r?.structured?.entity_id === "ent-t");
  }
  // (c) a cloudgrid.yaml with NO services block → not gated (static bundle).
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
    check("multi-file re-plug whose manifest declares NO services is NOT gated", r?.structured?.entity_id === "ent-s");
  }
  // (d) the SAME multi-file runtime re-plug on the LOCAL edition → not gated
  //     (the CLI/disk path there is reliable; the gate is hosted-only).
  {
    const ctx = makeCtx({ token: "jwt-l", edition: "local", grid: "natalys-grid" });
    replies = [
      { status: 202, body: { entity_id: "ent-l", slug: "natalys-grid", grid: "natalys-grid", url: "https://x", status: "live" } },
    ];
    const r = await runPlug(ctx, { artifact_files: HER_FILES, target_entity_id: "ent-l" });
    check("multi-file runtime re-plug on the LOCAL edition is NOT gated", r?.structured?.entity_id === "ent-l");
  }

  // ── 4. Corrupt-archive BUILD failure (slips past the gate) → actionable ─────
  // runPlug polls the deploy trace; a failed verdict carrying the exact tar/gzip
  // log must be rewritten to the CLI handoff, never surfaced raw.
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
console.log("\nAll inline multi-file guard checks passed (offline).");
