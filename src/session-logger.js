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
