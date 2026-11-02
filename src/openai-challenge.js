// OpenAI app-directory domain verification for the hosted web edition.
//
// The OpenAI Platform portal generates a token and checks that this host serves
// it, byte for byte, at GET /.well-known/openai-apps-challenge. The token comes
// from MCP_OPENAI_APPS_CHALLENGE so each deployment serves its own value; with
// the variable unset or blank the path is a plain 404, as on any other host.
//
// Public and static: no sign-in, no MCP session, no Origin check.

export const OPENAI_APPS_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";

/**
 * Normalise the configured token: surrounding whitespace (a trailing newline
 * from a Secret or a shell) is dropped, so the body is exactly the token.
 * Returns "" when nothing is configured.
 */
export function challengeToken(raw) {
  return String(raw ?? "").trim();
}

export function mountOpenAiChallenge(app, rawToken) {
  const token = challengeToken(rawToken);
  app.get(OPENAI_APPS_CHALLENGE_PATH, (_req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!token) {
      res.status(404).type("text/plain").send("Not found");
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(200).type("text/plain").send(token);
  });
}
