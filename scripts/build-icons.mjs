#!/usr/bin/env node
// Build the package icons from the CloudGrid brand mark (#490).
//
// The source is the design system's square app mark, brand/mark.svg in the
// installed @cloudgrid-io/ui package (the socket glyph from the wordmark on the
// brand purple; brand rule: never redraw). It is copied to
// assets/cloudgrid-icon.svg and rendered to every PNG the package ships:
//
//   assets/cloudgrid-icon.png       1254 px  (README / directory listings)
//   assets/cloudgrid-icon-512.png    512 px  (manifest.json "icon", the .mcpb)
//   assets/cloudgrid-icon-256.png    256 px
//   src/assets/favicon.png            80 px  (hosted landing page, server.json icon)
//
// Run: npm run build:icons   (needs rsvg-convert, e.g. `brew install librsvg`)
// Check (CI): npm run build:icons -- --check  → non-zero if the committed SVG
// no longer matches the library's mark. Rendering is not repeated in CI, so
// after a library bump that changes the mark, run the build and commit.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const mark = readFileSync(require.resolve("@cloudgrid-io/ui/brand/mark.svg"), "utf-8");
const at = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const SVG = "assets/cloudgrid-icon.svg";

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(at(SVG), "utf-8");
  } catch {
    /* missing → stale */
  }
  if (current !== mark) {
    console.error(`${SVG} does not match @cloudgrid-io/ui brand/mark.svg. Run \`npm run build:icons\` and commit the result.`);
    process.exit(1);
  }
  console.log(`${SVG} matches the library mark.`);
  process.exit(0);
}

writeFileSync(at(SVG), mark);
for (const [file, size] of [
  ["assets/cloudgrid-icon.png", 1254],
  ["assets/cloudgrid-icon-512.png", 512],
  ["assets/cloudgrid-icon-256.png", 256],
  ["src/assets/favicon.png", 80],
]) {
  execFileSync("rsvg-convert", ["-w", String(size), "-h", String(size), at(SVG), "-o", at(file)]);
  console.log(`Wrote ${file} (${size} px).`);
}
