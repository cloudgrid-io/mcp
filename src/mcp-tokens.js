// Access tokens for the hosted MCP server (web edition).
//
// The OAuth token endpoint issues tokens this server signs itself, for this
// server only: a JWT (RFC 9068 shape, `typ: at+jwt`) signed with Ed25519
// (`alg: EdDSA`), carrying the resource it is for as `aud`. Every request that
// presents one is checked for signature, audience, issuer and expiry before
// anything else happens. The CloudGrid account credential the server uses to
// call the API on the user's behalf travels inside the token SEALED
// (AES-256-GCM, key derived from the signing key), so the client holds an
// opaque value it cannot read, and the account credential is never handed to
// the client or accepted from it.
//
// KEYS: MCP_TOKEN_SIGNING_KEYS, a comma- or whitespace-separated list of
// base64url-encoded 32-byte Ed25519 seeds. The FIRST entry signs; ALL entries
// verify. Each key's `kid` is its RFC 7638 JWK thumbprint, so nothing else needs
// configuring. Rotation is the same order as MCP_OAUTH_HMAC_SECRET:
//   1. append the new seed (verify-only) and roll out;
//   2. move it to the front (it now signs) and roll out;
//   3. after the longest token lifetime has passed, drop the old seed.
// No key configured: a per-process key, with a warning. Tokens then stop
// verifying on restart and clients are asked to sign in again.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";

const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SEAL_INFO = "cloudgrid-mcp grant seal v1";
const TOKEN_TYP = "at+jwt";
// Clock skew tolerated on `iat` (a token from a few seconds in the future).
const IAT_SKEW_S = 60;

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function fromB64url(s) {
  return Buffer.from(String(s), "base64url");
}

// One configured key: the Ed25519 key pair, its kid and its sealing key.
function keyFromSeed(seed) {
  if (seed.length !== 32) throw new Error("an MCP token signing key must be a 32-byte Ed25519 seed (base64url)");
  const privateKey = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const x = publicKey.export({ format: "jwk" }).x;
  // RFC 7638: the thumbprint of the required members, in lexicographic order.
  const kid = b64url(createHash("sha256").update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x })).digest());
  const sealKey = Buffer.from(hkdfSync("sha256", seed, Buffer.from(kid), Buffer.from(SEAL_INFO), 32));
  return { kid, privateKey, publicKey, sealKey };
}

/** Generates a fresh seed, base64url. For tests and for provisioning a new key. */
export function generateSigningSeed() {
  return b64url(randomBytes(32));
}

/**
 * Parses MCP_TOKEN_SIGNING_KEYS. Returns { keys, ephemeral }, keys[0] signs.
 * A malformed entry throws: a typo in a signing key must stop the boot, not
 * silently fall back to a per-process key.
 */
export function resolveSigningKeys(env = process.env) {
  const entries = String(env.MCP_TOKEN_SIGNING_KEYS || "").split(/[\s,]+/).filter(Boolean);
  if (entries.length === 0) return { keys: [keyFromSeed(randomBytes(32))], ephemeral: true };
  const keys = entries.map((e, i) => {
    try {
      return keyFromSeed(fromB64url(e));
    } catch {
      throw new Error(`MCP_TOKEN_SIGNING_KEYS entry ${i + 1} is not a base64url 32-byte Ed25519 seed`);
    }
  });
  return { keys, ephemeral: false };
}

function seal(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.sealKey, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return b64url(Buffer.concat([iv, ct, cipher.getAuthTag()]));
}

function unseal(key, sealed) {
  const raw = fromB64url(sealed);
  if (raw.length < 12 + 16 + 1) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.sealKey, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * The token service. `issuers` and `audiences` are every value this server
 * accepts (its own host and its aliases); a token issued on one is valid on all.
 */
export function createTokenService({ keys, issuers, audiences, now = () => Date.now() }) {
  if (!keys?.length) throw new Error("createTokenService needs at least one key");
  const byKid = new Map(keys.map((k) => [k.kid, k]));
  const issuerSet = new Set(issuers);
  const audienceSet = new Set(audiences);
  const nowS = () => Math.floor(now() / 1000);

  return {
    /** The kid that signs new tokens (safe to log). */
    signingKid: keys[0].kid,

    /**
     * Issue an access token. `grant` is the account credential, sealed into
     * the token. Returns { token, expiresIn }.
     */
    issue({ iss, aud, sub, clientId, grant, ttlSeconds, family }) {
      const key = keys[0];
      const iat = nowS();
      const header = { alg: "EdDSA", typ: TOKEN_TYP, kid: key.kid };
      const claims = {
        iss,
        aud,
        sub: String(sub),
        client_id: String(clientId || ""),
        scope: "cloudgrid",
        iat,
        exp: iat + ttlSeconds,
        jti: randomUUID(),
        grt: seal(key, grant),
        ...(family ? { fam: family } : {}),
      };
      const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
      const sig = edSign(null, Buffer.from(input), key.privateKey);
      return { token: `${input}.${b64url(sig)}`, expiresIn: ttlSeconds };
    },

    /**
     * Verify a presented token. Returns { ok: true, claims, grant } or
     * { ok: false, reason }, where reason is one of: not_ours, malformed,
     * unknown_key, bad_signature, wrong_type, wrong_audience, wrong_issuer,
     * expired, not_yet_valid, no_subject, bad_grant. `not_ours` means the
     * value is not an EdDSA JWT at all (for example a platform session JWT).
     */
    verify(token) {
      const parts = String(token || "").split(".");
      if (parts.length !== 3) return { ok: false, reason: "not_ours" };
      let header;
      let claims;
      try {
        header = JSON.parse(fromB64url(parts[0]).toString("utf8"));
      } catch {
        return { ok: false, reason: "not_ours" };
      }
      if (!header || header.alg !== "EdDSA") return { ok: false, reason: "not_ours" };
      const key = byKid.get(header.kid);
      if (!key) return { ok: false, reason: "unknown_key" };
      const ok = edVerify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key.publicKey, fromB64url(parts[2]));
      if (!ok) return { ok: false, reason: "bad_signature" };
      if (header.typ !== TOKEN_TYP) return { ok: false, reason: "wrong_type" };
      try {
        claims = JSON.parse(fromB64url(parts[1]).toString("utf8"));
      } catch {
        return { ok: false, reason: "malformed" };
      }
      if (!claims || typeof claims !== "object") return { ok: false, reason: "malformed" };
      if (!audienceSet.has(claims.aud)) return { ok: false, reason: "wrong_audience" };
      if (!issuerSet.has(claims.iss)) return { ok: false, reason: "wrong_issuer" };
      const t = nowS();
      if (typeof claims.exp !== "number" || claims.exp <= t) return { ok: false, reason: "expired" };
      if (typeof claims.iat !== "number" || claims.iat > t + IAT_SKEW_S) return { ok: false, reason: "not_yet_valid" };
      if (typeof claims.sub !== "string" || claims.sub === "") return { ok: false, reason: "no_subject" };
      const grant = typeof claims.grt === "string" ? unseal(key, claims.grt) : null;
      if (!grant) return { ok: false, reason: "bad_grant" };
      return { ok: true, claims, grant };
    },

    /** Seal / unseal with the signing key, for state kept outside a token. */
    seal(value) {
      return `${keys[0].kid}.${seal(keys[0], value)}`;
    },
    unseal(sealed) {
      const i = String(sealed || "").indexOf(".");
      if (i < 0) return null;
      const key = byKid.get(sealed.slice(0, i));
      return key ? unseal(key, sealed.slice(i + 1)) : null;
    },
  };
}
