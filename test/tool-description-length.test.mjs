// #410: every tool description stays short, and grid_plug's keeps the clauses a
// model needs to call it correctly.
//
// The cap is 1,000 characters for every tool on both editions:
//   - it is #410's target for grid_plug, the longest description by far until
//     it was trimmed (2,527 characters measured 2026-10-21);
//   - every other tool was already under it (the longest, grid_get_app_source,
//     is 938), so one cap for all means no tool can grow to absorb a cut;
//   - directory reviews (OpenAI's automated metadata scan, Anthropic's connector
//     review) read these strings, and neither publishes a length limit, so the
//     safe course is to stay near the size of the rest of the toolset rather
//     than test a limit nobody states. Each description ships in tools/list on
//     every session, so length is also context spent on every call.
// Longer guidance belongs in the per-parameter describe() strings, the server
// instructions, or the docs grid_get_template serves.
//
// Run: node test/tool-description-length.test.mjs
import { registerTools } from "../src/tools.js";

export const DESCRIPTION_CAP = 1000;

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${!cond && detail ? `\n     ${detail}` : ""}`);
  if (!cond) failures++;
};

function capture(edition) {
  const configs = {};
  const server = {
    registerTool: (name, cfg) => { configs[name] = cfg; },
    tool: () => {},
    registerResource: () => {},
  };
  registerTools(server, {
    edition,
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
    canOpenBrowser: false,
    getToken: async () => null,
    getActiveGrid: async () => null,
    saveToken: async () => ({}),
    savedLocationNote: () => "",
    logger: null,
  });
  return configs;
}

export function overCap(configs, cap = DESCRIPTION_CAP) {
  return Object.entries(configs)
    .filter(([, cfg]) => String(cfg.description ?? "").length > cap)
    .map(([name, cfg]) => `${name} (${String(cfg.description).length})`);
}

// Self-test: the cap check must be able to fail.
check("cap self-test flags an over-long description", overCap({ t: { description: "x".repeat(DESCRIPTION_CAP + 1) } }).length === 1);
check("cap self-test passes a description at the cap", overCap({ t: { description: "x".repeat(DESCRIPTION_CAP) } }).length === 0);

// The clauses grid_plug's description must keep (what a model needs to decide
// to call it and to call it correctly). Routing phrases first (mcp#337: there
// is no grid_deploy alias, this phrasing routes the request).
const PLUG_MUST_SAY = [
  ["routing verbs", /deploy, publish, host, ship, launch, go live, or share a working link/],
  ["routing phrase: give me a link", /give me a link/],
  ["routing phrase: share it with friends", /share it with friends/],
  ["routing phrase: make it live", /make it live/],
  ["routing phrase: put it online", /put it online/],
  ["routing phrase: host this", /host this/],
  ["single page vs runtime app", /`html`[^.]*self-contained page[^.]*`artifact_files`[^.]*runtime app/],
  ["create vs update", /creates a new URL; with one it updates it in place/],
  ["source-first edit", /call grid_get_app_source first, then deploy with target_entity_id/],
  ["sign-in: needs_auth", /needs_auth/],
  ["sign-in: no guest publish", /there is no guest publish/],
  ["needs_grid: ask which grid", /needs_grid: ask which grid/],
  ["needs_grid_create: confirm a slug, grid_create_grid", /needs_grid_create: confirm a slug, then grid_create_grid/],
  ["no API keys in page source", /Never put an API key in page source/],
  ["runtime build polling", /returns building: poll grid_check_deploy until live/],
  ["end with the URL", /End with the live URL/],
];

for (const edition of ["web", "local"]) {
  const configs = capture(edition);
  const names = Object.keys(configs);
  check(`[${edition}] tools registered (${names.length})`, names.length > 0);
  const over = overCap(configs);
  check(`[${edition}] every tool description is at most ${DESCRIPTION_CAP} characters`, over.length === 0, over.join(", "));

  const plug = String(configs.grid_plug?.description ?? "");
  check(`[${edition}] grid_plug description length ${plug.length} is under ${DESCRIPTION_CAP}`, plug.length > 0 && plug.length < DESCRIPTION_CAP);
  for (const [label, re] of PLUG_MUST_SAY) check(`[${edition}] grid_plug says: ${label}`, re.test(plug));
  check(
    `[${edition}] grid_plug names the edition's sign-in step`,
    edition === "web"
      ? /signs in through the CloudGrid connector/.test(plug) && !/grid_login/.test(plug)
      : /call grid_login/.test(plug),
  );
  check(
    `[${edition}] grid_plug lists the edition's sources`,
    edition === "web" ? !/`path`/.test(plug) : /`path` \(local folder, file, or \.zip\)/.test(plug),
  );
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\ntool-description-length: all checks passed");
