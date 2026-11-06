// Offline test: a re-plug never writes a source that does not fit the target's
// kind (#481).
//
// Claims under test:
//   1. runtime app files (cloudgrid.yaml, package.json, index.js) re-plugged
//      onto a single-page site are refused BEFORE the plug POST, with the
//      agent-facing next step (plug again without target_entity_id).
//   2. the kind comes from this session's last plug when it is the same
//      entity (no extra read), else from the API (inspiration read, then the
//      runtime card).
//   3. a lone HTML page re-plugged onto a runtime app is refused before the
//      plug POST (it would replace the app's whole source).
//   4. fitting re-plugs still go through: a page onto a page, a page with
//      assets led by index.html onto a page, a full app onto an app.
//   5. an unknown kind (both reads fail) goes ahead as before.
//   6. the owner-token wire (a guest drop, always a page) is guarded too.
//   7. the refusal copy follows the voice rules.
// Run: node test/replug-kind-guard.test.mjs

import { runPlug, replugKindMismatch, STATIC_TARGET_REFUSAL, RUNTIME_TARGET_REFUSAL } from "../src/tools.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

function makeCtx({ token = "jwt-k", lastDrop = null } = {}) {
  return {
    edition: "web",
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop, anonCookie: null },
    canOpenBrowser: false,
    getToken: async () => token,
    getActiveGrid: async () => "acme",
    saveToken: async () => ({}),
    savedLocationNote: () => "",
    trustedServer: null,
    deployPollBudgetMs: 20,
    deployPollIntervalMs: 5,
  };
}

let calls = [];
let routes = {};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push({ url: u, method: opts.method || "GET" });
  const key = Object.keys(routes).find((k) => u.includes(k));
  const r = key ? routes[key] : { status: 404, body: { error: { code: "NOT_FOUND" } } };
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
};
const reset = (r) => { calls = []; routes = r; };
const plugPosts = () => calls.filter((c) => c.method === "POST" && c.url.includes("/api/v2/plug"));
const gets = (frag) => calls.filter((c) => c.method === "GET" && c.url.includes(frag));

async function attempt(ctx, input) {
  try {
    return { result: await runPlug(ctx, input), error: null };
  } catch (err) {
    return { result: null, error: err };
  }
}

const RUNTIME_FILES = [
  { path: "package.json", content: '{"name":"notes","main":"index.js"}' },
  { path: "cloudgrid.yaml", content: "name: notes\nneeds:\n  database: true\n" },
  { path: "index.js", content: "require('http').createServer((q, s) => s.end('ok')).listen(8080);" },
];
const PAGE_ID = "ent-page";
const APP_ID = "ent-app";
const UPDATED_PAGE = { entity_id: PAGE_ID, slug: "p", grid: "acme", url: "https://acme.cloudgrid.io/p", status: "live" };
const UPDATED_APP = { entity_id: APP_ID, slug: "a", grid: "acme", url: "https://a--acme.cloudgrid.io", status: "live" };

try {
  // ── 1 + 2. runtime files onto a page, kind read from the API ─────────────
  reset({
    [`/api/v2/inspirations/${PAGE_ID}`]: { status: 200, body: { entity_id: PAGE_ID, realm: "inspiration", kind: "inspiration" } },
    "/api/v2/plug": { status: 200, body: UPDATED_PAGE },
  });
  let r = await attempt(makeCtx(), { artifact_files: RUNTIME_FILES, target_entity_id: PAGE_ID });
  check("runtime files onto a page → refused", r.error?.message === STATIC_TARGET_REFUSAL);
  check("runtime files onto a page → nothing was posted", plugPosts().length === 0);
  check("runtime files onto a page → the kind was read from the inspiration read", gets(`/api/v2/inspirations/${PAGE_ID}`).length === 1);
  check("refusal → says nothing changed and the page stays",
    /^Nothing was changed\./.test(STATIC_TARGET_REFUSAL) && /The current page stays as is\.$/.test(STATIC_TARGET_REFUSAL));
  check("refusal → names the next call", /call grid_plug again with the same artifact_files and without target_entity_id/.test(STATIC_TARGET_REFUSAL));

  // ── 2. the session's last plug answers without a read ────────────────────
  reset({ "/api/v2/plug": { status: 200, body: UPDATED_PAGE } });
  r = await attempt(makeCtx({ lastDrop: { entity_id: PAGE_ID, kind: "inspiration" } }), { artifact_files: RUNTIME_FILES, target_entity_id: PAGE_ID });
  check("same-session page → refused from session state", r.error?.message === STATIC_TARGET_REFUSAL);
  check("same-session page → no read, no post", calls.length === 0);

  // A server file with no manifest, led by a non-HTML file, is not a page either.
  reset({ [`/api/v2/inspirations/${PAGE_ID}`]: { status: 200, body: {} } });
  r = await attempt(makeCtx(), { artifact_files: [{ path: "server.js", content: "x" }, { path: "style.css", content: "y" }], target_entity_id: PAGE_ID });
  check("files with no HTML page onto a page → refused", r.error?.message === STATIC_TARGET_REFUSAL && plugPosts().length === 0);

  // ── 3. a lone page onto a runtime app ────────────────────────────────────
  reset({
    [`/api/v2/runtimes/${APP_ID}/card`]: { status: 200, body: { kind: "app" } },
    "/api/v2/plug": { status: 200, body: UPDATED_APP },
  });
  r = await attempt(makeCtx(), { html: "<h1>just a page</h1>", target_entity_id: APP_ID });
  check("html onto an app → refused", r.error?.message === RUNTIME_TARGET_REFUSAL);
  check("html onto an app → nothing was posted", plugPosts().length === 0);
  check("html onto an app → inspiration read first, then the runtime card",
    gets(`/api/v2/inspirations/${APP_ID}`).length === 1 && gets(`/api/v2/runtimes/${APP_ID}/card`).length === 1);
  check("app refusal → says how to update the app and how to publish the page",
    /send all of its files in artifact_files, with its cloudgrid\.yaml/.test(RUNTIME_TARGET_REFUSAL) &&
      /without target_entity_id/.test(RUNTIME_TARGET_REFUSAL) && /The app stays as is\.$/.test(RUNTIME_TARGET_REFUSAL));

  reset({ [`/api/v2/runtimes/${APP_ID}/card`]: { status: 200, body: { kind: "agent" } } });
  r = await attempt(makeCtx(), { artifact_files: [{ path: "index.html", content: "<h1>x</h1>" }], target_entity_id: APP_ID });
  check("one .html file onto an agent → refused", r.error?.message === RUNTIME_TARGET_REFUSAL && plugPosts().length === 0);

  // ── 4. fitting re-plugs go through ───────────────────────────────────────
  reset({
    [`/api/v2/inspirations/${PAGE_ID}`]: { status: 200, body: { visibility: "private" } },
    "/api/v2/plug": { status: 200, body: UPDATED_PAGE },
  });
  r = await attempt(makeCtx(), { html: "<h1>v2</h1>", target_entity_id: PAGE_ID });
  check("html onto a page → posted", !r.error && plugPosts().length === 1);

  reset({
    [`/api/v2/inspirations/${PAGE_ID}`]: { status: 200, body: { visibility: "private" } },
    "/api/v2/plug": { status: 200, body: UPDATED_PAGE },
  });
  r = await attempt(makeCtx(), {
    artifact_files: [{ path: "style.css", content: "h1{}" }, { path: "index.html", content: "<h1>v3</h1>" }],
    target_entity_id: PAGE_ID,
  });
  check("page with assets onto a page → posted", !r.error && plugPosts().length === 1);

  reset({
    [`/api/v2/runtimes/${APP_ID}/card`]: { status: 200, body: { kind: "app", visibility: "grid" } },
    "/api/v2/plug": { status: 200, body: UPDATED_APP },
  });
  r = await attempt(makeCtx(), { artifact_files: RUNTIME_FILES, target_entity_id: APP_ID });
  check("full app onto an app → posted", !r.error && plugPosts().length === 1);

  // ── 5. unknown kind → as before ──────────────────────────────────────────
  reset({ "/api/v2/plug": { status: 200, body: UPDATED_PAGE } });
  r = await attempt(makeCtx(), { artifact_files: RUNTIME_FILES, target_entity_id: "ent-unknown" });
  check("unknown kind → the re-plug goes ahead", !r.error && plugPosts().length === 1);

  // ── 6. owner-token wire: always a page ───────────────────────────────────
  reset({ "/api/v2/plug": { status: 200, body: UPDATED_PAGE } });
  r = await attempt(makeCtx({ token: null }), { artifact_files: RUNTIME_FILES, target_entity_id: PAGE_ID, owner_token: "own-1" });
  check("guest drop + runtime files → refused, nothing posted, no read",
    r.error?.message === STATIC_TARGET_REFUSAL && calls.length === 0);

  // ── pure helper table ────────────────────────────────────────────────────
  const page = [{ path: "index.html" }];
  check("helper: unknown kind → null", replugKindMismatch({ targetKind: null, artifacts: RUNTIME_FILES }) === null);
  check("helper: a single image onto a page → allowed", replugKindMismatch({ targetKind: "inspiration", artifacts: [{ path: "photo.png" }] }) === null);
  check("helper: a manifest param with files onto a page → refused",
    replugKindMismatch({ targetKind: "inspiration", artifacts: page, manifestFromArtifacts: true }) === STATIC_TARGET_REFUSAL);
  check("helper: one page with a manifest onto an app → allowed",
    replugKindMismatch({ targetKind: "app", artifacts: page, manifestFromArtifacts: true }) === null);

  // ── 7. voice ─────────────────────────────────────────────────────────────
  for (const [name, text] of [["static", STATIC_TARGET_REFUSAL], ["runtime", RUNTIME_TARGET_REFUSAL]]) {
    check(`voice (${name}): no exclamation mark, em dash, or emoji`, !/[!—–]|\p{Extended_Pictographic}/u.test(text));
    check(`voice (${name}): no other CLI verb`, !/\b(cloudgrid|gridctl|cg)\s+[a-z]/.test(text));
  }
} finally {
  globalThis.fetch = realFetch;
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll replug-kind-guard checks passed (offline).");
