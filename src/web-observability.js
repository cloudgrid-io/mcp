// Observability for POST /mcp on the hosted edge (#353). Makes the four transport
// exits visible in the log — the 401 auth challenge, both 400 branches, and a
// successful session — so a client that completes OAuth and then fails to
// establish a session (#329) can be diagnosed instead of vanishing silently.
//
// Redaction — same standard as #347. Never log a bearer token, any fragment of
// it, or its length in a way that narrows it: log PRESENCE and PARSE RESULT only
// (see authHeaderState). Client-supplied text (clientInfo.name, the presented
// mcp-session-id) is untrusted — logSafe bounds its length and flattens control
// characters so a client cannot forge a log line or break log-line parsing.
//
// Scope note (mirroring #347's explicit statement): these helpers never emit the
// bearer or the mcp-session-id header value except as a bounded, flattened
// echo of the client-presented id on the rehydrate-failed path — an
// already-public session identifier, not a credential.

function defaultEmit(msg) {
  // eslint-disable-next-line no-console
  console.error(msg);
}

// Bound and flatten client-supplied text so it cannot forge a log line (strip
// CR/LF and other control chars) or flood one (cap length). Presence/shape only.
export function logSafe(value, max = 64) {
  const s = String(value ?? "");
  const flat = s.replace(/[\u0000-\u001f\u007f]/g, " ");
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

// Classify the Authorization header WITHOUT revealing the token. Distinguishing
// absent / not-bearer / empty-token is the entire diagnostic value of the 401
// (#353): it says why no usable Bearer was found, never what it was. The four
// categories:
//   absent      — no Authorization header at all
//   not-bearer  — a header of some OTHER scheme (e.g. "Basic …")
//   empty-token — the Bearer scheme but no token ("Bearer", "Bearer ")
//   bearer      — the Bearer scheme with a token (never reaches the 401)
// Note (#353): an HTTP parser strips a header value's trailing whitespace, so a
// client's "Bearer " arrives as "Bearer" — the empty-token case. This mirrors
// bearerOf() in web.js, which yields a token only for "Bearer <non-space…>".
export function authHeaderState(req) {
  const raw = req?.headers?.authorization;
  const h = Array.isArray(raw) ? raw[0] : raw;
  if (h == null || h === "") return "absent";
  if (!/^Bearer\b/i.test(h)) return "not-bearer";
  return /^Bearer\s+\S/i.test(h) ? "bearer" : "empty-token";
}

// Reduce an object to its KEY SHAPE — key names mapped to the TYPE of each value,
// recursively — never the values themselves. Used to log the client's advertised
// MCP capabilities at initialize (#297) while guaranteeing BY CONSTRUCTION that
// no value ever leaves the process: only key names and JS type names are emitted,
// so no token, header, tool argument, or user content can appear even if the
// object carried one. Depth- and breadth-capped so a malformed or huge object
// cannot blow the stack or flood the log.
export function keyShape(value, depth = 0) {
  if (value === null || typeof value !== "object" || depth >= 6) return typeof value;
  if (Array.isArray(value)) return `array[${value.length}]`;
  const out = {};
  for (const k of Object.keys(value).slice(0, 64)) out[k] = keyShape(value[k], depth + 1);
  return out;
}

// The 401 auth challenge on /mcp (REQUIRE_AUTH && no usable Bearer).
export function logAuthChallenge(req, emit = defaultEmit) {
  emit(`cloudgrid-mcp: /mcp 401 auth-challenge authorization=${authHeaderState(req)}`);
}

// The first 400 branch: a request with no session id that is not an initialize.
export function logNoSession(emit = defaultEmit) {
  emit("cloudgrid-mcp: /mcp 400 no-session reason=missing-session-id-and-not-initialize");
}

// The second 400 branch: a stale-id rehydrate that failed to prime and fell back
// to the 400. session-id is the client-presented header — echoed, bounded, never
// a credential.
export function logRehydrateFailed(sessionId, emit = defaultEmit) {
  emit(`cloudgrid-mcp: /mcp 400 rehydrate-failed session-id=${logSafe(sessionId)}`);
}

// The successful-session exit, emitted from the SDK's `oninitialized`. TWO lines
// with a DELIBERATE separation:
//
//   1. session-established — UNCONDITIONAL, emitted FIRST, outside any swallowing
//      try/catch. The record that a session exists must never depend on the
//      best-effort probe below. This is the fix for the #329 trap: the #297
//      capability line is observation-only and could silently NOT fire on a good
//      session, and its absence was mis-read as "no session existed". A separate
//      always-emitted line removes that ambiguity.
//   2. client-capabilities — best-effort observation only (#297). A failure here
//      is swallowed and MUST NOT suppress line 1 or affect the session. The
//      synthetic rehydrate initialize is skipped so the capability signal stays
//      clean (line 1 still fires for it — a rehydrate is a real session).
//
// `protocolVersion` is passed in (the SDK exposes no getter for the negotiated
// version post-init); web.js negotiates it with the same rule the SDK uses.
export function logInitialize(server, sessionId, protocolVersion, emit = defaultEmit) {
  let clientName = "unknown";
  try {
    clientName = server?.getClientVersion?.()?.name ?? "unknown";
  } catch {
    /* name only — the session-established line below still fires */
  }
  emit(
    `cloudgrid-mcp: session established session-id=${logSafe(sessionId)} ` +
      `protocol=${logSafe(protocolVersion, 32)} client=${logSafe(clientName)}`,
  );

  try {
    if (clientName !== "cloudgrid-mcp-rehydrate") {
      const caps = server?.getClientCapabilities?.();
      const shape = caps && typeof caps === "object" ? keyShape(caps) : null;
      emit(
        `cloudgrid-mcp: client-capabilities client=${logSafe(clientName)} capabilities=${JSON.stringify(shape)}`,
      );
    }
  } catch {
    /* observation-only — never affects the session or the line above */
  }
}
