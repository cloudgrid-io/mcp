// Offline unit test for robust content handling on grid_deploy's inline `html`
// single-file path (the hardening folded in from the old drop verb, 0.18.0).
// Verifies: base64-of-HTML decode, garbage rejection, small-fragment wrap, the
// @-prefixed / mistaken-path rejection, and the auth-aware inline size cap.
// Mocks global fetch. Run: node test/content-handling.test.mjs

import { runPlug } from "../src/tools.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

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

// fetch mock: record calls, always reply 200 with a url.
const calls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const form = opts.body instanceof FormData ? opts.body : null;
  calls.push({ url: String(url), headers: opts.headers || {}, form });
  return new Response(
    JSON.stringify({ url: "https://guest.cloudgrid.io/s", slug: "s", grid: null, entity_id: "e1" }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
};

const lastForm = () => calls[calls.length - 1].form;
// Read the Blob type + text of the "artifact" form part.
async function artifactPart() {
  const part = lastForm().get("artifact");
  const text = await part.text();
  return { type: part.type, text };
}

const FULL_HTML = "<!doctype html>\n<html><head><title>t</title></head><body><h1>Hi</h1></body></html>";

try {
  // 1. base64-of-HTML passed as `html` → decoded, published as text/html, NOT wrapped.
  {
    const b64 = Buffer.from(FULL_HTML, "utf8").toString("base64");
    const before = calls.length;
    await runPlug(makeCtx(), { html: b64, anon: true });
    check("base64 html → published (a fetch happened)", calls.length === before + 1);
    const { type, text } = await artifactPart();
    check("base64 html → text/html", type === "text/html");
    check("base64 html → materialized as index.html", lastForm().get("artifact").name === "index.html");
    check("base64 html → decoded, not wrapped in a shell", text === FULL_HTML);
    check("base64 html → NOT a base64 wall of text", !text.includes(b64));
  }

  // 2. Non-HTML large blob that is NOT decodable → throws, does NOT publish.
  {
    const notHtml = "This is a plain sentence that is not HTML. ".repeat(500);
    const before = calls.length;
    let err = null;
    try {
      await runPlug(makeCtx(), { html: notHtml, anon: true });
    } catch (e) {
      err = e;
    }
    check("large non-HTML blob → throws", err !== null);
    check("large non-HTML blob → did NOT publish", calls.length === before);
    check("error says it does not look like an HTML document", /HTML document/.test(err?.message || ""));
  }

  // 3. Small HTML fragment/snippet → still wrapped-and-published.
  {
    const before = calls.length;
    await runPlug(makeCtx(), { html: "<h1>hello snippet</h1>", anon: true });
    check("small fragment → published", calls.length === before + 1);
    const { type, text } = await artifactPart();
    check("small fragment → text/html", type === "text/html");
    check("small fragment → wrapped in a full document", /^<!doctype html>/i.test(text) && text.includes("hello snippet"));
  }

  // 4. A file-path-looking `html` (bare or @-prefixed) → rejected, steer to `path`.
  //    The single-file html path takes CONTENT, never a path — protects against
  //    publishing a file path as page text.
  {
    const before = calls.length;
    let err = null;
    try {
      await runPlug(makeCtx(), { html: "@/home/claude/deck.html", anon: true });
    } catch (e) {
      err = e;
    }
    check("@-path html → throws (never published)", err !== null && calls.length === before);
    check("@-path html → error steers to `path`", /file path/i.test(err?.message || "") && /`path`/.test(err?.message || ""));

    let err2 = null;
    try {
      await runPlug(makeCtx(), { html: "/home/claude/missing.html", anon: true });
    } catch (e) {
      err2 = e;
    }
    check("bare path-looking html → error names the path", /\/home\/claude\/missing\.html/.test(err2?.message || ""));
  }

  // 5. path-looking html on the web edition → hosted error, steers to inline HTML.
  {
    let err = null;
    try {
      await runPlug(makeCtx({ edition: "web" }), { html: "/home/claude/deck.html", anon: true });
    } catch (e) {
      err = e;
    }
    check("web path-looking html → error mentions inline HTML", /raw HTML inline/i.test(err?.message || ""));
  }

  // 6. Auth-aware inline size cap.
  {
    // anon inline > 2MB → anon message.
    const big = "<!doctype html><html><body>" + "a".repeat(2_100_000) + "</body></html>";
    let err = null;
    try {
      await runPlug(makeCtx(), { html: big, anon: true });
    } catch (e) {
      err = e;
    }
    check("anon inline > 2MB → throws anon message", /Anonymous drops are capped at 2 MB/.test(err?.message || ""));

    // authed inline between 2MB and AUTHED cap → allowed.
    const before = calls.length;
    await runPlug(makeCtx({ token: "jwt-1" }), { html: big });
    check("authed inline > 2MB (< 25MB) → allowed (published)", calls.length === before + 1);

    // authed over AUTHED cap → authed-limit message.
    const huge = "<!doctype html><html><body>" + "a".repeat(26_000_000) + "</body></html>";
    let err2 = null;
    try {
      await runPlug(makeCtx({ token: "jwt-1" }), { html: huge });
    } catch (e) {
      err2 = e;
    }
    check("authed inline > 25MB → throws authed-limit message", /capped at 25 MB/.test(err2?.message || ""));
  }
} finally {
  globalThis.fetch = realFetch;
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll content-handling checks passed (offline).");
