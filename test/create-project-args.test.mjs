// grid_create_project → `grid new` argv (0.20.22): the migration off `grid init`.
// Asserts the modern shape (new <slug> + --agent for agents), --needs support,
// and that the removed --description / legacy `init <kind>` positional are gone.
//
// Run: node test/create-project-args.test.mjs
import { buildCreateProjectArgs } from "../src/tools.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "ok  " : "FAIL"} ${label}`); if (!cond) failures++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// app, minimal
check("app: `new <name>` (no `init`, no kind positional)",
  eq(buildCreateProjectArgs({ kind: "app", name: "shop" }), ["new", "shop"]));

// agent → --agent flag, not a positional kind
check("agent: `new <name> --agent`",
  eq(buildCreateProjectArgs({ kind: "agent", name: "helper" }), ["new", "helper", "--agent"]));

// type + needs + dir + grid
check("full: type, needs (joined), dir, grid",
  eq(buildCreateProjectArgs({ kind: "app", name: "songs", type: "nextjs", needs: ["database", "ai"], dir: "songs", org: "atomic" }),
     ["new", "songs", "--type", "nextjs", "--needs", "database,ai", "--dir", "songs", "--grid", "atomic"]));

// --description is GONE (the CLI removed it; passing it must not appear)
const withDesc = buildCreateProjectArgs({ kind: "app", name: "x", description: "ignored" });
check("no --description flag is ever emitted", !withDesc.includes("--description"));

// never emits the deprecated `init` verb
const all = ["app", "agent"].flatMap((k) => buildCreateProjectArgs({ kind: k, name: "n", type: "node", needs: ["ai"], dir: "d", org: "g" }));
check("never emits `init`", !all.includes("init"));
check("always leads with `new`", buildCreateProjectArgs({ kind: "app", name: "n" })[0] === "new");

// empty needs → no --needs flag
check("empty needs omits --needs", !buildCreateProjectArgs({ kind: "app", name: "n", needs: [] }).includes("--needs"));

console.log(failures === 0 ? "\nAll create-project-args checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
