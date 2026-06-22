// MCP transport-level OAuth for the web edition.
//
// Implements the OAuth 2.1 surface the MCP authorization spec expects — metadata
// discovery (RFC 8414 + RFC 9728), dynamic client registration (RFC 7591), and the
// authorization-code flow with PKCE — as a thin BRIDGE over CloudGrid's existing
// sign-in: /oauth/authorize shows an interstitial, the user completes the normal
// api.cloudgrid.io/auth/login flow in a new tab, we poll /auth/status server-side,
// then redirect back to the client with an authorization code. /oauth/token
// exchanges it (PKCE-verified) for the CloudGrid JWT as the access token.
//
// No new identity provider. State is in-memory (single replica, like sessions).

import { randomUUID, createHash } from "node:crypto";
import { newLoginCode, buildLoginUrl, pollStatusOnce, decodeJwt } from "./auth.js";

const CODE_TTL_MS = 5 * 60 * 1000; // authorize sessions + auth codes live 5 minutes

// In-memory stores. { [id]: record } with created timestamps for TTL sweeps.
const clients = new Map(); // client_id -> { redirect_uris }
const authSessions = new Map(); // sid -> { cgCode, client_id, redirect_uri, state, code_challenge, created }
const authCodes = new Map(); // code -> { jwt, client_id, redirect_uri, code_challenge, created }

function sweep(map) {
  const now = Date.now();
  for (const [k, v] of map) if (now - v.created > CODE_TTL_MS) map.delete(k);
}

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function corsOk(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-protocol-version");
}

// The §23-voice interstitial. Opens the CloudGrid sign-in in a new tab and polls
// until it completes, then returns the browser to the client app.
function interstitialHtml(sid, loginUrl) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect CloudGrid</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font-family: Inter, system-ui, sans-serif; background:#0d0d0f; color:#fafafa; }
  main { max-width:420px; padding:2.5rem; text-align:center; }
  a.btn { display:inline-block; margin-top:1.25rem; padding:.75rem 1.5rem; border-radius:8px;
          background:#fafafa; color:#0d0d0f; text-decoration:none; font-weight:600; }
  p.status { margin-top:1.5rem; font-size:.9rem; opacity:.7; }
</style></head>
<body><main>
  <h1>Connect CloudGrid</h1>
  <p>Sign in with your CloudGrid account. This page returns to the app when you finish.</p>
  <a class="btn" href="${loginUrl}" target="_blank" rel="noopener">Sign in to CloudGrid</a>
  <p class="status" id="st">Waiting for sign-in.</p>
</main>
<script>
  async function tick() {
    try {
      const r = await fetch("/oauth/authorize/poll?sid=${sid}");
      const d = await r.json();
      if (d.status === "ready") { location.href = d.redirect; return; }
      if (d.status === "expired") { document.getElementById("st").textContent = "The sign-in window expired. Close this page and connect again."; return; }
    } catch {}
    setTimeout(tick, 2000);
  }
  tick();
</script></body></html>`;
}

/**
 * Mounts the OAuth surface on an express app.
 * publicBase = this server's public origin (e.g. https://mcp.cloudgrid.io).
 */
export function mountOAuth(app, publicBase) {
  const base = publicBase.replace(/\/+$/, "");

  const asMetadata = {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["cloudgrid"],
  };

  app.options(/^\/(\.well-known|oauth)\/.*/, (_req, res) => {
    corsOk(res);
    res.status(204).end();
  });

  // RFC 9728 — the resource points at its authorization server (us).
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    corsOk(res);
    res.json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["cloudgrid"] });
  });
  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    corsOk(res);
    res.json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["cloudgrid"] });
  });

  // RFC 8414.
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    corsOk(res);
    res.json(asMetadata);
  });

  // RFC 7591 — dynamic client registration. Public clients, PKCE-only.
  app.post("/oauth/register", (req, res) => {
    corsOk(res);
    const redirectUris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris : [];
    if (redirectUris.length === 0) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris is required." });
      return;
    }
    const clientId = randomUUID();
    clients.set(clientId, { redirect_uris: redirectUris, created: Date.now() });
    res.status(201).json({
      client_id: clientId,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      redirect_uris: redirectUris,
    });
  });

  // Authorization endpoint — render the bridge interstitial.
  app.get("/oauth/authorize", (req, res) => {
    sweep(authSessions);
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query;
    const client = clients.get(String(client_id));
    if (!client || !client.redirect_uris.includes(String(redirect_uri))) {
      res.status(400).send("Unknown client or redirect_uri. Re-add the connector and try again.");
      return;
    }
    if (response_type !== "code" || code_challenge_method !== "S256" || !code_challenge) {
      res.status(400).send("This server requires response_type=code with PKCE (S256).");
      return;
    }
    const sid = randomUUID();
    const cgCode = newLoginCode();
    authSessions.set(sid, {
      cgCode,
      client_id: String(client_id),
      redirect_uri: String(redirect_uri),
      state: state ? String(state) : "",
      code_challenge: String(code_challenge),
      created: Date.now(),
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(interstitialHtml(sid, buildLoginUrl(cgCode)));
  });

  // The interstitial's poll — bridges to CloudGrid /auth/status.
  app.get("/oauth/authorize/poll", async (req, res) => {
    corsOk(res);
    const sess = authSessions.get(String(req.query.sid));
    if (!sess || Date.now() - sess.created > CODE_TTL_MS) {
      res.json({ status: "expired" });
      return;
    }
    let upstream;
    try {
      upstream = await pollStatusOnce(sess.cgCode);
    } catch {
      res.json({ status: "pending" });
      return;
    }
    if (upstream.status === "authenticated" && upstream.jwt) {
      const code = b64url(Buffer.from(randomUUID()));
      authCodes.set(code, {
        jwt: upstream.jwt,
        client_id: sess.client_id,
        redirect_uri: sess.redirect_uri,
        code_challenge: sess.code_challenge,
        created: Date.now(),
      });
      authSessions.delete(String(req.query.sid));
      const sep = sess.redirect_uri.includes("?") ? "&" : "?";
      const redirect = `${sess.redirect_uri}${sep}code=${encodeURIComponent(code)}${sess.state ? `&state=${encodeURIComponent(sess.state)}` : ""}`;
      res.json({ status: "ready", redirect });
      return;
    }
    if (upstream.status === "expired") {
      res.json({ status: "expired" });
      return;
    }
    res.json({ status: "pending" });
  });

  // Token endpoint — PKCE-verified exchange; the CloudGrid JWT is the access token.
  app.post("/oauth/token", (req, res) => {
    corsOk(res);
    sweep(authCodes);
    const { grant_type, code, code_verifier, redirect_uri, client_id } = req.body ?? {};
    if (grant_type !== "authorization_code") {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }
    const rec = authCodes.get(String(code));
    if (!rec || rec.client_id !== String(client_id) || rec.redirect_uri !== String(redirect_uri)) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }
    const challenge = b64url(createHash("sha256").update(String(code_verifier ?? "")).digest());
    if (challenge !== rec.code_challenge) {
      res.status(400).json({ error: "invalid_grant", error_description: "PKCE verification failed." });
      return;
    }
    authCodes.delete(String(code)); // single use
    const claims = decodeJwt(rec.jwt);
    const expiresIn = claims.exp ? Math.max(60, claims.exp - Math.floor(Date.now() / 1000)) : 30 * 86400;
    res.json({ access_token: rec.jwt, token_type: "Bearer", expires_in: expiresIn, scope: "cloudgrid" });
  });
}

/** The WWW-Authenticate challenge for 401s when auth is required. */
export function bearerChallenge(publicBase) {
  const base = publicBase.replace(/\/+$/, "");
  return `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`;
}
