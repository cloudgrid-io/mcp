// Boot-time staleness self-check (local edition). The .mcpb never auto-updates,
// so a stale install must become a one-line, model-relayable reinstall note —
// and the check must NEVER break boot (offline/slow/error → null, silently).
//
// Run: node test/staleness.test.mjs
import { compareSemver, checkForNewerVersion, stalenessNote } from "../src/staleness.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "ok  " : "FAIL"} ${label}`); if (!cond) failures++; };

const registryReply = (version, { status = 200 } = {}) => async () =>
  new Response(JSON.stringify({ version }), { status, headers: { "content-type": "application/json" } });

try {
  // compareSemver
  check("semver: older", compareSemver("0.20.25", "0.20.27") === -1);
  check("semver: newer", compareSemver("0.21.0", "0.20.99") === 1);
  check("semver: equal", compareSemver("1.2.3", "1.2.3") === 0);
  check("semver: garbage → null", compareSemver("abc", "1.2.3") === null && compareSemver("1.2", "1.2.3") === null);

  // behind → info
  const behind = await checkForNewerVersion("0.20.20", { fetchImpl: registryReply("0.20.27") });
  check("behind: reports current/latest", behind?.behind === true && behind.current === "0.20.20" && behind.latest === "0.20.27");

  // up to date / ahead → null
  check("up to date → null", (await checkForNewerVersion("0.20.27", { fetchImpl: registryReply("0.20.27") })) === null);
  check("ahead (dev build) → null", (await checkForNewerVersion("0.21.0", { fetchImpl: registryReply("0.20.27") })) === null);

  // registry errors → null, never throws
  check("HTTP 500 → null", (await checkForNewerVersion("0.20.20", { fetchImpl: registryReply("x", { status: 500 }) })) === null);
  check("network error → null", (await checkForNewerVersion("0.20.20", { fetchImpl: async () => { throw new Error("offline"); } })) === null);
  check("bad payload → null", (await checkForNewerVersion("0.20.20", { fetchImpl: async () => new Response("{}", { status: 200 }) })) === null);
  // timeout: fetch that never resolves before the abort fires
  const hang = (url, { signal }) => new Promise((_, rej) => { signal.addEventListener("abort", () => rej(new Error("aborted"))); });
  check("timeout → null", (await checkForNewerVersion("0.20.20", { fetchImpl: hang, timeoutMs: 10 })) === null);

  // the note
  const note = stalenessNote({ current: "0.20.20", latest: "0.20.27", behind: true });
  check("note: names both versions", /v0\.20\.20/.test(note) && /v0\.20\.27/.test(note));
  check("note: explains the .mcpb never auto-updates", /never auto-updates/.test(note));
  check("note: points at the release download", /releases\/latest/.test(note));
  check("note: null when not behind", stalenessNote(null) === null && stalenessNote({ behind: false }) === null);

  console.log(failures === 0 ? "\nAll staleness checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
} catch (err) {
  console.error("staleness test crashed:", err);
  process.exit(1);
}
