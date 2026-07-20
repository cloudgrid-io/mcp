#!/usr/bin/env node
// CloudGrid MCP server — local edition (stdio).
//
// Runs as a subprocess of a local MCP client (Claude Code, Cursor, Claude
// Desktop). Full toolset, including the CLI-wrapping tools. Identity comes from
// the shared ~/.cloudgrid/credentials file, so it interoperates with the CLI.

import { installProxy } from "./proxy.js";
installProxy();

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
import { randomUUID } from "node:crypto";
import { createSessionLogger } from "./session-logger.js";
import { createSink } from "./log-sink.js";
import { INSTRUCTIONS_LOCAL } from "./playbook.js";
import { checkForNewerVersion } from "./staleness.js";

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

// Boot-time staleness self-check (local edition only — hosted auto-updates on
// cutover). Fire-and-forget with a short timeout: offline or slow → stays null.
// Surfaced in grid_start's live context so the model relays the reinstall note
// in-session; also logged to stderr for the Desktop MCP log.
ctx.staleness = null;
checkForNewerVersion(version)
  .then((info) => {
    if (info?.behind) {
      ctx.staleness = info;
      console.error(
        `cloudgrid-mcp: this MCP is v${info.current}; latest is v${info.latest}. ` +
          `The .mcpb Desktop extension never auto-updates — reinstall the latest from ` +
          `https://github.com/cloudgrid-io/mcp/releases/latest`,
      );
    }
  })
  .catch(() => {});

// QA session log (dark by default: no CLOUDGRID_QA_SLACK_WEBHOOK → null → no-op).
// The stdio process IS the session. user_request is forwarded by Claude Code via
// CLOUDGRID_USER_REQUEST when present.
ctx.sessionId = `cli-${randomUUID()}`;
ctx.logger = createSessionLogger({
  transport: "stdio",
  sessionId: ctx.sessionId,
  sink: createSink(process.env),
  ctx,
  userRequest: process.env.CLOUDGRID_USER_REQUEST || null,
});

const server = new McpServer({ name: "cloudgrid-mcp", version }, { instructions: INSTRUCTIONS_LOCAL });
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

// Flush the QA log once on shutdown if nothing triggered a flush during the
// session (abandoned / build-only session). Best-effort — a hard kill may cut
// delivery short; that is acceptable for QA. Guarded so it never crashes exit.
let shuttingDown = false;
async function flushAndExit(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await ctx.logger?.flush("abandoned"); } catch { /* never */ }
  process.exit(code);
}
process.on("SIGINT", () => flushAndExit(0));
process.on("SIGTERM", () => flushAndExit(0));
process.on("beforeExit", () => { ctx.logger?.flush("abandoned").catch(() => {}); });
