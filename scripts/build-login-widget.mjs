#!/usr/bin/env node
// Build the grid_login MCP App into a single self-contained HTML resource.
//
// The MCP Apps iframe CSP is deny-by-default (issue #302), so the widget cannot
// pull a remote script, stylesheet, or font. This bundles the widget entry
// (src/widgets/grid-login/mcp-app.js) together with the whole
// @modelcontextprotocol/ext-apps App class via esbuild, then inlines the
// bundled JS and the CSS into the HTML template — producing
// src/widgets/grid-login.html, which the server serves verbatim as the
// ui://grid-login/mcp-app.html resource.
//
// Run: npm run build:login-widget
// Check (CI): npm run build:login-widget -- --check  → non-zero if the committed
// output is stale, so the source and the built resource can never drift.

import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC_DIR = new URL("../src/widgets/grid-login/", import.meta.url);
const OUT_FILE = fileURLToPath(new URL("../src/widgets/grid-login.html", import.meta.url));

const check = process.argv.includes("--check");

const result = await build({
  entryPoints: [fileURLToPath(new URL("mcp-app.js", SRC_DIR))],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  write: false,
  legalComments: "none",
});

const js = result.outputFiles[0].text;
const css = readFileSync(new URL("mcp-app.css", SRC_DIR), "utf-8").trim();
const template = readFileSync(new URL("mcp-app.html", SRC_DIR), "utf-8");

// Guard the bundle against a stray `</script>` closing the inline script early.
if (js.includes("</script")) {
  console.error("bundle contains </script — inline injection would break");
  process.exit(1);
}

const html = template
  .replace("/* __CSS__ */", () => css)
  .replace("/* __JS__ */", () => js);

if (check) {
  let current = "";
  try {
    current = readFileSync(OUT_FILE, "utf-8");
  } catch {
    /* missing → stale */
  }
  if (current !== html) {
    console.error(
      "src/widgets/grid-login.html is stale. Run `npm run build:login-widget` and commit the result.",
    );
    process.exit(1);
  }
  console.log("grid-login.html is up to date.");
  process.exit(0);
}

writeFileSync(OUT_FILE, html);
console.log(`Wrote ${OUT_FILE} (${html.length} bytes).`);
