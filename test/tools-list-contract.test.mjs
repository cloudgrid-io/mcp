// The emitted tool contract (#400). What `tools/list` advertises is what MCP
// clients validate arguments against, and nothing else in CI looks at it:
// `gen-tool-docs --check` renders names and summaries, not schemas. A dependency
// bump (zod 3 -> 4 dropped `additionalProperties: false` from every tool) can
// change it with every other check green.
//
// Three checks, all through the real paths:
//   1. Snapshot. Spawn the stdio server, call `tools/list`, and compare every
//      tool's inputSchema and outputSchema (keys sorted) to
//      test/fixtures/tools-list-contract.json. A deliberate change re-records it:
//        node test/tools-list-contract.test.mjs --update
//      and the fixture diff is then part of the PR, where review sees it.
//   2. Emitted strictness. Every object in every advertised inputSchema that
//      declares properties carries `additionalProperties: false`.
//   3. Behaviour, independent of the installed zod major. Every registered
//      tool's input schema rejects an unknown key. On zod 3 a plain z.object
//      still emits `false` (so check 2 alone would pass vacuously there), but
//      it strips unknown keys instead of rejecting them, so this check fails.
//      A plain z.object fixture is run first to prove the check discriminates.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, strictInput } from "../src/tools/register.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/tools-list-contract.json", import.meta.url));
const update = process.argv.includes("--update");

let failures = 0;
function check(label, cond, detail = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${!cond && detail ? `\n     ${detail}` : ""}`);
  if (!cond) failures++;
}

const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  : v;

// ── 1. snapshot of what tools/list emits ────────────────────────────────────
const transport = new StdioClientTransport({
  command: "node",
  args: [fileURLToPath(new URL("../src/index.js", import.meta.url))],
  env: { ...process.env, CI: "true" },
});
const client = new Client({ name: "tools-list-contract", version: "0.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
await client.close();

const emitted = {};
for (const t of tools) emitted[t.name] = { inputSchema: t.inputSchema, outputSchema: t.outputSchema ?? null };
const text = JSON.stringify(sortKeys(emitted), null, 2) + "\n";

if (update) {
  writeFileSync(FIXTURE, text);
  console.log(`recorded ${tools.length} tools to ${FIXTURE}`);
} else {
  let want = null;
  try { want = JSON.parse(readFileSync(FIXTURE, "utf8")); } catch { /* missing: reported below */ }
  check("the fixture exists (record it with --update)", want !== null);
  if (want) {
    const got = JSON.parse(text);
    const names = [...new Set([...Object.keys(want), ...Object.keys(got)])].sort();
    const changed = names.filter((n) => JSON.stringify(want[n]) !== JSON.stringify(got[n]));
    check(
      `tools/list emits the recorded contract for all ${names.length} tools`,
      changed.length === 0,
      `changed: ${changed.join(", ")}. If intended, run node test/tools-list-contract.test.mjs --update and commit the fixture diff.`,
    );
  }
}

// ── 2. every advertised input object is closed ──────────────────────────────
function* openObjects(node, path) {
  if (Array.isArray(node)) { for (const [i, v] of node.entries()) yield* openObjects(v, `${path}[${i}]`); return; }
  if (!node || typeof node !== "object") return;
  if (node.properties && typeof node.properties === "object" && Object.keys(node.properties).length > 0
      && node.additionalProperties !== false) yield path;
  for (const [k, v] of Object.entries(node)) yield* openObjects(v, `${path}.${k}`);
}
const open = tools.flatMap((t) => [...openObjects(t.inputSchema, t.name)]);
check("every input object with properties advertises additionalProperties: false", open.length === 0,
  `open: ${open.join(", ")}`);

// ── 3. every registered input rejects an unknown key ────────────────────────
const PROBE = "__tools_list_contract_probe__";
const rejectsUnknownKey = (schema) => {
  const r = schema.safeParse({ [PROBE]: 1 });
  return !r.success && JSON.stringify(r.error.issues).includes("unrecognized_keys");
};
check("the probe discriminates: a plain z.object accepts the unknown key", !rejectsUnknownKey(z.object({ a: z.string().optional() })));
check("the probe discriminates: strictInput() rejects it", rejectsUnknownKey(strictInput({ a: z.string().optional() })));

for (const edition of ["local", "web"]) {
  const server = new McpServer({ name: "probe", version: "0.0.0" });
  registerTools(server, { edition });
  const registered = Object.entries(server._registeredTools);
  const loose = registered
    .filter(([, t]) => t.inputSchema && Object.keys(t.inputSchema.shape ?? {}).length > 0)
    .filter(([, t]) => !rejectsUnknownKey(t.inputSchema))
    .map(([n]) => n);
  check(`${edition} edition: every tool input (${registered.length} tools) rejects an unknown key`, loose.length === 0,
    `accepts it: ${loose.join(", ")}`);
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
