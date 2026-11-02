// Sign-in on the hosted MCP server (web edition): who must sign in, when, and
// how each AI tool is told to do it.
//
// One address serves everyone. Browsing tools work signed out; every other tool
// needs an account. How the client is asked to sign in depends on the client,
// read from `clientInfo` at initialize (authMode below):
//
//   "call"        Answer the protected tools/call with HTTP 401 and a
//                 WWW-Authenticate challenge. The client runs OAuth and retries.
//   "tool-error"  Answer the protected tools/call with a tool error carrying
//                 `_meta["mcp/www_authenticate"]` (the OpenAI Apps form).
//   "connect"     Answer initialize itself with 401, so the client signs in when
//                 the server is added (CLI and IDE clients).
//
// clientInfo is self-reported, so it only picks the SIGNAL. It never grants
// anything: a protected call without a valid token is refused in every mode.

import { createHash } from "node:crypto";

/** Tools that work without an account. Everything else needs one. */
export const PUBLIC_TOOLS = new Set(["grid_start", "grid_get_template", "grid_get_app_source"]);

export const AUTH_SCOPE = "cloudgrid";

export const AUTH_MODES = new Set(["call", "tool-error", "connect"]);

/**
 * MCP_AUTH_MODE_OVERRIDES: `name=mode` pairs, comma separated, matched against
 * the lower-cased clientInfo name, e.g. `openai-mcp=tool-error`. Lets one
 * client's signal change after a live test without a release. Unknown modes are
 * ignored.
 */
export function parseAuthModeOverrides(raw) {
  const map = new Map();
  for (const pair of String(raw || "").split(",")) {
    const i = pair.lastIndexOf("=");
    if (i <= 0) continue;
    const name = pair.slice(0, i).trim().toLowerCase();
    const mode = pair.slice(i + 1).trim();
    if (name && AUTH_MODES.has(mode)) map.set(name, mode);
  }
  return map;
}

/**
 * The sign-in signal for a client, from its initialize `clientInfo`.
 * To change what one client gets after a live test, change its line here (or
 * set MCP_AUTH_MODE_OVERRIDES).
 */
export function authMode(clientInfo, overrides = new Map()) {
  const name = typeof clientInfo?.name === "string" ? clientInfo.name.trim().toLowerCase() : "";
  if (overrides.has(name)) return overrides.get(name);
  // Claude on the web, desktop and mobile (connectors are brokered by claude.ai).
  if (name === "anthropic/claudeai" || name === "claude-ai") return "call";
  // ChatGPT: a plain 401 first. If the live test shows it is not honoured,
  // change this line to "tool-error".
  if (name.startsWith("openai") || name.includes("chatgpt")) return "call";
  // Claude Code, Gemini CLI, VS Code, Cursor, Copilot Studio, and anything else.
  return "connect";
}

/** The tools/call names in a JSON-RPC body (a single message or a batch). */
function toolCallNames(body) {
  const messages = Array.isArray(body) ? body : [body];
  const names = [];
  for (const m of messages) {
    if (m && typeof m === "object" && m.method === "tools/call") {
      names.push(typeof m.params?.name === "string" ? m.params.name : "");
    }
  }
  return names;
}

/** True when the body calls at least one tool that needs an account. */
export function callsProtectedTool(body) {
  return toolCallNames(body).some((n) => !PUBLIC_TOOLS.has(n));
}

/** The WWW-Authenticate value for a 401 from `base` (this host's origin). */
export function bearerChallenge(base, { error, description } = {}) {
  const b = String(base).replace(/\/+$/, "");
  let v = `Bearer resource_metadata="${b}/.well-known/oauth-protected-resource", scope="${AUTH_SCOPE}"`;
  if (error) v += `, error="${error}"`;
  if (description) v += `, error_description="${String(description).replace(/["\\]/g, "")}"`;
  return v;
}

/**
 * The tool result for a protected call made without an account, in the
 * "tool-error" mode. The `_meta` key is what ChatGPT reads to start sign-in;
 * the text is for any client that does not.
 */
export function signInRequiredResult(base) {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          "This needs a CloudGrid account. Sign in when your AI tool asks, then try again. " +
          "Browsing templates and app sources works without an account.",
      },
    ],
    _meta: {
      "mcp/www_authenticate": [
        bearerChallenge(base, { error: "insufficient_scope", description: "Sign in to CloudGrid to use this tool" }),
      ],
    },
  };
}

/**
 * Asks the API whether a CloudGrid session token is valid and not signed out
 * (GET /api/v2/users/me). Answers are cached briefly by the token's hash, so a
 * busy connection costs one API call every few minutes.
 * Returns { ok: true, sub, email } | { ok: false } | { ok: false, unavailable: true }.
 */
export function createPlatformValidator({ apiBase, fetchImpl = fetch, now = () => Date.now() }) {
  const cache = new Map(); // sha256(token) -> { ok, sub, email, until }
  const OK_MS = 5 * 60 * 1000;
  const BAD_MS = 60 * 1000;
  const MAX = 2000;
  return async function validatePlatformToken(token) {
    const key = createHash("sha256").update(String(token)).digest("base64url");
    const hit = cache.get(key);
    if (hit && hit.until > now()) return hit;
    let entry;
    try {
      const res = await fetchImpl(`${apiBase}/api/v2/users/me`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const me = await res.json().catch(() => ({}));
        entry = {
          ok: true,
          sub: typeof me?.user_id === "string" ? me.user_id : null,
          email: typeof me?.email === "string" ? me.email : null,
          until: now() + OK_MS,
        };
      } else if (res.status === 401 || res.status === 403) {
        entry = { ok: false, until: now() + BAD_MS };
      } else {
        return { ok: false, unavailable: true };
      }
    } catch {
      return { ok: false, unavailable: true };
    }
    if (cache.size >= MAX) cache.delete(cache.keys().next().value);
    cache.set(key, entry);
    return entry;
  };
}

/**
 * Resolves a presented Bearer to the account it speaks for.
 *
 *  - An MCP access token (this server's own): verified locally.
 *  - A CloudGrid session token presented directly, which is what this server
 *    handed out as the access token before 0.22. Connections made then still
 *    hold one, so it is accepted while it lasts (at most 30 days after it was
 *    issued), and only after the API confirms it is valid and not signed out.
 *    Remove this branch once the last such token has expired.
 *
 * Returns { ok: true, platformToken, sub, kind } or { ok: false, reason }.
 */
export function createBearerResolver({ tokens, validatePlatformToken, log = console.error }) {
  return async function resolveBearer(token) {
    const v = tokens.verify(token);
    if (v.ok) return { ok: true, kind: "mcp", platformToken: v.grant, sub: v.claims.sub, claims: v.claims };
    if (v.reason !== "not_ours") return { ok: false, reason: v.reason };
    // Only a JWT-shaped value is worth asking the API about.
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(token))) return { ok: false, reason: "malformed" };
    const legacy = await validatePlatformToken(String(token));
    if (legacy.unavailable) return { ok: false, reason: "unavailable" };
    if (!legacy.ok) return { ok: false, reason: "legacy_rejected" };
    log("[auth] accepted a CloudGrid session token issued before 0.22 (legacy connection)");
    return { ok: true, kind: "legacy", platformToken: String(token), sub: legacy.sub };
  };
}
