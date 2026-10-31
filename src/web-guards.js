// Request guards for the hosted web edition: Origin validation, verifiable
// session ids, client-IP resolution and a small in-memory rate limiter.
//
// Everything here is in-process and dependency-free. The hosted edition keeps
// its sessions in memory (see web.js), so these limits are per process too.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// --- Origin allow-list --------------------------------------------------------
// The MCP Streamable HTTP transport requires servers to validate the Origin
// header. A request WITHOUT an Origin is a non-browser client (the hosted
// connectors of Claude and ChatGPT call from their servers, as do desktop and CLI
// clients) and is allowed. A request WITH an Origin must match the allow-list.
//
// Defaults: the Claude and ChatGPT web apps, this server's own public origin, and
// loopback on any port (local browser-based tools such as the MCP Inspector).
// MCP_ALLOWED_ORIGINS adds entries (comma or whitespace separated). An entry may
// be an exact origin ("https://app.example.com") or a subdomain wildcard
// ("https://*.example.com", which does not match the apex). A single "*" turns
// the check off.
export const DEFAULT_ALLOWED_ORIGINS = [
  "https://claude.ai",
  "https://*.claude.ai",
  "https://claude.com",
  "https://*.claude.com",
  "https://chatgpt.com",
  "https://*.chatgpt.com",
  "https://chat.openai.com",
];

const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/;

function originOf(value) {
  try {
    const u = new URL(String(value));
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Build the Origin matcher. Returns `(origin) => boolean`; an absent origin is
 * the caller's concern (the guard allows it).
 */
export function createOriginMatcher({ env = process.env, publicBase } = {}) {
  const extra = String(env.MCP_ALLOWED_ORIGINS || "").split(/[\s,]+/).filter(Boolean);
  if (extra.includes("*")) return () => true;
  const exact = new Set();
  const suffixes = []; // { scheme, suffix } for "scheme://*.domain"
  const own = publicBase ? originOf(publicBase) : null;
  if (own) exact.add(own);
  for (const entry of [...DEFAULT_ALLOWED_ORIGINS, ...extra]) {
    const m = /^(https?):\/\/\*\.([a-z0-9.-]+)$/i.exec(entry);
    if (m) {
      suffixes.push({ scheme: `${m[1].toLowerCase()}:`, suffix: `.${m[2].toLowerCase()}` });
      continue;
    }
    const o = originOf(entry);
    if (o) exact.add(o);
  }
  return (origin) => {
    if (typeof origin !== "string" || origin === "") return false;
    if (LOOPBACK_ORIGIN.test(origin)) return true;
    const o = originOf(origin);
    // The Origin header is a bare origin; anything with a path, or the opaque
    // "null" origin, does not normalize back to itself and is refused.
    if (!o || o !== origin.toLowerCase().replace(/\/$/, "")) return false;
    if (exact.has(o)) return true;
    const { protocol, hostname } = new URL(o);
    return suffixes.some((s) => s.scheme === protocol && hostname.endsWith(s.suffix));
  };
}

/** Express middleware: 403 a request whose Origin is present and not allowed. */
export function originGuard(isAllowed, { onRefused } = {}) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin === undefined || isAllowed(origin)) {
      next();
      return;
    }
    onRefused?.(origin);
    res.status(403).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Forbidden: this Origin is not allowed." },
      id: null,
    });
  };
}

// --- Verifiable session ids ----------------------------------------------------
// A session id is `<random>.<tag>`: 16 random bytes and a 128-bit HMAC tag, both
// base64url (45 characters, all visible ASCII as the transport spec requires).
// The tag covers this server's public origin, so an id is only valid on the edge
// that issued it. web.js rebuilds a session for an unknown id only when the tag
// verifies, i.e. only for an id some process of this edge actually issued.
//
// Key: MCP_SESSION_SECRET if set, else MCP_TRUSTED_SERVER_SECRET (present on every
// hosted edge). The key is derived, never used raw, so the same secret's other
// use is not exposed. With neither set, a per-process key is generated: ids then
// verify only within the process that issued them, so a client whose session
// was lost to a restart is asked to initialize again (404) instead of being
// rebuilt in place.
const SESSION_TAG_LABEL = "cloudgrid-mcp/session-id/v1";

function b64url(buf) {
  return buf.toString("base64url");
}

export function createSessionIds({ env = process.env, publicBase = "" } = {}) {
  const configured = env.MCP_SESSION_SECRET || env.MCP_TRUSTED_SERVER_SECRET || "";
  const ephemeral = configured === "";
  const root = ephemeral ? randomBytes(32) : Buffer.from(configured, "utf8");
  const key = createHmac("sha256", root).update(SESSION_TAG_LABEL).digest();
  const scope = String(publicBase).replace(/\/+$/, "");

  const tagOf = (random) =>
    createHmac("sha256", key).update(`${scope}|${random}`).digest().subarray(0, 16);

  return {
    ephemeral,
    mint() {
      const random = b64url(randomBytes(16));
      return `${random}.${b64url(tagOf(random))}`;
    },
    verify(id) {
      if (typeof id !== "string") return false;
      const m = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{22})$/.exec(id);
      if (!m) return false;
      const given = Buffer.from(m[2], "base64url");
      const expected = tagOf(m[1]);
      return given.length === expected.length && timingSafeEqual(given, expected);
    },
  };
}

// --- Client IP ------------------------------------------------------------------
// Behind the ingress, the TCP peer is the proxy, so the client address comes from
// X-Forwarded-For. Only the entries the trusted proxies appended can be believed;
// anything to their left is client-supplied. With `hops` trusted proxies in front
// of this process, the client is the hops-th entry from the right. The ingress in
// front of the hosted edge sets X-Forwarded-For to the client address it resolved,
// so the default is 1. 0 ignores the header and uses the socket peer.
export function clientIp(req, hops = 1) {
  const peer = String(req.socket?.remoteAddress || "unknown").replace(/^::ffff:/, "");
  if (hops <= 0) return peer;
  const raw = req.headers["x-forwarded-for"];
  const header = Array.isArray(raw) ? raw.join(",") : raw;
  if (!header) return peer;
  const parts = header.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return peer;
  const pick = parts[Math.max(0, parts.length - hops)];
  return pick.replace(/^::ffff:/, "");
}

// --- Rate limiting -------------------------------------------------------------------
// A token bucket per key: `perMinute` tokens of burst, refilled continuously at
// perMinute/60 per second. In memory and per process, so it bounds what one
// process accepts; it is not a global quota. The key map is bounded: buckets that
// have refilled are dropped by the sweep, and past `maxKeys` the oldest entries
// go first.
export function createRateLimiter({ perMinute, maxKeys = 50_000, now = Date.now } = {}) {
  const capacity = Number(perMinute);
  const enabled = Number.isFinite(capacity) && capacity > 0;
  const ratePerMs = capacity / 60_000;
  const buckets = new Map(); // key -> { tokens, at }

  function refill(b, t) {
    b.tokens = Math.min(capacity, b.tokens + (t - b.at) * ratePerMs);
    b.at = t;
  }

  return {
    enabled,
    /** Take one token. Returns { ok: true } or { ok: false, retryAfterSec }. */
    take(key) {
      if (!enabled) return { ok: true };
      const t = now();
      let b = buckets.get(key);
      if (b) {
        refill(b, t);
        buckets.delete(key); // re-insert: Map order doubles as recency
      } else {
        b = { tokens: capacity, at: t };
        if (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value);
      }
      buckets.set(key, b);
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return { ok: true };
      }
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / ratePerMs / 1000)) };
    },
    sweep() {
      const t = now();
      for (const [k, b] of buckets) {
        refill(b, t);
        if (b.tokens >= capacity) buckets.delete(k);
      }
    },
    get size() {
      return buckets.size;
    },
  };
}

/** Write the 429. JSON-RPC shaped on /mcp, OAuth-error shaped elsewhere. */
export function sendRateLimited(res, retryAfterSec, { jsonRpc = false } = {}) {
  res.setHeader("Retry-After", String(retryAfterSec));
  if (jsonRpc) {
    res.status(429).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: `Too many requests. Retry after ${retryAfterSec} seconds.` },
      id: null,
    });
    return;
  }
  res.status(429).json({
    error: "rate_limited",
    error_description: `Too many requests. Retry after ${retryAfterSec} seconds.`,
  });
}

/** Express middleware over a limiter, keyed by client IP. */
export function rateLimitMiddleware(limiter, { hops = 1, name = "" } = {}) {
  return (req, res, next) => {
    const r = limiter.take(`${name}|${clientIp(req, hops)}`);
    if (r.ok) {
      next();
      return;
    }
    sendRateLimited(res, r.retryAfterSec);
  };
}

/** A non-negative integer from env, else the default. */
export function envInt(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
