// CloudGrid MCP server — docs edition (public, read-only, no auth).
//
// A public documentation search server exposing search_cloudgrid_documentation
// (and an optional cloudgrid_quickstart_guide) over MCP Streamable HTTP. The
// same Express + StreamableHTTP pattern as the web edition (src/web.js),
// stripped to the minimum: no auth, no OAuth, no session identity, no secrets.
// Safe to expose anonymously.
//
// The corpus (src/corpus/*.md) is indexed at startup with BM25 keyword search.
// The search backend is behind a clean interface so it can be swapped to
// semantic/embedding search later without changing the tool contract.
//
// Run: PORT=8080 node src/docs.js     Health: GET /healthz

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DocsSearch, loadCorpus } from "./docs-search.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));

const PORT = Number(process.env.PORT || 8080);

// Build the search index once at startup.
const search = loadCorpus(new DocsSearch());

// Load the quickstart guide verbatim.
const QUICKSTART = readFileSync(new URL("./corpus/cookbook.md", import.meta.url), "utf-8");

// ── Tool helpers (same convention as tools.js) ────────────────────────────────
function ok(text) {
  return { content: [{ type: "text", text }] };
}

function createDocsServer() {
  const server = new McpServer({ name: "cloudgrid-docs", version });

  // Naming cleanup (spec §6): the docs tools move to the gridctl_* family. Both
  // legacy names stay registered as deprecated aliases (same handler) so nothing
  // breaks mid-migration; aliases are removed in a later major.
  //   search_cloudgrid_documentation → gridctl_search_docs
  //   cloudgrid_quickstart_guide     → gridctl_quickstart
  const dual = (name, alias, description, schema, handler) => {
    server.tool(name, description, schema, handler);
    server.tool(alias, `(deprecated: use ${name}) ${description}`, schema, handler);
  };

  dual(
    "gridctl_search_docs",
    "search_cloudgrid_documentation",
    "Search CloudGrid documentation — guides, tutorials, CLI reference, MCP setup, and skill descriptions. Returns the most relevant doc chunks with title, snippet, and source path.",
    {
      query: z
        .string()
        .describe(
          "The search query, e.g. 'deploy a database app' or 'add the MCP to Cursor'",
        ),
    },
    async ({ query }) => {
      const results = search.search(query, 5);
      if (results.length === 0) {
        return ok("No documentation matched your query. Try different keywords.");
      }
      const text = results
        .map(
          (r, i) => `### ${i + 1}. ${r.title}\n${r.snippet}\n_Source: ${r.source}_`,
        )
        .join("\n\n---\n\n");
      return ok(text);
    },
  );

  dual(
    "gridctl_quickstart",
    "cloudgrid_quickstart_guide",
    "Get the CloudGrid quickstart guide — the canonical build-and-ship loop from scaffold to deploy to feedback.",
    {},
    async () => ok(QUICKSTART),
  );

  return server;
}

// ── HTTP server (mirrors src/web.js, no auth) ─────────────────────────────────
const app = express();
app.use(express.json());

app.get("/healthz", (_req, res) => res.json({ ok: true, edition: "docs" }));

const transports = Object.create(null);

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  let transport = sessionId ? transports[sessionId] : undefined;

  if (transport) {
    await transport.handleRequest(req, res, req.body);
    return;
  }

  if (sessionId || !isInitializeRequest(req.body)) {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "No valid session. Send an initialize request first." },
      id: null,
    });
    return;
  }

  const newSessionId = randomUUID();
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => newSessionId,
    onsessioninitialized: (sid) => {
      transports[sid] = transport;
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) delete transports[transport.sessionId];
  };
  const server = createDocsServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

async function handleSessionRequest(req, res) {
  const sessionId = req.headers["mcp-session-id"];
  const transport = sessionId ? transports[sessionId] : undefined;
  if (!transport) {
    res.status(400).send("Invalid or missing session id");
    return;
  }
  await transport.handleRequest(req, res);
}

app.get("/mcp", handleSessionRequest);
app.delete("/mcp", handleSessionRequest);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.error(
    `cloudgrid-docs edition listening on :${PORT} (POST /mcp, GET /healthz) — ${search.size} chunks indexed`,
  );
});
