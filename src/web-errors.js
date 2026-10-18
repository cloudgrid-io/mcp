// Terminal error handling for the hosted web edition.
//
// Every route in src/web.js is expected to answer for itself. This is the last
// line: anything that still reaches Express as an error — a synchronous throw, a
// rejected async handler (Express 5 forwards those to error middleware), or a
// body-parser failure — gets a fixed, generic response here instead of Express's
// default handler, whose output depends on NODE_ENV.
//
// What the client sees is deliberately content-free: no error message, no stack,
// no file path. On /mcp it is a JSON-RPC 2.0 error object, the same shape every
// other /mcp response uses, so an MCP client can parse it. Elsewhere it is a
// plain-text status line.
//
// What the log sees: method, path (never the query string), status, and for a
// server-side failure the error's stack. Never the request body, never headers
// (Authorization carries the bearer), never a body-parser error's message (it can
// quote the raw body it failed on).

function defaultEmit(...args) {
  // eslint-disable-next-line no-console
  console.error(...args);
}

// A client error raised by Express or body-parser carries a 4xx `status`. Keep
// that status — a malformed body is the caller's fault, not a 500 — but never its
// message. Anything else is a server failure.
function statusOf(err) {
  const s = Number(err?.status ?? err?.statusCode);
  return Number.isInteger(s) && s >= 400 && s < 500 ? s : 500;
}

function jsonRpcError(err, status) {
  if (status >= 500) return { code: -32603, message: "Internal error" };
  if (err?.type === "entity.parse.failed") return { code: -32700, message: "Parse error" };
  return { code: -32600, message: "Invalid Request" };
}

const PLAIN = { 400: "Bad Request", 413: "Payload Too Large", 415: "Unsupported Media Type" };

export function createErrorHandler({ emit = defaultEmit } = {}) {
  // Four arguments: that is how Express recognises error-handling middleware.
  // eslint-disable-next-line no-unused-vars
  return function terminalErrorHandler(err, req, res, next) {
    const status = statusOf(err);
    const where = `${req.method} ${req.path}`;
    if (status >= 500) {
      emit(`[web] unhandled error on ${where} -> ${status}`, err?.stack || String(err));
    } else {
      emit(`[web] rejected request on ${where} -> ${status} (${err?.type || err?.name || "client error"})`);
    }

    // A response already under way cannot be replaced. Hand it back to Express,
    // which closes the connection without writing anything further.
    if (res.headersSent) return next(err);

    if (req.path === "/mcp") {
      res.status(status).json({ jsonrpc: "2.0", error: jsonRpcError(err, status), id: null });
      return;
    }
    res
      .status(status)
      .type("text/plain")
      .send(status >= 500 ? "Internal Server Error" : PLAIN[status] || "Bad Request");
  };
}
