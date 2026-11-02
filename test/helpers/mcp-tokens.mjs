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

// A stand-in CloudGrid API that accepts every session (GET /api/v2/users/me
// answers 200 with the token's sub), for tests about something other than
// sign-out. Returns { base, close }.
export async function startAcceptingApi() {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    const bearer = String(req.headers.authorization || "").replace(/^Bearer /, "");
    let sub = null;
    try { sub = JSON.parse(Buffer.from(bearer.split(".")[1], "base64url").toString()).sub; } catch { /* not a JWT */ }
    if (req.url === "/api/v2/users/me" && sub) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ user_id: sub }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
