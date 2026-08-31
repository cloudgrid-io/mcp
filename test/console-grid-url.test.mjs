// consoleGridUrl — the post-plug console link (#355).
//
// These assertions pin LITERAL expected strings, not `consoleGridUrl(...)`
// compared against itself. That circularity was the RETURN on PR #356: an
// assertion of the form `emitted === consoleGridUrl(slug)` proves deploy.js
// calls the helper but survives the helper regressing to the bare root — which
// IS bug #355. A literal fails when the helper's logic breaks, which is the
// whole point of a regression guard.
import assert from "node:assert/strict";
import { consoleGridUrl, CONSOLE_URL } from "../src/tools/constants.js";

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};

// Grid-specific link — the behaviour the ticket asked for.
check("known slug → /home?grid=<slug>",
  consoleGridUrl("atomic") === "https://console.cloudgrid.io/home?grid=atomic");

// The slug is URL-encoded, so a space or reserved char cannot break the query
// or smuggle another parameter. This is also the security property the
// committee checked.
check("slug is URL-encoded (space)",
  consoleGridUrl("my grid") === "https://console.cloudgrid.io/home?grid=my%20grid");
check("slug is URL-encoded (ampersand cannot add a param)",
  consoleGridUrl("a&b=c") === "https://console.cloudgrid.io/home?grid=a%26b%3Dc");

// Falsy slug → the bare root. No behaviour change when the grid is unknown.
check("null slug → bare root", consoleGridUrl(null) === CONSOLE_URL);
check("undefined slug → bare root", consoleGridUrl(undefined) === CONSOLE_URL);
check("empty slug → bare root", consoleGridUrl("") === CONSOLE_URL);

// Anchor the constant itself so a change to CONSOLE_URL is a conscious one.
check("CONSOLE_URL is the console root", CONSOLE_URL === "https://console.cloudgrid.io/");

console.log(failures === 0 ? "\nAll console-grid-url checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
