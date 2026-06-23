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
  readActiveOrgSlug,
  writeCredentials,
  credentialsPath,
} from "./auth.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url)));

const ctx = {
  edition: "local",
  state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
  canOpenBrowser: true,
  getToken: async () => (await readCredentials())?.jwt ?? null,
  getActiveOrg: async () => await readActiveOrgSlug(),
  saveToken: async (jwt) => await writeCredentials(jwt),
  savedLocationNote: () => `Credentials saved to ${credentialsPath()}.`,
};

const server = new McpServer({ name: "cloudgrid-mcp", version });
registerTools(server, ctx);

const transport = new StdioServerTransport();
await server.connect(transport);
