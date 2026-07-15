// Offline unit test for the QA "model-as-courier" capture (grid_deploy carries
// the user's request + a self-reported build note into the QA session log).
// Drives the REAL registered grid_deploy handler (via registerTools + a fake
// server) with a mocked plug API and a stub sink, and asserts what the flushed
// QA log carries. Run: node test/qa-courier.test.mjs
//
// Plain .mjs + node:assert — no vitest. Fake-server + stubSink pattern mirrors
// test/session-logger.test.mjs and test/grid-picker.test.mjs.

import assert from "node:assert/strict";
import { registerTools } from "../src/tools.js";
import { SessionLogger } from "../src/session-logger.js";

let failures = 0;
function test(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok   ${label}`))
    .catch((e) => { failures++; console.log(`FAIL ${label}\n     ${e.message}`); });
}

// ── Fake MCP server: capture the registered tool handlers by name ───────────
function makeToolServer() {
  const handlers = {};
  return {
    handlers,
    registerTool(name, _config, handler) { handlers[name] = handler; },
    tool(name, _d, _s, _a, handler) { handlers[name] = handler; },
    registerResource() {},
  };
}

function stubSink() {
  const sent = [];
  return { sent, send: async (payload) => { sent.push(payload); } };
}

function makeCtx({ token = null, sink, loggerOpts = {} } = {}) {
  const ctx = {
    edition: "web",
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null, client: { name: "test", version: "1" } },
    canOpenBrowser: false,
    getToken: async () => token,
    getActiveGrid: async () => null,
    saveToken: async () => ({}),
    savedLocationNote: () => "",
    trustedServer: null,
  };
  ctx.logger = new SessionLogger({ transport: "hosted", sessionId: "s1", sink, ctx, now: () => 0, ...loggerOpts });
  return ctx;
}

// ── fetch mock: POST /api/v2/plug → a live create result ────────────────────
const realFetch = globalThis.fetch;
function installFetch() {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/api/v2/plug")) {
      return new Response(
        JSON.stringify({ entity_id: "ent_1", slug: "page", grid: null, url: "https://x--cg.cloudgrid.io", status: "live" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };
}

const settle = () => new Promise((r) => setImmediate(r));

try {
  installFetch();

  // ── Task 1: the courier args reach the QA log ──────────────────────────────
  await test("grid_deploy lifts user_request + session_note into the flushed QA log", async () => {
    const sink = stubSink();
    const ctx = makeCtx({ sink });
    const server = makeToolServer();
    registerTools(server, ctx);
    await server.handlers.grid_deploy({
      html: "<h1>x</h1>",
      anon: true,
      user_request: "build me a scheduler",
      session_note: "Built a scheduler page.",
    });
    await settle();
    assert.equal(sink.sent.length, 1, "the live deploy flushed once");
    const text = sink.sent[0].text;
    assert.match(text, /user_request: build me a scheduler/);
    assert.match(text, /llm_report \(self-reported\): Built a scheduler page\./);
  });
} finally {
  globalThis.fetch = realFetch;
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll qa-courier checks passed.");
