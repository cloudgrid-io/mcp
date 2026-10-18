// Shared helpers for the live smoke scripts (smoke-drop, smoke-redrop,
// smoke-claim). These run against the live API on demand and are not in CI.
//
// Secrets come only from environment variables. Nothing here prints a token:
// every tool output goes through redact() before it is logged.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
export function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}
export const failureCount = () => failures;

// Ends the run: non-zero exit on any failed check.
export function finish(passMessage) {
  if (failures > 0) {
    console.log(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log(`\n${passMessage}`);
}

export const textOf = (r) => r?.content?.[0]?.text ?? "";

// Read a non-empty env var, or null.
export function env(name) {
  const v = process.env[name];
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

// Values that must never reach stdout. Filled from the env vars the scripts
// read and from tokens that come back in tool results.
const secrets = new Set();
export function registerSecret(value) {
  if (typeof value === "string" && value.length > 0) secrets.add(value);
}

// Mask known secrets, any `token=` query parameter (claim URLs carry one), and
// any `owner_token` / `claim_token` value echoed in text.
export function redact(text) {
  let out = String(text ?? "");
  for (const s of secrets) out = out.split(s).join("[redacted]");
  out = out.replace(/([?&]token=)[^&\s"')]+/gi, "$1[redacted]");
  out = out.replace(/((?:owner|claim)_token["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[redacted]");
  return out;
}

export function logOutput(label, result) {
  console.log(`--- ${label} ---\n${redact(textOf(result))}`);
}

// A CLOUDGRID_HOME for the spawned stdio server.
//
// signedOut: an empty directory, so the run is signed out even on a machine
// that has a signed-in CLI in ~/.cloudgrid.
// signedIn(jwt): a directory holding only a credentials file built from the
// token (mode 0600). The token is never written anywhere else and the
// directory is removed by cleanup().
export function isolatedHome(jwt = null) {
  const dir = mkdtempSync(join(tmpdir(), "cloudgrid-mcp-smoke-"));
  if (jwt) {
    registerSecret(jwt);
    writeFileSync(join(dir, "credentials"), JSON.stringify({ jwt }) + "\n", { mode: 0o600 });
  }
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// A signed-out create must be refused before anything is published: needs_auth
// set, no entity id, no owner token, no URL in the text.
export function assertSignedOutCreateRefused(prefix, res) {
  const s = res?.structuredContent ?? {};
  const text = textOf(res);
  check(`${prefix} signed-out create returned needs_auth`, s.needs_auth === true);
  check(`${prefix} signed-out create is not a tool error`, res?.isError !== true);
  check(`${prefix} signed-out create returned no entity_id`, !s.entity_id);
  check(`${prefix} signed-out create returned no owner_token`, !s.owner_token);
  check(`${prefix} signed-out create returned no live URL`, !/https?:\/\/\S*cloudgrid\.io/.test(text) && !s.url);
  check(`${prefix} signed-out create points at grid_login`, /grid_login/.test(text));
}
