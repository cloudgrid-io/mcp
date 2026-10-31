// #433 — the hosted (web) edition sends no conversation text unless the user
// sends a note or a report.
//
// Drives the REAL registered handlers (registerTools + a fake server) with a
// mocked plug API and a stub log sink, on both editions:
//   1. Hosted: the grid_plug schema has no user_request / session_note, and a
//      strict schema would refuse them if a client sent them anyway.
//   2. Hosted: a live plug, a failed plug, an idle period and a session close
//      post NOTHING to the log sink.
//   3. Hosted: grid_note posts — once per call, carrying the note; grid_report
//      posts to the feedback endpoint with the message and nothing more.
//   4. Local: unchanged — the courier fields exist and a live plug flushes.
//
// Run: node test/hosted-no-auto-log.test.mjs
import assert from "node:assert/strict";
import { registerTools } from "../src/tools.js";
import { SessionLogger, createSessionLogger } from "../src/session-logger.js";

let failures = 0;
function test(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`ok   ${label}`))
    .catch((e) => { failures++; console.log(`FAIL ${label}\n     ${e.message}`); });
}

function makeToolServer() {
  const handlers = {};
  const configs = {};
  return {
    handlers,
    configs,
    registerTool(name, config, handler) { handlers[name] = handler; configs[name] = config; },
    tool(name, _d, _s, _a, handler) { handlers[name] = handler; },
    registerResource() {},
  };
}

function stubSink() {
  const sent = [];
  return { sent, send: async (payload) => { sent.push(payload); } };
}

// Hosted: exactly what web.js builds — createSessionLogger with explicitOnly.
function makeCtx({ edition, sink, idleMs } = {}) {
  const ctx = {
    edition,
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null, client: { name: "test", version: "1" } },
    canOpenBrowser: false,
    getToken: async () => "jwt",
    getActiveGrid: async () => "g1",
    saveToken: async () => ({}),
    savedLocationNote: () => "",
    trustedServer: null,
  };
  ctx.logger = edition === "web"
    ? createSessionLogger({ transport: "hosted", sessionId: "s1", sink, ctx, explicitOnly: true, env: {} })
    : new SessionLogger({ transport: "stdio", sessionId: "cli-1", sink, ctx, now: () => 0, ...(idleMs ? { idleMs } : {}) });
  return ctx;
}

// fetch mock: grids list, plug (live or 500), and the feedback endpoint.
const realFetch = globalThis.fetch;
const feedbackBodies = [];
let plugMode = "live";
function installFetch() {
  feedbackBodies.length = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/api/v2/grids") || u.endsWith("/api/v2/orgs")) {
      return new Response(
        JSON.stringify({ grids: [{ slug: "g1", name: "Grid One", role: "owner", render_ready: true }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (u.includes("/api/v2/plug")) {
      if (plugMode === "fail") {
        return new Response(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: "boom" } }),
          { status: 500, headers: { "content-type": "application/json" } });
      }
      return new Response(
        JSON.stringify({ entity_id: "ent_1", slug: "page", grid: "g1", url: "https://x--cg.cloudgrid.io", status: "live" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (u.includes("/api/v2/errors")) {
      feedbackBodies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ status: "recorded" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  };
}
const settle = () => new Promise((r) => setTimeout(r, 30));

try {
  installFetch();

  // ── 1. Hosted schema: no courier fields ────────────────────────────────────
  await test("hosted grid_plug schema has no user_request / session_note; local keeps both", async () => {
    const web = makeToolServer();
    registerTools(web, makeCtx({ edition: "web", sink: stubSink() }));
    const webShape = web.configs.grid_plug.inputSchema.shape;
    assert.equal(webShape.user_request, undefined, "hosted has no user_request");
    assert.equal(webShape.session_note, undefined, "hosted has no session_note");
    const local = makeToolServer();
    registerTools(local, makeCtx({ edition: "local", sink: stubSink() }));
    const localShape = local.configs.grid_plug.inputSchema.shape;
    assert.ok(localShape.user_request, "local keeps user_request");
    assert.ok(localShape.session_note, "local keeps session_note");
    // The hosted schema is strict: a client that still sends the fields is refused.
    const parsed = web.configs.grid_plug.inputSchema.safeParse({ html: "<h1>x</h1>", session_note: "n" });
    assert.equal(parsed.success, false, "hosted strict schema rejects session_note");
  });

  // ── 2. Hosted: nothing posts on live / failed / idle / close ──────────────
  await test("hosted: a live plug posts nothing to the log sink", async () => {
    plugMode = "live";
    const sink = stubSink();
    const ctx = makeCtx({ edition: "web", sink });
    const server = makeToolServer();
    registerTools(server, ctx);
    const res = await server.handlers.grid_plug({ html: "<h1>x</h1>" });
    assert.equal(res?.structuredContent?.url, "https://x--cg.cloudgrid.io", "the plug went live");
    await settle();
    assert.equal(sink.sent.length, 0, "no post on a live plug");
    assert.equal(ctx.logger.flushed, false);
  });

  await test("hosted: a failed plug posts nothing to the log sink", async () => {
    plugMode = "fail";
    const sink = stubSink();
    const ctx = makeCtx({ edition: "web", sink });
    const server = makeToolServer();
    registerTools(server, ctx);
    const res = await server.handlers.grid_plug({ html: "<h1>x</h1>" });
    assert.equal(res?.isError, true, "the plug failed");
    await settle();
    assert.equal(sink.sent.length, 0, "no post on a failed plug");
    plugMode = "live";
  });

  await test("hosted: no idle timer is armed, and an explicit flush (close path) posts nothing", async () => {
    const sink = stubSink();
    const ctx = makeCtx({ edition: "web", sink });
    const server = makeToolServer();
    registerTools(server, ctx);
    await server.handlers.grid_start({});
    assert.equal(ctx.logger.idleMs, 0, "explicit-only logger has no idle window");
    assert.equal(ctx.logger.idleTimer, null, "no idle timer armed after a call");
    // web.js used to call flush("abandoned") on transport close; the logger
    // itself refuses, so a stray caller cannot bring the post back.
    await ctx.logger.flush("abandoned");
    await ctx.logger.flush("live");
    await settle();
    assert.equal(sink.sent.length, 0, "flush is a no-op on the hosted logger");
  });

  await test("hosted: CLOUDGRID_QA_IDLE_MS cannot re-arm an idle post", async () => {
    const sink = stubSink();
    const ctx = { edition: "web", state: {}, getToken: async () => null, getActiveGrid: async () => null };
    const logger = createSessionLogger({ transport: "hosted", sessionId: "s", sink, ctx, explicitOnly: true, env: { CLOUDGRID_QA_IDLE_MS: "5" } });
    await logger.recordCall("grid_start", {}, { content: [] }, 1);
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(sink.sent.length, 0, "no idle post even with a 5ms idle window configured");
  });

  // ── 3. Hosted: grid_note and grid_report still send ───────────────────────
  await test("hosted: grid_note posts the note (and only then), once per call", async () => {
    const sink = stubSink();
    const ctx = makeCtx({ edition: "web", sink });
    const server = makeToolServer();
    registerTools(server, ctx);
    await server.handlers.grid_plug({ html: "<h1>x</h1>" });
    await settle();
    assert.equal(sink.sent.length, 0, "still nothing after the plug");
    const res = await server.handlers.grid_note({ summary: "Built a scheduler page." });
    assert.match(res.content?.[0]?.text || "", /Sent the note/);
    assert.equal(sink.sent.length, 1, "grid_note posted once");
    const text = sink.sent[0].text;
    assert.match(text, /reason: note/);
    assert.match(text, /llm_report \(self-reported\): Built a scheduler page\./);
    assert.match(text, /grid_plug/, "the trail names the tools called");
    assert.doesNotMatch(text, /<h1>x<\/h1>/, "no file content rides along");
    // A second note is a second post — nothing is dropped after the first.
    await server.handlers.grid_note({ summary: "Second note." });
    assert.equal(sink.sent.length, 2, "a later note posts again");
    assert.match(sink.sent[1].text, /Second note\./);
  });

  await test("hosted: grid_note says so when no sink is configured (dark server)", async () => {
    const ctx = makeCtx({ edition: "web", sink: null });
    assert.equal(ctx.logger, null, "no webhook → no logger");
    const server = makeToolServer();
    registerTools(server, ctx);
    const res = await server.handlers.grid_note({ summary: "x" });
    assert.match(res.content?.[0]?.text || "", /nothing was sent/);
  });

  await test("hosted: grid_report posts the message to the feedback endpoint, without the conversation", async () => {
    const sink = stubSink();
    const ctx = makeCtx({ edition: "web", sink });
    const server = makeToolServer();
    registerTools(server, ctx);
    const res = await server.handlers.grid_report({ message: "ZZREPORTMARK build failed", context: { tool: "grid_plug", error_code: "INTERNAL_ERROR" } });
    assert.equal(res?.structuredContent?.status, "recorded");
    assert.equal(feedbackBodies.length, 1, "one feedback POST");
    assert.match(feedbackBodies[0], /ZZREPORTMARK build failed/);
    assert.doesNotMatch(feedbackBodies[0], /include_conversation/, "the conversation flag is absent unless the user agreed");
    assert.equal(sink.sent.length, 0, "grid_report does not post to the log sink");
  });

  // The wiring: web.js builds its logger explicit-only and no longer flushes on
  // transport close (the behaviour above is proven on a logger the test built;
  // this pins that the real entrypoint builds the same one).
  await test("web.js builds the logger explicit-only and never calls flush", async () => {
    const { readFileSync } = await import("node:fs");
    const web = readFileSync(new URL("../src/web.js", import.meta.url), "utf-8");
    assert.match(web, /createSessionLogger\(\{[\s\S]*?explicitOnly:\s*true[\s\S]*?\}\)/, "web.js passes explicitOnly: true");
    assert.doesNotMatch(web, /\.flush\(/, "web.js has no flush call left");
  });

  await test("hosted descriptions say what grid_note and grid_report send", async () => {
    const server = makeToolServer();
    registerTools(server, makeCtx({ edition: "web", sink: stubSink() }));
    assert.match(server.configs.grid_note.description, /What is sent/);
    assert.match(server.configs.grid_note.description, /no other conversation text/);
    assert.match(server.configs.grid_report.description, /What is sent/);
    assert.match(server.configs.grid_report.description, /nothing else from the conversation/);
  });

  // ── 4. Local: unchanged ───────────────────────────────────────────────────
  await test("local: a live plug still flushes the QA log, carrying the courier fields", async () => {
    const sink = stubSink();
    const ctx = makeCtx({ edition: "local", sink });
    const server = makeToolServer();
    registerTools(server, ctx);
    await server.handlers.grid_plug({ html: "<h1>x</h1>", user_request: "build me a scheduler", session_note: "Built it." });
    await settle();
    assert.equal(sink.sent.length, 1, "the local live plug flushed once");
    assert.match(sink.sent[0].text, /reason: live/);
    assert.match(sink.sent[0].text, /user_request: build me a scheduler/);
    assert.match(sink.sent[0].text, /llm_report \(self-reported\): Built it\./);
  });

  await test("local: the idle timer still posts an abandoned log", async () => {
    const sink = stubSink();
    const ctx = makeCtx({ edition: "local", sink, idleMs: 15 });
    const server = makeToolServer();
    registerTools(server, ctx);
    await server.handlers.grid_start({});
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(sink.sent.length, 1, "local idle flush fired");
    assert.match(sink.sent[0].text, /reason: abandoned/);
  });
} finally {
  globalThis.fetch = realFetch;
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll hosted-no-auto-log checks passed.");
