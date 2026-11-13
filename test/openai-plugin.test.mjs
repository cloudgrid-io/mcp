// The ChatGPT plugin package (#503): openai-plugin/cloudgrid/ is what is
// uploaded to the OpenAI plugin portal. This checks the shape the portal
// accepted, that every tool a review test case names is one the hosted
// server lists, and that the build produces the ZIP the portal takes.
//
// Run: node test/openai-plugin.test.mjs
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { unzipSync, strFromU8 } from "fflate";
import { captureTools } from "./helpers/tool-text.mjs";
import { buildZip, LOGO_SOURCE } from "../scripts/build-openai-plugin.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${!cond && detail ? `\n     ${detail}` : ""}`);
  if (!cond) failures++;
};

const root = fileURLToPath(new URL("..", import.meta.url));
const readJson = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const plugin = readJson("openai-plugin/cloudgrid/plugin.json");
const mcp = readJson("openai-plugin/cloudgrid/mcp.json");
const serverJson = readJson("server.json");
const pkg = readJson("package.json");

// Self-test of the tools_triggered parser and checks below.
export function triggeredTools(tc) {
  return typeof tc.tools_triggered === "string" ? tc.tools_triggered.split(",").map((s) => s.trim()).filter(Boolean) : null;
}
check("self-test: an array tools_triggered is rejected", triggeredTools({ tools_triggered: ["grid_plug"] }) === null);
check("self-test: a comma-joined string is split", JSON.stringify(triggeredTools({ tools_triggered: "grid_get_app_source, grid_plug" })) === '["grid_get_app_source","grid_plug"]');

// ── plugin.json top level ──────────────────────────────────────────────────
for (const k of ["name", "version", "description", "homepage", "repository", "license"]) {
  check(`plugin.json has ${k}`, typeof plugin[k] === "string" && plugin[k].length > 0);
}
check("plugin.json name is cloudgrid", plugin.name === "cloudgrid");
check("plugin.json version is semver", /^\d+\.\d+\.\d+$/.test(plugin.version));
check("plugin.json author has name, email, url", ["name", "email", "url"].every((k) => typeof plugin.author?.[k] === "string"));

// ── com.openai interface ───────────────────────────────────────────────────
const oa = plugin.extensions?.["com.openai"];
const ui = oa?.interface ?? {};
for (const k of ["displayName", "shortDescription", "longDescription", "developerName", "category", "websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL", "composerIcon", "logo"]) {
  check(`interface has ${k}`, typeof ui[k] === "string" && ui[k].length > 0);
}
check("interface category is exactly Developer Tools", ui.category === "Developer Tools");
check("interface capabilities is a non-empty string list", Array.isArray(ui.capabilities) && ui.capabilities.length > 0 && ui.capabilities.every((c) => typeof c === "string" && c.length > 0));
check("interface defaultPrompt is a non-empty string list", Array.isArray(ui.defaultPrompt) && ui.defaultPrompt.length > 0 && ui.defaultPrompt.every((c) => typeof c === "string" && c.length > 0));
check("interface logo and composerIcon are the ZIP's assets/logo.png", ui.logo === "./assets/logo.png" && ui.composerIcon === "./assets/logo.png");
for (const k of ["websiteURL", "supportURL", "privacyPolicyURL", "termsOfServiceURL"]) {
  check(`interface ${k} is https`, /^https:\/\//.test(ui[k] ?? ""));
}

// ── review test cases ──────────────────────────────────────────────────────
const hosted = new Set(Object.keys(captureTools("web").configs));
const positive = oa?.review?.test_cases?.positive ?? [];
const negative = oa?.review?.test_cases?.negative ?? [];
check("review has positive test cases", positive.length > 0);
check("review has negative test cases", negative.length > 0);
for (const [i, tc] of positive.entries()) {
  const label = `positive[${i}] (${tc.description})`;
  check(`${label} has description, prompt, expected_behavior`, ["description", "prompt", "expected_behavior"].every((k) => typeof tc[k] === "string" && tc[k].length > 0));
  check(`${label} tools_triggered is a string`, typeof tc.tools_triggered === "string");
  const names = triggeredTools(tc) ?? [];
  check(`${label} names at least one tool`, names.length > 0);
  for (const n of names) check(`${label} ${n} is a hosted tool`, hosted.has(n), `hosted tools: ${[...hosted].join(", ")}`);
}
for (const [i, tc] of negative.entries()) {
  check(`negative[${i}] has description and prompt`, typeof tc.description === "string" && typeof tc.prompt === "string");
}

// ── mcp.json ───────────────────────────────────────────────────────────────
const srv = mcp.mcpServers?.cloudgrid;
const remote = serverJson.remotes?.find((r) => r.type === "streamable-http");
check("mcp.json points at the hosted remote in server.json", srv?.type === "streamable-http" && srv?.url === remote?.url);
check("mcp.json signs in with OAuth dynamic client registration", srv?.extensions?.["com.openai"]?.auth?.type === "oauth" && srv.extensions["com.openai"].auth.client?.mode === "dcr");

// ── no secrets ─────────────────────────────────────────────────────────────
const raw = readFileSync(join(root, "openai-plugin/cloudgrid/plugin.json"), "utf8") + readFileSync(join(root, "openai-plugin/cloudgrid/mcp.json"), "utf8");
check("package carries no token or secret fields", !/token|secret|verification|api[_-]?key/i.test(raw.replace(/"tools_triggered"/g, "")));

// ── build ──────────────────────────────────────────────────────────────────
const out = buildZip(join(mkdtempSync(join(tmpdir(), "openai-plugin-")), "plugin.zip"));
const files = unzipSync(readFileSync(out));
check("ZIP holds plugin.json, mcp.json, assets/logo.png at its root", JSON.stringify(Object.keys(files).sort()) === JSON.stringify(["assets/logo.png", "mcp.json", "plugin.json"]));
const zipped = JSON.parse(strFromU8(files["plugin.json"]));
check("ZIP plugin.json version is package.json's", zipped.version === pkg.version);
check("ZIP plugin.json otherwise matches the committed file", JSON.stringify({ ...zipped, version: plugin.version }) === JSON.stringify(plugin));
check("ZIP logo is the 512 px brand icon", Buffer.compare(Buffer.from(files["assets/logo.png"]), readFileSync(LOGO_SOURCE)) === 0);
check("ZIP mcp.json matches the committed file", JSON.stringify(JSON.parse(strFromU8(files["mcp.json"]))) === JSON.stringify(mcp));

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nopenai-plugin: all checks passed");
