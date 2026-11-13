#!/usr/bin/env node
// scripts/build-openai-plugin.mjs: build the ChatGPT plugin ZIP that is
// uploaded to the OpenAI plugin portal (#503).
//
// The package is openai-plugin/cloudgrid/ (plugin.json + mcp.json) plus the
// 512 px brand icon from assets/, which goes in as assets/logo.png. The
// plugin.json version in the ZIP is package.json's version; the committed
// file keeps the last version that was uploaded.
//
// Usage: node scripts/build-openai-plugin.mjs [--out <zip path>]
// Default output: openai-plugin/dist/cloudgrid-chatgpt-plugin.zip (gitignored).

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync, strToU8 } from "fflate";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = join(root, "openai-plugin", "cloudgrid");

export const LOGO_SOURCE = join(root, "assets", "cloudgrid-icon-512.png");
export const DEFAULT_OUT = join(root, "openai-plugin", "dist", "cloudgrid-chatgpt-plugin.zip");

// The files that go into the ZIP, keyed by their path inside it.
export function pluginFiles() {
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  const plugin = JSON.parse(readFileSync(join(pkgDir, "plugin.json"), "utf8"));
  plugin.version = version;
  return {
    "plugin.json": strToU8(JSON.stringify(plugin, null, 2) + "\n"),
    "mcp.json": readFileSync(join(pkgDir, "mcp.json")),
    "assets/logo.png": readFileSync(LOGO_SOURCE),
  };
}

export function buildZip(out = DEFAULT_OUT) {
  const zip = zipSync(pluginFiles(), { level: 9 });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, zip);
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--out");
  const out = buildZip(i >= 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : DEFAULT_OUT);
  console.log(`wrote ${out}`);
}
