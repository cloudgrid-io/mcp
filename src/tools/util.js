// Shared MCP result-shape helpers.
// Extracted verbatim from src/tools.js (refactor: split tools.js into modules).

export function ok(text) {
  return { content: [{ type: "text", text }] };
}
export function fail(text) {
  return { content: [{ type: "text", text }], isError: true };
}

// How a tool tells the user to sign in. The local edition signs in with
// grid_login; the hosted edition has no sign-in tool: the AI tool's connector
// asks the user to sign in when a tool needs an account.
export function signInHow(ctx) {
  return ctx?.edition === "web"
    ? "Ask the user to sign in to CloudGrid when their AI tool prompts them (if it does not, reconnect the CloudGrid connector)"
    : "Call grid_login to sign in";
}
// The tool to name in parentheses after "sign in": grid_login, or nothing.
export function signInRef(ctx) {
  return ctx?.edition === "web" ? "" : " (grid_login)";
}

export function okResult({ text, structured, meta }) {
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
    ...(meta ? { _meta: meta } : {}),
  };
}
