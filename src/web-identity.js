import { decodeJwt } from "./auth.js";

function isTokenExpired(jwt, now) {
  if (!jwt) return false;
  return decodeJwt(jwt).exp * 1000 <= now();
}

export function createWebIdentity({
  initialTransportToken = null,
  now = () => Date.now(),
} = {}) {
  let transportToken = initialTransportToken;
  let explicitToken = null;
  let hasExplicitLogin = false;

  // An explicit login wins over transport-token refreshes for the same subject.
  // A genuine transport subject change ends that override so credentials from
  // the previous person cannot persist on a connection now owned by another.
  function effectiveToken() {
    return hasExplicitLogin ? explicitToken : transportToken;
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

    async getToken() {
      const jwt = effectiveToken();
      return isTokenExpired(jwt, now) ? null : jwt;
    },

    async getCredentialsStatus() {
      const jwt = effectiveToken();
      if (!jwt) return { creds: null, expired: false };
      if (isTokenExpired(jwt, now)) return { creds: null, expired: true };
      return { creds: { jwt }, expired: false };
    },

    async saveToken(jwt) {
      explicitToken = jwt;
      hasExplicitLogin = true;
      return decodeJwt(jwt);
    },
  };
}
