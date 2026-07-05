// Offline unit test for inline source-fetch (Task 35 / 0.8.3): gridctl_source
// fetches a drop's CURRENT deployed HTML inline so an agent that lost the
// content can edit it and re-plug in place. Drives the REAL runSource seam and
// the REAL registered tool handlers with a mocked global fetch, and asserts:
//   1. URL resolution order: explicit url > session lastDrop.url > entityUrl(grid,slug) > fail.
//   2. SSRF guard: non-*.cloudgrid.io url fails with NO fetch; *.cloudgrid.io url fetches.
//   3. HTML returned inline in content AND structuredContent.html; bytes set; truncated past 1.5MB.
//   4. Non-200 → graceful fail (no throw).
//   5. Defaults: no inputs + a session lastDrop → fetches lastDrop.url.
//   6. Alias cloudgrid_source registered and behaves identically to gridctl_source.
//   7. Playbook (gridctl_start) contains the new rule; drop/plug descriptions contain the new clause.
// Run: node test/source-fetch.test.mjs

import { runSource, registerTools } from "../src/tools.js";

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

// ── fetch mock: record requested urls; reply from a queue ───────────────────
let fetchCalls = [];
let replies = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  fetchCalls.push({ url: String(url), method: opts.method || "GET" });
  const next = replies.shift() ?? { status: 200, body: "<!doctype html><html></html>" };
  const body = typeof next.body === "string" ? next.body : String(next.body);
  const res = new Response(body, {
    status: next.status,
    headers: { "content-type": "text/html", ...(next.headers || {}) },
  });
  // Response.url is read-only and defaults to ""; override it so redirect
  // detection can be exercised.
  Object.defineProperty(res, "url", { value: next.finalUrl ?? String(url), configurable: true });
  return res;
};

const reset = () => { fetchCalls = []; replies = []; };

try {
  // ── 1. Resolution order ───────────────────────────────────────────────────
  // explicit url wins over session state.
  reset();
  replies = [{ status: 200, body: "<html>explicit</html>" }];
  await runSource(
    makeCtx({ lastDrop: { entity_id: "e1", url: "https://acme.cloudgrid.io/session" } }),
    { url: "https://acme.cloudgrid.io/explicit" },
  );
  check("explicit url wins over session lastDrop", fetchCalls[0]?.url === "https://acme.cloudgrid.io/explicit");

  // session lastDrop.url used when no explicit url.
  reset();
  replies = [{ status: 200, body: "<html>session</html>" }];
  await runSource(
    makeCtx({ lastDrop: { entity_id: "e1", url: "https://acme.cloudgrid.io/session" } }),
    {},
  );
  check("session lastDrop.url used when no explicit url", fetchCalls[0]?.url === "https://acme.cloudgrid.io/session");

  // grid+slug composes the URL when neither url nor session state present.
  reset();
  replies = [{ status: 200, body: "<html>composed</html>" }];
  await runSource(makeCtx({ lastDrop: null }), { grid: "acme", slug: "page" });
  check(
    "grid+slug composes path-based apex URL",
    fetchCalls[0]?.url === "https://acme.cloudgrid.io/page",
  );

  // no url, no session, no grid+slug → fail (throws).
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

  // ── 2. SSRF guard ──────────────────────────────────────────────────────────
  reset();
  let ssrfThrew = false;
  try {
    await runSource(makeCtx({ lastDrop: null }), { url: "https://evil.example.com/x" });
  } catch (err) {
    ssrfThrew = /limited to https:\/\/\*\.cloudgrid\.io/.test(err.message);
  }
  check("SSRF: non-cloudgrid host fails, no fetch performed", ssrfThrew && fetchCalls.length === 0);

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

  reset();
  replies = [{ status: 200, body: "<html>ok</html>" }];
  await runSource(makeCtx({ lastDrop: null }), { url: "https://sub.cloudgrid.io/x" });
  check("SSRF: *.cloudgrid.io url is fetched", fetchCalls.length === 1);

  // redirect off cloudgrid is refused.
  reset();
  replies = [{ status: 200, body: "<html></html>", finalUrl: "https://evil.example.com/x" }];
  let redirectThrew = false;
  try {
    await runSource(makeCtx({ lastDrop: null }), { url: "https://acme.cloudgrid.io/x" });
  } catch (err) {
    redirectThrew = /Refusing to follow a redirect/.test(err.message);
  }
  check("SSRF: redirect off cloudgrid refused", redirectThrew);

  // ── 3. Inline HTML + bytes + truncated ─────────────────────────────────────
  reset();
  const smallHtml = "<!doctype html><html><body>hi</body></html>";
  replies = [{ status: 200, body: smallHtml }];
  const small = await runSource(makeCtx({ lastDrop: null }), { url: "https://acme.cloudgrid.io/p" });
  check("returns html inline in content text", small.text.includes(smallHtml));
  check("content text has the source prefix line", /Current source for https:\/\/acme\.cloudgrid\.io\/p \(\d+ bytes\)/.test(small.text));
  check("structuredContent.html is the html", small.structured.html === smallHtml);
  check("structured.bytes is the byte length", small.structured.bytes === Buffer.byteLength(smallHtml));
  check("structured.truncated false for small body", small.structured.truncated === false);
  check("structured.url echoes the fetched url", small.structured.url === "https://acme.cloudgrid.io/p");

  // truncated past 1.5MB.
  reset();
  const big = "x".repeat(1_500_001);
  replies = [{ status: 200, body: big }];
  const truncatedRes = await runSource(makeCtx({ lastDrop: null }), { url: "https://acme.cloudgrid.io/big" });
  check("bytes reports the FULL size even when truncated", truncatedRes.structured.bytes === 1_500_001);
  check("truncated:true past 1.5MB", truncatedRes.structured.truncated === true);
  check("truncated html is capped at 1.5MB", Buffer.byteLength(truncatedRes.structured.html) === 1_500_000);
  check("truncated note present in text", /too large to return in full/.test(truncatedRes.text));

  // entity_id echoed in structuredContent.
  reset();
  replies = [{ status: 200, body: "<html></html>" }];
  const echoed = await runSource(makeCtx({ lastDrop: null }), { url: "https://acme.cloudgrid.io/p", entity_id: "ent-42" });
  check("structured.entity_id echoes input", echoed.structured.entity_id === "ent-42");

  // ── 4. Non-200 → graceful fail (throws a friendly Error, no crash) ─────────
  reset();
  replies = [{ status: 404, body: "not found" }];
  let non200Threw = false;
  try {
    await runSource(makeCtx({ lastDrop: null }), { url: "https://acme.cloudgrid.io/gone" });
  } catch (err) {
    non200Threw = /Couldn't read the live drop \(HTTP 404\)/.test(err.message);
  }
  check("non-200 → graceful fail (HTTP status surfaced)", non200Threw);

  // ── 5. Defaults: no inputs + session lastDrop → fetch lastDrop.url ─────────
  reset();
  replies = [{ status: 200, body: "<html>default</html>" }];
  const def = await runSource(
    makeCtx({ lastDrop: { entity_id: "e9", url: "https://guest.cloudgrid.io/abc" } }),
    {},
  );
  check("defaults to session lastDrop.url", fetchCalls[0]?.url === "https://guest.cloudgrid.io/abc");
  check("defaults echo session entity_id", def.structured.entity_id === "e9");

  // ── 6 + 7. Registered handlers / alias / playbook / descriptions ───────────
  const server = makeServer();
  registerTools(server, makeCtx({ lastDrop: null }));

  check("gridctl_source registered", typeof server.handlers.gridctl_source === "function");
  check("cloudgrid_source alias registered", typeof server.handlers.cloudgrid_source === "function");

  // alias behaves identically to the primary tool.
  reset();
  replies = [{ status: 200, body: "<html>alias</html>" }, { status: 200, body: "<html>alias</html>" }];
  const viaPrimary = await server.handlers.gridctl_source({ url: "https://acme.cloudgrid.io/a" });
  const viaAlias = await server.handlers.cloudgrid_source({ url: "https://acme.cloudgrid.io/a" });
  check(
    "alias behaves identically (same structuredContent.html)",
    viaPrimary.structuredContent.html === viaAlias.structuredContent.html &&
      viaAlias.structuredContent.html === "<html>alias</html>",
  );

  // handler wraps a thrown error as a graceful { isError:true } result (no throw).
  reset();
  const errRes = await server.handlers.gridctl_source({ url: "https://evil.example.com/x" });
  check("handler returns isError result on SSRF (does not throw)", errRes?.isError === true);

  // playbook rule (served by gridctl_start).
  const start = await server.handlers.gridctl_start({});
  const startText = start?.content?.[0]?.text ?? "";
  check(
    "gridctl_start playbook contains the source-first rule",
    startText.includes("call gridctl_source to fetch the current HTML") ||
      /gridctl_source[\s\S]*target_entity_id[\s\S]*Do not ask the user to paste/.test(startText),
  );

  // drop/plug descriptions carry the new clause.
  check(
    "gridctl_drop description mentions gridctl_source",
    /call gridctl_source first to retrieve it, then re-plug with target_entity_id/.test(server.descriptions.gridctl_drop),
  );
  check(
    "gridctl_plug description mentions gridctl_source",
    /call gridctl_source first to retrieve it, then re-plug with target_entity_id/.test(server.descriptions.gridctl_plug),
  );
} finally {
  globalThis.fetch = realFetch;
}

if (failures > 0) {
  console.log(`\n${failures} source-fetch check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll source-fetch checks passed.");
