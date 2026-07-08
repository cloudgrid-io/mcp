#!/usr/bin/env node
// CloudGrid MCP server — local edition (stdio).
//
// Runs as a subprocess of a local MCP client (Claude Code, Cursor, Claude
// Desktop). Full toolset, including the CLI-wrapping tools. Identity comes from
// the shared ~/.cloudgrid/credentials file, so it interoperates with the CLI.

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import {
  readCredentials,
  readActiveGridSlug,
  writeCredentials,
  credentialsPath,
} from "./auth.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));

const ctx = {
  edition: "local",
  state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
  canOpenBrowser: true,
  getToken: async () => (await readCredentials())?.jwt ?? null,
  getActiveGrid: async () => await readActiveGridSlug(),
  saveToken: async (jwt) => await writeCredentials(jwt),
  savedLocationNote: () => `Credentials saved to ${credentialsPath()}.`,
};

const server = new McpServer({ name: "cloudgrid-mcp", version });
registerTools(server, ctx);

// Capture the calling agent's clientInfo (name+version) once the MCP handshake
// completes, so grid_report can attribute the report's origin (which agent).
// getClientVersion() is populated by the SDK from the initialize request's
// clientInfo. Never fatal — a missing client just falls back to "unknown".
server.server.oninitialized = () => {
  try {
    ctx.state.client = server.server.getClientVersion() ?? null;
  } catch {
    ctx.state.client = null;
  }
};

const transport = new StdioServerTransport();
await server.connect(transport);
