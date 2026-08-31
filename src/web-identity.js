import { decodeJwt } from "./auth.js";

function isTokenExpired(jwt, now) {
  if (!jwt) return false;
  return decodeJwt(jwt).exp * 1000 <= now();
}

// Is this token a credential the server can actually authenticate with right
// now? A present, decodable token whose numeric `exp` is still in the future.
// Anything else — absent, undecodable, or lacking a real expiry — is unusable.
// Unlike isTokenExpired (which treats an undecodable token as "not expired"
// because NaN <= now is false), this answers the transport guard's question,
// where a token we cannot vouch for must not pass.
function isCredentialUsable(jwt, now) {
  if (!jwt) return false;
  const { exp } = decodeJwt(jwt);
  if (typeof exp !== "number" || !Number.isFinite(exp)) return false;
  return exp * 1000 > now();
}

export function createWebIdentity({
  initialTransportToken = null,
  now = () => Date.now(),
} = {}) {
  let transportToken = initialTransportToken;
  let explicitToken = null;
  let hasExplicitLogin = false;
  const revokedTokens = new Set();

  // An explicit login wins over transport-token refreshes for the same subject.
  // A genuine transport subject change ends that override so credentials from
  // the previous person cannot persist on a connection now owned by another.
  function rawEffectiveToken() {
    return hasExplicitLogin ? explicitToken : transportToken;
  }

  function effectiveToken() {
    const tok = rawEffectiveToken();
    return revokedTokens.has(tok) ? null : tok;
  }

  return {
    captureTransportToken(jwt) {
      const previousSub = decodeJwt(transportToken).sub;
      const nextSub = decodeJwt(jwt).sub;
      const identityChanged = Boolean(previousSub && nextSub && previousSub !== nextSub);
      transportToken = jwt;
      if (identityChanged && hasExplicitLogin) {
        explicitToken = null;
        hasExplicitLogin = false;
      }
      return { identityChanged };
    },

    // Whether the session currently holds any credential the server can use:
    // the effective token (explicit login shadowing transport per #279) is
    // present, decodable, and unexpired. The transport guard asks this before
    // accepting a request, so an expired/invalid Bearer with no valid explicit
    // login is challenged rather than degrading to an in-band login link.
    hasUsableCredential() {
      return isCredentialUsable(effectiveToken(), now);
    },

    async getToken() {
      const jwt = effectiveToken();
      return isTokenExpired(jwt, now) ? null : jwt;
    },

    async getCredentialsStatus() {
      const jwt = effectiveToken();
      if (!jwt) {
        // A revoked token is surfaced as expired so the client triggers re-auth.
        const revoked = revokedTokens.has(rawEffectiveToken());
        return { creds: null, expired: revoked || isTokenExpired(rawEffectiveToken(), now) };
      }
      if (isTokenExpired(jwt, now)) return { creds: null, expired: true };
      return { creds: { jwt }, expired: false };
    },

    async saveToken(jwt) {
      explicitToken = jwt;
      hasExplicitLogin = true;
      return decodeJwt(jwt);
    },

    markRevoked(jwt) {
      if (jwt) revokedTokens.add(jwt);
    },
  };
}
