// Test helper: throwaway signing keys and access tokens for the web edition.
// A test passes TEST_SIGNING_SEED to its web child as MCP_TOKEN_SIGNING_KEYS and
// mints tokens for that child's base URL with mcpToken(). The sealed account
// credential is a fake, unsigned JWT: the tests' upstream stubs never verify it.

import { createTokenService, generateSigningSeed, resolveSigningKeys } from "../../src/mcp-tokens.js";

export const TEST_SIGNING_SEED = generateSigningSeed();

export function fakePlatformJwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

export function mcpToken(baseUrl, { sub, email, ttlSeconds = 3600, seed = TEST_SIGNING_SEED }) {
  const base = String(baseUrl).replace(/\/+$/, "");
  const svc = createTokenService({
    keys: resolveSigningKeys({ MCP_TOKEN_SIGNING_KEYS: seed }).keys,
    issuers: [base],
    audiences: [`${base}/mcp`],
  });
  const now = Math.floor(Date.now() / 1000);
  const grant = fakePlatformJwt({ sub, email, iat: now, exp: now + 30 * 86400 });
  return svc.issue({ iss: base, aud: `${base}/mcp`, sub, clientId: "test", grant, ttlSeconds }).token;
}
