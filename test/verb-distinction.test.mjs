// Tests for #242 — the three adopt/access verbs must be distinguishable from
// the MCP tool surface ALONE, since that is all the model reads. The bug: a
// user ran `grid collab <entity>` and the agent replied "I'll pick up that grid
// collab" — it mapped "collab" onto grid_pickup (a FORK), the exact wrong verb,
// because nothing on the surface names "collab" as a distinct operation.
//
// The verb model (packages/cli/src/program.ts:156-168, monorepo):
//   collab  = get PUSH ACCESS to the SAME live entity (grant only; fetches
//             nothing — run pull afterwards). CLI-only: `grid collab <entity>`.
//   pull    = continue an entity you already have access to (fetch + edit).
//   pickup  = make your OWN COPY, like a git fork (a NEW entity).
//
// These are NEGATIVE assertions: each one fails on the pre-fix descriptions, so
// a regression that re-conflates the verbs (or restores the stale "rolling out
// soon" text) turns this test red. A test that only asserts a string EXISTS
// would pass on the buggy code and prove nothing.
//
// Run: node test/verb-distinction.test.mjs

import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runPull } from "../src/tools/deploy.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// ── Part A: the live tool surface (what the model actually reads) ────────────

const transport = new StdioClientTransport({ command: "node", args: ["src/index.js"] });
const client = new Client({ name: "verb-distinction-test", version: "0.0.0" });
await client.connect(transport);
const { tools } = await client.listTools();
await client.close();

const desc = (name) => tools.find((t) => t.name === name)?.description ?? "";
const pickup = desc("grid_pickup");
const pull = desc("grid_pull");
const edit = desc("grid_edit_existing_app");

check("grid_pickup is a registered tool", pickup.length > 0);
check("grid_pull is a registered tool", pull.length > 0);
check("grid_edit_existing_app is a registered tool", edit.length > 0);

// grid_pickup must DISAMBIGUATE itself from collab, naming collab as the
// separate CLI operation — otherwise "collab" maps onto pickup (the #242 bug).
check("grid_pickup names the CLI `grid collab` as the distinct verb", /grid collab/i.test(pickup));
check("grid_pickup still frames itself as a fork/copy", /fork|copy/i.test(pickup));
// pickup must actively DISCLAIM granting access (access is collab's job). Any
// mention of granting access in pickup must be a denial ("never grants you
// access" / "does not grant access"), never a positive claim.
check(
  "grid_pickup explicitly disclaims granting access",
  /\b(never|not|n't|no)\b[^.]*grants?\s+(you\s+)?(push\s+)?access/i.test(pickup),
);

// grid_pull must frame collab as an ACCESS grant that fetches nothing — not as
// "rolling out soon", and not as a synonym for pull.
check("grid_pull names the CLI `grid collab`", /grid collab/i.test(pull));
check(
  "grid_pull frames collab as permission-only / fetches-nothing",
  /permission only|grants permission|fetches nothing/i.test(pull),
);
check("grid_pull mentions push access", /push access/i.test(pull));

// grid_edit_existing_app (the local CLI-wrapping pull) must also point at collab
// for gaining access, so its surface is consistent with grid_pull's.
check("grid_edit_existing_app names the CLI `grid collab`", /grid collab/i.test(edit));

// The stale "(rolling out soon)" tag must be gone from EVERY tool description:
// `grid collab` ships in the CLI today (program.ts:169) and the server route is
// live (entity-pickup.ts:157), so telling the model it is unavailable is wrong.
const stillRolling = tools.filter((t) => /rolling out soon/i.test(t.description ?? ""));
check(
  `no tool description says "rolling out soon" (offenders: ${stillRolling.map((t) => t.name).join(", ") || "none"})`,
  stillRolling.length === 0,
);

// ── Part B: the runtime guidance runPull emits when the caller lacks access ──
// This is the exact moment "collab" is relevant to a user, so the string it
// prints must teach collab correctly and must not carry the stale tag.
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { code: "NOT_ALLOWLISTED" } }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  const ctx = {
    edition: "web",
    state: {},
    getToken: async () => "tok",
    getActiveGrid: async () => "acme",
  };
  const out = await runPull(ctx, { entity_id: "acme/nebula-prism-8694" });
  globalThis.fetch = realFetch;

  const text = out?.text ?? "";
  check("runPull view-only guidance names the CLI `grid collab`", /grid collab/i.test(text));
  check(
    "runPull view-only guidance frames collab as permission-only / fetches-nothing",
    /permission only|grants permission|fetches nothing/i.test(text),
  );
  check("runPull view-only guidance does NOT say \"rolling out soon\"", !/rolling out soon/i.test(text));
  check("runPull view-only guidance still offers the fork (grid_pickup)", /grid_pickup/i.test(text));
}

// ── Part C: no stale "rolling out soon" anywhere in the collab-touching source ─
// Catches occurrences on code paths Parts A/B don't exercise (e.g. runPull's
// 200 view-only branch) and in the playbook the model orients from.
{
  const sources = [
    "src/tools/register.js",
    "src/tools/deploy.js",
    "src/corpus/playbook.md",
  ];
  for (const rel of sources) {
    const body = readFileSync(new URL(`../${rel}`, import.meta.url), "utf-8");
    check(`${rel} contains no "rolling out soon"`, !/rolling out soon/i.test(body));
  }
}

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll verb-distinction checks passed.");
