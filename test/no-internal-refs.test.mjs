// Tests for the internal-reference guard (.github/scripts/no-internal-refs.mjs).
//
// These drive the SAME scanLine() the CI script uses (it imports it directly),
// so a green test here means the check itself behaves this way — not a parallel
// reimplementation. See mcp#294 for the two false positives that motivated the
// boundary fixes.
//
// Every changed rule is tested in BOTH directions: a former false positive that
// must now pass (no finding) AND a true positive that must still fail (finding).
// A rule that no longer fires at all is a deletion, not a fix.

import { test } from "node:test";
import assert from "node:assert/strict";
import { scanLine } from "../.github/scripts/no-internal-refs.mjs";

function rulesFired(line) {
  return scanLine(line).map((f) => f.rule);
}
function matchesFor(line, rule) {
  return scanLine(line)
    .filter((f) => f.rule === rule)
    .map((f) => f.match);
}

// ---------------------------------------------------------------------------
// internal-hostname — the #303 false positive
// ---------------------------------------------------------------------------

test("internal-hostname: minified property access is NOT flagged (t.local)", () => {
  // The exact byte sequence from the built artifact src/widgets/grid-login.html:81
  const line = `function Go(t){let r=Zc({precision:t.precision}),n=["Z"];t.local&&n.push(""),`;
  assert.deepEqual(matchesFor(line, "internal-hostname"), []);
});

test("internal-hostname: other minified property accesses are NOT flagged", () => {
  // The next dependency bump could pick any of these — each is a property
  // access preceded by an identifier char / operator, not a hostname.
  for (const line of ["x=n.lan;", "a;b.internal", "y&&o.corp&&z", "z=e.intranet"]) {
    assert.deepEqual(
      matchesFor(line, "internal-hostname"),
      [],
      `should not flag: ${line}`,
    );
  }
});

test("internal-hostname: a genuine leak in the SAME kind of built artifact IS flagged", () => {
  // Coverage that must NOT be lost: a real hostname inlined by esbuild would
  // appear as a string literal / URL / bare token, not a property access.
  const cases = [
    [`n=["Z"];a=fetch("https://secrets.internal/keys");`, "secrets.internal"],
    [`var u="admin.corp";`, "admin.corp"],
    [`return\`db.lan\`;`, "db.lan"],
  ];
  for (const [line, expected] of cases) {
    assert.deepEqual(
      matchesFor(line, "internal-hostname"),
      [expected],
      `should flag ${expected} in: ${line}`,
    );
  }
});

test("internal-hostname: authored-source hosts still flagged (prose, url, leading ws)", () => {
  assert.deepEqual(matchesFor("connect to db.lan for backups", "internal-hostname"), ["db.lan"]);
  assert.deepEqual(matchesFor("  api.intranet", "internal-hostname"), ["api.intranet"]);
  assert.deepEqual(matchesFor("see https://build.internal/ci", "internal-hostname"), ["build.internal"]);
});

test("internal-hostname: allowlisted hosts are not flagged", () => {
  for (const line of [
    "https://app.cloudgrid.io",
    "http://localhost:3000",
    "127.0.0.1:8080",
  ]) {
    assert.deepEqual(matchesFor(line, "internal-hostname"), [], line);
  }
});

// ---------------------------------------------------------------------------
// decision-number — the #293 false positive
// ---------------------------------------------------------------------------

test("decision-number: a date is NOT flagged (decision 2026-08-23)", () => {
  assert.deepEqual(matchesFor("founder decision 2026-08-23", "decision-number"), []);
  assert.deepEqual(matchesFor("decision 2026", "decision-number"), []);
});

test("decision-number: a real three-digit reference IS still flagged, any case", () => {
  assert.deepEqual(matchesFor("Decision 062", "decision-number"), ["Decision 062"]);
  assert.deepEqual(matchesFor("decision 062", "decision-number"), ["decision 062"]);
  assert.deepEqual(matchesFor("DECISION 062", "decision-number"), ["DECISION 062"]);
  assert.deepEqual(matchesFor("see decision 067.", "decision-number"), ["decision 067"]);
});

// ---------------------------------------------------------------------------
// Audit of the unchanged rules — proof they still fire (true positives),
// so the refactor did not silently break them.
// ---------------------------------------------------------------------------

test("unchanged literal rules still fire", () => {
  assert.ok(rulesFired("git clone atomicfuse/cloudgrid").includes("private-repo"));
  assert.ok(rulesFired("see docs/decisions/0001.md").includes("decision-docs-path"));
  assert.ok(rulesFired("see docs/strategy/plan.md").includes("strategy-docs-path"));
  assert.ok(rulesFired("per the cli-ux-spec").includes("cli-ux-spec"));
  assert.ok(rulesFired("tracked in BL1234").includes("ticket-id"));
});

test("ticket-id remains bounded on both sides", () => {
  // Bounded left and right already (\bBL\d+\b) — an embedded BL### does not fire.
  assert.deepEqual(matchesFor("TABLE12 rows", "ticket-id"), []);
  assert.deepEqual(matchesFor("fixed BL42 today", "ticket-id"), ["BL42"]);
});
