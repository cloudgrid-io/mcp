// Unit tests for consent-gated error reporting (Task 34 / 0.8.1, 34b / 0.8.2).
//
// Offline surfaces:
//   1. runReport() — posts the CLI reporter's shape { type:"error", category,
//      app, message, context, trace_id?, failed_step?, http_status?, cli_version,
//      node_version, platform:"<platform> <arch>" } to /api/v2/errors (0.8.2:
//      was /errors/feedback). Source attribution (source/client/platform/
//      mcp_version) is sent BOTH top-level AND mirrored in context.origin.
//      Authed → Bearer; anon+web → trusted-server headers. include_conversation
//      defaults false. CLOUDGRID_TELEMETRY=off suppresses the POST. 429/401/error
//      → friendly text, never throws. Secrets in context are scrubbed client-side.
//   2. scrubReportContext() — redacts secret-looking KEYS, leaves the rest.
//   3. errorGuidance() report offer — appended on 5xx / INTERNAL_ERROR /
//      build-deploy failures ONLY; NOT on 429 / needs_grid / 409 EDIT_REJECTED /
//      401 / 403.
//
// Run: node test/error-reporting.test.mjs

import {
  runReport,
  scrubReportContext,
  errorGuidance,
  REPORT_OFFER,
  MCP_VERSION,
} from "../src/tools.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// ── fetch mock ───────────────────────────────────────────────────────────────
let calls = [];
let replies = [];
globalThis.fetch = async (url, opts = {}) => {
  const parsedBody = (() => {
    try {
      return typeof opts.body === "string" ? JSON.parse(opts.body) : opts.body;
    } catch {
      return opts.body;
    }
  })();
  calls.push({ url: String(url), headers: opts.headers || {}, method: opts.method, body: parsedBody });
  const next = replies.shift() ?? { status: 201, body: { status: "recorded" } };
  if (next.throw) throw new Error(next.throw);
  return new Response(JSON.stringify(next.body ?? {}), {
    status: next.status,
    headers: { "content-type": "application/json" },
  });
};

function makeCtx({ token = null, edition = "local", trustedServer = null, client } = {}) {
  return {
    edition,
    state: client === undefined ? {} : { client },
    getToken: async () => token,
    getActiveGrid: async () => null,
    trustedServer,
  };
}

try {
  // ═══ 1. scrubReportContext ════════════════════════════════════════════════
  {
    const scrubbed = scrubReportContext({
      tool: "grid_plug",
      api_key: "sk-live-123",
      nested: { authToken: "abc", ok: "keep" },
      password: "hunter2",
      list: [{ secret: "x", label: "y" }],
    });
    check("scrub keeps non-secret keys", scrubbed.tool === "grid_plug" && scrubbed.nested.ok === "keep");
    check("scrub redacts api_key", scrubbed.api_key === "[REDACTED]");
    check("scrub redacts nested authToken", scrubbed.nested.authToken === "[REDACTED]");
    check("scrub redacts password", scrubbed.password === "[REDACTED]");
    check("scrub redacts secret inside arrays", scrubbed.list[0].secret === "[REDACTED]" && scrubbed.list[0].label === "y");
  }

  // ═══ 2. runReport — authed happy path posts the CLI shape + attribution ════
  {
    calls = [];
    replies = [{ status: 201, body: { status: "recorded" } }];
    const ctx = makeCtx({
      token: "jwt-abc",
      edition: "local",
      client: { name: "claude-code", version: "1.2.3" },
    });
    const res = await runReport(ctx, {
      message: "deploy failed",
      context: { tool: "grid_plug", error_code: "INTERNAL_ERROR", api_key: "sk-secret" },
      trace_id: "trace-9",
      failed_step: "build",
      http_status: 500,
    });
    const c = calls[0];
    const plat = `${process.platform} ${process.arch}`;
    // 0.8.2: repointed off /errors/feedback to the CLI's /errors endpoint.
    check("authed report POSTs to /api/v2/errors (not /feedback)", /\/api\/v2\/errors$/.test(c.url) && c.method === "POST");
    check("authed report sends Bearer token", c.headers["Authorization"] === "Bearer jwt-abc");
    // CLI payload shape.
    check("body type:'error'", c.body.type === "error");
    check("body category defaults to 'mcp'", c.body.category === "mcp");
    check("body has app:mcp", c.body.app === "mcp");
    check("body has message", c.body.message === "deploy failed");
    check("body has node_version", c.body.node_version === process.version);
    check("body platform is '<platform> <arch>'", c.body.platform === plat);
    check("body cli_version is null for MCP", c.body.cli_version === null);
    check("body forwards trace_id", c.body.trace_id === "trace-9");
    check("body forwards failed_step", c.body.failed_step === "build");
    check("body forwards http_status", c.body.http_status === 500);
    check("body forwards context.tool", c.body.context.tool === "grid_plug");
    check("scrubs secret keys in context before sending", c.body.context.api_key === "[REDACTED]");
    check("does NOT set include_conversation by default", c.body.include_conversation === undefined);
    // Source attribution — top-level.
    check("top-level source = mcp-stdio (local)", c.body.source === "mcp-stdio");
    check("top-level client = name+version", c.body.client === "claude-code 1.2.3");
    check("top-level platform present", c.body.platform === plat);
    // Source attribution — mirrored in context.origin (the durable carrier).
    check("context.origin.source = mcp-stdio", c.body.context.origin.source === "mcp-stdio");
    check("context.origin.client = name+version", c.body.context.origin.client === "claude-code 1.2.3");
    check("context.origin.platform present", c.body.context.origin.platform === plat);
    check("context.origin.mcp_version = MCP_VERSION", c.body.context.origin.mcp_version === MCP_VERSION);
    check("success → recorded", res.structuredContent.status === "recorded");
    check("success → thank-you text", /thank you/i.test(res.content[0].text));
  }

  // ═══ 2a. web edition → source mcp-hosted; category override honored ════════
  {
    calls = [];
    replies = [{ status: 201, body: { status: "recorded" } }];
    const ctx = makeCtx({
      token: "jwt",
      edition: "web",
      client: { name: "ChatGPT", version: "0.9" },
    });
    await runReport(ctx, { message: "x", category: "deploy" });
    const c = calls[0];
    check("web edition source = mcp-hosted (top-level)", c.body.source === "mcp-hosted");
    check("web edition source = mcp-hosted (context.origin)", c.body.context.origin.source === "mcp-hosted");
    check("category override honored", c.body.category === "deploy");
    check("web client attributed", c.body.context.origin.client === "ChatGPT 0.9");
  }

  // ═══ 2a2. missing clientInfo → client falls back to 'unknown' ══════════════
  {
    calls = [];
    replies = [{ status: 201, body: { status: "recorded" } }];
    const ctx = makeCtx({ token: "jwt", edition: "local" }); // no client stashed
    await runReport(ctx, { message: "x" });
    const c = calls[0];
    check("missing clientInfo → top-level client 'unknown'", c.body.client === "unknown");
    check("missing clientInfo → context.origin.client 'unknown'", c.body.context.origin.client === "unknown");
  }

  // ═══ 2b. include_conversation only when explicitly true ════════════════════
  {
    calls = [];
    replies = [{ status: 201, body: { status: "recorded" } }];
    const ctx = makeCtx({ token: "jwt", edition: "local" });
    await runReport(ctx, { message: "x", include_conversation: true });
    check("include_conversation:true forwarded on the wire", calls[0].body.include_conversation === true);
  }
  {
    calls = [];
    replies = [{ status: 201, body: { status: "recorded" } }];
    const ctx = makeCtx({ token: "jwt", edition: "local" });
    await runReport(ctx, { message: "x", include_conversation: false });
    check("include_conversation:false NOT sent on the wire", calls[0].body.include_conversation === undefined);
  }

  // ═══ 2c. anon + web → trusted-server headers, graceful 401 degrade ═════════
  {
    calls = [];
    replies = [{ status: 401, body: { error: "unauthorized" } }];
    const ctx = makeCtx({
      token: null,
      edition: "web",
      trustedServer: { secret: "ts-secret", endUserId: "user-1" },
    });
    const res = await runReport(ctx, { message: "boom" });
    const c = calls[0];
    check("anon+web report sends trusted-server auth header", c.headers["X-CloudGrid-Trusted-Server-Auth"] === "ts-secret");
    check("anon+web report sends trusted-server end-user header", c.headers["X-CloudGrid-Trusted-Server-End-User"] === "user-1");
    check("anon+web report sends NO Bearer", c.headers["Authorization"] === undefined);
    check("401 degrades gracefully → unauthorized status (no throw)", res.structuredContent.status === "unauthorized");
    check("401 degrade → 'sign in' text", /sign in/i.test(res.content[0].text));
  }

  // ═══ 2d. 429 rate-limit → friendly text ════════════════════════════════════
  {
    calls = [];
    replies = [{ status: 429, body: { error: "rate limited" } }];
    const ctx = makeCtx({ token: "jwt" });
    const res = await runReport(ctx, { message: "boom" });
    check("429 → rate_limited status", res.structuredContent.status === "rate_limited");
    check("429 → friendly 'try again later' text", /later/i.test(res.content[0].text));
  }

  // ═══ 2e. network error → never throws ══════════════════════════════════════
  {
    calls = [];
    replies = [{ throw: "ECONNREFUSED" }];
    const ctx = makeCtx({ token: "jwt" });
    let threw = false;
    let res = null;
    try {
      res = await runReport(ctx, { message: "boom" });
    } catch {
      threw = true;
    }
    check("network error never throws", threw === false);
    check("network error → error status", res?.structuredContent.status === "error");
  }

  // ═══ 2f. empty message → skipped, no wire call ═════════════════════════════
  {
    calls = [];
    replies = [];
    const ctx = makeCtx({ token: "jwt" });
    const res = await runReport(ctx, { message: "   " });
    check("empty message → skipped", res.structuredContent.status === "skipped");
    check("empty message → no wire call", calls.length === 0);
  }

  // ═══ 2g. CLOUDGRID_TELEMETRY=off → no POST, disabled status ════════════════
  {
    calls = [];
    replies = [{ status: 201, body: { status: "recorded" } }];
    const prev = process.env.CLOUDGRID_TELEMETRY;
    process.env.CLOUDGRID_TELEMETRY = "off";
    const ctx = makeCtx({ token: "jwt", client: { name: "claude-code" } });
    const res = await runReport(ctx, { message: "boom" });
    if (prev === undefined) delete process.env.CLOUDGRID_TELEMETRY;
    else process.env.CLOUDGRID_TELEMETRY = prev;
    check("TELEMETRY=off → no wire call", calls.length === 0);
    check("TELEMETRY=off → disabled status", res.structuredContent.status === "disabled");
    check("TELEMETRY=off → 'disabled' text", /disabled/i.test(res.content[0].text));
  }

  // ═══ 2h. clientInfo capture via a mocked MCP SDK server ════════════════════
  // Mirrors index.js/web.js: on `oninitialized`, stash getClientVersion() into
  // ctx.state.client. Uses a mock Server so no real transport/handshake is needed.
  {
    const ctx = { edition: "local", state: {} };
    // Mock of the SDK's inner Server: settable oninitialized + getClientVersion().
    const mockServer = {
      oninitialized: null,
      _clientVersion: { name: "cursor", version: "0.42" },
      getClientVersion() {
        return this._clientVersion;
      },
    };
    // The wiring index.js/web.js perform:
    mockServer.oninitialized = () => {
      try {
        ctx.state.client = mockServer.getClientVersion() ?? null;
      } catch {
        ctx.state.client = null;
      }
    };
    check("client not captured before initialize", ctx.state.client === undefined);
    mockServer.oninitialized(); // simulate the SDK firing the initialized notification
    check("clientInfo captured after initialize", ctx.state.client?.name === "cursor" && ctx.state.client?.version === "0.42");
    // And it flows through to a report's origin.
    calls = [];
    replies = [{ status: 201, body: { status: "recorded" } }];
    await runReport({ ...ctx, getToken: async () => "jwt", getActiveGrid: async () => null }, { message: "boom" });
    check("captured client attributed in report", calls[0].body.context.origin.client === "cursor 0.42");
  }

  // ═══ 3. errorGuidance report offer — GENUINE bugs get it ═══════════════════
  check("500 → report offer appended", errorGuidance({ status: 500 }) === REPORT_OFFER);
  check("502 → report offer appended", errorGuidance({ status: 502 }) === REPORT_OFFER);
  check("INTERNAL_ERROR → report offer appended", errorGuidance({ status: 500, code: "INTERNAL_ERROR" }) === REPORT_OFFER);
  check("BUILD_FAILED → report offer appended", errorGuidance({ status: 422, code: "BUILD_FAILED" }) === REPORT_OFFER);
  check("DEPLOY_FAILED → report offer appended", errorGuidance({ status: 422, code: "DEPLOY_FAILED" }) === REPORT_OFFER);
  check("report offer asks for permission first", /ASK the user for permission/.test(REPORT_OFFER));
  check("report offer names grid_report", /grid_report/.test(REPORT_OFFER));
  check("report offer forbids sending the full conversation without a yes", /do NOT include the full conversation/.test(REPORT_OFFER));

  // ═══ 3b. errorGuidance report offer — EXPECTED conditions do NOT get it ════
  check("429 → NO report offer", errorGuidance({ status: 429 }) !== REPORT_OFFER && !/grid_report/.test(errorGuidance({ status: 429 }) || ""));
  check("409 EDIT_REJECTED → NO report offer", errorGuidance({ status: 409, isEdit: true }) !== REPORT_OFFER && !/grid_report/.test(errorGuidance({ status: 409, isEdit: true }) || ""));
  check("401 → NO report offer", errorGuidance({ status: 401, isEdit: true }) !== REPORT_OFFER && !/grid_report/.test(errorGuidance({ status: 401 }) || ""));
  check("403 → NO report offer", errorGuidance({ status: 403 }) !== REPORT_OFFER && !/grid_report/.test(errorGuidance({ status: 403 }) || ""));
  // needs_grid is a structured signal, not an error status — it never reaches
  // errorGuidance (drop returns it via okResult). A plain unmapped 4xx (the
  // shape a needs_grid-adjacent 400 would take) must NOT get the offer either.
  check("unmapped 4xx (no code) → NO report offer", errorGuidance({ status: 400 }) === null);
  check("unmapped 4xx (unknown code) → NO report offer", errorGuidance({ status: 400, code: "SOME_NEW_ERROR" }) === null);
} catch (err) {
  console.error("test harness error:", err);
  failures++;
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll error-reporting checks passed.");
