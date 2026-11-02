// Refresh tokens for the hosted MCP server: rotating, single use, with reuse
// detection.
//
// A sign-in starts a FAMILY. Each refresh token belongs to one family and can be
// used once: using it returns a new access token and a new refresh token, and
// marks the old one used. Presenting a used refresh token again means two
// parties hold the same token, so the whole family is revoked and the user signs
// in again. A family slides: every refresh pushes its expiry out by the refresh
// lifetime, so an active user stays signed in, up to the expiry of the CloudGrid
// session it holds.
//
// State lives in a small key-value backend: Redis in production (src/redis-client.js),
// an in-memory map in tests and when no store is configured. Only GET, SET with
// expiry, GETDEL, DEL and EXPIRE are used, so no scripting or transactions are
// needed. Keys (all under `mcp:oauth:`):
//   rf:<family>  the family record (JSON, opaque to this module)
//   rt:<hash>    a live refresh token -> its family
//   ru:<hash>    a used refresh token -> its family (for reuse detection)
// A refresh token is never stored, only its SHA-256.

import { createHash, randomBytes } from "node:crypto";

const PREFIX = "mcp:oauth:";
const TOKEN_PREFIX = "cgr1";

const hashOf = (token) => createHash("sha256").update(String(token)).digest("base64url");

function newToken(family) {
  return `${TOKEN_PREFIX}.${family}.${randomBytes(32).toString("base64url")}`;
}

function familyOf(token) {
  const m = /^cgr1\.([A-Za-z0-9_-]{22})\.[A-Za-z0-9_-]{43}$/.exec(String(token || ""));
  return m ? m[1] : null;
}

/** An in-memory backend with the same contract as the Redis client. */
export function createMemoryBackend({ now = () => Date.now() } = {}) {
  const map = new Map(); // key -> { v, exp }
  const live = (k) => {
    const e = map.get(k);
    if (!e) return null;
    if (e.exp <= now()) {
      map.delete(k);
      return null;
    }
    return e;
  };
  return {
    async get(k) {
      return live(k)?.v ?? null;
    },
    async set(k, v, ttlSeconds) {
      map.set(k, { v: String(v), exp: now() + ttlSeconds * 1000 });
      return "OK";
    },
    async getdel(k) {
      const e = live(k);
      map.delete(k);
      return e ? e.v : null;
    },
    async del(...keys) {
      let n = 0;
      for (const k of keys) if (map.delete(k)) n++;
      return n;
    },
    async expire(k, ttlSeconds) {
      const e = live(k);
      if (!e) return 0;
      e.exp = now() + ttlSeconds * 1000;
      return 1;
    },
    async ping() {
      return "PONG";
    },
    size: () => map.size,
  };
}

/**
 * The refresh-token store.
 * backend: { get, set, getdel, del, expire } (Redis client or memory backend).
 * refreshTtlSeconds: the sliding lifetime of a family.
 */
export function createRefreshStore({ backend, refreshTtlSeconds, now = () => Date.now() }) {
  const ttlFor = (record) => {
    const cap = typeof record?.expiresAt === "number" ? Math.floor((record.expiresAt - now()) / 1000) : refreshTtlSeconds;
    return Math.min(refreshTtlSeconds, cap);
  };

  return {
    /**
     * Start a family for a sign-in. `record` is stored as is (the caller seals
     * anything secret) and may carry `expiresAt` (ms): the family never outlives
     * it. Returns { token, family, expiresIn } or null when nothing can be
     * issued (the record is already past its expiry).
     */
    async start(record) {
      const family = randomBytes(16).toString("base64url");
      const ttl = ttlFor(record);
      if (ttl <= 0) return null;
      const token = newToken(family);
      await backend.set(`${PREFIX}rf:${family}`, JSON.stringify(record), ttl);
      await backend.set(`${PREFIX}rt:${hashOf(token)}`, family, ttl);
      return { token, family, expiresIn: ttl };
    },

    /**
     * Use a refresh token. Returns
     *   { ok: true, family, record, token, expiresIn }  the new refresh token
     *   { ok: false, reason: "invalid" }   unknown, expired or malformed
     *   { ok: false, reason: "reused" }    already used: the family is revoked
     * A backend failure throws (the caller answers "try again", never "invalid").
     */
    async rotate(token) {
      const family = familyOf(token);
      if (!family) return { ok: false, reason: "invalid" };
      const h = hashOf(token);
      if (await backend.get(`${PREFIX}ru:${h}`)) {
        await backend.del(`${PREFIX}rf:${family}`);
        return { ok: false, reason: "reused" };
      }
      // Single use: GETDEL makes exactly one caller the winner.
      const owner = await backend.getdel(`${PREFIX}rt:${h}`);
      if (owner !== family) return { ok: false, reason: "invalid" };
      const raw = await backend.get(`${PREFIX}rf:${family}`);
      let record = null;
      try {
        record = raw ? JSON.parse(raw) : null;
      } catch {
        record = null;
      }
      const ttl = record ? ttlFor(record) : 0;
      // Remember the used token for as long as the family can live, so a replay
      // is recognised as one.
      await backend.set(`${PREFIX}ru:${h}`, family, Math.max(ttl, 60));
      if (!record || ttl <= 0) return { ok: false, reason: "invalid" };
      const next = newToken(family);
      await backend.set(`${PREFIX}rt:${hashOf(next)}`, family, ttl);
      await backend.expire(`${PREFIX}rf:${family}`, ttl);
      return { ok: true, family, record, token: next, expiresIn: ttl };
    },

    /** End a family: every refresh token in it stops working. */
    async revoke(family) {
      if (family) await backend.del(`${PREFIX}rf:${family}`);
    },

    /** Whether a family is still live (used to check a token's family). */
    async isLive(family) {
      return Boolean(family && (await backend.get(`${PREFIX}rf:${family}`)));
    },
  };
}
