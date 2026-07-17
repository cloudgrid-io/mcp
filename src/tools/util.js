// Shared MCP result-shape helpers.
// Extracted verbatim from src/tools.js (refactor: split tools.js into modules).

export function ok(text) {
  return { content: [{ type: "text", text }] };
}
export function fail(text) {
  return { content: [{ type: "text", text }], isError: true };
}

export function okResult({ text, structured, meta }) {
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
    ...(meta ? { _meta: meta } : {}),
  };
}
