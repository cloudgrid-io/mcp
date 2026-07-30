#!/usr/bin/env node
// Generate the README tool table from the live tool registry.
//
// Calls registerTools() with a mock server to capture every tool's name,
// description, and annotations — twice (local + web) to classify by edition.
// Emits a managed block between <!-- gen:tools --> and <!-- /gen:tools --> so
// regeneration is idempotent and reviewable.
//
// Usage:
//   node scripts/gen-tool-docs.mjs          # regenerate README.md in place
//   node scripts/gen-tool-docs.mjs --check  # exit non-zero if stale

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const README = join(ROOT, "README.md");
const START_MARKER = "<!-- gen:tools -->";
const END_MARKER = "<!-- /gen:tools -->";

// ── Mock server that captures registrations ──────────────────────────────────

class MockServer {
  constructor() {
    this.tools = [];
  }
  registerTool(name, config, _handler) {
    this.tools.push({
      name,
      description: config.description ?? "",
      annotations: config.annotations ?? {},
    });
  }
  tool(name, description, _schema, annotations, _handler) {
    this.tools.push({ name, description, annotations: annotations ?? {} });
  }
  registerResource() {}
}

// ── Collect tools for a given edition ────────────────────────────────────────

async function collectTools(edition) {
  const { registerTools } = await import(
    join(ROOT, "src", "tools", "register.js")
  );
  const server = new MockServer();
  const ctx = {
    edition,
    state: {},
    getToken: async () => null,
    getCredentialsStatus: async () => ({ creds: null, expired: false }),
    getActiveGrid: async () => null,
    canOpenBrowser: false,
    savedLocationNote: () => "",
    logger: null,
    staleness: null,
    trustedServer: null,
  };
  registerTools(server, ctx);
  return server.tools;
}

// ── Extract a short summary from a description ──────────────────────────────

function shortDesc(desc) {
  // Take the first sentence (up to the first period followed by a space or
  // end, or the first em-dash clause). Cap at 120 chars.
  let s = desc.replace(/\s+/g, " ").trim();
  const dotMatch = s.match(/^(.+?\.)\s/);
  if (dotMatch) s = dotMatch[1];
  if (s.length > 120) s = s.slice(0, 117) + "...";
  return s;
}

// ── Extract what the tool wraps ──────────────────────────────────────────────

function wrapsInfo(desc) {
  // CLI tools say "Wraps `grid <verb>`"
  const cliMatch = desc.match(/[Ww]raps\s+`grid\s+([^`]+)`/);
  if (cliMatch) return "`grid " + cliMatch[1] + "`";
  // API tools mention the endpoint or "Calls the API directly"
  if (/POST\s+\/api/.test(desc)) {
    const m = desc.match(/(POST|GET|PATCH|DELETE)\s+(\/api\/v2\/\S+)/);
    return m ? `\`${m[1]} ${m[2]}\`` : "API";
  }
  if (/GET\s+\/auth/.test(desc)) {
    const m = desc.match(/(GET)\s+(\/auth\/\S+)/);
    return m ? `\`${m[1]} ${m[2]}\`` : "API";
  }
  if (/Calls the API directly/.test(desc)) return "API";
  if (/corpus/.test(desc.toLowerCase())) return "corpus";
  return "API";
}

// ── Build the managed block ──────────────────────────────────────────────────

async function generateBlock() {
  const localTools = await collectTools("local");
  const webTools = await collectTools("web");
  const webNames = new Set(webTools.map((t) => t.name));

  const { MIN_CLI_VERSION, MCP_VERSION } = await import(
    join(ROOT, "src", "tools", "constants.js")
  );

  const shared = localTools.filter((t) => webNames.has(t.name));
  const localOnly = localTools.filter((t) => !webNames.has(t.name));

  const lines = [];
  lines.push(`## Tools`);
  lines.push(``);
  lines.push(
    `${localTools.length} tools registered (${shared.length} shared across both editions, ` +
      `${localOnly.length} local-only). No deprecated aliases. ` +
      `MIN_CLI_VERSION: ${MIN_CLI_VERSION}.`,
  );
  lines.push(``);

  // ── Shared tools table ───────────────────────────────────────────────────
  lines.push(`### Direct-API tools (both editions)`);
  lines.push(``);
  lines.push(`| Tool | Wraps | Summary |`);
  lines.push(`|---|---|---|`);
  for (const t of shared) {
    lines.push(
      `| \`${t.name}\` | ${wrapsInfo(t.description)} | ${shortDesc(t.description)} |`,
    );
  }
  lines.push(``);
  lines.push(
    `The direct-API tools call the platform without the CLI, so they also work in`,
  );
  lines.push(
    `the web edition. \`grid_login\` writes the same \`~/.cloudgrid/credentials\` the`,
  );
  lines.push(`CLI uses, so the two share one identity.`);
  lines.push(``);

  // ── Local-only tools table ───────────────────────────────────────────────
  lines.push(`### CLI-wrapping tools (local edition only)`);
  lines.push(``);
  lines.push(`| Tool | Wraps | Summary |`);
  lines.push(`|---|---|---|`);
  for (const t of localOnly) {
    lines.push(
      `| \`${t.name}\` | ${wrapsInfo(t.description)} | ${shortDesc(t.description)} |`,
    );
  }
  lines.push(``);

  return lines.join("\n");
}

// ── Main ─────────────────────────────────────────────────────────────────────

const check = process.argv.includes("--check");
const block = await generateBlock();
const readme = readFileSync(README, "utf8");

const startIdx = readme.indexOf(START_MARKER);
const endIdx = readme.indexOf(END_MARKER);

let updated;
if (startIdx !== -1 && endIdx !== -1) {
  const before = readme.slice(0, startIdx + START_MARKER.length);
  const after = readme.slice(endIdx);
  updated = before + "\n" + block + "\n" + after;
} else {
  console.error(
    `Missing ${START_MARKER} / ${END_MARKER} markers in README.md`,
  );
  process.exit(1);
}

if (check) {
  if (updated !== readme) {
    console.error(
      "README tool table is stale. Run `node scripts/gen-tool-docs.mjs` to regenerate.",
    );
    process.exit(1);
  }
  console.log("README tool table is up to date.");
  process.exit(0);
}

writeFileSync(README, updated);
console.log("README.md tool table regenerated.");
