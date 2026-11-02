// MCP transport-level OAuth for the web edition.
//
// Implements the OAuth 2.1 surface the MCP authorization spec expects — metadata
// discovery (RFC 8414 + RFC 9728), dynamic client registration (RFC 7591), and the
// authorization-code flow with PKCE — as a thin BRIDGE over CloudGrid's existing
// sign-in: /oauth/authorize shows an interstitial, the user completes the normal
// api.cloudgrid.io/auth/login flow in a new tab, we poll /auth/status server-side,
// then redirect back to the client with an authorization code. /oauth/token
// exchanges it (PKCE-verified) for an access token this server signs for itself
// (src/mcp-tokens.js). The CloudGrid session the sign-in produced stays on the
// server side, sealed inside that token; it is never returned to the client.
//
// Mounted on every host. One server can answer for several public origins (its
// own and its aliases, e.g. mcp.cloudgrid.io and mcp-connected.cloudgrid.io):
// each request is answered for the origin it arrived on, and a token issued on
// any of them is accepted on all.
//
// No new identity provider. Client REGISTRATIONS are stateless (a signed,
// self-describing client_id — durable across restarts and replicas, see #3060);
// only the short-lived authorize sessions and auth codes are in-memory.

import { randomUUID, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { newLoginCode, buildLoginUrl, pollStatusOnce, decodeJwt } from "./auth.js";
import { AUTH_SCOPE } from "./web-auth.js";

const CODE_TTL_MS = 5 * 60 * 1000; // authorize sessions + auth codes live 5 minutes

// In-memory stores for the SHORT-LIVED, single-flight halves of the flow. These
// are 5-minute, retry-on-failure sessions: losing them to a restart just means
// the user clicks "sign in" again, never that they must re-add the connector.
// Client REGISTRATIONS are NOT here — they are stateless (see below, #3060).
const authSessions = new Map(); // sid -> { cgCode, client_id, redirect_uri, state, code_challenge, resource, created }
const authCodes = new Map(); // code -> { grant, client_id, redirect_uri, code_challenge, resource, created }

function sweep(map) {
  const now = Date.now();
  for (const [k, v] of map) if (now - v.created > CODE_TTL_MS) map.delete(k);
}

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Observability helpers (#345). The OAuth flow was only observable on the paths
// it did NOT take — a refused token exchange logs (denyToken), but a successful
// one and the authorize arrival logged nothing, so "no log line" meant both
// "never happened" and "worked fine". These emit SHAPE and PRESENCE, never
// values: this is an auth path and a log aggregator is not private. See the
// issue's redaction list — code, verifier, code_challenge value, JWT, secret,
// the full client_id, and the full redirect_uri all stay out of the log.

// A ~12-char prefix correlates lines without printing the signed client_id,
// which embeds the redirect set.
function clientIdPrefix(clientId) {
  return clientId ? `${String(clientId).slice(0, 12)}…` : "absent";
}

// The HOST is the diagnostic value; the path can carry a per-install identifier,
// so it is dropped.
function hostOf(uri) {
  if (!uri) return "absent";
  try {
    return new URL(String(uri)).host;
  } catch {
    return "invalid";
  }
}

// --- RFC 8707 Resource Indicators (#329) --------------------------------------
// The MCP 2025-06-18 authorization spec has clients send `resource` — the
// canonical URI of the MCP server the token is for — on BOTH the authorize and
// token requests. We accept it, validate it against this server's own resource
// identifier (the `${base}/mcp` value /.well-known/oauth-protected-resource
// returns), and bind it to the code. A mismatch is `invalid_target` (RFC 8707
// §2). A MISSING resource stays acceptable: Claude web / Claude Code work today
// and may not send it, and the spec is explicit that clients "MUST send this
// parameter regardless of whether authorization servers support it" — i.e. the
// server may still honour requests without it.
//
// Comparison is on the CANONICAL form, not a raw string, so a cosmetically
// different but equivalent URI (uppercase scheme/host, a trailing slash, a
// default port) is not falsely rejected. Per the spec: lowercase scheme and
// host (URL parsing does this), no fragment, and the trailing-slash-free path.
// The QUERY STRING is also dropped by construction (we rebuild from protocol +
// host + path only), so `…/mcp?x=1` compares EQUAL to `…/mcp`. That is the
// permissive direction and fine here — our resource identifier carries no
// query — but it is stated because nobody would predict it from the code.
// Returns null for anything that is not an absolute URI — that then fails the
// equality check as a mismatch.
function normalizeResource(uri) {
  try {
    const u = new URL(String(uri));
    if (!u.host) return null;
    const path = u.pathname.replace(/\/+$/, ""); // …/mcp/ ≡ …/mcp
    return `${u.protocol}//${u.host}${path}`; // protocol + host are already lowercased & default-port-stripped
  } catch {
    return null;
  }
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
// Whoever holds the secret can forge a client_id for an arbitrary redirect set,
// so /oauth/authorize re-applies the redirect URI rules to every client_id it
// verifies rather than trusting the signed set alone; PKCE + CloudGrid sign-in
// still gate getting a token.
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

// The signed payload. Without a client_name it is the bare redirect array — the
// original format, so every client_id minted before client_name was carried
// still verifies unchanged. With one, it is { redirect_uris, client_name }.
function signedPayload(canonical, clientName) {
  if (!clientName) return canonical;
  return JSON.stringify({ redirect_uris: JSON.parse(canonical), client_name: clientName });
}

// A registered client_name is shown on the consent step, so it is bounded and
// stripped of control characters. It is self-asserted by the client: the consent
// step shows the redirect HOST alongside it, and the host is what the user can
// actually check.
const MAX_CLIENT_NAME_LENGTH = 80;
function cleanClientName(name) {
  if (typeof name !== "string") return "";
  return name.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_CLIENT_NAME_LENGTH);
}

// --- Redirect URI rules -------------------------------------------------------
// A redirect URI must be `https:`, or `http:` on a loopback address (local
// clients run a callback listener on 127.0.0.1 / [::1] / localhost). Anything
// else — other schemes, http to a non-loopback host, a fragment (RFC 6749
// §3.1.2), embedded credentials — is refused. Enforced at registration
// (invalid_redirect_uri, RFC 7591 §3.2.2) and again at authorize, so a client_id
// minted before these rules cannot be used with a URI that breaks them.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

// Returns null when the URI is acceptable, else a reason for error_description.
export function redirectUriProblem(uri) {
  if (typeof uri !== "string" || uri === "") return "redirect_uri must be a non-empty string.";
  let u;
  try {
    u = new URL(uri);
  } catch {
    return "redirect_uri must be an absolute URI.";
  }
  if (uri.includes("#")) return "redirect_uri must not contain a fragment.";
  if (u.username || u.password) return "redirect_uri must not contain user credentials.";
  if (u.protocol === "https:" && u.hostname) return null;
  if (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname)) return null;
  return "redirect_uri must use https, or http on a loopback address (127.0.0.1, [::1], localhost).";
}

function isHttpUrl(uri) {
  try {
    const { protocol } = new URL(String(uri));
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

// --- Who the consent page names (#5785) ----------------------------------------
// A registered client_name is self-asserted. It is shown only when the redirect
// host is one of the AI tools that use this server, or loopback (a local
// client); for any other host the page says "An application at <host>".
const KNOWN_CLIENT_HOSTS = new Set(["claude.ai", "claude.com", "chatgpt.com"]);
export function shownClientName(clientName, redirectUri) {
  if (!clientName) return "";
  try {
    const host = new URL(String(redirectUri)).hostname.toLowerCase();
    return KNOWN_CLIENT_HOSTS.has(host) || LOOPBACK_HOSTS.has(host) ? clientName : "";
  } catch {
    return "";
  }
}

// --- Same-browser completion (#5785) ---------------------------------------------
// The sign-in opens in a new tab of the browser that opened /oauth/authorize. On
// completion the CloudGrid API sets that browser's `cloudgrid_session` cookie to
// the same session it returns from /auth/status. The poll completes only when
//   1. it carries this server's own binding cookie for the authorize session, and
//   2. its `cloudgrid_session` equals the session /auth/status returned.
// A sign-in finished in another browser (a forwarded link) therefore cannot
// complete the flow. A browser already signed in to CloudGrid skips the sign-in
// and approves with one click (POST /oauth/authorize/approve).
const SESSION_COOKIE = "cloudgrid_session";
// How long the poll waits for the cookie after the sign-in completed before it
// says the sign-in was finished elsewhere.
const OTHER_BROWSER_GRACE_MS = 15_000;
// The poll reaches the API at most once a second per authorize session.
const POLL_MIN_INTERVAL_MS = 1_000;

// Host-only, and `__Host-` on https so a cookie set elsewhere on the domain
// cannot stand in for it.
function bindCookieName(base) {
  return String(base).startsWith("https:") ? "__Host-cg_mcp_authorize" : "cg_mcp_authorize";
}

// Every value the browser sent for `name` (a tenant on the shared domain can
// plant a second cookie of the same name), decoded on read. A value that does
// not decode is skipped, so a cookie planted to break parsing cannot turn the
// sign-in pages into a 500.
function cookieValues(req, name) {
  const out = [];
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0 || part.slice(0, i).trim() !== name) continue;
    try {
      out.push(decodeURIComponent(part.slice(i + 1).trim()));
    } catch {
      /* skipped */
    }
  }
  return out;
}

function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

function signClientId(canonical, secret) {
  const payload = b64url(Buffer.from(canonical, "utf8"));
  const signingInput = `${CLIENT_ID_PREFIX}.${payload}`;
  const sig = b64url(createHmac("sha256", secret).update(signingInput).digest());
  return `${signingInput}.${sig}`;
}

// Verify a client_id against any accepted secret; returns
// { redirect_uris, client_name } or null.
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
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return { redirect_uris: parsed, client_name: "" };
    if (parsed && Array.isArray(parsed.redirect_uris)) {
      return { redirect_uris: parsed.redirect_uris, client_name: cleanClientName(parsed.client_name) };
    }
    return null;
  } catch {
    return null;
  }
}

// CORS. The discovery documents are public metadata and stay readable from any
// origin. The registration, token and poll endpoints answer a browser only when
// its Origin is on the allow-list (web-guards.js); the connectors of Claude and
// ChatGPT call them from their servers, where CORS does not apply.
function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-protocol-version");
}

function corsPublic(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  corsHeaders(res);
}

function corsAllowListed(req, res, isOriginAllowed) {
  res.setHeader("Vary", "Origin");
  const origin = req.headers.origin;
  if (typeof origin === "string" && isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    corsHeaders(res);
  }
}

// HTML-escape for text and attribute positions.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// JSON for embedding inside an inline <script>: `<` and the JS line
// separators are escaped so the value cannot close the script element.
function scriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

// Every OAuth HTML response refuses to be framed, and does not leak its URL
// (which carries client_id and state) as a referrer.
function oauthPageHeaders(res) {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function sendOAuthError(res, message, status = 400) {
  oauthPageHeaders(res);
  res.status(status).type("text/plain; charset=utf-8").send(message);
}

// The §23-voice interstitial. First a consent step naming the client and the
// host the browser returns to; nothing starts until the user continues. Then it
// opens the CloudGrid sign-in in a new tab and polls until it completes, and
// returns the browser to the client app.
function interstitialHtml({ sid, loginUrl, clientName, redirectHost, signedInAs = null, formToken = "" }) {
  const approve = signedInAs
    ? `<p>Signed in to CloudGrid as <strong>${escapeHtml(signedInAs)}</strong>.</p>
  <form method="post" action="/oauth/authorize/approve">
    <input type="hidden" name="sid" value="${escapeHtml(sid)}">
    <input type="hidden" name="form_token" value="${escapeHtml(formToken)}">
    <button class="btn" type="submit">Allow</button>
  </form>
  <p class="status"><a id="go" href="${escapeHtml(loginUrl)}" target="_blank" rel="noopener noreferrer">Use a different account</a></p>`
    : `<a class="btn" id="go" href="${escapeHtml(loginUrl)}" target="_blank" rel="noopener noreferrer">Continue to sign in</a>`;
  const who = clientName
    ? `<strong>${escapeHtml(clientName)}</strong> (<strong>${escapeHtml(redirectHost)}</strong>)`
    : `An application at <strong>${escapeHtml(redirectHost)}</strong>`;
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Connect CloudGrid</title>
<link rel="icon" type="image/png" href="/favicon.png">
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font-family: Inter, system-ui, sans-serif; background:#0d0d0f; color:#fafafa; }
  main { max-width:420px; padding:2.5rem; text-align:center; }
  p.host { margin-top:1rem; font-size:.95rem; }
  a.btn, button.btn { display:inline-block; margin-top:1.25rem; padding:.75rem 1.5rem; border-radius:8px; border:0;
          background:#fafafa; color:#0d0d0f; text-decoration:none; font-weight:600; font-size:1rem; cursor:pointer; }
  a { color:#fafafa; }
  p.status { margin-top:1.5rem; font-size:.9rem; opacity:.7; }
  [hidden] { display:none !important; }
</style></head>
<body><main>
  <h1>Connect CloudGrid</h1>
  <p id="consent">${who} wants to connect to your CloudGrid account.</p>
  <p class="host">After sign-in you will be returned to <strong>${escapeHtml(redirectHost)}</strong>. If you did not start this, close this page.</p>
  ${approve}
  <p class="status" id="st" hidden>Waiting for sign-in. Finish it in this browser.</p>
</main>
<script>
  const POLL_URL = ${scriptJson(`/oauth/authorize/poll?sid=${sid}`)};
  const st = document.getElementById("st");
  let started = false;
  async function tick() {
    try {
      const r = await fetch(POLL_URL);
      const d = await r.json();
      if (d.status === "ready") {
        let ok = false;
        try { const u = new URL(d.redirect); ok = u.protocol === "https:" || u.protocol === "http:"; } catch {}
        if (ok) { location.href = d.redirect; return; }
        st.textContent = "This connection cannot be completed. Close this page and connect again.";
        return;
      }
      if (d.status === "expired") { st.textContent = "The sign-in window expired. Close this page and connect again."; return; }
      if (d.status === "other_browser") { st.textContent = "This sign-in was finished in a different browser. Close this page, connect again, and finish the sign-in in this browser."; return; }
    } catch {}
    setTimeout(tick, 2000);
  }
  document.getElementById("go").addEventListener("click", () => {
    st.hidden = false;
    if (started) return;
    started = true;
    tick();
  });
</script></body></html>`;
}

/**
 * The public origin a request arrived on: one of `bases` (matched on the Host
 * header), else the first (primary) one. Never a value the client made up.
 */
export function createBaseResolver(bases) {
  const list = bases.map((b) => String(b).replace(/\/+$/, ""));
  const byHost = new Map(list.map((b) => [new URL(b).host.toLowerCase(), b]));
  return (req) => byHost.get(String(req?.headers?.host || "").toLowerCase()) ?? list[0];
}

/**
 * Mounts the OAuth surface on an express app.
 * opts.bases — this server's public origins; the first is the primary one.
 * opts.tokens — the token service (src/mcp-tokens.js) that signs access tokens.
 * opts.accessTokenTtlSeconds — the access token lifetime.
 * opts.refresh — the refresh-token store (src/refresh-store.js), or null: then
 *   no refresh token is issued and the access token is the whole sign-in.
 * opts.isOriginAllowed — the browser Origin allow-list for CORS.
 */
export function mountOAuth(app, opts) {
  const bases = opts.bases.map((b) => String(b).replace(/\/+$/, ""));
  const baseFor = createBaseResolver(bases);
  const tokens = opts.tokens;
  const accessTtl = opts.accessTokenTtlSeconds;
  const refresh = opts.refresh ?? null;
  const isOriginAllowed = opts.isOriginAllowed ?? (() => false);
  const corsOk = (req, res) => corsAllowListed(req, res, isOriginAllowed);
  // Every resource identifier this server answers for, canonical form (#329).
  // A client may name any of them; the token is bound to the one it named.
  const acceptedResources = new Set(bases.map((b) => normalizeResource(`${b}/mcp`)));

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

  const asMetadata = (base) => ({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: refresh ? ["authorization_code", "refresh_token"] : ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [AUTH_SCOPE],
    // RFC 8707 Resource Indicators support (#329). RFC 8707 defines NO
    // authorization-server metadata field of its own, and neither does the MCP
    // spec; the only IANA-registered resource-related AS-metadata field is
    // `protected_resources` (RFC 9728 §4) — a JSON array of the resource
    // identifiers this AS issues tokens for. Advertising ours here lets a client
    // discover the canonical `resource` value to send, and signals that we honour
    // the parameter rather than ignoring it.
    protected_resources: [`${base}/mcp`],
  });

  app.options(/^\/\.well-known\/.*/, (_req, res) => {
    corsPublic(res);
    res.status(204).end();
  });
  app.options(/^\/oauth\/.*/, (req, res) => {
    corsOk(req, res);
    res.status(204).end();
  });

  // RFC 9728 — the resource points at its authorization server (us).
  const serveResourceMetadata = (req, res) => {
    corsPublic(res);
    const base = baseFor(req);
    res.json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: [AUTH_SCOPE] });
  };
  app.get("/.well-known/oauth-protected-resource", serveResourceMetadata);
  app.get("/.well-known/oauth-protected-resource/mcp", serveResourceMetadata);

  // RFC 8414. Both the root form and the path-inserted form: the MCP
  // authorization spec has clients derive the metadata URL from the RESOURCE
  // url (…/mcp), so a client that tries `/.well-known/oauth-authorization-server/mcp`
  // first must not get a 404 HTML page. The protected-resource document above
  // already served both forms; this one served only the root, and the asymmetry
  // was an oversight rather than a decision.
  const serveAsMetadata = (req, res) => {
    corsPublic(res);
    res.json(asMetadata(baseFor(req)));
  };
  app.get("/.well-known/oauth-authorization-server", serveAsMetadata);
  app.get("/.well-known/oauth-authorization-server/mcp", serveAsMetadata);

  // RFC 7591 — dynamic client registration. Public clients, PKCE-only.
  app.post("/oauth/register", (req, res) => {
    corsOk(req, res);
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
    for (const uri of redirectUris) {
      const problem = redirectUriProblem(uri);
      if (problem) {
        res.status(400).json({ error: "invalid_redirect_uri", error_description: problem });
        return;
      }
    }
    const canonical = canonicalRedirectUris(redirectUris);
    if (Buffer.byteLength(canonical, "utf8") > MAX_REDIRECT_URIS_BYTES) {
      res.status(400).json({
        error: "invalid_client_metadata",
        error_description: `redirect_uris exceed the ${MAX_REDIRECT_URIS_BYTES}-byte limit.`,
      });
      return;
    }
    const clientName = cleanClientName(req.body?.client_name);
    const clientId = signClientId(signedPayload(canonical, clientName), clientSecrets.secrets[0]);
    res.status(201).json({
      client_id: clientId,
      ...(clientName ? { client_name: clientName } : {}),
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      redirect_uris: JSON.parse(canonical),
    });
  });

  // Authorization endpoint — render the bridge interstitial.
  app.get("/oauth/authorize", async (req, res) => {
    sweep(authSessions);
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type, resource } = req.query;
    // Observability (#345/#329): the request SHAPE the client actually sent,
    // logged before any check so a rejected request is still visible. Presence,
    // not values — nothing here is reusable in a log aggregator. The resource
    // HOST is included: it is not a secret, and its presence/absence is the exact
    // signal that distinguishes ChatGPT (sends it) from Claude (does not).
    console.error(
      `[oauth] authorize request: client_id=${clientIdPrefix(client_id)} ` +
        `response_type=${response_type ? String(response_type) : "absent"} ` +
        `state=${state ? "present" : "absent"} ` +
        `pkce=${code_challenge ? (code_challenge_method ? String(code_challenge_method) : "present(no-method)") : "absent"} ` +
        `redirect_host=${hostOf(redirect_uri)} ` +
        `resource_host=${hostOf(resource)}`,
    );
    const client = verifyClientId(client_id, clientSecrets.secrets);
    if (!client || !client.redirect_uris.includes(String(redirect_uri))) {
      sendOAuthError(res, "Unknown client or redirect_uri. Re-add the connector and try again.");
      return;
    }
    // Re-checked here, not only at registration: a client_id signed before the
    // redirect rules existed still carries its original set. Rendered, never
    // redirected to.
    if (redirectUriProblem(String(redirect_uri))) {
      console.error(`[oauth] authorize refused: redirect_uri not allowed redirect_host=${hostOf(redirect_uri)}`);
      sendOAuthError(res, "This redirect_uri is not allowed. Re-add the connector and try again.");
      return;
    }
    if (response_type !== "code" || code_challenge_method !== "S256" || !code_challenge) {
      sendOAuthError(res, "This server requires response_type=code with PKCE (S256).");
      return;
    }
    // RFC 8707 (#329): if a `resource` is present it must be THIS server's
    // resource identifier. Compared on the canonical form so an equivalent URI
    // (case, trailing slash, default port) is accepted. A mismatch is
    // invalid_target; a MISSING resource stays acceptable (Claude compatibility).
    // The bound value is the canonical string, so the token endpoint can compare
    // apples to apples later.
    // No `resource` sent: the token is for the resource of the host the
    // client is talking to.
    let boundResource = normalizeResource(`${baseFor(req)}/mcp`);
    if (resource !== undefined && String(resource) !== "") {
      const requested = normalizeResource(resource);
      if (!requested || !acceptedResources.has(requested)) {
        // RFC 6749 §4.1.2.1: the redirect_uri is already verified as registered
        // (the render-path 400 above), so an authorization error is returned by
        // REDIRECTING to it with error= and state=, NOT by rendering an opaque
        // body the client cannot read — RFC 8707 §2 defines invalid_target as
        // exactly such an OAuth error code. This is the whole point of the PR:
        // a spec fix that makes a silent failure legible must not add a new
        // illegible one (an opaque 400 where ChatGPT expects
        // error=invalid_target&state=… would just be another #329-shaped
        // symptom). The two 400s above STAY renders: an unverified client or
        // redirect_uri must NEVER be redirected to, so they are not precedent.
        console.error(
          `[oauth] authorize refused (redirect): invalid_target resource_host=${hostOf(resource)} expected_host=${hostOf(baseFor(req))}`,
        );
        const sep = String(redirect_uri).includes("?") ? "&" : "?";
        let location = `${redirect_uri}${sep}error=invalid_target&error_description=${encodeURIComponent(
          "The requested resource does not identify this server.",
        )}`;
        if (state) location += `&state=${encodeURIComponent(String(state))}`;
        res.redirect(302, location);
        return;
      }
      boundResource = requested;
    }
    const sid = randomUUID();
    const cgCode = newLoginCode();
    const bind = randomBytes(18).toString("base64url");
    const formToken = randomBytes(18).toString("base64url");
    // Already signed in to CloudGrid in this browser: offer one-click Allow.
    // The session is checked with the API, never trusted from the cookie.
    let signedIn = null;
    // The account must be named on the page: no email, no one-click path.
    for (const existing of cookieValues(req, SESSION_COOKIE).slice(0, 3)) {
      if (!opts.validatePlatformToken) break;
      const v = await opts.validatePlatformToken(existing).catch(() => ({ ok: false }));
      if (v.ok && v.email) {
        signedIn = { email: v.email, session: existing };
        break;
      }
    }
    authSessions.set(sid, {
      cgCode,
      bind,
      formToken,
      client_id: String(client_id),
      redirect_uri: String(redirect_uri),
      state: state ? String(state) : "",
      code_challenge: String(code_challenge),
      resource: boundResource,
      created: Date.now(),
    });
    const base = baseFor(req);
    res.cookie?.(bindCookieName(base), `${sid}.${bind}`, {
      httpOnly: true,
      secure: base.startsWith("https:"),
      sameSite: "lax",
      path: "/",
      maxAge: CODE_TTL_MS,
    });
    oauthPageHeaders(res);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(
      interstitialHtml({
        sid,
        loginUrl: buildLoginUrl(cgCode),
        clientName: shownClientName(client.client_name, redirect_uri),
        redirectHost: new URL(String(redirect_uri)).host,
        signedInAs: signedIn?.email ?? null,
        formToken,
      }),
    );
  });

  // The authorize session this browser holds, from its binding cookie.
  function boundSession(req, sid) {
    const sess = authSessions.get(String(sid));
    if (!sess || Date.now() - sess.created > CODE_TTL_MS) return null;
    const want = `${sid}.${sess.bind}`;
    return cookieValues(req, bindCookieName(baseFor(req))).some((c) => sameSecret(c, want)) ? sess : null;
  }

  // Hand an authorization code for this session back to the client.
  function issueCode(sid, sess, grant) {
    const code = b64url(Buffer.from(randomUUID()));
    authCodes.set(code, {
      grant,
      client_id: sess.client_id,
      redirect_uri: sess.redirect_uri,
      code_challenge: sess.code_challenge,
      resource: sess.resource, // RFC 8707 binding carried from the authorize session (#329)
      created: Date.now(),
    });
    authSessions.delete(String(sid));
    // The sign-in half succeeded. Without this line a connector failure gives
    // no way to tell whether the user ever got through sign-in at all.
    console.error("[oauth] authorization code issued after sign-in; awaiting token exchange");
    const sep = sess.redirect_uri.includes("?") ? "&" : "?";
    // Observability (#345): we handed control back to the client, and to
    // where. The host only — the full redirect carries the code and a
    // per-install path.
    console.error(`[oauth] redirect handed back to client; redirect_host=${hostOf(sess.redirect_uri)}`);
    return `${sess.redirect_uri}${sep}code=${encodeURIComponent(code)}${sess.state ? `&state=${encodeURIComponent(sess.state)}` : ""}`;
  }

  // One-click Allow for a browser already signed in to CloudGrid. Same-origin
  // form POST only: the binding cookie, the per-session form token, a
  // same-origin Fetch Metadata / Origin, and a CloudGrid session the API accepts.
  app.post("/oauth/authorize/approve", async (req, res) => {
    const base = baseFor(req);
    const site = req.headers["sec-fetch-site"];
    const origin = req.headers.origin;
    // Both headers are required (the platform cookie policy): current
    // browsers send them on a same-origin form POST.
    if (site !== "same-origin" || origin !== new URL(base).origin) {
      sendOAuthError(res, "This approval must come from the CloudGrid connect page.", 403);
      return;
    }
    const sid = String(req.body?.sid ?? "");
    const sess = boundSession(req, sid);
    if (!sess || !sameSecret(String(req.body?.form_token ?? ""), sess.formToken)) {
      sendOAuthError(res, "This connection request has expired or was opened in another browser. Close this page and connect again.");
      return;
    }
    // The session the approval is for: one the API accepts and names, checked again now.
    let grant = null;
    for (const c of cookieValues(req, SESSION_COOKIE).slice(0, 3)) {
      if (!opts.validatePlatformToken) break;
      const v = await opts.validatePlatformToken(c).catch(() => ({ ok: false }));
      if (v.ok && v.email) {
        grant = c;
        break;
      }
    }
    if (!grant || !isHttpUrl(sess.redirect_uri)) {
      sendOAuthError(res, "You are not signed in to CloudGrid in this browser. Close this page and connect again.");
      return;
    }
    console.error("[oauth] signed-in browser approved the connection");
    res.redirect(302, issueCode(sid, sess, grant));
  });

  // The interstitial's poll — bridges to CloudGrid /auth/status.
  app.get("/oauth/authorize/poll", async (req, res) => {
    corsOk(req, res);
    const sid = String(req.query.sid);
    // Only the browser that opened this authorize session may poll it.
    const sess = boundSession(req, sid);
    if (!sess) {
      res.json({ status: "expired" });
      return;
    }
    // The sign-in result is read from the API once (it hands it out once) and
    // kept here; it is released only to this same browser, below.
    if (!sess.grant) {
      const now = Date.now();
      if (now - (sess.lastPoll ?? 0) < POLL_MIN_INTERVAL_MS) {
        res.json({ status: "pending" });
        return;
      }
      sess.lastPoll = now;
      let upstream;
      try {
        upstream = await pollStatusOnce(sess.cgCode);
      } catch {
        res.json({ status: "pending" });
        return;
      }
      if (upstream.status === "expired") {
        authSessions.delete(sid);
        res.json({ status: "expired" });
        return;
      }
      if (upstream.status !== "authenticated" || !upstream.jwt) {
        res.json({ status: "pending" });
        return;
      }
      sess.grant = upstream.jwt;
      sess.grantAt = now;
    }
    if (!isHttpUrl(sess.redirect_uri)) {
      // Unreachable while authorize enforces the redirect rules; kept so a
      // code is never handed to a non-http(s) target.
      authSessions.delete(sid);
      res.json({ status: "expired" });
      return;
    }
    if (cookieValues(req, SESSION_COOKIE).some((c) => sameSecret(c, sess.grant))) {
      res.json({ status: "ready", redirect: issueCode(sid, sess, sess.grant) });
      return;
    }
    // Signed in, but not in this browser (yet: the cookie can trail the
    // sign-in by a moment). After the grace period, end the attempt.
    if (Date.now() - sess.grantAt > OTHER_BROWSER_GRACE_MS) {
      authSessions.delete(sid);
      console.error("[oauth] sign-in finished in a different browser; connection refused");
      res.json({ status: "other_browser" });
      return;
    }
    res.json({ status: "pending" });
  });

  // Token endpoint — PKCE-verified exchange for an access token this server
  // signs. The CloudGrid session is sealed inside it and never returned.
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

  app.post("/oauth/token", async (req, res) => {
    corsOk(req, res);
    res.setHeader("Cache-Control", "no-store");
    sweep(authCodes);
    const { grant_type, code, code_verifier, redirect_uri, client_id, resource } = req.body ?? {};
    if (grant_type === "refresh_token" && refresh) {
      await refreshGrant(req, res);
      return;
    }
    if (grant_type !== "authorization_code") {
      denyToken(
        res,
        "unsupported_grant_type",
        refresh ? "grant_type must be authorization_code or refresh_token" : "grant_type must be authorization_code",
        `(got ${JSON.stringify(grant_type ?? null)})`,
      );
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
    // RFC 8707 (#329): if the client repeats `resource` at the token endpoint it
    // must be the one bound at authorize. Mismatch → invalid_target, refused via
    // denyToken so it is logged. A token request with NO resource stays
    // acceptable (Claude compatibility), even when one was bound. Only the HOSTS
    // are logged — the resource URI is not a secret but nothing bearer-shaped is.
    if (resource !== undefined && String(resource) !== "") {
      const requested = normalizeResource(resource);
      if (!requested || requested !== rec.resource) {
        denyToken(
          res,
          "invalid_target",
          "resource does not match the authorize request",
          `(resource_host ${hostOf(resource)} vs bound ${hostOf(rec.resource)})`,
        );
        return;
      }
    }
    const challenge = b64url(createHash("sha256").update(String(code_verifier ?? "")).digest());
    if (challenge !== rec.code_challenge) {
      denyToken(res, "invalid_grant", code_verifier === undefined ? "code_verifier is required (PKCE)" : "PKCE verification failed");
      return;
    }
    const sub = decodeJwt(rec.grant).sub;
    if (!sub) {
      denyToken(res, "invalid_grant", "the sign-in did not produce an account");
      return;
    }
    // A refresh family for this sign-in. A store failure here costs only the
    // refresh token: the user still gets an access token now.
    let family = null;
    if (refresh) {
      try {
        const exp = decodeJwt(rec.grant).exp;
        family = await refresh.start({
          sub,
          clientId: String(client_id),
          aud: rec.resource,
          grant: tokens.seal(rec.grant),
          ...(typeof exp === "number" ? { expiresAt: exp * 1000 } : {}),
        });
      } catch (err) {
        console.error(`[oauth] refresh store unavailable at sign-in; issuing an access token only (${String(err?.message || err).slice(0, 80)})`);
      }
    }
    const issued = tokens.issue({
      iss: baseFor(req),
      aud: rec.resource,
      sub,
      clientId: client_id,
      grant: rec.grant,
      ttlSeconds: grantTtl(rec.grant, family ? accessTtl : opts.accessTokenTtlNoRefreshSeconds ?? accessTtl),
      family: family?.family,
    });
    // Observability (#345): the success path. Without this, a successful
    // exchange and total silence were the same observation. The token is never
    // logged; client_id is a prefix only.
    console.error(
      `[oauth] token exchange succeeded; access token issued${family ? " with a refresh token" : ""} (client_id=${clientIdPrefix(client_id)})`,
    );
    res.json({
      access_token: issued.token,
      token_type: "Bearer",
      expires_in: issued.expiresIn,
      scope: AUTH_SCOPE,
      ...(family ? { refresh_token: family.token } : {}),
    });
  });

  // RFC 6749 §6 — refresh. Each refresh token works once: it returns a new
  // access token and a new refresh token. A refresh token presented a second
  // time revokes its whole family (src/refresh-store.js).
  async function refreshGrant(req, res) {
    const { refresh_token, client_id, resource } = req.body ?? {};
    if (typeof refresh_token !== "string" || refresh_token === "") {
      denyToken(res, "invalid_request", "refresh_token is required");
      return;
    }
    // A public client has only its client_id; the refresh token must have been
    // issued to it (RFC 6749 §6), so it is required.
    if (typeof client_id !== "string" || client_id === "") {
      denyToken(res, "invalid_request", "client_id is required at the token endpoint");
      return;
    }
    const unavailable = (err) => {
      // The store or the API did not answer. Every check runs before the
      // refresh token is used, so a failure here leaves it unused and the
      // client's retry can still succeed. (A store failure after rotate() has
      // used it cannot be undone; that retry gets invalid_grant.)
      console.error(`[oauth] refresh unavailable (${String(err?.message || err).slice(0, 80)})`);
      res.status(503);
      res.setHeader("Retry-After", "5");
      res.json({ error: "temporarily_unavailable", error_description: "Try again shortly." });
    };
    // Every check before the token is used: a wrong client, resource or a
    // signed-out session must not consume it.
    let peeked;
    try {
      peeked = await refresh.peek(refresh_token);
    } catch (err) {
      unavailable(err);
      return;
    }
    if (peeked) {
      const prec = peeked.record;
      // Only the client that started the family may continue it.
      if (String(client_id) !== prec.clientId) {
        await refresh.revoke(peeked.family).catch(() => {});
        denyToken(res, "invalid_grant", "refresh token was issued to another client");
        return;
      }
      if (resource !== undefined && String(resource) !== "" && normalizeResource(resource) !== prec.aud) {
        denyToken(res, "invalid_target", "resource does not match the sign-in");
        return;
      }
      const g = tokens.unseal(prec.grant);
      if (!g) {
        await refresh.revoke(peeked.family).catch(() => {});
        denyToken(res, "invalid_grant", "the sign-in can no longer be refreshed");
        return;
      }
      // The CloudGrid session may have been signed out (or the account
      // removed) since the sign-in. If so the whole sign-in ends.
      if (opts.validatePlatformToken) {
        const live = await opts.validatePlatformToken(g);
        if (live.unavailable) {
          unavailable("CloudGrid API");
          return;
        }
        if (!live.ok) {
          await refresh.revoke(peeked.family).catch(() => {});
          console.error("[oauth] refresh refused: the CloudGrid session is signed out; its sign-in was revoked");
          denyToken(res, "invalid_grant", "the CloudGrid session is signed out");
          return;
        }
      }
    }
    let r;
    try {
      r = await refresh.rotate(refresh_token);
    } catch (err) {
      unavailable(err);
      return;
    }
    if (!r.ok) {
      if (r.reason === "reused") console.error("[oauth] refresh token reuse detected; its sign-in was revoked");
      denyToken(res, "invalid_grant", "refresh token is unknown, expired or already used");
      return;
    }
    const rec = r.record;
    if (String(client_id) !== rec.clientId) {
      await refresh.revoke(r.family).catch(() => {});
      denyToken(res, "invalid_grant", "refresh token was issued to another client");
      return;
    }
    const grant = tokens.unseal(rec.grant);
    if (!grant) {
      await refresh.revoke(r.family).catch(() => {});
      denyToken(res, "invalid_grant", "the sign-in can no longer be refreshed");
      return;
    }
    const issued = tokens.issue({
      iss: baseFor(req),
      aud: rec.aud,
      sub: rec.sub,
      clientId: rec.clientId,
      grant,
      ttlSeconds: grantTtl(grant, accessTtl),
      family: r.family,
    });
    console.error(`[oauth] refresh succeeded; tokens rotated (client_id=${clientIdPrefix(rec.clientId)})`);
    res.json({
      access_token: issued.token,
      token_type: "Bearer",
      expires_in: issued.expiresIn,
      scope: AUTH_SCOPE,
      refresh_token: r.token,
    });
  }
}

// An access token never outlives the CloudGrid session sealed inside it.
function grantTtl(grant, ttlSeconds) {
  const exp = decodeJwt(grant).exp;
  if (typeof exp !== "number") return ttlSeconds;
  return Math.max(60, Math.min(ttlSeconds, exp - Math.floor(Date.now() / 1000)));
}
