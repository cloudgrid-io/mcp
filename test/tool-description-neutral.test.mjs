// #500: tool descriptions state what a tool does, the requests it serves, what
// it needs, and what it returns. They carry no instructions about model
// behavior and name no other tool. The Claude connector directory asks us to
// confirm exactly that. Workflow guidance (call order, polling, confirming with
// the user, which verb fits a request) lives in the server instructions and in
// the tool results, which are allowed to guide the model.
//
// Checked on both editions, for everything tools/list advertises per tool: the
// description and every input and output describe() string at any depth.
//
// Run: node test/tool-description-neutral.test.mjs
import { captureTools, toolTexts } from "./helpers/tool-text.mjs";

let failures = 0;
const check = (label, cond, detail = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}${!cond && detail ? `\n     ${detail}` : ""}`);
  if (!cond) failures++;
};

// Imperative directives to the model. Word-bounded and case-insensitive. Kept
// tight: each one is a directive form, not a word plain functional text needs
// ("does not stream", "poll_url" and "persistent" do not match).
export const DIRECTIVES = [
  /\bnever\b/i,
  /\balways\b/i,
  /\bmust\b/i,
  /\bshould\b/i,
  /\bdo not\b/i,
  /\bdon't\b/i,
  /\bpoll(s|ed|ing)?\b/i,
  /\breach for\b/i,
  /\b(tell|ask|remind) the user\b/i,
  /\b(confirm|check)( it| this| that)? with the user\b/i,
  /\bsay so\b/i,
  /\bprefer\b/i,
  /\buse (this|it) (when|for|whenever|instead)\b/i,
  /\buse when\b/i,
  /\bmake sure\b/i,
  /\bpersist\b/i,
  /\brelay\b/i,
  /\bre-?call\b/i,
  /\bcall (this|it|again)\b/i,
];

const TOOL_NAME = /\bgrid_[a-z0-9]+(?:_[a-z0-9]+)*\b/gi;

export function textHits(self, text) {
  const s = String(text || "");
  const hits = [];
  for (const re of DIRECTIVES) {
    const m = s.match(re);
    if (m) hits.push(`directive "${m[0]}"`);
  }
  for (const m of s.matchAll(TOOL_NAME)) {
    if (m[0].toLowerCase() !== self) hits.push(`names ${m[0]}`);
  }
  return hits;
}

// Self-test: the guard must be able to fail, or a green run proves nothing.
{
  const bad = [
    ["grid_check_deploy", "do NOT tell the user the app is live until it does."],
    ["grid_pickup", "so do NOT reach for this when the user asks to collab."],
    ["grid_plug", "A runtime app returns building: poll until live."],
    ["grid_create_grid", "suggest a slug, CONFIRM it with the user, create."],
    ["grid_create_grid", "Never send the user to the console."],
    ["grid_report", "ALWAYS ask first."],
    ["grid_hello", "Must be true to proceed."],
    ["grid_plug", "call grid_get_app_source first"],
    ["grid_plug", "The durable handle a previous plug returned: persist it."],
  ];
  for (const [self, b] of bad) check(`guard self-test flags: ${b.slice(0, 50)}`, textHits(self, b).length > 0);
  check("guard self-test passes a tool naming itself", textHits("grid_get_template", "grid_get_template loads a doc.").length === 0);
  check("guard self-test passes plain functional text", textHits("grid_check_deploy",
    "Reports whether a build finished. Takes the poll_url from the plug result. Does not stream. Persistent disk. Returns needs_grid_create when the account has no grid.",
  ).length === 0);
}

for (const edition of ["web", "local"]) {
  const { configs } = captureTools(edition);
  const names = Object.keys(configs);
  check(`[${edition}] tools registered (${names.length})`, names.length >= (edition === "web" ? 15 : 17));
  let strings = 0;
  for (const [name, cfg] of Object.entries(configs)) {
    for (const [path, text] of toolTexts(name, cfg)) {
      strings++;
      const hits = textHits(name, text);
      if (hits.length) check(`[${edition}] ${path} is neutral`, false, `${hits.join("; ")}\n     text: ${text}`);
    }
    const desc = String(cfg.description ?? "");
    check(`[${edition}] ${name} description is neutral`, textHits(name, desc).length === 0);
  }
  check(`[${edition}] walked every advertised string (${strings})`, strings > 100);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\ntool-description-neutral: all checks passed");
