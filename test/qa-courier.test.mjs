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

function makeCtx({ token = null, sink, loggerOpts = {}, withLogger = true } = {}) {
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
  ctx.logger = withLogger
    ? new SessionLogger({ transport: "hosted", sessionId: "s1", sink, ctx, now: () => 0, ...loggerOpts })
    : null;
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

  // ── Task 2: the trail line never leaks the courier args verbatim ───────────
  // Default-deny (scrubArgs allowlist) already drops them to [omitted]; this pins
  // it so nobody later adds them to ALLOWED_ARG_KEYS and double-prints the request
  // (it belongs in the header / llm_report fields, not the per-call args line).
  await test("courier args render as [omitted] in the per-call trail line", async () => {
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
    const text = sink.sent[0].text;
    assert.match(text, /"user_request":"\[omitted\]"/);
    assert.match(text, /"session_note":"\[omitted\]"/);
    // and the raw request text must NOT appear inside the args JSON blob
    assert.doesNotMatch(text, /args=\{[^\n]*build me a scheduler/);
  });

  // stdio precedence: a logger seeded with a userRequest (the env/header value on
  // stdio) ignores a later setUserRequest — the courier arg does NOT override it.
  await test("stdio-seeded userRequest wins over the courier arg (only-if-unset)", async () => {
    const sink = stubSink();
    const ctx = makeCtx({ sink, loggerOpts: { userRequest: "from-env" } });
    const server = makeToolServer();
    registerTools(server, ctx);
    await server.handlers.grid_deploy({
      html: "<h1>x</h1>",
      anon: true,
      user_request: "build me a scheduler",
    });
    await settle();
    const text = sink.sent[0].text;
    assert.match(text, /user_request: from-env/);
    assert.doesNotMatch(text, /user_request: build me a scheduler/);
  });

  // ── Task 3: grid_note is honest once the log has posted ─────────────────────
  // A successful deploy flushes the QA log ("live") on the SAME call. A grid_note
  // that lands AFTER that flush records nothing (the log is gone), so it must SAY
  // so rather than falsely acknowledge — and it must not add a second post.
  await test("grid_note after a live-flushed deploy says the log already posted, adds no post", async () => {
    const sink = stubSink();
    const ctx = makeCtx({ sink });
    const server = makeToolServer();
    registerTools(server, ctx);
    await server.handlers.grid_deploy({ html: "<h1>x</h1>", anon: true });
    await settle();
    assert.equal(sink.sent.length, 1, "the live deploy flushed once");
    assert.equal(ctx.logger.flushed, true, "logger is flushed after a live deploy");
    const res = await server.handlers.grid_note({ summary: "a late note that will be dropped" });
    const text = res.content?.[0]?.text || "";
    assert.match(text, /already posted/);
    assert.match(text, /session_note on your next grid_deploy/);
    await settle();
    assert.equal(sink.sent.length, 1, "grid_note after flush adds no second post");
    assert.doesNotMatch(sink.sent[0].text, /a late note that will be dropped/);
  });

  // grid_note BEFORE the deploy is the pre-flush path: it records the narrative,
  // which the deploy's flush then carries into llm_report.
  await test("grid_note before the deploy lands in the flushed log's llm_report", async () => {
    const sink = stubSink();
    const ctx = makeCtx({ sink });
    const server = makeToolServer();
    registerTools(server, ctx);
    const noteRes = await server.handlers.grid_note({ summary: "Built a scheduler page." });
    assert.match(noteRes.content?.[0]?.text || "", /Noted\./);
    await server.handlers.grid_deploy({ html: "<h1>x</h1>", anon: true });
    await settle();
    assert.equal(sink.sent.length, 1);
    assert.match(sink.sent[0].text, /llm_report \(self-reported\): Built a scheduler page\./);
  });

  // The dead post-deploy nudge is gone: an obedient grid_note after a live flush
  // would be silently dropped, so the deploy no longer tells the agent to call it.
  await test("a successful deploy result text no longer mentions grid_note", async () => {
    const sink = stubSink();
    const ctx = makeCtx({ sink });
    const server = makeToolServer();
    registerTools(server, ctx);
    const res = await server.handlers.grid_deploy({ html: "<h1>x</h1>", anon: true });
    const text = res.content?.[0]?.text || "";
    assert.doesNotMatch(text, /grid_note/);
  });
} finally {
  globalThis.fetch = realFetch;
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll qa-courier checks passed.");
