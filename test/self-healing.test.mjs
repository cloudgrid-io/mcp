// Unit tests for the MCP self-healing behaviour (Task 31 / 0.7.2).
//
// Three surfaces, all offline:
//   1. errorGuidance() — the pure known-code → guidance mapper. Known codes map
//      to actionable agent-facing text; UNKNOWN codes return null so callers
//      leave the raw server error UNCHANGED (no blanket rewriting).
//   2. The LOCAL-edition CLI self-heal rung: a signed-in CREATE that hits the
//      known 400 SCOPE_INVALID platform bug is retried through the bundled CLI.
//      Only local + create + signed-in triggers it; web / anon / edit do NOT.
//      Asserted against the real runPlug via mocked fetch + an injected
//      CLI runner (the deps seam).
//   3. grid_fetch corpus resolution for kind:"rule" (and troubleshooting).
//
// Run: node test/self-healing.test.mjs

import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  errorGuidance,
  parseCliPlugUrl,
  runPlug,
  fetchCorpus,
} from "../src/tools.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// ── fetch mock (mirrors plug-wire.test.mjs) ──────────────────────────────────
const calls = [];
let replies = [];
globalThis.fetch = async (url, opts = {}) => {
  const form = opts.body instanceof FormData ? opts.body : null;
  calls.push({ url: String(url), headers: opts.headers || {}, form, method: opts.method });
  const next = replies.shift() ?? { status: 200, body: {} };
  return new Response(JSON.stringify(next.body), {
    status: next.status,
    headers: { "content-type": "application/json", ...(next.headers || {}) },
  });
};

function makeCtx({ token = null, edition = "local" } = {}) {
  return {
    edition,
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
    canOpenBrowser: false,
    getToken: async () => token,
    getActiveGrid: async () => null,
    saveToken: async () => ({}),
    savedLocationNote: () => "",
    trustedServer: null,
  };
}

// A recording CLI runner: injected via the deps seam so no real CLI is spawned.
function makeCliRunner(stdout) {
  const invocations = [];
  const run = async (args) => {
    invocations.push(args);
    return stdout;
  };
  run.invocations = invocations;
  return run;
}
// A temp-dir maker that stays in-memory-ish (a throwaway path under the OS tmp);
// the runner is mocked so nothing is actually spawned against it, but the
// fallback still writes/cleans files, so give it a real writable dir.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const makeTmp = () => mkdtemp(join(tmpdir(), "cloudgrid-selfheal-test-"));

const SCOPE_INVALID_400 = {
  status: 400,
  body: { error: { code: "SCOPE_INVALID", message: "scope=personal, visibility=grid" } },
};

try {
  // ═══ 1. errorGuidance mapping ══════════════════════════════════════════════

  // 400 SCOPE_INVALID — local create → CLI-fallback wording.
  {
    const g = errorGuidance({ status: 400, code: "SCOPE_INVALID", edition: "local", isEdit: false, isAnon: false, signedIn: true });
    check("SCOPE_INVALID local create → names the known platform issue", /Known platform issue/.test(g));
    check("SCOPE_INVALID local create → announces the CLI fallback", /bundled CloudGrid CLI/.test(g));
  }
  // 400 SCOPE_INVALID — web create → do-not-retry / do-not-anon wording.
  {
    const g = errorGuidance({ status: 400, code: "SCOPE_INVALID", edition: "web", isEdit: false, isAnon: false, signedIn: true });
    check("SCOPE_INVALID web create → names the known platform issue", /Known platform issue/.test(g));
    check("SCOPE_INVALID web create → re-plug of existing still works", /Re-plug of an existing entity still works/.test(g));
    check("SCOPE_INVALID web create → do NOT retry with other parameters", /do NOT retry with other parameters/.test(g));
    check("SCOPE_INVALID web create → do NOT fall back to anonymous", /do NOT fall back to anonymous/.test(g));
    check("SCOPE_INVALID web create → does NOT mention a CLI fallback", !/CLI/.test(g));
  }
  // 400 SCOPE_INVALID on an EDIT is not the create bug → no guidance.
  check(
    "SCOPE_INVALID on an edit → no guidance (not the create bug)",
    errorGuidance({ status: 400, code: "SCOPE_INVALID", edition: "local", isEdit: true }) === null,
  );
  // 400 SCOPE_INVALID already anon → no guidance.
  check(
    "SCOPE_INVALID on the anon wire → no guidance",
    errorGuidance({ status: 400, code: "SCOPE_INVALID", edition: "local", isEdit: false, isAnon: true }) === null,
  );

  // 429 anon cap.
  {
    const g = errorGuidance({ status: 429 });
    check("429 → do not retry today", /Do not retry today/.test(g));
    check("429 → not a sign-in problem", /not treat this as a sign-in problem/.test(g));
    check("429 → use signed-in path if signed in", /use the signed-in path instead of anonymous/.test(g));
  }

  // 409 edit-rejected and 401 edit → have concise guidance.
  check("409 → guidance present", /cannot be updated right now/.test(errorGuidance({ status: 409, isEdit: true }) || ""));
  check("401 edit → guidance mentions authorization", /did not authorize|Sign in/.test(errorGuidance({ status: 401, isEdit: true }) || ""));
  check("401 create → offers the anonymous fallback (not-authenticated flow)", /publish anonymously now|anon: true/.test(errorGuidance({ status: 401, isEdit: false }) || ""));

  // UNKNOWN 4xx codes pass through unchanged (null) — they're client-side
  // conditions, not bugs, so no rewriting and no report offer.
  check("unknown 400 code → null (pass through unchanged)", errorGuidance({ status: 400, code: "SOME_NEW_ERROR" }) === null);
  check("plain 400 with no code → null", errorGuidance({ status: 400 }) === null);

  // ═══ 2. parseCliPlugUrl ════════════════════════════════════════════════════
  check(
    "parseCliPlugUrl extracts the live URL from CLI stdout",
    parseCliPlugUrl("Building…\nDeployed!\nOutlet: https://demo.atomic.cloudgrid.io\n") ===
      "https://demo.atomic.cloudgrid.io",
  );
  check(
    "parseCliPlugUrl takes the LAST cloudgrid.io URL (final = deployed)",
    parseCliPlugUrl("log https://build.cloudgrid.io/x\nLive: https://demo.atomic.cloudgrid.io") ===
      "https://demo.atomic.cloudgrid.io",
  );
  check("parseCliPlugUrl strips trailing punctuation", parseCliPlugUrl("Live: https://a.cloudgrid.io.") === "https://a.cloudgrid.io");
  check("parseCliPlugUrl returns null when no URL", parseCliPlugUrl("nothing here") === null);

  // ═══ 3. CLI self-heal rung — TRIGGER cases ════════════════════════════════

  // runPlug: local + signed-in + create + SCOPE_INVALID → CLI fallback fires.
  {
    calls.length = 0;
    replies = [SCOPE_INVALID_400];
    const ctx = makeCtx({ token: "jwt", edition: "local" });
    const run = makeCliRunner("Live: https://healed.atomic.cloudgrid.io\n");
    const res = await runPlug(
      ctx,
      { artifact_files: [{ path: "index.html", content: "<h1>hi</h1>" }] },
      { run, makeTmp },
    );
    check("runPlug local authed create SCOPE_INVALID → CLI invoked", run.invocations.length === 1);
    check(
      "runPlug fallback runs `plug <dir> --no-clipboard --no-notify`",
      run.invocations[0]?.[0] === "plug" &&
        run.invocations[0]?.includes("--no-clipboard") &&
        run.invocations[0]?.includes("--no-notify"),
    );
    check("runPlug fallback returns the CLI-parsed URL as success", res.structured.url === "https://healed.atomic.cloudgrid.io");
    check("runPlug fallback marks via=cli-fallback", res.structured.via === "cli-fallback");
    check("runPlug fallback text notes the CLI recovery", /bundled CloudGrid CLI/.test(res.text));
  }

  // runPlug via the inline `html` single-file path: same trigger, same self-heal.
  {
    calls.length = 0;
    replies = [SCOPE_INVALID_400];
    const ctx = makeCtx({ token: "jwt", edition: "local" });
    const run = makeCliRunner("Outlet: https://drop-healed.atomic.cloudgrid.io\n");
    const res = await runPlug(ctx, { html: "<h1>hi</h1>" }, { run, makeTmp });
    check("runPlug html local authed create SCOPE_INVALID → CLI invoked", run.invocations.length === 1);
    check("runPlug html fallback returns the CLI-parsed URL", res.structured.url === "https://drop-healed.atomic.cloudgrid.io");
  }

  // ═══ 3b. CLI self-heal rung — NON-trigger cases (must NOT fire) ════════════

  // 0.8.0 regression guard: a NORMAL authed create now succeeds server-side
  // (SCOPE_INVALID is durably fixed), so a signed-in local create that returns a
  // clean 201 must NOT invoke the CLI fallback at all — the self-heal rung stays
  // dormant on the happy path.
  {
    calls.length = 0;
    replies = [
      {
        status: 201,
        body: {
          entity_id: "ent-ok",
          slug: "ok",
          grid: "atomic",
          url: "https://ok.atomic.cloudgrid.io",
          status: "live",
        },
      },
    ];
    const ctx = makeCtx({ token: "jwt", edition: "local" });
    const run = makeCliRunner("should not run");
    const res = await runPlug(
      ctx,
      { artifact_files: [{ path: "index.html", content: "<h1>hi</h1>" }] },
      { run, makeTmp },
    );
    check("runPlug normal authed create (201) → CLI NOT invoked (self-heal dormant)", run.invocations.length === 0);
    check("runPlug normal authed create → returns the direct-API URL", res.structured.url === "https://ok.atomic.cloudgrid.io");
    check("runPlug normal authed create → NOT marked via=cli-fallback", res.structured.via !== "cli-fallback");
  }

  // web edition → no CLI fallback; the error surfaces with web guidance.
  {
    calls.length = 0;
    replies = [SCOPE_INVALID_400];
    const ctx = makeCtx({ token: "jwt", edition: "web" });
    const run = makeCliRunner("should not run");
    let err = null;
    try {
      await runPlug(ctx, { artifact_files: [{ path: "index.html", content: "<h1>hi</h1>" }] }, { run, makeTmp });
    } catch (e) {
      err = e;
    }
    check("runPlug WEB SCOPE_INVALID → CLI NOT invoked", run.invocations.length === 0);
    check("runPlug WEB SCOPE_INVALID → throws with web guidance", err !== null && /do NOT fall back to anonymous/.test(err.message));
  }

  // anonymous create → CLI fallback must NOT fire.
  {
    calls.length = 0;
    replies = [SCOPE_INVALID_400];
    const ctx = makeCtx({ token: null, edition: "local" }); // no token → anon wire
    const run = makeCliRunner("should not run");
    let err = null;
    try {
      await runPlug(ctx, { artifact_files: [{ path: "index.html", content: "x" }], anon: true }, { run, makeTmp });
    } catch (e) {
      err = e;
    }
    check("runPlug ANON SCOPE_INVALID → CLI NOT invoked", run.invocations.length === 0);
    check("runPlug ANON SCOPE_INVALID → still throws (no self-heal)", err !== null);
  }

  // edit (target_entity_id) that 400s → CLI fallback must NOT fire (never edits).
  {
    calls.length = 0;
    replies = [SCOPE_INVALID_400];
    const ctx = makeCtx({ token: "jwt", edition: "local" });
    const run = makeCliRunner("should not run");
    let err = null;
    try {
      await runPlug(
        ctx,
        { artifact_files: [{ path: "index.html", content: "x" }], target_entity_id: "ent-9" },
        { run, makeTmp },
      );
    } catch (e) {
      err = e;
    }
    check("runPlug EDIT SCOPE_INVALID → CLI NOT invoked (never edits)", run.invocations.length === 0);
    check("runPlug EDIT SCOPE_INVALID → throws", err !== null);
  }

  // a DIFFERENT local authed create error (not SCOPE_INVALID) → no fallback,
  // unknown code passes through unchanged.
  {
    calls.length = 0;
    replies = [{ status: 400, body: { error: { code: "SOMETHING_ELSE", message: "nope" } } }];
    const ctx = makeCtx({ token: "jwt", edition: "local" });
    const run = makeCliRunner("should not run");
    let err = null;
    try {
      await runPlug(ctx, { artifact_files: [{ path: "index.html", content: "x" }] }, { run, makeTmp });
    } catch (e) {
      err = e;
    }
    check("runPlug non-SCOPE_INVALID error → CLI NOT invoked", run.invocations.length === 0);
    check("runPlug unknown code → error passes through unchanged (no guidance appended)", err !== null && /nope/.test(err.message) && !/—/.test(err.message));
  }

  // ═══ 4. grid_fetch corpus resolution for kind:"rule" ════════════════════
  {
    const corpusRoot = fileURLToPath(new URL("../src/corpus/", import.meta.url));
    const rulesDir = join(corpusRoot, "rules");
    const preexisted = existsSync(rulesDir);
    const fixture = join(rulesDir, "__selfheal_fixture__.md");
    mkdirSync(rulesDir, { recursive: true });
    writeFileSync(fixture, "# Rule fixture\nDo not fall back to anonymous.\n");
    try {
      const content = fetchCorpus("rule", "__selfheal_fixture__");
      check("fetchCorpus resolves kind:\"rule\" → rules/<name>.md", typeof content === "string" && /Do not fall back to anonymous/.test(content));
      // troubleshooting kind is also mapped (dir may be absent → null, but no throw).
      check("fetchCorpus kind:\"troubleshooting\" is a known kind (no throw)", (() => { try { fetchCorpus("troubleshooting", "x"); return true; } catch { return false; } })());
    } finally {
      rmSync(fixture, { force: true });
      if (!preexisted) rmSync(rulesDir, { recursive: true, force: true });
    }
  }
} catch (err) {
  console.error("test harness error:", err);
  failures++;
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll self-healing checks passed.");
