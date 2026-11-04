// consoleGridUrl — the post-plug console link (#355).
//
// These assertions pin LITERAL expected strings, not `consoleGridUrl(...)`
// compared against itself. That circularity was the RETURN on PR #356: an
// assertion of the form `emitted === consoleGridUrl(slug)` proves deploy.js
// calls the helper but survives the helper regressing to the bare root — which
// IS bug #355. A literal fails when the helper's logic breaks, which is the
// whole point of a regression guard.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { consoleGridUrl, CONSOLE_URL } from "../src/tools/constants.js";

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};

// Grid-specific link — the behaviour the ticket asked for.
check("known slug → /home?grid=<slug>",
  consoleGridUrl("atomic") === "https://my.cloudgrid.io/home?grid=atomic");

// The slug is URL-encoded, so a space or reserved char cannot break the query
// or smuggle another parameter. This is also the security property the
// committee checked.
check("slug is URL-encoded (space)",
  consoleGridUrl("my grid") === "https://my.cloudgrid.io/home?grid=my%20grid");
check("slug is URL-encoded (ampersand cannot add a param)",
  consoleGridUrl("a&b=c") === "https://my.cloudgrid.io/home?grid=a%26b%3Dc");

// Falsy slug → the bare root. No behaviour change when the grid is unknown.
check("null slug → bare root", consoleGridUrl(null) === CONSOLE_URL);
check("undefined slug → bare root", consoleGridUrl(undefined) === CONSOLE_URL);
check("empty slug → bare root", consoleGridUrl("") === CONSOLE_URL);

// Anchor the constant itself so a change to CONSOLE_URL is a conscious one.
check("CONSOLE_URL is the console root", CONSOLE_URL === "https://my.cloudgrid.io/");

// CLOUDGRID_CONSOLE_URL points the links at another environment's Console
// (staging) (#468). The value is read once at import, so each case runs in a
// fresh process with only that variable set. A trailing slash, or none, or
// several, all give the same root.
function consoleUrlsWith(value) {
  const env = { ...process.env };
  delete env.CLOUDGRID_CONSOLE_URL;
  if (value !== undefined) env.CLOUDGRID_CONSOLE_URL = value;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e",
    'const m = await import(process.argv[1]); console.log(JSON.stringify([m.CONSOLE_URL, m.consoleGridUrl("acme")]));',
    new URL("../src/tools/constants.js", import.meta.url).href], { env, encoding: "utf-8" });
  if (r.status !== 0) return [null, r.stderr];
  return JSON.parse(r.stdout.trim());
}
const staging = ["https://my.cgstage.io/", "https://my.cgstage.io/home?grid=acme"];
check("unset → production root",
  JSON.stringify(consoleUrlsWith(undefined)) === JSON.stringify(["https://my.cloudgrid.io/", "https://my.cloudgrid.io/home?grid=acme"]));
check("empty → production root",
  consoleUrlsWith("")[0] === "https://my.cloudgrid.io/");
check("override with trailing slash → that Console",
  JSON.stringify(consoleUrlsWith("https://my.cgstage.io/")) === JSON.stringify(staging));
check("override without trailing slash → same root",
  JSON.stringify(consoleUrlsWith("https://my.cgstage.io")) === JSON.stringify(staging));
check("override with several trailing slashes → same root",
  JSON.stringify(consoleUrlsWith("https://my.cgstage.io///")) === JSON.stringify(staging));

console.log(failures === 0 ? "\nAll console-grid-url checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
