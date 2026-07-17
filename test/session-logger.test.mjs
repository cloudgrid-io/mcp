// test/session-logger.test.mjs
import assert from "node:assert/strict";
import { scrubText, deriveFilename, scrubArgs } from "../src/session-logger.js";
import { renderLogText } from "../src/session-logger.js";
import { SessionLogger } from "../src/session-logger.js";
import { createSessionLogger } from "../src/session-logger.js";
import { createSink, SlackWebhookSink } from "../src/log-sink.js";
import { registerTools } from "../src/tools.js";

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
test("scrubText redacts a GitHub PAT", () => {
  const tok = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  assert.equal(scrubText(`token ${tok} here`).includes(tok), false);
});
test("scrubText redacts a Slack token", () => {
  const tok = "xoxb-123456789012-abcdefABCDEF";
  assert.equal(scrubText(`slack ${tok} here`).includes(tok), false);
});
test("scrubText redacts an AWS access key id", () => {
  const tok = "AKIAIOSFODNN7EXAMPLE";
  assert.equal(scrubText(`aws ${tok} here`).includes(tok), false);
});
test("scrubText redacts a Google API key", () => {
  const tok = "AIzaSyABCDEF0123456789abcdef0123456789XYZ";
  assert.equal(scrubText(`gcp ${tok} here`).includes(tok), false);
});
test("scrubText redacts a Stripe secret key", () => {
  const tok = "sk_live_51SUPERSECRETvalue000";
  assert.equal(scrubText(`stripe ${tok} here`).includes(tok), false);
});
test("scrubText redacts a PEM private key block", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIBsecretkeymaterial\n-----END RSA PRIVATE KEY-----";
  const out = scrubText(`key:\n${pem}\ndone`);
  assert.equal(out.includes("MIIBsecretkeymaterial"), false);
  assert.equal(out.includes("BEGIN RSA PRIVATE KEY"), false);
});
test("scrubText redacts basic-auth URL creds but keeps scheme and host", () => {
  const out = scrubText("clone https://user:hunter2@example.com/x now");
  assert.equal(out.includes("user:hunter2"), false);
  assert.equal(out.includes("example.com"), true);
  assert.equal(out.includes("https://"), true);
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
    { at: "10:22:41", name: "grid_deploy", args: { dir: "." }, outcome: "ok", key: "url=https://x--cg.cloudgrid.io status=live", duration_ms: 28500 },
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
  assert.match(txt, /grid_deploy/);
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
  await logger.recordCall("grid_init", { name: "sched", template: "python", api_key: "sk-SHOULDvanish01234567" }, { content: [], structuredContent: {} }, 1200);
  assert.equal(logger.calls.length, 1);
  const c = logger.calls[0];
  assert.equal(c.name, "grid_init");
  assert.equal(c.outcome, "ok");
  assert.equal(c.args.name, "sched");        // allowlisted → retained
  assert.equal(c.args.template, "[omitted]"); // not allowlisted → dropped
  assert.equal(c.args.api_key, "[omitted]");  // not allowlisted → dropped
  assert.equal(c.duration_ms, 1200);
});

test("scrubArgs drops grid_secrets value but keeps key/name", async () => {
  const logger = new SessionLogger({ transport: "stdio", sessionId: "cli-1", sink: stubSink(), ctx: makeCtx(), now: () => 0 });
  await logger.recordCall("grid_secrets", { action: "set", name: "API_KEY", key: "API_KEY", value: "sk-SUPERsecret0123456789" }, { content: [], structuredContent: {} }, 10);
  const a = logger.calls[0].args;
  assert.equal(a.value, "[omitted]");
  assert.equal(a.name, "API_KEY");
  assert.equal(a.key, "API_KEY");
  assert.equal(a.action, "set");
});

test("scrubArgs drops grid_env value", async () => {
  const logger = new SessionLogger({ transport: "stdio", sessionId: "cli-1", sink: stubSink(), ctx: makeCtx(), now: () => 0 });
  await logger.recordCall("grid_env", { action: "set", name: "TOKEN", value: "hunter2-very-secret" }, { content: [], structuredContent: {} }, 10);
  assert.equal(logger.calls[0].args.value, "[omitted]");
});

test("scrubArgs drops grid_claim claim_url and claim_token", async () => {
  const logger = new SessionLogger({ transport: "stdio", sessionId: "cli-1", sink: stubSink(), ctx: makeCtx(), now: () => 0 });
  await logger.recordCall("grid_claim", { claim_url: "https://cloudgrid.io/claim?token=abc123secret", claim_token: "abc123secret" }, { content: [], structuredContent: {} }, 10);
  assert.equal(logger.calls[0].args.claim_url, "[omitted]");
  assert.equal(logger.calls[0].args.claim_token, "[omitted]");
});

test("scrubArgs drops grid_deploy html/cloudgrid_yaml but keeps grid/filename/target_entity_id", async () => {
  const logger = new SessionLogger({ transport: "stdio", sessionId: "cli-1", sink: stubSink(), ctx: makeCtx(), now: () => 0 });
  await logger.recordCall("grid_deploy", {
    grid: "cg", filename: "index.html", target_entity_id: "e_1",
    html: "<html>secret markup with sk-ABCDdef0123456789ABCD</html>",
    cloudgrid_yaml: "env:\n  KEY: sk-ABCDdef0123456789ABCD",
  }, { content: [], structuredContent: {} }, 10);
  const a = logger.calls[0].args;
  assert.equal(a.html, "[omitted]");
  assert.equal(a.cloudgrid_yaml, "[omitted]");
  assert.equal(a.grid, "cg");
  assert.equal(a.filename, "index.html");
  assert.equal(a.target_entity_id, "e_1");
});

test("scrubArgs value-scrubs an allowlisted string containing a JWT", async () => {
  const logger = new SessionLogger({ transport: "stdio", sessionId: "cli-1", sink: stubSink(), ctx: makeCtx(), now: () => 0 });
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1XzEifQ.c2ln";
  await logger.recordCall("grid_login", { url: `https://x.io/cb?jwt=${jwt}` }, { content: [], structuredContent: {} }, 10);
  assert.equal(logger.calls[0].args.url.includes(jwt), false);
  assert.match(logger.calls[0].args.url, /\[REDACTED\]/);
});

test("setUserRequest caps a huge value so the rendered log stays small (trail line still present)", async () => {
  const sink = stubSink();
  const logger = new SessionLogger({ transport: "stdio", sessionId: "cli-1", sink, ctx: makeCtx(), now: () => 0 });
  logger.setUserRequest("z".repeat(500 * 1024)); // 500KB — no cap → whole trail past the Slack clip
  await logger.recordCall("grid_init", { name: "x" }, { content: [], structuredContent: {} }, 1);
  await logger.flush("live");
  assert.equal(sink.sent.length, 1);
  const text = sink.sent[0].text;
  assert.ok(text.length < 10 * 1024, `rendered log should be < 10KB, was ${text.length}`);
  assert.match(text, /user_request: z/); // capped, not dropped — the line is present
});

test("setNarrative scrubs before capping so a token straddling the 4000 boundary cannot leak", async () => {
  const sink = stubSink();
  const logger = new SessionLogger({ transport: "stdio", sessionId: "cli-1", sink, ctx: makeCtx(), now: () => 0 });
  const token = "ghp_" + "A".repeat(30);         // a full GitHub PAT
  const pad = "n".repeat(3989) + " ";            // token starts at index 3990, straddles 4000
  logger.setNarrative(pad + token);
  await logger.recordCall("grid_init", { name: "x" }, { content: [], structuredContent: {} }, 1);
  await logger.flush("live");
  assert.equal(sink.sent.length, 1);
  assert.doesNotMatch(sink.sent[0].text, /ghp_/); // slice-before-scrub would leak a partial "ghp_…"
});

test("recordCall marks error outcome on isError result", async () => {
  const logger = new SessionLogger({ transport: "stdio", sessionId: "cli-1", sink: stubSink(), ctx: makeCtx(), now: () => 0 });
  await logger.recordCall("grid_deploy", {}, { content: [{ type: "text", text: "boom" }], isError: true }, 50);
  assert.equal(logger.calls[0].outcome, "error");
});

test("recordCall extracts grid_deploy url/status into key", async () => {
  const logger = new SessionLogger({ transport: "stdio", sessionId: "cli-1", sink: stubSink(), ctx: makeCtx(), now: () => 0 });
  await logger.recordCall("grid_deploy", {}, { content: [], structuredContent: { url: "https://x--cg.cloudgrid.io", status: "live", entity_id: "e_1" } }, 100);
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

test("recordCall auto-flushes with reason live on a grid_deploy url", async () => {
  const sink = stubSink();
  const logger = new SessionLogger({ transport: "stdio", sessionId: "cli-1", sink, ctx: makeCtx(), now: () => 0 });
  await logger.recordCall("grid_deploy", {}, { content: [], structuredContent: { url: "https://x--cg.cloudgrid.io", status: "live" } }, 100);
  await new Promise((r) => setImmediate(r)); // let the fire-and-forget flush settle
  assert.equal(sink.sent.length, 1);
  assert.match(sink.sent[0].text, /reason: live/);
});

test("recordCall auto-flushes with reason error on isError", async () => {
  const sink = stubSink();
  const logger = new SessionLogger({ transport: "stdio", sessionId: "cli-1", sink, ctx: makeCtx(), now: () => 0 });
  await logger.recordCall("grid_deploy", {}, { content: [{ type: "text", text: "boom" }], isError: true }, 100);
  await new Promise((r) => setImmediate(r));
  assert.equal(sink.sent.length, 1);
  assert.match(sink.sent[0].text, /reason: error/);
});

test("benign non-grid_deploy error is recorded but does NOT flush; later grid_deploy live flushes and carries the trail", async () => {
  const sink = stubSink();
  const logger = new SessionLogger({ transport: "stdio", sessionId: "cli-1", sink, ctx: makeCtx(), now: () => 0 });
  // routine failure during exploration — must not freeze capture
  await logger.recordCall("grid_fetch", { kind: "workflow", name: "nope" }, { content: [{ type: "text", text: "no such workflow" }], isError: true }, 10);
  await new Promise((r) => setImmediate(r));
  assert.equal(logger.calls[0].outcome, "error");
  assert.equal(sink.sent.length, 0); // benign error did NOT flush/freeze
  // the real deploy still triggers the live flush later
  await logger.recordCall("grid_deploy", {}, { content: [], structuredContent: { url: "https://x--cg.cloudgrid.io", status: "live" } }, 100);
  await new Promise((r) => setImmediate(r));
  assert.equal(sink.sent.length, 1);
  assert.match(sink.sent[0].text, /reason: live/);
  assert.match(sink.sent[0].text, /grid_fetch/); // the earlier error is in the trail
});

test("flush never throws when the sink rejects", async () => {
  const badSink = { send: async () => { throw new Error("slack down"); } };
  const logger = new SessionLogger({ transport: "stdio", sessionId: "cli-1", sink: badSink, ctx: makeCtx(), now: () => 0 });
  await logger.recordCall("grid_init", {}, { content: [] }, 10);
  await assert.doesNotReject(() => logger.flush("abandoned"));
});

test("createSink returns null when webhook unset (dark by default)", () => {
  assert.equal(createSink({}), null);
});
test("createSink returns a SlackWebhookSink when webhook set", () => {
  const sink = createSink({ CLOUDGRID_QA_SLACK_WEBHOOK: "https://hooks.slack.com/services/X" });
  assert.ok(sink instanceof SlackWebhookSink);
});
test("SlackWebhookSink.send POSTs a JSON body with the log text", async () => {
  const seen = [];
  const fakeFetch = async (url, opts) => { seen.push({ url, opts }); return { ok: true }; };
  const sink = new SlackWebhookSink("https://hooks.slack.com/services/X", { fetchImpl: fakeFetch });
  await sink.send({ filename: "log-x-stdio-mcp.txt", summary: "u · cg · x · live", text: "BODY-LINE-1\nBODY-LINE-2" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://hooks.slack.com/services/X");
  const body = JSON.parse(seen[0].opts.body);
  assert.match(body.text, /log-x-stdio-mcp\.txt/);
  assert.match(body.text, /u · cg · x · live/);
  assert.match(body.text, /BODY-LINE-1/);
});
test("SlackWebhookSink.send never throws on a network error", async () => {
  const sink = new SlackWebhookSink("https://x", { fetchImpl: async () => { throw new Error("net"); } });
  await assert.doesNotReject(() => sink.send({ filename: "f", summary: "s", text: "t" }));
});
test("SlackWebhookSink.send passes an abort signal to fetch (FIX 5 timeout)", async () => {
  let seenOpts;
  const sink = new SlackWebhookSink("https://x", { fetchImpl: async (_url, opts) => { seenOpts = opts; return { ok: true }; } });
  await sink.send({ filename: "f", summary: "s", text: "t" });
  assert.ok(seenOpts.signal, "a signal was passed to fetch");
  assert.equal(typeof seenOpts.signal.aborted, "boolean"); // it's an AbortSignal
});
test("SlackWebhookSink.send resolves without throwing when the fetch aborts (FIX 5)", async () => {
  const sink = new SlackWebhookSink("https://x", { fetchImpl: async () => {
    const e = new Error("The operation was aborted"); e.name = "AbortError"; throw e;
  } });
  await assert.doesNotReject(() => sink.send({ filename: "f", summary: "s", text: "t" }));
});

test("createSessionLogger returns null when no sink (dark)", () => {
  const logger = createSessionLogger({ transport: "stdio", sessionId: "cli-1", sink: null, ctx: makeCtx() });
  assert.equal(logger, null);
});
test("createSessionLogger returns a logger when a sink is present", () => {
  const logger = createSessionLogger({ transport: "stdio", sessionId: "cli-1", sink: stubSink(), ctx: makeCtx() });
  assert.ok(logger instanceof SessionLogger);
});

function makeToolServer() {
  const handlers = {};
  return {
    handlers,
    registerTool(name, _config, handler) { handlers[name] = handler; },
    tool(name, _d, _s, _a, handler) { handlers[name] = handler; },
    registerResource() {},
  };
}

test("registered handlers route through ctx.logger.recordCall (via withCapture)", async () => {
  const recorded = [];
  const server = makeToolServer();
  const ctx = {
    edition: "web",
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null, client: { name: "test", version: "1" } },
    canOpenBrowser: false,
    getToken: async () => null,
    getActiveGrid: async () => null,
    // spy logger: proves the wrapper calls recordCall without running heavy tools
    logger: { recordCall: (name, input, result) => { recorded.push({ name, input, result }); }, setNarrative() {} },
  };
  registerTools(server, ctx);
  assert.ok(typeof server.handlers.grid_note === "function");
  await server.handlers.grid_note({ summary: "hello" });
  await new Promise((r) => setImmediate(r));
  assert.ok(recorded.some((c) => c.name === "grid_note"));
});

test("withCapture records a thrown handler as error, not ok (FIX 3)", async () => {
  // grid_list_grids's handler awaits ctx.getToken() OUTSIDE any try/catch, so a
  // rejecting getToken makes the registered handler genuinely throw — the exact
  // case where the old finally-based capture wrongly recorded outcome "ok".
  const server = makeToolServer();
  const ctx = {
    edition: "web", state: { client: null }, canOpenBrowser: false,
    getToken: async () => { throw new Error("boom"); },
    getActiveGrid: async () => null,
  };
  ctx.logger = new SessionLogger({ transport: "hosted", sessionId: "s1", sink: stubSink(), ctx, now: () => 0 });
  registerTools(server, ctx);
  await assert.rejects(() => server.handlers.grid_list_grids({})); // the throw still propagates
  await new Promise((r) => setImmediate(r)); // let the fire-and-forget recordCall settle
  const rec = ctx.logger.calls.find((c) => c.name === "grid_list_grids");
  assert.ok(rec, "the thrown call was recorded");
  assert.equal(rec.outcome, "error");
});

test("grid_start and grid_fetch route through the capture shim (FIX 4)", async () => {
  const recorded = [];
  const server = makeToolServer();
  const ctx = {
    edition: "web",
    state: { client: { name: "test", version: "1" } },
    canOpenBrowser: false,
    getToken: async () => null,
    getActiveGrid: async () => null,
    logger: { recordCall: (name) => { recorded.push(name); }, setNarrative() {} },
  };
  registerTools(server, ctx);
  assert.ok(typeof server.handlers.grid_fetch === "function");
  assert.ok(typeof server.handlers.grid_start === "function");
  await server.handlers.grid_start({});
  await server.handlers.grid_fetch({ kind: "workflow", name: "nope" });
  await new Promise((r) => setImmediate(r));
  assert.ok(recorded.includes("grid_start"), "grid_start was captured");
  assert.ok(recorded.includes("grid_fetch"), "grid_fetch was captured");
});

test("grid_note records a self-report narrative and never errors", async () => {
  const server = makeToolServer();
  const ctx = {
    edition: "web", state: { client: null }, canOpenBrowser: false,
    getToken: async () => null, getActiveGrid: async () => null,
  };
  ctx.logger = new SessionLogger({ transport: "hosted", sessionId: "s1", sink: stubSink(), ctx, now: () => 0 });
  registerTools(server, ctx);
  assert.ok(typeof server.handlers.grid_note === "function");
  const res = await server.handlers.grid_note({ summary: "Built a scheduler with a dashboard." });
  assert.equal(res.isError, undefined);
  assert.equal(ctx.logger.narrative, "Built a scheduler with a dashboard.");
});

test("idle timeout flushes with reason abandoned", async () => {
  const sink = stubSink();
  const clock = fakeClock(0);
  // 20ms idle window for the test
  const logger = new SessionLogger({ transport: "stdio", sessionId: "cli-1", sink, ctx: makeCtx(), now: clock.now, idleMs: 20 });
  await logger.recordCall("grid_init", { template: "python" }, { content: [], structuredContent: {} }, 5);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(sink.sent.length, 1);
  assert.match(sink.sent[0].text, /reason: abandoned/);
});

test("createSessionLogger honors CLOUDGRID_QA_IDLE_MS", () => {
  const logger = createSessionLogger({ transport: "stdio", sessionId: "cli-1", sink: stubSink(), ctx: makeCtx(), env: { CLOUDGRID_QA_IDLE_MS: "1234" } });
  assert.equal(logger.idleMs, 1234);
});

// keep this at the very bottom of the file across all tasks:
process.on("exit", () => { if (failures) process.exit(1); });
