// Unit tests for consent-gated error reporting (Task 34 / 0.8.1).
//
// Three offline surfaces:
//   1. runReport() — posts {app:"mcp", message, context, node_version, platform}
//      to /api/v2/errors/feedback. Authed → Bearer; anon+web → trusted-server
//      headers. include_conversation defaults false. 429/401/error → friendly
//      text, never throws. Obvious secrets in context are scrubbed client-side.
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

function makeCtx({ token = null, edition = "local", trustedServer = null } = {}) {
  return {
    edition,
    state: {},
    getToken: async () => token,
    getActiveGrid: async () => null,
    trustedServer,
  };
}

try {
  // ═══ 1. scrubReportContext ════════════════════════════════════════════════
  {
    const scrubbed = scrubReportContext({
      tool: "gridctl_drop",
      api_key: "sk-live-123",
      nested: { authToken: "abc", ok: "keep" },
      password: "hunter2",
      list: [{ secret: "x", label: "y" }],
    });
    check("scrub keeps non-secret keys", scrubbed.tool === "gridctl_drop" && scrubbed.nested.ok === "keep");
    check("scrub redacts api_key", scrubbed.api_key === "[REDACTED]");
    check("scrub redacts nested authToken", scrubbed.nested.authToken === "[REDACTED]");
    check("scrub redacts password", scrubbed.password === "[REDACTED]");
    check("scrub redacts secret inside arrays", scrubbed.list[0].secret === "[REDACTED]" && scrubbed.list[0].label === "y");
  }

  // ═══ 2. runReport — authed happy path posts the correct body ═══════════════
  {
    calls = [];
    replies = [{ status: 201, body: { status: "recorded" } }];
    const ctx = makeCtx({ token: "jwt-abc", edition: "local" });
    const res = await runReport(ctx, {
      message: "deploy failed",
      context: { tool: "gridctl_drop", error_code: "INTERNAL_ERROR", api_key: "sk-secret" },
    });
    const c = calls[0];
    check("authed report POSTs to /api/v2/errors/feedback", /\/api\/v2\/errors\/feedback$/.test(c.url) && c.method === "POST");
    check("authed report sends Bearer token", c.headers["Authorization"] === "Bearer jwt-abc");
    check("authed report body has app:mcp", c.body.app === "mcp");
    check("authed report body has message", c.body.message === "deploy failed");
    check("authed report body has node_version", c.body.node_version === process.version);
    check("authed report body has platform", c.body.platform === process.platform);
    check("authed report body forwards context.tool", c.body.context.tool === "gridctl_drop");
    check("authed report scrubs secret keys in context before sending", c.body.context.api_key === "[REDACTED]");
    check("authed report does NOT set include_conversation by default", c.body.include_conversation === undefined);
    check("authed report success → recorded", res.structuredContent.status === "recorded");
    check("authed report success → thank-you text", /thank you/i.test(res.content[0].text));
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

  // ═══ 3. errorGuidance report offer — GENUINE bugs get it ═══════════════════
  check("500 → report offer appended", errorGuidance({ status: 500 }) === REPORT_OFFER);
  check("502 → report offer appended", errorGuidance({ status: 502 }) === REPORT_OFFER);
  check("INTERNAL_ERROR → report offer appended", errorGuidance({ status: 500, code: "INTERNAL_ERROR" }) === REPORT_OFFER);
  check("BUILD_FAILED → report offer appended", errorGuidance({ status: 422, code: "BUILD_FAILED" }) === REPORT_OFFER);
  check("DEPLOY_FAILED → report offer appended", errorGuidance({ status: 422, code: "DEPLOY_FAILED" }) === REPORT_OFFER);
  check("report offer asks for permission first", /ASK the user for permission/.test(REPORT_OFFER));
  check("report offer names gridctl_report", /gridctl_report/.test(REPORT_OFFER));
  check("report offer forbids sending the full conversation without a yes", /do NOT include the full conversation/.test(REPORT_OFFER));

  // ═══ 3b. errorGuidance report offer — EXPECTED conditions do NOT get it ════
  check("429 → NO report offer", errorGuidance({ status: 429 }) !== REPORT_OFFER && !/gridctl_report/.test(errorGuidance({ status: 429 }) || ""));
  check("409 EDIT_REJECTED → NO report offer", errorGuidance({ status: 409, isEdit: true }) !== REPORT_OFFER && !/gridctl_report/.test(errorGuidance({ status: 409, isEdit: true }) || ""));
  check("401 → NO report offer", errorGuidance({ status: 401, isEdit: true }) !== REPORT_OFFER && !/gridctl_report/.test(errorGuidance({ status: 401 }) || ""));
  check("403 → NO report offer", errorGuidance({ status: 403 }) !== REPORT_OFFER && !/gridctl_report/.test(errorGuidance({ status: 403 }) || ""));
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
