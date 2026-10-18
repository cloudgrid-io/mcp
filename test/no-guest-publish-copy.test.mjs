// #395 — agent-facing copy must not offer a guest publish.
//
// Since #396 a signed-out create returns needs_auth and publishes nothing, even
// with anon: true. Any copy that still offers "plug it as a guest" is a dead
// end: the model offers it, the user picks it, and the next call is refused.
// This test pins every surface a model reads — the hosted server instructions,
// the grid_plug description and schema, the playbook, the skills — so the old
// copy cannot come back unnoticed.
//
// Run: node test/no-guest-publish-copy.test.mjs
import { readFileSync } from "node:fs";
import { registerTools } from "../src/tools.js";
import { INSTRUCTIONS_WEB, INSTRUCTIONS_LOCAL } from "../src/playbook.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "ok  " : "FAIL"} ${label}`); if (!cond) failures++; };

// Phrases that offer, or steer toward, an anonymous / guest publish.
const OFFERS_GUEST = [
  /as a guest/i,
  /(?<!no )guest (link|option|path|fallback|publish)/i,
  /guest links? expire/i,
  /expires? in 7 days/i,
  /lasts 7 days/i,
  /no account (is )?needed/i,
  /no login (needed|required)/i,
  /login optional/i,
  /anyone can publish/i,
  /publish(ing)? anonymously/i,
  /re-call grid_plug with anon/i,
  /sign-in-vs-guest/i,
  /sign in vs anonymous/i,
  /only if they choose guest/i,
];
const offending = (text) => OFFERS_GUEST.filter((re) => re.test(text)).map(String);
const noGuest = (label, text) => {
  const hits = offending(text);
  check(`${label} does not offer a guest publish${hits.length ? ` (matched ${hits.join(", ")})` : ""}`, hits.length === 0);
};

// ── Server instructions ─────────────────────────────────────────────────────
noGuest("INSTRUCTIONS_WEB", INSTRUCTIONS_WEB);
noGuest("INSTRUCTIONS_LOCAL", INSTRUCTIONS_LOCAL);
check("INSTRUCTIONS_WEB names grid_login as the signed-out step", /grid_login/.test(INSTRUCTIONS_WEB));

// ── Tool descriptions and schema ────────────────────────────────────────────
for (const edition of ["web", "local"]) {
  const configs = {};
  const handlers = {};
  const server = {
    registerTool: (name, cfg, h) => { configs[name] = cfg; handlers[name] = h; },
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
  const plug = configs.grid_plug;
  check(`[${edition}] grid_plug is registered`, Boolean(plug));
  if (!plug) continue;

  noGuest(`[${edition}] grid_plug description`, plug.description);
  check(`[${edition}] grid_plug description names grid_login for the signed-out case`, /grid_login/.test(plug.description));

  // Every input + output field description.
  for (const [field, schema] of Object.entries(plug.inputSchema || {})) {
    noGuest(`[${edition}] grid_plug input "${field}"`, schema?.description || "");
  }
  for (const [field, schema] of Object.entries(plug.outputSchema || {})) {
    noGuest(`[${edition}] grid_plug output "${field}"`, schema?.description || "");
  }

  const anonDesc = plug.inputSchema?.anon?.description || "";
  if (plug.inputSchema?.anon) {
    check(`[${edition}] anon field says it does not publish`, /does not publish/i.test(anonDesc));
  }
  const needsAuth = plug.outputSchema?.needs_auth?.description || "";
  check(`[${edition}] needs_auth description routes to grid_login`, /grid_login/.test(needsAuth));
  check(`[${edition}] needs_auth description does not mention anon: true`, !/anon:\s*true/i.test(needsAuth));

  // Every other tool's description, too.
  for (const [name, cfg] of Object.entries(configs)) {
    if (name === "grid_plug") continue;
    noGuest(`[${edition}] ${name} description`, cfg?.description || "");
  }

  // The live signed-out prompt: names grid_login, offers nothing else.
  for (const input of [{ html: "<h1>hi</h1>" }, { html: "<h1>hi</h1>", anon: true }]) {
    const res = await handlers.grid_plug(input);
    const text = res?.content?.[0]?.text ?? "";
    const tag = input.anon ? " (anon: true)" : "";
    check(`[${edition}] signed-out plug${tag} returns needs_auth`, res?.structuredContent?.needs_auth === true);
    check(`[${edition}] signed-out prompt${tag} names grid_login`, /grid_login/.test(text));
    check(`[${edition}] signed-out prompt${tag} does not mention guest or anon`, !/guest|anon/i.test(text));
    noGuest(`[${edition}] signed-out prompt${tag}`, text);
  }
}

// ── Corpus and docs ─────────────────────────────────────────────────────────
const FILES = [
  "src/corpus/playbook.md",
  "src/corpus/skill-plug.md",
  "src/corpus/skill-login.md",
  "src/corpus/skill-claim.md",
  "src/corpus/skills-readme.md",
  "README.md",
  "REMOTE.md",
  "manifest.json",
];
for (const f of FILES) noGuest(f, readFileSync(new URL(`../${f}`, import.meta.url), "utf-8"));

const playbook = readFileSync(new URL("../src/corpus/playbook.md", import.meta.url), "utf-8");
const rule17 = playbook.match(/^17\..*$/m)?.[0] || "";
check("playbook rule 17 exists", rule17.length > 0);
check("playbook rule 17 routes to grid_login", /grid_login/.test(rule17));
check("playbook rule 17 says never pass anon: true", /never pass anon: true/i.test(rule17));
check("playbook rule 17 keeps the owner_token edit path", /owner_token/.test(rule17));
check("playbook rule 17 keeps the claim_token claim path", /claim_token/.test(rule17));

console.log(failures ? `\n${failures} failure(s)` : "\nall no-guest-publish-copy checks passed");
process.exit(failures ? 1 : 0);
