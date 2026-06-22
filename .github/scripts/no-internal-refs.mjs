#!/usr/bin/env node
// Internal-reference linter.
// Scans tracked text files and exits nonzero if any contain references to
// internal repos, decision docs, ticket IDs, or non-allowed hostnames.
// No dependencies — runs on a stock Node 20+.

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Set to true to honour "# noqa: internal-ref" escape comments.
// Must stay false for public repos.
const ALLOW_NOQA = false;

// Patterns that must never appear in public source.
const PATTERNS = [
  {
    id: "private-repo",
    regex: /atomicfuse\/cloudgrid/g,
    label: "private monorepo reference (atomicfuse/cloudgrid)",
  },
  {
    id: "decision-docs-path",
    regex: /docs\/decisions\//g,
    label: "internal decision docs path (docs/decisions/)",
  },
  {
    id: "strategy-docs-path",
    regex: /docs\/strategy\//g,
    label: "internal strategy docs path (docs/strategy/)",
  },
  {
    id: "cli-ux-spec",
    regex: /cli-ux-spec/g,
    label: "internal CLI UX spec reference (cli-ux-spec)",
  },
  {
    id: "ticket-id",
    regex: /\bBL\d+\b/g,
    label: "internal ticket ID (BL###)",
  },
  {
    id: "decision-number",
    regex: /decision \d{3}/gi,
    label: "internal decision reference (decision NNN)",
  },
];

// Hostname allowlist — any hostname matched by the hostname regex that does
// NOT match one of these patterns is flagged.
const ALLOWED_HOST_PATTERNS = [
  /^(.+\.)?cloudgrid\.io$/,
  /^localhost$/,
  /^127\.0\.0\.1$/,
];

// Detects hostnames that look internal: subdomains of common internal TLDs,
// or explicit internal/staging/dev subdomains. This is intentionally narrow
// to avoid false positives on general URLs.
const INTERNAL_HOSTNAME_RE =
  /\b(?:[a-z0-9-]+\.(?:internal|corp|local|lan|intranet))\b/gi;

// File extensions to scan. Binary files are excluded.
const TEXT_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".yml",
  ".yaml",
  ".json",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".mts",
  ".cts",
  ".jsx",
  ".tsx",
  ".sh",
  ".bash",
  ".zsh",
  ".toml",
  ".cfg",
  ".ini",
  ".html",
  ".css",
  ".scss",
  ".xml",
  ".svg",
  ".env.example",
  ".gitignore",
  ".dockerignore",
]);

// Files to always skip (relative to repo root).
const SKIP_FILES = new Set([
  ".github/scripts/no-internal-refs.mjs", // this file contains the patterns
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTextFile(path) {
  // Check extension
  for (const ext of TEXT_EXTENSIONS) {
    if (path.endsWith(ext)) return true;
  }
  // Also scan extensionless files that look like docs/config
  const base = path.split("/").pop();
  return [
    "README",
    "LICENSE",
    "CONTRIBUTING",
    "CODEOWNERS",
    "SECURITY",
    "Makefile",
    "Dockerfile",
    "Procfile",
  ].some((name) => base === name || base.startsWith(name + "."));
}

function getTrackedFiles() {
  const output = execSync("git ls-files", { encoding: "utf8" });
  return output
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const files = getTrackedFiles().filter(
  (f) => isTextFile(f) && !SKIP_FILES.has(f),
);

let totalFindings = 0;

for (const file of files) {
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue; // deleted / unreadable
  }

  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip noqa-annotated lines (private repos only).
    if (ALLOW_NOQA && /# noqa: internal-ref/.test(line)) continue;

    // Check each pattern.
    for (const pat of PATTERNS) {
      pat.regex.lastIndex = 0;
      let match;
      while ((match = pat.regex.exec(line)) !== null) {
        console.log(`${file}:${i + 1}: ${pat.label} — "${match[0]}"`);
        totalFindings++;
      }
    }

    // Check internal hostnames.
    INTERNAL_HOSTNAME_RE.lastIndex = 0;
    let hostMatch;
    while ((hostMatch = INTERNAL_HOSTNAME_RE.exec(line)) !== null) {
      const hostname = hostMatch[0].toLowerCase();
      const allowed = ALLOWED_HOST_PATTERNS.some((re) => re.test(hostname));
      if (!allowed) {
        // Skip noqa-annotated lines (private repos only).
        if (ALLOW_NOQA && /# noqa: internal-ref/.test(line)) continue;
        console.log(
          `${file}:${i + 1}: non-allowed internal hostname — "${hostname}"`,
        );
        totalFindings++;
      }
    }
  }
}

if (totalFindings > 0) {
  console.log(`\n${totalFindings} internal reference(s) found.`);
  process.exit(1);
}

console.log("No internal references found.");
process.exit(0);
