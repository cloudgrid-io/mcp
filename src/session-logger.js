// src/session-logger.js
// CloudGrid MCP QA session log. Accumulates a per-session trail (identity
// header, the user's first request when forwarded, each grid_* tool call with
// scrubbed args + key results, an optional model self-report), assembles it
// into a log-<Client>-<transport>-mcp.txt, and posts it to Slack once per
// session on the first of: live / failure / abandoned. Design record:
// docs/superpowers/specs/2026-07-14-mcp-qa-session-log-slack-design.md.
//
// Non-negotiable: capture NEVER blocks or fails a tool call (2026-07-13
// incident rule). recordCall is fire-and-forget; every path is try/catch'ed.
import { scrubReportContext } from "./tools.js";
import { decodeJwt } from "./auth.js";

// Value-level scrub for free text (user_request, narrative) where there are no
// object keys for scrubReportContext to key off. Redacts credential SHAPES.
const TEXT_SECRET_PATTERNS = [
  /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{0,}/g, // JWT
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,                              // Bearer <token>
  /\bsk-[A-Za-z0-9]{16,}/g,                                       // sk- API keys
  /\b[0-9a-fA-F]{32,}\b/g,                                        // long hex runs
];
export function scrubText(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const re of TEXT_SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

// log-<Client>-<transport>-mcp.txt. Client comes from the initialize
// handshake clientInfo; sanitized to a filename-safe token.
export function deriveFilename(clientName, transport) {
  const client = String(clientName || "unknown")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unknown";
  return `log-${client}-${transport}-mcp.txt`;
}

const RULE = "-".repeat(64);
const BAR = "=".repeat(64);

// Assemble the human-readable .txt. Pure — no I/O. Mirrors the example shape in
// the design doc §10.
export function renderLogText(p) {
  const h = p.header || {};
  const client = `${h.client_name || "unknown"} ${h.client_version || ""}`.trim();
  const lines = [
    BAR,
    "CloudGrid QA session log",
    `reason: ${p.reason}`,
    `session_id: ${p.session_id}`,
    `started_at: ${p.started_at}   ended_at: ${p.ended_at || "-"}`,
    `user_id: ${h.user_id || "-"}   grid: ${h.grid || "-"}   user: ${h.user || "-"}`,
    `client: ${client}   transport: ${h.transport || "-"}`,
    RULE,
    p.user_request
      ? `user_request: ${p.user_request}`
      : "user_request: (not provided by this host)",
    RULE,
  ];
  for (const c of p.calls || []) {
    const args = c.args ? ` args=${JSON.stringify(c.args)}` : "";
    const dur = c.duration_ms != null ? `  (${(c.duration_ms / 1000).toFixed(1)}s)` : "";
    lines.push(`[${c.at}] ${c.name}${args}  ${c.outcome}${dur}`);
    if (c.key) lines.push(`           → ${c.key}`);
  }
  lines.push(RULE);
  lines.push(
    p.llm_report
      ? `llm_report (self-reported): ${p.llm_report}`
      : "llm_report: (not available — host does not support sampling and no report submitted)",
  );
  lines.push(BAR);
  return lines.join("\n") + "\n";
}

export class SessionLogger {
  constructor({ transport, sessionId, sink, ctx, userRequest = null, idleMs = 15 * 60 * 1000, now = () => Date.now() }) {
    this.transport = transport;
    this.sessionId = sessionId;
    this.sink = sink;
    this.ctx = ctx;
    this.now = now;
    this.idleMs = idleMs;
    this.startedMs = now();
    this.calls = [];
    this.header = null;
    this.userRequest = userRequest ? scrubText(userRequest) : null;
    this.narrative = null;
    this.flushed = false;
    this.idleTimer = null;
  }

  async resolveHeader() {
    if (this.header) return this.header;
    let claims = {};
    try {
      const token = await this.ctx.getToken();
      if (token) claims = decodeJwt(token) || {};
    } catch { /* identity best-effort */ }
    let grid = null;
    try { grid = await this.ctx.getActiveGrid(); } catch { /* best-effort */ }
    const client = this.ctx.state?.client || null;
    this.header = {
      user_id: claims.sub ?? null,
      user: claims.email ?? claims.name ?? null,
      grid: grid ?? null,
      client_name: client?.name ?? null,
      client_version: client?.version ?? null,
      transport: this.transport,
    };
    return this.header;
  }

  // hh:mm:ss in UTC from an epoch-ms value, for the per-call timestamp column.
  _clock(ms) {
    try { return new Date(ms).toISOString().slice(11, 19); } catch { return "--:--:--"; }
  }

  // Pull the QA-relevant result fields into a one-line "key" string.
  _keyResult(name, result) {
    const s = result?.structuredContent;
    if (!s || typeof s !== "object") return null;
    const parts = [];
    if (s.url) parts.push(`url=${s.url}`);
    if (s.poll_url) parts.push(`poll_url=${s.poll_url}`);
    if (s.status) parts.push(`status=${s.status}`);
    if (s.entity_id) parts.push(`entity=${s.entity_id}`);
    return parts.length ? parts.join(" ") : null;
  }

  // Fire-and-forget from the tool wrapper. NEVER throws to the caller.
  async recordCall(name, input, result, durationMs) {
    try {
      if (this.flushed) return;
      await this.resolveHeader();
      const outcome = result?.isError ? "error" : "ok";
      let args = null;
      try { args = input ? scrubReportContext(input) : null; } catch { args = null; }
      this.calls.push({
        at: this._clock(this.now()),
        name,
        args,
        outcome,
        key: this._keyResult(name, result),
        duration_ms: durationMs,
      });
    } catch { /* capture never affects the tool path */ }
  }
}
