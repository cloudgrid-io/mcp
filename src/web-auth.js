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
import { decodeJwt } from "./auth.js";

/**
 * Tools that work without an account. Everything else needs one. Resources and
 * prompts are not gated: today they are only the widget HTML templates. A
 * resource or prompt that returns account data must be added to the gate.
 */
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
export function createPlatformValidator({ apiBase, fetchImpl = (...a) => fetch(...a), now = () => Date.now() }) {
  const cache = new Map(); // sha256(token) -> { ok, sub, email, until }
  const OK_MS = 5 * 60 * 1000;
  const BAD_MS = 60 * 1000;
  const REFUSED_MS = 15 * 60 * 1000;
  const MAX = 2000;
  const keyOf = (token) => createHash("sha256").update(String(token)).digest("base64url");
  async function validatePlatformToken(token) {
    const key = keyOf(token);
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
  }
  /** The API refused this token on a real call: remember it as refused. */
  validatePlatformToken.markRefused = (token) => {
    if (cache.size >= MAX) cache.delete(cache.keys().next().value);
    cache.set(keyOf(token), { ok: false, until: now() + REFUSED_MS });
  };
  return validatePlatformToken;
}

/**
 * Watches this process's calls to the API: when the API answers a call made
 * with a Bearer with 401 AUTH_INVALID or AUTH_EXPIRED, that credential is
 * signed out or gone, and `onRefused(token)` is told. Every tool's API call
 * goes through fetch, so this covers them all without each tool reporting it.
 */
export function observeApiRefusals({ apiBase, onRefused, target = globalThis }) {
  const base = String(apiBase).replace(/\/+$/, "");
  const original = target.fetch;
  target.fetch = async function fetchObserved(input, init) {
    const res = await original(input, init);
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
      if (res.status === 401 && typeof url === "string" && url.startsWith(base)) {
        const headers = new Headers(init?.headers ?? (typeof input === "object" && input?.headers) ?? undefined);
        const auth = headers.get("authorization") || "";
        if (auth.startsWith("Bearer ")) {
          const body = await res.clone().json().catch(() => null);
          if (body?.code === "AUTH_INVALID" || body?.code === "AUTH_EXPIRED") onRefused(auth.slice(7));
        }
      }
    } catch {
      /* observation never changes the response */
    }
    return res;
  };
  return () => { target.fetch = original; };
}

/**
 * The downstream credential. The CloudGrid session sealed in an access token is
 * the user's 30-day session; the server does not send it on tool calls. It
 * trades it at the API (POST /api/v2/auth/token/downstream, authenticated as
 * the trusted server) for a short-lived child token that the API scopes to what
 * a connected AI tool may do, and sends that child instead. Children are cached
 * until shortly before they expire.
 *
 * Returns { token, expiresAt } | { refused: true } (the session is signed out)
 * | { notOffered: true } (404: the API does not offer the exchange yet; the
 * caller then uses the session itself, as before 0.22; remove once the
 * endpoint is deployed everywhere) | { failed: true } (anything else: the
 * caller answers 503 and never falls back to the session).
 */
export function createDownstreamExchanger({
  apiBase,
  trustedSecret,
  fetchImpl = (...a) => fetch(...a),
  now = () => Date.now(),
  log = console.error,
}) {
  const cache = new Map(); // sha256(parent) -> { token, expiresAt }
  const parents = new Map(); // child token -> parent session (in memory only; FIFO-capped at 2 * MAX)
  const MAX = 2000;
  const keyOf = (t) => createHash("sha256").update(String(t)).digest("base64url");
  let warned = false;

  async function exchange(parent, endUserId = "hosted-mcp") {
    if (!trustedSecret) return { notOffered: true };
    const key = keyOf(parent);
    const hit = cache.get(key);
    if (hit && hit.expiresAt - 60_000 > now()) return hit;
    let res;
    try {
      res = await fetchImpl(`${apiBase}/api/v2/auth/token/downstream`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${parent}`,
          "X-CloudGrid-Trusted-Server-Auth": trustedSecret,
          "X-CloudGrid-Trusted-Server-End-User": String(endUserId),
        },
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      return { failed: true };
    }
    if (res.status === 401) {
      cache.delete(key);
      return { refused: true };
    }
    if (res.status === 404) {
      if (!warned) {
        warned = true;
        log("[auth] the API does not offer the downstream token exchange yet; using the session itself");
      }
      return { notOffered: true };
    }
    if (!res.ok) {
      log(`[auth] downstream token exchange failed (HTTP ${res.status}); request refused`);
      return { failed: true };
    }
    const body = await res.json().catch(() => null);
    if (typeof body?.access_token !== "string") return { failed: true };
    const entry = { token: body.access_token, expiresAt: now() + Math.max(60, Number(body.expires_in) || 0) * 1000 };
    if (cache.size >= MAX) {
      const [oldKey, old] = cache.entries().next().value;
      cache.delete(oldKey);
      parents.delete(old.token);
    }
    cache.set(key, entry);
    parents.set(entry.token, parent);
    if (parents.size > MAX * 2) parents.delete(parents.keys().next().value);
    return entry;
  }
  /** The session a child was minted from (for refusal tracking). */
  exchange.parentOf = (child) => parents.get(child) ?? null;
  return exchange;
}

/**
 * Resolves a presented Bearer to the account it speaks for.
 *
 *  - An MCP access token (this server's own): verified locally.
 *  - A CloudGrid session token presented directly, which is what this server
 *    handed out as the access token before 0.22. Connections made then still
 *    hold one, so it is accepted while it lasts (at most 30 days after it was
 *    issued), only if it was issued before the cutoff (legacyIssuedBefore), and
 *    only after the API confirms it is valid and not signed out.
 *    Remove this branch once the last such token has expired.
 *
 * Returns { ok: true, platformToken, sub, kind } or { ok: false, reason }.
 */
export function createBearerResolver({
  tokens,
  validatePlatformToken,
  exchangeDownstream = null,
  legacyIssuedBefore = Infinity,
  log = console.error,
}) {
  return async function resolveBearer(token) {
    const v = tokens.verify(token);
    if (v.ok) {
      // The CloudGrid session sealed in the token can be signed out or its
      // account removed after the token was issued. Ask the API (cached), so
      // that reaches the client as a 401 within minutes, not a dead end. If
      // the API cannot be asked, the request gets 503 (fail closed), the same
      // as for a legacy token.
      const live = await validatePlatformToken(v.grant);
      if (live.unavailable) return { ok: false, reason: "unavailable" };
      if (!live.ok) return { ok: false, reason: "grant_revoked" };
      // Tool calls use the scoped child token, not the session itself.
      let platformToken = v.grant;
      if (exchangeDownstream) {
        const d = await exchangeDownstream(v.grant);
        if (d.refused) return { ok: false, reason: "grant_revoked" };
        if (d.failed) return { ok: false, reason: "unavailable" };
        if (d.token) platformToken = d.token;
      }
      return { ok: true, kind: "mcp", platformToken, sub: v.claims.sub, claims: v.claims };
    }
    if (v.reason !== "not_ours") return { ok: false, reason: v.reason };
    // Only a JWT-shaped value is worth asking the API about.
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(String(token))) return { ok: false, reason: "malformed" };
    // Only tokens from before 0.22 are legacy connections. `iat` is read before
    // the API verifies the signature; a forged `iat` still fails there.
    const iat = decodeJwt(String(token)).iat;
    if (typeof iat !== "number" || iat >= legacyIssuedBefore) return { ok: false, reason: "legacy_too_new" };
    const legacy = await validatePlatformToken(String(token));
    if (legacy.unavailable) return { ok: false, reason: "unavailable" };
    if (!legacy.ok) return { ok: false, reason: "legacy_rejected" };
    log("[auth] accepted a CloudGrid session token issued before 0.22 (legacy connection)");
    let platformToken = String(token);
    if (exchangeDownstream) {
      const d = await exchangeDownstream(platformToken);
      if (d.refused) return { ok: false, reason: "legacy_rejected" };
      if (d.failed) return { ok: false, reason: "unavailable" };
      if (d.token) platformToken = d.token;
    }
    return { ok: true, kind: "legacy", platformToken, sub: legacy.sub };
  };
}
