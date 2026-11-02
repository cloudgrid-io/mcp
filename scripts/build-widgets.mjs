#!/usr/bin/env node
// Build the MCP App widgets into single self-contained HTML resources.
//
// The MCP Apps iframe CSP is deny-by-default (issue #302), so a widget cannot
// pull a remote script, stylesheet, or font. For each widget this bundles the
// entry (src/widgets/<name>/mcp-app.js) together with the whole
// @modelcontextprotocol/ext-apps App class via esbuild, then inlines the bundled
// JS and the CSS into the HTML template, producing src/widgets/<name>.html,
// which the server serves verbatim as the widget's ui:// resource.
//
//   grid-login   → ui://grid-login/mcp-app.html   (sign-in card, #302)
//   live-result  → ui://cloudgrid/live-result.html (app card after a plug, #434)
//
// Run: npm run build:widgets
// Check (CI): npm run build:widgets -- --check  → non-zero if any committed
// output is stale, so the sources and the built resources can never drift.

import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const WIDGETS = ["grid-login", "live-result"];
const check = process.argv.includes("--check");

async function buildWidget(name) {
  const srcDir = new URL(`../src/widgets/${name}/`, import.meta.url);
  const result = await build({
    entryPoints: [fileURLToPath(new URL("mcp-app.js", srcDir))],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: "es2022",
    minify: true,
    write: false,
    legalComments: "none",
  });
  const js = result.outputFiles[0].text;
  const css = readFileSync(new URL("mcp-app.css", srcDir), "utf-8").trim();
  const template = readFileSync(new URL("mcp-app.html", srcDir), "utf-8");
  // Guard the bundle against a stray `</script>` closing the inline script early.
  if (js.includes("</script")) {
    throw new Error(`${name}: bundle contains </script; inline injection would break`);
  }
  return template.replace("/* __CSS__ */", () => css).replace("/* __JS__ */", () => js);
}

let stale = 0;
for (const name of WIDGETS) {
  const outFile = fileURLToPath(new URL(`../src/widgets/${name}.html`, import.meta.url));
  const html = await buildWidget(name);
  if (check) {
    let current = "";
    try {
      current = readFileSync(outFile, "utf-8");
    } catch {
      /* missing → stale */
    }
    if (current !== html) {
      console.error(`src/widgets/${name}.html is stale. Run \`npm run build:widgets\` and commit the result.`);
      stale++;
    } else {
      console.log(`${name}.html is up to date.`);
    }
  } else {
    writeFileSync(outFile, html);
    console.log(`Wrote ${outFile} (${html.length} bytes).`);
  }
}
process.exit(stale ? 1 : 0);
