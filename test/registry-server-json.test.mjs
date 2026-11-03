// #457: server.json, the official MCP Registry entry for the hosted server.
//
// The registry (registry.modelcontextprotocol.io) feeds the GitHub MCP Registry
// that the VS Code / GitHub Copilot gallery reads. This test keeps the file
// publishable:
//   1. It validates against the registry schema it names in `$schema`. A copy of
//      that dated schema is vendored at test/fixtures/server.schema.2025-12-11.json
//      so CI needs no network; moving to a newer schema means updating both.
//   2. The fields the listing depends on: the GitHub-namespace name, one remote
//      streamable-http endpoint at the hosted URL, the repository, and a
//      description within the registry's 100-character limit.
//   3. `version` equals package.json's, so each release publishes its own
//      version (the release bump must update server.json too).
//
// Run: node test/registry-server-json.test.mjs
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${!cond && detail ? `\n     ${detail}` : ""}`);
  if (!cond) failures++;
};

const SCHEMA_URL = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";
const schema = read("./fixtures/server.schema.2025-12-11.json");
const server = read("../server.json");
const pkg = read("../package.json");

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

export function schemaErrors(doc) {
  return validate(doc) ? [] : validate.errors.map((e) => `${e.instancePath || "/"} ${e.message}`);
}

// Self-test: the validator must be able to fail.
check("self-test: a server without a name is rejected", schemaErrors({ description: "x", version: "1.0.0" }).length > 0);
check("self-test: an unknown remote type is rejected",
  schemaErrors({ ...server, remotes: [{ type: "websocket", url: "https://example.com/mcp" }] }).length > 0);
check("self-test: a 101-character description is rejected", schemaErrors({ ...server, description: "x".repeat(101) }).length > 0);

// 1. Schema
check("vendored schema is the one server.json names", schema.$id === SCHEMA_URL && server.$schema === SCHEMA_URL);
const errs = schemaErrors(server);
check("server.json validates against the registry schema", errs.length === 0, errs.join("; "));

// 2. Listing fields
check("name is the GitHub-namespace name", server.name === "io.github.cloudgrid-io/mcp");
check("exactly one remote", Array.isArray(server.remotes) && server.remotes.length === 1);
check("remote is streamable-http at the hosted URL",
  server.remotes?.[0]?.type === "streamable-http" && server.remotes?.[0]?.url === "https://mcp.cloudgrid.io/mcp");
check("no packages entry (remote-only listing)", server.packages === undefined);
check("repository points at this repo", server.repository?.url === "https://github.com/cloudgrid-io/mcp" && server.repository?.source === "github");
check("description is at most 100 characters", typeof server.description === "string" && server.description.length <= 100);
check("description has no exclamation marks", !String(server.description).includes("!"));

// 3. Version in step with the package
check(`version matches package.json (${server.version} vs ${pkg.version})`, server.version === pkg.version);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nregistry-server-json: all checks passed");
