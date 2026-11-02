// Test helper: the cookies a browser would send on the OAuth poll. The
// authorize response sets this server's binding cookie; a sign-in completed in
// that browser leaves the CloudGrid session cookie (`cloudgrid_session`) equal
// to the session the API hands out on /auth/status (cloudgrid-io/cloudgrid#5785).
export function browserCookies(authorizeResponse, sessionJwt) {
  const set = authorizeResponse.headers.getSetCookie?.() ?? [];
  const bind = set.map((c) => c.split(";")[0]);
  if (sessionJwt) bind.push(`cloudgrid_session=${sessionJwt}`);
  return bind.join("; ");
}
