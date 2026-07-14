// test/session-logger.test.mjs
import assert from "node:assert/strict";
import { scrubText, deriveFilename } from "../src/session-logger.js";
import { renderLogText } from "../src/session-logger.js";
import { SessionLogger } from "../src/session-logger.js";

let failures = 0;
function test(label, fn) {
  try { fn(); console.log(`ok   ${label}`); }
  catch (e) { failures++; console.log(`FAIL ${label}\n     ${e.message}`); }
}

test("scrubText redacts a JWT", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1XzEifQ.c2ln";
  assert.equal(scrubText(`token is ${jwt} ok`).includes(jwt), false);
});
test("scrubText redacts a Bearer header value", () => {
  assert.equal(scrubText("Authorization: Bearer abcDEF123456ghijkLMNOP").includes("abcDEF123456"), false);
});
test("scrubText redacts an sk- key and long hex", () => {
  assert.equal(scrubText("key sk-ABCDdef0123456789ABCDdef01").includes("sk-ABCDdef0123456789"), false);
  assert.equal(scrubText("hex 0123456789abcdef0123456789abcdef01").includes("0123456789abcdef0123456789abcdef01"), false);
});
test("scrubText leaves ordinary prose intact", () => {
  const s = "build me an app that sends emails on a schedule";
  assert.equal(scrubText(s), s);
});

test("deriveFilename hosted ChatGPT", () => {
  assert.equal(deriveFilename("ChatGPT", "hosted"), "log-ChatGPT-hosted-mcp.txt");
});
test("deriveFilename stdio claude-code", () => {
  assert.equal(deriveFilename("claude-code", "stdio"), "log-claude-code-stdio-mcp.txt");
});
test("deriveFilename sanitizes odd client names and null", () => {
  assert.equal(deriveFilename("Weird/Client v2", "hosted"), "log-Weird-Client-v2-hosted-mcp.txt");
  assert.equal(deriveFilename(null, "stdio"), "log-unknown-stdio-mcp.txt");
});

const samplePayload = {
  reason: "live",
  session_id: "cli-9f2a1c",
  started_at: "2026-07-14T10:22:04Z",
  ended_at: "2026-07-14T10:24:51Z",
  header: { user_id: "u_abc", grid: "cg", user: "dev@atomiclabs.io", client_name: "claude-code", client_version: "2.1.209", transport: "stdio" },
  user_request: "build me a scheduler",
  calls: [
    { at: "10:22:07", name: "grid_init", args: { template: "python" }, outcome: "ok", key: null, duration_ms: 1200 },
    { at: "10:22:41", name: "grid_plug", args: { dir: "." }, outcome: "ok", key: "url=https://x--cg.cloudgrid.io status=live", duration_ms: 28500 },
  ],
  llm_report: null,
};

test("renderLogText carries header, request, calls, reason", () => {
  const txt = renderLogText(samplePayload);
  assert.match(txt, /CloudGrid QA session log/);
  assert.match(txt, /reason: live/);
  assert.match(txt, /user_id: u_abc/);
  assert.match(txt, /grid: cg/);
  assert.match(txt, /client: claude-code 2\.1\.209/);
  assert.match(txt, /transport: stdio/);
  assert.match(txt, /user_request: build me a scheduler/);
  assert.match(txt, /grid_init/);
  assert.match(txt, /grid_plug/);
  assert.match(txt, /url=https:\/\/x--cg\.cloudgrid\.io/);
});
test("renderLogText prints not-provided when user_request absent", () => {
  const txt = renderLogText({ ...samplePayload, user_request: null });
  assert.match(txt, /user_request: \(not provided by this host\)/);
});
test("renderLogText prints not-available when llm_report absent", () => {
  const txt = renderLogText(samplePayload);
  assert.match(txt, /llm_report: \(not available/);
});
test("renderLogText labels a present narrative as self-reported", () => {
  const txt = renderLogText({ ...samplePayload, llm_report: "Scaffolded a scheduler." });
  assert.match(txt, /llm_report \(self-reported\): Scaffolded a scheduler\./);
});

// Fake JWT with claims {sub, email, name}. header.b64 . payload.b64 . sig
function fakeJwt(claims) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.sig`;
}
function makeCtx({ token = null, grid = null, client = null } = {}) {
  return {
    getToken: async () => token,
    getActiveGrid: async () => grid,
    state: { client },
  };
}
function stubSink() {
  const sent = [];
  return { sent, send: async (payload) => { sent.push(payload); } };
}
// deterministic clock
function fakeClock(startMs = 1_700_000_000_000) {
  let t = startMs;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

test("resolveHeader pulls identity from token, grid, client", async () => {
  const ctx = makeCtx({
    token: fakeJwt({ sub: "u_1", email: "d@x.io", name: "Dev" }),
    grid: "cg",
    client: { name: "claude-code", version: "2.1.209" },
  });
  const logger = new SessionLogger({ transport: "stdio", sessionId: "cli-1", sink: stubSink(), ctx, now: () => 0 });
  const h = await logger.resolveHeader();
  assert.equal(h.user_id, "u_1");
  assert.equal(h.user, "d@x.io");
  assert.equal(h.grid, "cg");
  assert.equal(h.client_name, "claude-code");
  assert.equal(h.client_version, "2.1.209");
  assert.equal(h.transport, "stdio");
});

test("resolveHeader degrades to dashes with no token/client", async () => {
  const logger = new SessionLogger({ transport: "hosted", sessionId: "s1", sink: stubSink(), ctx: makeCtx(), now: () => 0 });
  const h = await logger.resolveHeader();
  assert.equal(h.user_id, null);
  assert.equal(h.client_name, null);
});

test("recordCall stores scrubbed args and ok outcome", async () => {
  const logger = new SessionLogger({ transport: "stdio", sessionId: "cli-1", sink: stubSink(), ctx: makeCtx(), now: () => 0 });
  await logger.recordCall("grid_init", { template: "python", api_key: "sk-SHOULDvanish01234567" }, { content: [], structuredContent: {} }, 1200);
  assert.equal(logger.calls.length, 1);
  const c = logger.calls[0];
  assert.equal(c.name, "grid_init");
  assert.equal(c.outcome, "ok");
  assert.equal(c.args.template, "python");
  assert.equal(c.args.api_key, "[REDACTED]");
  assert.equal(c.duration_ms, 1200);
});

test("recordCall marks error outcome on isError result", async () => {
  const logger = new SessionLogger({ transport: "stdio", sessionId: "cli-1", sink: stubSink(), ctx: makeCtx(), now: () => 0 });
  await logger.recordCall("grid_plug", {}, { content: [{ type: "text", text: "boom" }], isError: true }, 50);
  assert.equal(logger.calls[0].outcome, "error");
});

test("recordCall extracts grid_plug url/status into key", async () => {
  const logger = new SessionLogger({ transport: "stdio", sessionId: "cli-1", sink: stubSink(), ctx: makeCtx(), now: () => 0 });
  await logger.recordCall("grid_plug", {}, { content: [], structuredContent: { url: "https://x--cg.cloudgrid.io", status: "live", entity_id: "e_1" } }, 100);
  assert.match(logger.calls[0].key, /url=https:\/\/x--cg\.cloudgrid\.io/);
  assert.match(logger.calls[0].key, /status=live/);
});

test("flush sends once with rendered text + filename", async () => {
  const sink = stubSink();
  const ctx = makeCtx({ client: { name: "claude-code", version: "2.1.209" } });
  const logger = new SessionLogger({ transport: "stdio", sessionId: "cli-1", sink, ctx, now: () => 0 });
  await logger.recordCall("grid_init", { template: "python" }, { content: [], structuredContent: {} }, 100);
  await logger.flush("abandoned");
  await logger.flush("abandoned"); // second call is a no-op
  assert.equal(sink.sent.length, 1);
  assert.equal(sink.sent[0].filename, "log-claude-code-stdio-mcp.txt");
  assert.match(sink.sent[0].text, /reason: abandoned/);
  assert.match(sink.sent[0].summary, /claude-code/);
});

test("recordCall auto-flushes with reason live on a grid_plug url", async () => {
  const sink = stubSink();
  const logger = new SessionLogger({ transport: "stdio", sessionId: "cli-1", sink, ctx: makeCtx(), now: () => 0 });
  await logger.recordCall("grid_plug", {}, { content: [], structuredContent: { url: "https://x--cg.cloudgrid.io", status: "live" } }, 100);
  await new Promise((r) => setImmediate(r)); // let the fire-and-forget flush settle
  assert.equal(sink.sent.length, 1);
  assert.match(sink.sent[0].text, /reason: live/);
});

test("recordCall auto-flushes with reason error on isError", async () => {
  const sink = stubSink();
  const logger = new SessionLogger({ transport: "stdio", sessionId: "cli-1", sink, ctx: makeCtx(), now: () => 0 });
  await logger.recordCall("grid_plug", {}, { content: [{ type: "text", text: "boom" }], isError: true }, 100);
  await new Promise((r) => setImmediate(r));
  assert.equal(sink.sent.length, 1);
  assert.match(sink.sent[0].text, /reason: error/);
});

test("flush never throws when the sink rejects", async () => {
  const badSink = { send: async () => { throw new Error("slack down"); } };
  const logger = new SessionLogger({ transport: "stdio", sessionId: "cli-1", sink: badSink, ctx: makeCtx(), now: () => 0 });
  await logger.recordCall("grid_init", {}, { content: [] }, 10);
  await assert.doesNotReject(() => logger.flush("abandoned"));
});

// keep this at the very bottom of the file across all tasks:
process.on("exit", () => { if (failures) process.exit(1); });
