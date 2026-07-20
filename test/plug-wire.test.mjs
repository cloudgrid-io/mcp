// Offline unit test for the unified plug wire contract (0.7.0 / spec v2).
// Mocks global fetch and asserts EXACTLY what runPlug puts on the wire — both via
// the inline `html` single-file path (the folded-in old drop behavior) and via
// `artifact_files`:
//   - create: no target_entity_id; anon create persists the owner_token.
//   - re-plug: target_entity_id (+ owner_token on the anon wire, and NO
//     Authorization header) → the same entity is updated in place.
//   - authed re-plug: Authorization + target_entity_id + a cloudgrid.yaml part
//     (the authed update path requires one on the wire).
//   - explicit target_entity_id semantics; 409 EDIT_REJECTED surfaces an error
//     (never a silent create).
//   - url consumption: server `url` verbatim; client composition fallback only
//     when the server left it empty.
// Run: node test/plug-wire.test.mjs

import { runPlug, resolvePlugUrl, parseManifestName } from "../src/tools.js";

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

  // ── html single-file publish: anon create → re-plug (owner-token wire) ──────
  // The inline `html` path is the old drop behavior folded into runPlug: one
  // index.html artifact, anon claim handle, in-place re-plug by target_entity_id.
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
  const c1 = await runPlug(anonCtx, { html: "<h1>v1</h1>", anon: true });
  check("html anon create materializes ONE index.html artifact", (() => {
    const parts = lastCall().form.getAll("artifact");
    return parts.length === 1 && parts[0].name === "index.html";
  })());
  check("html anon create sends the artifact as text/html", lastCall().form.get("artifact")?.type === "text/html");
  check("html anon create sends NO target_entity_id", formField("target_entity_id") === null);
  check("html anon create sends NO owner_token", formField("owner_token") === null);
  check("html anon create sends NO Authorization", !("Authorization" in lastCall().headers));
  check("html anon create surfaces entity_id", c1.structured.entity_id === "ent-1");
  check("html anon create surfaces owner_token", c1.structured.owner_token === "tok-A");
  check("html anon create persists the owner_token in state", anonCtx.state.lastDrop.owner_token === "tok-A");
  check("html anon create arms the claim with the owner token", anonCtx.state.lastAnonClaim.token === "tok-A");
  check("html anon create says Live", /^Live:/m.test(c1.text));

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
  const c2 = await runPlug(anonCtx, { html: "<h1>v2</h1>", anon: true, target_entity_id: "ent-1" });
  check("html anon re-plug targets the SAME entity", formField("target_entity_id") === "ent-1");
  check("html anon re-plug recovers the owner_token from session", formField("owner_token") === "tok-A");
  check("html anon re-plug sends NO Authorization header", !("Authorization" in lastCall().headers));
  check("html anon re-plug keeps the URL", c2.structured.url === "https://guest.cloudgrid.io/s1");
  check("html anon re-plug says Updated in place", /Updated in place/.test(c2.text));
  check("refreshed owner_token REPLACES the stored one", anonCtx.state.lastDrop.owner_token === "tok-B");
  check("refreshed owner_token also feeds the claim", anonCtx.state.lastAnonClaim.token === "tok-B");

  // No target → a fresh create (a new entity, new URL).
  replies = [
    { status: 201, body: { entity_id: "ent-2", slug: "s2", grid: null, url: "https://guest.cloudgrid.io/s2", owner_token: "tok-C", status: "live" } },
  ];
  const c3 = await runPlug(anonCtx, { html: "<h1>v3</h1>", anon: true });
  check("no target_entity_id → a real create (no target sent)", formField("target_entity_id") === null);
  check("create returns a NEW entity", c3.structured.entity_id === "ent-2");

  // 409 EDIT_REJECTED on a re-plug → clear error, never a silent create.
  replies = [
    { status: 409, body: { error: { code: "EDIT_REJECTED", message: "This inspiration can no longer be edited in place." } } },
  ];
  let editErr = null;
  try {
    await runPlug(anonCtx, { html: "<h1>v4</h1>", anon: true, target_entity_id: "ent-1", owner_token: "tok-B" });
  } catch (e) {
    editErr = e;
  }
  check("409 EDIT_REJECTED surfaces an error (no silent create)", editErr !== null);
  check("409 error explains the entity cannot be updated", (editErr?.message ?? "").includes("cannot be updated right now"));

  // Explicit target with no way to authorize → client-side error, no call.
  const bareCtx = makeCtx();
  const callsBefore = calls.length;
  let bareErr = null;
  try {
    await runPlug(bareCtx, { html: "<h1>x</h1>", anon: true, target_entity_id: "ent-9" });
  } catch (e) {
    bareErr = e;
  }
  check("anon explicit target without owner_token errors", bareErr !== null && (bareErr.message ?? "").includes("owner_token"));
  check("…and makes no network call", calls.length === callsBefore);

  // ── html authed create → authed re-plug ─────────────────────────────────────
  const authedCtx = makeCtx({ token: "jwt-1", edition: "local" });
  replies = [
    { status: 202, body: { entity_id: "ent-3", slug: "s3", grid: "atomic", url: "https://atomic.cloudgrid.io/s3", status: "live" } },
  ];
  const a1 = await runPlug(authedCtx, { html: "<h1>v1</h1>" });
  check("html authed create sends Authorization", lastCall().headers.Authorization === "Bearer jwt-1");
  check("html authed create sends NO target", formField("target_entity_id") === null);
  check("html authed create sends NO cloudgrid.yaml part", lastCall().form?.get("cloudgrid.yaml") === null);
  check("html authed create surfaces entity_id", a1.structured.entity_id === "ent-3");
  check("html authed create carries no owner_token", !("owner_token" in a1.structured));

  replies = [
    { status: 202, body: { entity_id: "ent-3", slug: "s3", grid: "atomic", url: "https://atomic.cloudgrid.io/s3", status: "live" } },
  ];
  const a2 = await runPlug(authedCtx, { html: "<h1>v2</h1>", target_entity_id: "ent-3" });
  check("html authed re-plug targets the same entity", formField("target_entity_id") === "ent-3");
  check("html authed re-plug keeps Authorization", lastCall().headers.Authorization === "Bearer jwt-1");
  check("html authed re-plug attaches the required cloudgrid.yaml part", lastCall().form?.get("cloudgrid.yaml") !== null);
  check("html authed re-plug says Updated in place + same URL", /Updated in place/.test(a2.text) && a2.structured.url === "https://atomic.cloudgrid.io/s3");

  // Server url empty → client composition fallback.
  replies = [
    { status: 202, body: { entity_id: "ent-3", slug: "s3", grid: "atomic", url: "", status: "live", detection: { kind: "inspiration" } } },
  ];
  const a3 = await runPlug(authedCtx, { html: "<h1>v3</h1>" });
  check("empty server url falls back to client composition", a3.structured.url === "https://atomic.cloudgrid.io/s3");

  // ── new deploy → the MCP surfaces visibility for the agent to ASK the user;
  //    it never sets visibility silently (no auto-PATCH). Applies to every new
  //    create — inspiration and app, web and local.
  {
    const webAuthed = makeCtx({ token: "jwt-web", edition: "web" });
    webAuthed.getActiveGrid = async () => "acme";
    const before = calls.length;
    replies = [
      { status: 201, body: { entity_id: "ent-w", slug: "sw", grid: "acme", url: "https://acme.cloudgrid.io/sw", status: "live", visibility: "org" } },
    ];
    const w = await runPlug(webAuthed, { html: "<h1>hosted share</h1>" });
    const plugPost = calls
      .slice(before)
      .find((c) => c.url.endsWith("/api/v2/plug") && c.method === "POST");
    const patch = calls
      .slice(before)
      .find((c) => c.url.includes("/api/v2/inspirations/") && c.method === "PATCH");
    check("web authed html create posts to /plug with Authorization", Boolean(plugPost) && plugPost.headers.Authorization === "Bearer jwt-web");
    check("new deploy → visibility is NOT set silently (no PATCH)", !patch);
    check("new deploy → reports the server's current visibility", w.structured.current_visibility === "org");
    check("new deploy → offers the full visibility option set", Array.isArray(w.structured.visibility_options) && ["private", "org", "space", "link"].every((v) => w.structured.visibility_options.some((o) => o.value === v)));
    check("new deploy → instructs the agent to ASK then grid_visibility", /ASK the user who should be able to open this/.test(w.text) && /grid_visibility/.test(w.text));
    check("web authed html create → says Your app is live", /Your app is live/.test(w.text));
  }

  // A runtime app create ALSO gets the visibility ask (universal, not auto-set).
  {
    const webApp = makeCtx({ token: "jwt-app", edition: "web" });
    webApp.getActiveGrid = async () => "acme";
    const before = calls.length;
    replies = [
      { status: 202, body: { entity_id: "ent-app", slug: "app1", grid: "acme", url: "https://app1.acme.cloudgrid.io", status: "live", detection: { kind: "app" } } },
    ];
    const wa = await runPlug(webApp, { artifact_files: [{ path: "index.html", content: "<h1>x</h1>" }], hints: { kind: "app" } });
    const patch = calls
      .slice(before)
      .find((c) => c.url.includes("/api/v2/inspirations/") && c.method === "PATCH");
    check("app create → no silent visibility PATCH", !patch);
    check("app create → also offers options + asks", Array.isArray(wa.structured.visibility_options) && /ASK the user who should be able to open this/.test(wa.text));
  }

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

  // ── grid+slug re-plug (from the pickup contract's replug_handle) ────────────
  // A client holding only the grid+slug handle (not the raw entity_id) re-plugs
  // in place: runPlug resolves grid+slug → entity_id via the pickup contract,
  // then updates that entity. A slug that does NOT resolve → CREATE (no false-
  // positive). target_entity_id stays the primary handle.
  const isPickup = (u) => /\/api\/v2\/entities\/[^/]+\/pickup$/.test(u);

  // (a) grid+slug that resolves → RE-PLUG the resolved entity in place.
  {
    const gsCtx = makeCtx({ token: "jwt-gs", edition: "local" });
    gsCtx.getActiveGrid = async () => "acme";
    const before = calls.length;
    replies = [
      // pickup resolve: grid+slug → an existing entity
      { status: 200, body: { entity_id: "ent-gs", slug: "page", grid: "acme", kind: "inspiration", single_html: true, capabilities: { replug: true, fork: true }, replug_handle: { target_entity_id: "ent-gs", grid: "acme", slug: "page" } } },
      // the /plug re-plug
      { status: 202, body: { entity_id: "ent-gs", slug: "page", grid: "acme", url: "https://acme.cloudgrid.io/page", status: "live" } },
    ];
    const gs = await runPlug(gsCtx, { html: "<h1>edited</h1>", grid: "acme", slug: "page" });
    const madeCalls = calls.slice(before);
    const pickupCall = madeCalls.find((c) => isPickup(c.url));
    const plugPost = madeCalls.find((c) => c.url.endsWith("/api/v2/plug") && c.method === "POST");
    check("grid+slug: resolves via the pickup contract (POST /entities/page/pickup)", Boolean(pickupCall) && pickupCall.url.endsWith("/api/v2/entities/page/pickup") && pickupCall.method === "POST");
    check("grid+slug: pickup resolve carries the grid header", pickupCall?.headers?.["X-CloudGrid-Grid"] === "acme");
    check("grid+slug: /plug re-plugs the RESOLVED entity (not a create)", plugPost?.form?.get("target_entity_id") === "ent-gs");
    check("grid+slug: authed re-plug carries the cloudgrid.yaml part", plugPost?.form?.get("cloudgrid.yaml") !== null);
    check("grid+slug: says Updated in place + keeps the URL", /Updated in place/.test(gs.text) && gs.structured.url === "https://acme.cloudgrid.io/page");
  }

  // (b) grid+slug that does NOT resolve (404) → CREATE, never a false-positive re-plug.
  {
    const gnCtx = makeCtx({ token: "jwt-gn", edition: "local" });
    gnCtx.getActiveGrid = async () => "acme";
    const before = calls.length;
    replies = [
      { status: 404, body: { error: { code: "NOT_FOUND", message: "no such entity" } } }, // pickup resolve: nonexistent
      { status: 201, body: { entity_id: "ent-new", slug: "brand-new", grid: "acme", url: "https://acme.cloudgrid.io/brand-new", status: "live" } },
    ];
    const gn = await runPlug(gnCtx, { html: "<h1>new</h1>", grid: "acme", slug: "brand-new" });
    const madeCalls = calls.slice(before);
    const plugPost = madeCalls.find((c) => c.url.endsWith("/api/v2/plug") && c.method === "POST");
    check("grid+slug nonexistent: pickup resolve attempted", madeCalls.some((c) => isPickup(c.url)));
    check("grid+slug nonexistent: /plug sends NO target (CREATE, no false-positive)", plugPost?.form?.get("target_entity_id") === null);
    check("grid+slug nonexistent: creates a NEW entity", gn.structured.entity_id === "ent-new");
  }

  // (c) target_entity_id stays PRIMARY: when present, no pickup resolve happens.
  {
    const primaryCtx = makeCtx({ token: "jwt-p", edition: "local" });
    const before = calls.length;
    replies = [{ status: 202, body: { entity_id: "ent-primary", slug: "s", grid: "acme", url: "https://acme.cloudgrid.io/s", status: "live" } }];
    await runPlug(primaryCtx, { html: "<h1>x</h1>", target_entity_id: "ent-primary", grid: "acme", slug: "page" });
    const madeCalls = calls.slice(before);
    check("target_entity_id primary: NO pickup resolve when it is present", !madeCalls.some((c) => isPickup(c.url)));
    check("target_entity_id primary: /plug targets it directly", madeCalls.find((c) => c.url.endsWith("/api/v2/plug"))?.form?.get("target_entity_id") === "ent-primary");
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
