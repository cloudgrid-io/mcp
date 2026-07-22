// Offline unit test for inline source-fetch (Task 35 / 0.8.3, reworked 0.16.2):
// grid_source returns a drop's CURRENT deployed HTML inline so an agent that
// lost the content can edit it and re-plug in place.
//
// 0.16.2 flow change — API-first, public-fetch fallback:
//   runSource now reads the HTML from the API (GET
//   ${API_BASE}/api/v2/inspirations/<seg>/source) BEFORE fetching the public
//   *.cloudgrid.io URL. On the hosted edition the MCP pod can reach the API but
//   NOT the public ingress ("fetch failed"), so the API read is the primary path
//   and the public fetch is the fallback (used e.g. on the local edition, or when
//   the API can't serve the source).
//
// Drives the REAL runSource seam and the REAL registered tool handlers with a
// mocked global fetch that ROUTES BY URL (API read vs public fetch), and asserts:
//   1. URL resolution order: explicit url > session lastDrop.url > grid+slug > fail.
//   2. SSRF guard: non-*.cloudgrid.io / http / lookalike url fails with NO fetch at
//      all (neither the API read nor the public fetch); a *.cloudgrid.io url proceeds.
//   3. API-first: API returns {html} → returned inline WITHOUT any public fetch.
//   4. Fallback: API non-ok → falls back to the public fetch and returns its HTML.
//   5. entity_id present → the API is called with /inspirations/<entity_id>/source.
//   6. HTML returned inline in content AND structuredContent.html; bytes set;
//      truncated past 1.5MB (via whichever path).
//   7. Non-200 on the public fallback → graceful fail (no crash); redirect off
//      cloudgrid refused.
//   8. Defaults: no inputs + a session lastDrop → reads lastDrop's source.
//   9. Only grid_source is registered — the deprecated cloudgrid_source alias
//      is gone (0.10.0); playbook + drop/plug descriptions carry the source rule.
// Run: node test/source-fetch.test.mjs

import { runSource, registerTools, API_BASE } from "../src/tools.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// ── Fake MCP server: capture handlers AND descriptions by name ──────────────
function makeServer() {
  const handlers = {};
  const descriptions = {};
  return {
    handlers,
    descriptions,
    registerTool(name, config, handler) {
      handlers[name] = handler;
      descriptions[name] = config?.description ?? "";
    },
    tool(name, desc, _schema, _annotations, handler) {
      handlers[name] = handler;
      descriptions[name] = desc ?? "";
    },
    registerResource() {},
  };
}

function makeCtx({ token = null, edition = "web", lastDrop = null } = {}) {
  return {
    edition,
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop, anonCookie: null },
    canOpenBrowser: false,
    getToken: async () => token,
    getActiveGrid: async () => null,
    saveToken: async () => ({}),
    savedLocationNote: () => "",
    trustedServer: null,
  };
}

// ── fetch mock ──────────────────────────────────────────────────────────────
// Routes by URL: `${API_BASE}/api/v2/inspirations/<seg>/source` is the API read;
// any other (*.cloudgrid.io) URL is the public fetch.
//   - apiHtml: string  → API read responds 200 { html: apiHtml }.
//   - apiHtml: null    → API read responds non-ok (403), forcing the public fallback.
//   - publicReplies: FIFO queue of { status, body, headers?, finalUrl? } for the
//     public fetch path (mirrors the old single-queue mock).
let fetchCalls = [];
let apiHtml = null; // default: force fallback so the public path is exercised
let publicReplies = [];
// Pickup-contract reply (POST /api/v2/entities/:target/pickup). Default null →
// the mock responds 404, so the best-effort url→entity_id resolve is a no-op and
// existing (pre-pickup) behavior is preserved.
let pickupReply = null;
const realFetch = globalThis.fetch;

const isApiSourceUrl = (u) => /\/api\/v2\/inspirations\/[^/]+\/source$/.test(u);
const isPickupUrl = (u) => /\/api\/v2\/entities\/[^/]+\/pickup$/.test(u);
const apiSourceCalls = () => fetchCalls.filter((c) => isApiSourceUrl(c.url));
const pickupCalls = () => fetchCalls.filter((c) => isPickupUrl(c.url));
const publicCalls = () => fetchCalls.filter((c) => !isApiSourceUrl(c.url) && !isPickupUrl(c.url));

function makeResponse({ status = 200, body = "", headers = {}, finalUrl, url }) {
  const res = new Response(String(body), {
    status,
    headers: { "content-type": "text/html", ...headers },
  });
  // Response.url is read-only and defaults to ""; override it so redirect
  // detection (on the public path) can be exercised.
  Object.defineProperty(res, "url", { value: finalUrl ?? url ?? "", configurable: true });
  return res;
}

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  fetchCalls.push({ url: u, method: opts.method || "GET", headers: opts.headers || {} });
  if (isPickupUrl(u)) {
    // Pickup-contract resolve path (POST). Respond from pickupReply, or 404.
    const r = pickupReply ?? { status: 404, body: JSON.stringify({ error: "not found" }) };
    return makeResponse({ status: r.status, body: typeof r.body === "string" ? r.body : JSON.stringify(r.body), url: u });
  }
  if (isApiSourceUrl(u)) {
    // API read path. The real route (GET /api/v2/inspirations/:seg/source)
    // returns the RAW HTML bytes as text/html — NOT a JSON { html } envelope.
    // Mock it faithfully so the reader is tested against the real contract.
    if (typeof apiHtml === "string") {
      return makeResponse({
        status: 200,
        body: apiHtml,
        headers: { "content-type": "text/html; charset=utf-8" },
        url: u,
      });
    }
    return makeResponse({ status: 403, body: JSON.stringify({ error: "no source" }), url: u });
  }
  // Public fetch path.
  const next = publicReplies.shift() ?? { status: 200, body: "<!doctype html><html></html>" };
  return makeResponse({ ...next, url: u });
};

const reset = () => {
  fetchCalls = [];
  apiHtml = null; // fallback by default
  publicReplies = [];
  pickupReply = null; // pickup resolve is a no-op (404) unless a test arms it
};

try {
  // ── 1. Resolution order (exercised via the public fallback: apiHtml=null) ───
  // explicit url wins over session state — the fallback fetch hits the explicit url.
  reset();
  publicReplies = [{ status: 200, body: "<html>explicit</html>" }];
  await runSource(
    makeCtx({ lastDrop: { entity_id: "e1", url: "https://acme.cloudgrid.io/session" } }),
    { url: "https://acme.cloudgrid.io/explicit" },
  );
  check(
    "explicit url wins over session lastDrop (public fetch target)",
    publicCalls()[0]?.url === "https://acme.cloudgrid.io/explicit",
  );

  // session lastDrop.url used when no explicit url.
  reset();
  publicReplies = [{ status: 200, body: "<html>session</html>" }];
  await runSource(
    makeCtx({ lastDrop: { entity_id: "e1", url: "https://acme.cloudgrid.io/session" } }),
    {},
  );
  check(
    "session lastDrop.url used when no explicit url",
    publicCalls()[0]?.url === "https://acme.cloudgrid.io/session",
  );

  // grid+slug composes the URL when neither url nor session state present.
  reset();
  publicReplies = [{ status: 200, body: "<html>composed</html>" }];
  await runSource(makeCtx({ lastDrop: null }), { grid: "acme", slug: "page" });
  check(
    "grid+slug composes path-based apex URL",
    publicCalls()[0]?.url === "https://acme.cloudgrid.io/page",
  );

  // no url, no session, no grid+slug → fail (throws), no fetch of any kind.
  reset();
  let threw = false;
  try {
    await runSource(makeCtx({ lastDrop: null }), {});
  } catch (err) {
    threw = /don't have this drop's URL/.test(err.message);
  }
  check("no url + no session + no grid/slug → fail", threw && fetchCalls.length === 0);

  // entity_id mismatch with session lastDrop → do NOT reuse session url.
  reset();
  let mismatchThrew = false;
  try {
    await runSource(
      makeCtx({ lastDrop: { entity_id: "e1", url: "https://acme.cloudgrid.io/session" } }),
      { entity_id: "other" },
    );
  } catch (err) {
    mismatchThrew = /don't have this drop's URL/.test(err.message);
  }
  check("entity_id mismatch does not reuse session url", mismatchThrew && fetchCalls.length === 0);

  // ── 2. SSRF guard (rejected BEFORE any fetch — API read or public) ──────────
  reset();
  let ssrfThrew = false;
  try {
    await runSource(makeCtx({ lastDrop: null }), { url: "https://evil.example.com/x" });
  } catch (err) {
    ssrfThrew = /limited to https:\/\/\*\.cloudgrid\.io/.test(err.message);
  }
  check("SSRF: non-cloudgrid host fails, NO fetch (API or public)", ssrfThrew && fetchCalls.length === 0);

  // lookalike host must NOT pass (cloudgrid.io.evil.com).
  reset();
  let lookalikeThrew = false;
  try {
    await runSource(makeCtx({ lastDrop: null }), { url: "https://cloudgrid.io.evil.com/x" });
  } catch {
    lookalikeThrew = true;
  }
  check("SSRF: lookalike host rejected, no fetch", lookalikeThrew && fetchCalls.length === 0);

  // http (non-https) cloudgrid host rejected.
  reset();
  let httpThrew = false;
  try {
    await runSource(makeCtx({ lastDrop: null }), { url: "http://acme.cloudgrid.io/x" });
  } catch {
    httpThrew = true;
  }
  check("SSRF: http (non-https) rejected, no fetch", httpThrew && fetchCalls.length === 0);

  // a valid *.cloudgrid.io url proceeds — API read attempted, then public fallback.
  reset();
  publicReplies = [{ status: 200, body: "<html>ok</html>" }];
  await runSource(makeCtx({ lastDrop: null }), { url: "https://sub.cloudgrid.io/x" });
  check("SSRF: *.cloudgrid.io url proceeds to a public fetch (fallback)", publicCalls().length === 1);

  // redirect off cloudgrid is refused (public fallback path).
  reset();
  publicReplies = [{ status: 200, body: "<html></html>", finalUrl: "https://evil.example.com/x" }];
  let redirectThrew = false;
  try {
    await runSource(makeCtx({ lastDrop: null }), { url: "https://acme.cloudgrid.io/x" });
  } catch (err) {
    redirectThrew = /Refusing to follow a redirect/.test(err.message);
  }
  check("SSRF: redirect off cloudgrid refused", redirectThrew);

  // ── 3. API-first: API returns {html} → returned inline, NO public fetch ─────
  reset();
  apiHtml = "<!doctype html><html><body>from-api</body></html>";
  const viaApi = await runSource(
    makeCtx({ lastDrop: { entity_id: "e1", url: "https://acme.cloudgrid.io/session" } }),
    { url: "https://acme.cloudgrid.io/p" },
  );
  check("API-first: structured.html is the API html", viaApi.structured.html === apiHtml);
  check("API-first: content text includes the API html", viaApi.text.includes(apiHtml));
  check("API-first: the API source route was hit", apiSourceCalls().length >= 1);
  check("API-first: NO public fetch when the API served the html", publicCalls().length === 0);
  check(
    "API-first: structured.url still echoes the resolved public url",
    viaApi.structured.url === "https://acme.cloudgrid.io/p",
  );

  // ── 4. Fallback: API non-ok → public fetch, returns its HTML ────────────────
  reset();
  apiHtml = null; // API returns non-ok
  publicReplies = [{ status: 200, body: "<html>from-public</html>" }];
  const viaFallback = await runSource(makeCtx({ lastDrop: null }), {
    url: "https://acme.cloudgrid.io/p",
  });
  check("fallback: API attempted then non-ok", apiSourceCalls().length >= 1);
  check("fallback: exactly one public fetch performed", publicCalls().length === 1);
  check("fallback: structured.html is the public html", viaFallback.structured.html === "<html>from-public</html>");

  // ── 5. entity_id present → API called with /inspirations/<entity_id>/source ──
  reset();
  apiHtml = null;
  publicReplies = [{ status: 200, body: "<html></html>" }];
  await runSource(makeCtx({ lastDrop: null }), {
    url: "https://acme.cloudgrid.io/p",
    entity_id: "ent-42",
  });
  check(
    "entity_id: API read hits /inspirations/ent-42/source first",
    apiSourceCalls()[0]?.url === `${API_BASE}/api/v2/inspirations/ent-42/source`,
  );

  // entity_id echoed in structuredContent (via the API path here).
  reset();
  apiHtml = "<html>echo</html>";
  const echoed = await runSource(makeCtx({ lastDrop: null }), {
    url: "https://acme.cloudgrid.io/p",
    entity_id: "ent-42",
  });
  check("structured.entity_id echoes input", echoed.structured.entity_id === "ent-42");

  // ── 6. Inline HTML + bytes + truncated ──────────────────────────────────────
  reset();
  apiHtml = null;
  const smallHtml = "<!doctype html><html><body>hi</body></html>";
  publicReplies = [{ status: 200, body: smallHtml }];
  const small = await runSource(makeCtx({ lastDrop: null }), { url: "https://acme.cloudgrid.io/p" });
  check("returns html inline in content text", small.text.includes(smallHtml));
  check(
    "content text has the source prefix line",
    /Current source for https:\/\/acme\.cloudgrid\.io\/p \(\d+ bytes\)/.test(small.text),
  );
  check("structuredContent.html is the html", small.structured.html === smallHtml);
  check("structured.bytes is the byte length", small.structured.bytes === Buffer.byteLength(smallHtml));
  check("structured.truncated false for small body", small.structured.truncated === false);
  check("structured.url echoes the resolved url", small.structured.url === "https://acme.cloudgrid.io/p");

  // truncated past 1.5MB — exercised via the API path (shared shaping helper).
  reset();
  apiHtml = "x".repeat(1_500_001);
  const truncatedRes = await runSource(makeCtx({ lastDrop: null }), { url: "https://acme.cloudgrid.io/big" });
  check("bytes reports the FULL size even when truncated", truncatedRes.structured.bytes === 1_500_001);
  check("truncated:true past 1.5MB", truncatedRes.structured.truncated === true);
  check("truncated html is capped at 1.5MB", Buffer.byteLength(truncatedRes.structured.html) === 1_500_000);
  check("truncated note present in text", /too large to return in full/.test(truncatedRes.text));

  // ── 7. Non-200 on the public fallback → graceful fail (no crash) ────────────
  reset();
  apiHtml = null;
  publicReplies = [{ status: 404, body: "not found" }];
  let non200Threw = false;
  try {
    await runSource(makeCtx({ lastDrop: null }), { url: "https://acme.cloudgrid.io/gone" });
  } catch (err) {
    non200Threw = /Couldn't read the live drop \(HTTP 404\)/.test(err.message);
  }
  check("non-200 on public fallback → graceful fail (HTTP status surfaced)", non200Threw);

  // ── 8. Defaults: no inputs + session lastDrop → reads lastDrop's source ─────
  reset();
  apiHtml = null;
  publicReplies = [{ status: 200, body: "<html>default</html>" }];
  const def = await runSource(
    makeCtx({ lastDrop: { entity_id: "e9", url: "https://guest.cloudgrid.io/abc" } }),
    {},
  );
  check("defaults to session lastDrop.url (public fallback)", publicCalls()[0]?.url === "https://guest.cloudgrid.io/abc");
  check("defaults echo session entity_id", def.structured.entity_id === "e9");
  // the session entity_id is also used to key the API read.
  check(
    "defaults: API read keyed by session entity_id",
    apiSourceCalls().some((c) => c.url === `${API_BASE}/api/v2/inspirations/e9/source`),
  );

  // ── 10. URL → entity_id via the pickup contract (fresh chat, no session) ────
  // A bare URL with no session lastDrop and no entity_id resolves a REAL
  // entity_id (+ edition metadata) through the deployed pickup contract, so the
  // agent can re-plug in place. The HTML still comes from the API read.
  const pickupBody = {
    entity_id: "e9",
    slug: "page",
    grid: "acme",
    kind: "inspiration",
    single_html: true,
    version: 3,
    url: "https://acme.cloudgrid.io/page",
    owner: { handle: "me", is_you: true },
    capabilities: { replug: true, fork: true },
    replug_handle: { target_entity_id: "e9", grid: "acme", slug: "page" },
    source_download_url: "/api/v2/inspirations/page/source",
  };

  reset();
  apiHtml = "<!doctype html><html><body>picked-up</body></html>";
  pickupReply = { status: 200, body: pickupBody };
  const picked = await runSource(
    makeCtx({ token: "jwt-x", lastDrop: null }),
    { url: "https://acme.cloudgrid.io/page" },
  );
  check("pickup resolve: entity_id resolved (not null)", picked.structured.entity_id === "e9");
  check("pickup resolve: HTML still returned via the API read", picked.structured.html === apiHtml);
  check("pickup resolve: the pickup contract was called exactly once", pickupCalls().length === 1);
  check("pickup resolve: contract POSTed (not fetched public)", pickupCalls()[0]?.method === "POST");
  check("pickup resolve: NO public *.cloudgrid.io fetch for resolution", publicCalls().length === 0);
  check("pickup resolve: carries kind", picked.structured.kind === "inspiration");
  check("pickup resolve: carries single_html", picked.structured.single_html === true);
  check("pickup resolve: carries capabilities.replug", picked.structured.capabilities?.replug === true);
  check("pickup resolve: carries replug_handle", picked.structured.replug_handle?.target_entity_id === "e9");
  check("pickup resolve: carries source_download_url", picked.structured.source_download_url === "/api/v2/inspirations/page/source");
  // The API read is keyed by the resolved entity_id.
  check(
    "pickup resolve: API read keyed by resolved entity_id",
    apiSourceCalls().some((c) => c.url === `${API_BASE}/api/v2/inspirations/e9/source`),
  );

  // Best-effort: pickup failure → falls back to today's behavior (no throw, HTML
  // still served via the API read, entity_id null). Never regress the read.
  reset();
  apiHtml = "<html>still-served</html>";
  pickupReply = { status: 500, body: { error: "boom" } };
  const degraded = await runSource(
    makeCtx({ token: "jwt-x", lastDrop: null }),
    { url: "https://acme.cloudgrid.io/page" },
  );
  check("pickup failure: does not throw; HTML still returned", degraded.structured.html === "<html>still-served</html>");
  check("pickup failure: entity_id falls back to null", degraded.structured.entity_id === null);
  check("pickup failure: still no public fetch", publicCalls().length === 0);

  // When the entity_id is already known (session state), the pickup resolve is
  // SKIPPED — no needless contract call.
  reset();
  apiHtml = "<html>known</html>";
  pickupReply = { status: 200, body: { entity_id: "should-not-be-used" } };
  const known = await runSource(
    makeCtx({ lastDrop: { entity_id: "e1", url: "https://acme.cloudgrid.io/s" } }),
    {},
  );
  check("pickup skipped when entity_id already known (session)", pickupCalls().length === 0);
  check("pickup skipped: session entity_id preserved", known.structured.entity_id === "e1");

  // ── 9. Registered handlers / no alias / playbook / descriptions ─────────────
  const server = makeServer();
  registerTools(server, makeCtx({ lastDrop: null }));

  check("grid_source registered", typeof server.handlers.grid_get_app_source === "function");
  // 0.10.0: the deprecated cloudgrid_source alias is gone.
  check("cloudgrid_source alias NOT registered", server.handlers.cloudgrid_source === undefined);
  const cloudgridHandlers = Object.keys(server.handlers).filter((n) => n.startsWith("cloudgrid_"));
  check(
    `no registered handler starts with cloudgrid_ (found: ${cloudgridHandlers.join(", ") || "none"})`,
    cloudgridHandlers.length === 0,
  );

  // the primary tool still returns inline HTML (via the API path here).
  reset();
  apiHtml = "<html>primary</html>";
  const viaPrimary = await server.handlers.grid_get_app_source({ url: "https://acme.cloudgrid.io/a" });
  check(
    "grid_source returns inline HTML",
    viaPrimary.structuredContent.html === "<html>primary</html>",
  );

  // handler wraps a thrown error as a graceful { isError:true } result (no throw).
  reset();
  const errRes = await server.handlers.grid_get_app_source({ url: "https://evil.example.com/x" });
  check("handler returns isError result on SSRF (does not throw)", errRes?.isError === true);

  // playbook rule (served by grid_start).
  const start = await server.handlers.grid_start({});
  const startText = start?.content?.[0]?.text ?? "";
  check(
    "grid_start playbook contains the source-first rule",
    startText.includes("call grid_get_app_source to fetch the current HTML") ||
      /grid_get_app_source[\s\S]*target_entity_id[\s\S]*Do not ask the user to paste/.test(startText),
  );

  // grid_plug (primary) description carries the source-first clause.
  check(
    "grid_plug description mentions grid_get_app_source",
    /call grid_get_app_source first, then deploy with target_entity_id/.test(server.descriptions.grid_plug),
  );

  // ── Edition-aware edit flow (spec §6): the playbook carries EACH branch ──────
  check(
    "playbook: edit-from-URL branch — grid_get_app_source resolves entity_id + single_html",
    /grid_get_app_source/.test(startText) && /entity_id/.test(startText) && /single_html/.test(startText),
  );
  check(
    "playbook: edit-in-place branch — single-HTML + capabilities.replug via target_entity_id / grid+slug",
    /capabilities\.replug/.test(startText) && /target_entity_id/.test(startText) && /grid\+slug/.test(startText),
  );
  check(
    "playbook: multi-file fallback branch — app/agent or single_html:false → source_download_url + local edition/CLI",
    /multi-file/.test(startText) && /source_download_url/.test(startText) && /local edition/.test(startText) && /CLI/.test(startText),
  );
  check(
    "playbook: not-owner fork branch — replug:false / not_owner → grid_copy_app",
    /not_owner/.test(startText) && /grid_copy_app/.test(startText),
  );

  // grid_plug description advertises grid+slug as an alternative re-plug handle.
  check(
    "grid_plug description mentions grid+slug re-plug handle",
    /grid\s*\+\s*slug/.test(server.descriptions.grid_plug),
  );
  // grid_get_app_source (renamed from grid_source) description advertises
  // URL→entity_id resolution + edition metadata. The grid_source alias was
  // dropped in the 0.20.8 alias diet — assert it stays gone.
  check(
    "grid_get_app_source description mentions resolving entity_id from a URL + capabilities",
    /entity_id/.test(server.descriptions.grid_get_app_source) && /capabilities/.test(server.descriptions.grid_get_app_source),
  );
  check(
    "grid_source alias is no longer registered (0.20.8 alias diet)",
    server.descriptions.grid_source === undefined,
  );
} finally {
  globalThis.fetch = realFetch;
}

if (failures > 0) {
  console.log(`\n${failures} source-fetch check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll source-fetch checks passed.");
