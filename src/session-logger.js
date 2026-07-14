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

// Default-DENY arg capture for the QA log. Only these known-safe, non-sensitive
// scalar keys are retained verbatim (then value-scrubbed); every other key is
// dropped to "[omitted]" so a secret/content VALUE can never reach the log even
// if a future tool adds a new sensitive arg. Security posture: allowlist, not
// denylist. (Design doc §8: an internal channel must not receive tokens.)
const ALLOWED_ARG_KEYS = new Set([
  "action", "name", "slug", "kind", "type", "grid", "org",
  "entity_id", "target_entity_id", "dir", "cwd", "mode", "tail",
  "since", "limit", "visibility", "version", "filename", "anon",
  "force", "confirm", "new_name", "role", "domain", "when",
  "single_html", "replug", "fork", "no_bind", "key", "url",
  "path", "target_dir", "label", "encoding",
]);

// Redact a tool's raw input for the QA log: keep only allowlisted keys, mark the
// rest "[omitted]", value-scrub retained strings. NEVER throws.
export function scrubArgs(input) {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    const out = {};
    for (const [k, v] of Object.entries(input)) {
      if (!ALLOWED_ARG_KEYS.has(k)) { out[k] = "[omitted]"; continue; }
      out[k] = typeof v === "string" ? scrubText(v) : v;
    }
    return out;
  } catch { return null; }
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
      const args = scrubArgs(input);
      this.calls.push({
        at: this._clock(this.now()),
        name,
        args,
        outcome,
        key: this._keyResult(name, result),
        duration_ms: durationMs,
      });
      // Trigger flush on the first live / error moment. Fire-and-forget so the
      // tool return is never delayed by delivery.
      if (outcome === "error") {
        this.flush("error").catch(() => {});
      } else if (name === "grid_plug" && (result?.structuredContent?.url || result?.structuredContent?.poll_url)) {
        this.flush("live").catch(() => {});
      } else {
        this._resetIdle();
      }
    } catch { /* capture never affects the tool path */ }
  }

  _resetIdle() {
    try {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      if (this.flushed || !this.idleMs) return;
      this.idleTimer = setTimeout(() => { this.flush("abandoned").catch(() => {}); }, this.idleMs);
      if (this.idleTimer.unref) this.idleTimer.unref(); // don't keep the process alive
    } catch { /* timers best-effort */ }
  }

  _summary(header, reason) {
    const url = [...this.calls].reverse().find((c) => c.key && c.key.includes("url="))?.key || "";
    return [
      header.user || header.user_id || "anon",
      header.grid || "-",
      `${header.client_name || "unknown"} ${header.client_version || ""}`.trim(),
      reason,
      url,
    ].join(" · ");
  }

  async flush(reason) {
    if (this.flushed) return;
    this.flushed = true;
    try { if (this.idleTimer) clearTimeout(this.idleTimer); } catch { /* noop */ }
    try {
      const header = await this.resolveHeader();
      const payload = {
        reason,
        session_id: this.sessionId,
        started_at: new Date(this.startedMs).toISOString(),
        ended_at: new Date(this.now()).toISOString(),
        header,
        user_request: this.userRequest,
        calls: this.calls,
        llm_report: this.narrative ? scrubText(this.narrative) : null,
      };
      const text = renderLogText(payload);
      const filename = deriveFilename(header.client_name, this.transport);
      const summary = this._summary(header, reason);
      await this.sink.send({ filename, summary, text });
    } catch { /* delivery never affects the tool path */ }
  }

  setUserRequest(text) {
    try { if (!this.userRequest && text) this.userRequest = scrubText(text); } catch { /* noop */ }
  }

  setNarrative(text) {
    try { if (text) this.narrative = String(text).slice(0, 4000); } catch { /* noop */ }
  }
}

// Factory: returns null when there is no sink, so callers can attach
// `ctx.logger = createSessionLogger(...)` and `ctx.logger?.recordCall(...)`
// costs nothing when QA logging is dark.
export function createSessionLogger(opts) {
  if (!opts || !opts.sink) return null;
  const env = opts.env || process.env;
  const idleMs = env.CLOUDGRID_QA_IDLE_MS ? Number(env.CLOUDGRID_QA_IDLE_MS) : undefined;
  return new SessionLogger({ ...opts, ...(Number.isFinite(idleMs) ? { idleMs } : {}) });
}
