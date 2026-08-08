// URL shape guard (#244): template cloudgrid.yaml comments must use the flat
// host shape (<name>-<4hex>--<org>.cloudgrid.io), never the retired nested
// shape (<name>.<org>.cloudgrid.io). Prevents regression of the 62-file fix.
//
// The nested shape was retired; the platform 301s it. All 62 template yamls
// were migrated in mcp#245, but nothing in CI prevented reintroduction.
// This guard closes that gap.
//
// Run:  node test/url-shape-guard.test.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const TEMPLATES_DIR = join(__dirname, "..", "src", "corpus", "templates");

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// ── Find every cloudgrid.yaml under templates/ ────────────────────────────

function findYamlFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...findYamlFiles(full));
    else if (entry.name === "cloudgrid.yaml") results.push(full);
  }
  return results;
}

// Fail fast if the templates directory is missing (prevents a false green from
// a moved/renamed directory).
let dirExists = false;
try {
  dirExists = statSync(TEMPLATES_DIR).isDirectory();
} catch {}
check("templates directory exists", dirExists);

if (!dirExists) {
  console.log(`\nExpected directory at: ${TEMPLATES_DIR}`);
  process.exit(1);
}

const files = findYamlFiles(TEMPLATES_DIR);
check(`found template cloudgrid.yaml files (${files.length})`, files.length > 0);

if (files.length === 0) {
  console.log("\nNo cloudgrid.yaml files found under templates/ — cannot guard.");
  process.exit(1);
}

// ── URL shape check ───────────────────────────────────────────────────────
//
// For every line that mentions cloudgrid.io, extract the hostname(s) and
// verify they either:
//   (a) use the flat shape (contain "--"), or
//   (b) are on the allowlist (api.cloudgrid.io, www.cloudgrid.io, bare
//       cloudgrid.io, *.cloudgrid.io wildcard refs, docs.cloudgrid.io,
//       console.cloudgrid.io).
//
// Anything else is the retired nested shape and fails the guard.

// Allowlist: well-known subdomains that are NOT entity URLs.
const ALLOWED_PREFIXES = new Set(["api", "www", "docs", "console"]);

function isAllowlisted(host) {
  // Bare "cloudgrid.io" with no subdomain.
  if (host === "cloudgrid.io") return true;
  // Wildcard refs like "*.cloudgrid.io".
  if (host.startsWith("*.")) return true;
  // Known non-entity subdomains (api.cloudgrid.io, etc.).
  const parts = host.split(".");
  // parts: [subdomain, "cloudgrid", "io"] for a single-level subdomain.
  if (parts.length === 3 && ALLOWED_PREFIXES.has(parts[0])) return true;
  return false;
}

const ROOT = join(TEMPLATES_DIR, "..", "..", "..");

console.log(`\nurl-shape-guard: checking ${files.length} template cloudgrid.yaml files …\n`);

for (const file of files) {
  const rel = relative(ROOT, file);
  const content = readFileSync(file, "utf-8");
  const lines = content.split("\n");
  let fileOk = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes("cloudgrid.io")) continue;

    // Extract all hostname-shaped tokens ending in .cloudgrid.io.
    const hostMatches = line.match(/[a-z0-9*.<>-]+\.cloudgrid\.io/gi);
    if (!hostMatches) continue;

    for (const raw of hostMatches) {
      // Normalize: strip any leading angle brackets from template tokens
      // like "<name>-<4hex>--<org>.cloudgrid.io" or "<name>.<org>.cloudgrid.io".
      // We keep the structure but strip < > for easier analysis.
      const host = raw.replace(/[<>]/g, "");

      if (isAllowlisted(host)) continue;

      // This host mentions cloudgrid.io and is not allowlisted — it must
      // contain "--" (the flat-shape double-dash separator).
      if (!host.includes("--")) {
        check(
          `${rel} line ${i + 1}: nested URL shape '${raw}' — must use flat shape with '--' separator`,
          false,
        );
        fileOk = false;
      }
    }
  }

  if (fileOk) {
    check(`${rel} uses flat URL shape`, true);
  }
}

console.log("");

if (failures > 0) {
  console.log(`${failures} url-shape-guard check(s) FAILED.`);
  console.log(
    "A template cloudgrid.yaml uses the retired nested URL shape (<name>.<org>.cloudgrid.io).",
  );
  console.log(
    "The correct shape is flat: <name>-<4hex>--<org>.cloudgrid.io (with '--' double-dash separator).",
  );
  process.exit(1);
}
console.log("All url-shape-guard checks passed.");
