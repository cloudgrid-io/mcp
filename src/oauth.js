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
// No new identity provider. Client REGISTRATIONS are stateless (a signed,
// self-describing client_id — durable across restarts and replicas, see #3060);
// only the short-lived authorize sessions and auth codes are in-memory.

import { randomUUID, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { newLoginCode, buildLoginUrl, pollStatusOnce, decodeJwt } from "./auth.js";

const CODE_TTL_MS = 5 * 60 * 1000; // authorize sessions + auth codes live 5 minutes

// In-memory stores for the SHORT-LIVED, single-flight halves of the flow. These
// are 5-minute, retry-on-failure sessions: losing them to a restart just means
// the user clicks "sign in" again, never that they must re-add the connector.
// Client REGISTRATIONS are NOT here — they are stateless (see below, #3060).
const authSessions = new Map(); // sid -> { cgCode, client_id, redirect_uri, state, code_challenge, created }
const authCodes = new Map(); // code -> { jwt, client_id, redirect_uri, code_challenge, created }

function sweep(map) {
  const now = Date.now();
  for (const [k, v] of map) if (now - v.created > CODE_TTL_MS) map.delete(k);
}

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// --- Stateless client registration (#3060) -----------------------------------
// A `client_id` is a signed token that CARRIES its own redirect-URI set, not a
// random handle into a process-local Map. Registration signs the (sorted,
// deduped) set under a server secret; /oauth/authorize verifies by recomputing
// the HMAC and checking `redirect_uri` against the signed set. This makes
// registration durable across restarts, deploys, and ANY replica count with no
// datastore, and removes the old unbounded-growth `clients` Map entirely.
//
// PKCE and redirect validation are untouched — if anything stricter: the
// redirect set is now cryptographically bound into the client_id, so a tampered
// client_id fails the HMAC and is rejected.
//
// SECRET: MCP_OAUTH_HMAC_SECRET, read from env, sourced from a Kubernetes Secret
// (NEVER a ConfigMap), never logged. It is a whitespace/comma-separated list:
// the FIRST entry signs, ALL entries verify.
//
// ROTATION (rolling-update safe — order matters). Do NOT simply prepend the new
// secret: during a rollout, new pods would sign under a key the not-yet-updated
// old pods cannot verify, so authorize returns transient 400s. Instead:
//   1. APPEND the new secret (last position = verify-only) and deploy. Every pod
//      now VERIFIES both keys; all pods still SIGN under the old first entry.
//   2. Once the rollout is complete, PROMOTE the new secret to first position
//      (the signing slot) and deploy. New client_ids are signed under it; the
//      old key still verifies outstanding ones.
//   3. Later, DROP the old key. client_ids minted under it stop verifying and
//      those users re-add the connector ONCE — the deliberate-rotation cost,
//      versus today's every-deploy breakage.
// An attacker who obtains the secret can forge a client_id for an arbitrary
// redirect set — but /oauth/register already mints one for any redirect set
// unauthenticated, so the secret gates INTEGRITY, not registration; PKCE +
// CloudGrid sign-in still gate getting a token.
const CLIENT_ID_PREFIX = "cg1"; // versioned so the scheme can evolve

// A client_id CARRIES its redirect set and travels in a query string, so the set
// must stay bounded or the token grows without limit. Caps chosen well above any
// real client (ChatGPT/Claude register one or two URIs).
const MAX_REDIRECT_URIS = 10;
const MAX_REDIRECT_URIS_BYTES = 4096;
// A configured signing key shorter than this is weak for an HMAC secret; we warn
// but still accept it — any configured key beats the ephemeral fallback (#3060).
const MIN_SECRET_LENGTH = 32;

function resolveClientSecrets(env = process.env) {
  const configured = (env.MCP_OAUTH_HMAC_SECRET || "").split(/[\s,]+/).filter(Boolean);
  if (configured.length > 0) return { secrets: configured, ephemeral: false };
  // No configured secret: a per-process ephemeral one. The flow works within a
  // single process, but registrations do NOT survive a restart — i.e. #3060 is
  // unfixed. Production MUST set the secret; the boot log states which mode is
  // active so a deploy can be verified.
  return { secrets: [randomBytes(32).toString("hex")], ephemeral: true };
}

// Canonical form the signature covers: sorted + deduped, as JSON.
function canonicalRedirectUris(uris) {
  return JSON.stringify([...new Set(uris.map((u) => String(u)))].sort());
}

function signClientId(canonical, secret) {
  const payload = b64url(Buffer.from(canonical, "utf8"));
  const signingInput = `${CLIENT_ID_PREFIX}.${payload}`;
  const sig = b64url(createHmac("sha256", secret).update(signingInput).digest());
  return `${signingInput}.${sig}`;
}

// Verify a client_id against any accepted secret; returns { redirect_uris } or null.
function verifyClientId(clientId, secrets) {
  const parts = String(clientId).split(".");
  if (parts.length !== 3 || parts[0] !== CLIENT_ID_PREFIX) return null;
  const [, payload, sig] = parts;
  const signingInput = `${CLIENT_ID_PREFIX}.${payload}`;
  const given = Buffer.from(sig);
  let ok = false;
  for (const secret of secrets) {
    const expected = Buffer.from(b64url(createHmac("sha256", secret).update(signingInput).digest()));
    if (expected.length === given.length && timingSafeEqual(expected, given)) {
      ok = true;
      break;
    }
  }
  if (!ok) return null;
  try {
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const uris = JSON.parse(json);
    return Array.isArray(uris) ? { redirect_uris: uris } : null;
  } catch {
    return null;
  }
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
<link rel="icon" type="image/png" href="/favicon.png">
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
 * opts.requireAuth — when false the OAuth discovery and registration routes are
 *   not mounted (anonymous-first host has no use for them).
 */
export function mountOAuth(app, publicBase, opts = {}) {
  if (!opts.requireAuth) return;
  const base = publicBase.replace(/\/+$/, "");

  // Resolve the client-registration signing secret(s) once at mount. Log which
  // mode is active — durable vs. ephemeral — so a production deploy can be
  // verified from the boot log without ever printing the secret itself.
  const clientSecrets = resolveClientSecrets();
  if (clientSecrets.ephemeral) {
    console.warn(
      "[oauth] MCP_OAUTH_HMAC_SECRET is NOT set — OAuth client registrations use a per-process " +
        "ephemeral secret (see #3060). This is NOT just a survives-restart issue: with more than " +
        "one replica, each process mints under its own key, so a client_id registered on one " +
        "replica fails on another — authorize breaks intermittently, per request, with no restart " +
        "involved, which diagnoses as an unrelated bug. Set the secret in production.",
    );
  } else {
    const weak = clientSecrets.secrets.filter((s) => s.length < MIN_SECRET_LENGTH).length;
    if (weak > 0) {
      console.warn(
        `[oauth] MCP_OAUTH_HMAC_SECRET has ${weak} key(s) shorter than ${MIN_SECRET_LENGTH} chars — ` +
          "weak for an HMAC signing key; use a long random value (e.g. `openssl rand -hex 32`). " +
          "Accepted anyway (still better than the ephemeral fallback).",
      );
    }
    console.log(
      `[oauth] client-registration secret configured (${clientSecrets.secrets.length} key(s)); ` +
        "registrations are durable across restarts and replicas.",
    );
  }

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

  // RFC 8414. Both the root form and the path-inserted form: the MCP
  // authorization spec has clients derive the metadata URL from the RESOURCE
  // url (…/mcp), so a client that tries `/.well-known/oauth-authorization-server/mcp`
  // first must not get a 404 HTML page. The protected-resource document above
  // already served both forms; this one served only the root, and the asymmetry
  // was an oversight rather than a decision.
  const serveAsMetadata = (_req, res) => {
    corsOk(res);
    res.json(asMetadata);
  };
  app.get("/.well-known/oauth-authorization-server", serveAsMetadata);
  app.get("/.well-known/oauth-authorization-server/mcp", serveAsMetadata);

  // RFC 7591 — dynamic client registration. Public clients, PKCE-only.
  app.post("/oauth/register", (req, res) => {
    corsOk(res);
    const redirectUris = Array.isArray(req.body?.redirect_uris) ? req.body.redirect_uris : [];
    if (redirectUris.length === 0) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris is required." });
      return;
    }
    if (redirectUris.length > MAX_REDIRECT_URIS) {
      res.status(400).json({
        error: "invalid_client_metadata",
        error_description: `At most ${MAX_REDIRECT_URIS} redirect_uris are allowed.`,
      });
      return;
    }
    const canonical = canonicalRedirectUris(redirectUris);
    if (Buffer.byteLength(canonical, "utf8") > MAX_REDIRECT_URIS_BYTES) {
      res.status(400).json({
        error: "invalid_client_metadata",
        error_description: `redirect_uris exceed the ${MAX_REDIRECT_URIS_BYTES}-byte limit.`,
      });
      return;
    }
    const clientId = signClientId(canonical, clientSecrets.secrets[0]);
    res.status(201).json({
      client_id: clientId,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      redirect_uris: JSON.parse(canonical),
    });
  });

  // Authorization endpoint — render the bridge interstitial.
  app.get("/oauth/authorize", (req, res) => {
    sweep(authSessions);
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query;
    const client = verifyClientId(client_id, clientSecrets.secrets);
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
      // The sign-in half succeeded. Without this line a connector failure gives
      // no way to tell whether the user ever got through sign-in at all.
      console.error("[oauth] authorization code issued after sign-in; awaiting token exchange");
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
  //
  // WHY THIS BRANCHES INSTEAD OF ONE COMBINED `if`
  //
  // Reported 2026-08-30: ChatGPT web fails with "Something went wrong with
  // setting up the connection" AFTER the user signs in, which puts the failure
  // in this handler. It could not be diagnosed from either side, because five
  // unrelated causes all produced a byte-identical `{"error":"invalid_grant"}`:
  //
  //   unknown/expired code · code already exchanged · client_id absent
  //   · client_id mismatched · redirect_uri mismatched (a trailing slash does it)
  //
  // All five were reproduced against this handler (test/oauth-token-exchange).
  // Nothing was logged, so the server could not say which happened either — the
  // failure was invisible from both ends at once. That is the actual defect
  // being fixed here: not the rejection, which is correct in every one of those
  // cases, but that a rejection carried no information.
  //
  // The reason is logged server-side and returned as `error_description`. The
  // caller already holds the code, the client_id and the redirect_uri it sent,
  // so naming which of ITS OWN values did not match tells it nothing it did not
  // already know. The token, the verifier and the code are never logged.
  //
  // THE TRADE, NAMED (so nobody extends this pattern by accident): branching
  // these messages does hand a holder of an EXFILTRATED code a small oracle —
  // they can confirm the code is live and probe client_id / redirect_uri
  // without spending a PKCE guess. Accepted here because the code is
  // single-use, dies in 5 minutes, and PKCE still gates the token, so the
  // oracle reveals only values the attacker would have to have already; and
  // RFC 6749 §5.2 explicitly provides error_description for this purpose. That
  // reasoning is specific to this endpoint. Do NOT copy the pattern somewhere
  // a failed attempt is cheap to repeat or the compared value is a secret.
  const denyToken = (res, error, reason, detail = "") => {
    console.error(`[oauth] token exchange refused: ${reason}${detail ? ` ${detail}` : ""}`);
    res.status(400).json({ error, error_description: reason });
  };

  app.post("/oauth/token", (req, res) => {
    corsOk(res);
    sweep(authCodes);
    const { grant_type, code, code_verifier, redirect_uri, client_id } = req.body ?? {};
    if (grant_type !== "authorization_code") {
      denyToken(res, "unsupported_grant_type", "grant_type must be authorization_code", `(got ${JSON.stringify(grant_type ?? null)})`);
      return;
    }
    const codeKey = String(code);
    const rec = authCodes.get(codeKey);
    if (!rec) {
      // Also the retry case: codes are single-use, so a second exchange of a
      // code that already succeeded lands here.
      denyToken(res, "invalid_grant", "authorization code is unknown, expired or already exchanged");
      return;
    }
    authCodes.delete(codeKey); // single use — consume before validation so a failed attempt cannot be retried
    if (rec.client_id !== String(client_id)) {
      denyToken(
        res,
        "invalid_grant",
        client_id === undefined ? "client_id is required at the token endpoint" : "client_id does not match the one the code was issued to",
      );
      return;
    }
    if (rec.redirect_uri !== String(redirect_uri)) {
      // The exact strings, because the difference is usually invisible —
      // a trailing slash, a case change, an added query parameter.
      denyToken(res, "invalid_grant", "redirect_uri does not match the authorize request", `(sent ${JSON.stringify(redirect_uri ?? null)}, expected ${JSON.stringify(rec.redirect_uri)})`);
      return;
    }
    const challenge = b64url(createHash("sha256").update(String(code_verifier ?? "")).digest());
    if (challenge !== rec.code_challenge) {
      denyToken(res, "invalid_grant", code_verifier === undefined ? "code_verifier is required (PKCE)" : "PKCE verification failed");
      return;
    }
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
