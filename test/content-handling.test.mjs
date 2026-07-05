// Offline unit test for robust content handling in runDrop (0.8.4).
// Verifies: base64-of-HTML decode (inline + via path), garbage rejection,
// small-fragment wrap preserved, @-prefixed / mistaken-path handling, the
// path→text/html content-type sniff, and the auth-aware inline size cap.
// Mocks global fetch and the fs deps seam. Run: node test/content-handling.test.mjs

import { runDrop } from "../src/tools.js";

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
    await runDrop(makeCtx(), { html: b64, anonymous: true });
    check("base64 html → published (a fetch happened)", calls.length === before + 1);
    const { type, text } = await artifactPart();
    check("base64 html → text/html", type === "text/html");
    check("base64 html → decoded, not wrapped in a shell", text === FULL_HTML);
    check("base64 html → NOT a base64 wall of text", !text.includes(b64));
  }

  // 2. base64-of-HTML in a file read via `path` → decoded, text/html.
  {
    const b64 = Buffer.from(FULL_HTML, "utf8").toString("base64");
    const deps = { readFile: async () => Buffer.from(b64, "utf8"), fsExists: () => true };
    await runDrop(makeCtx(), { path: "/tmp/deck_b64.txt", anonymous: true }, deps);
    const { type, text } = await artifactPart();
    check("base64-in-file via path → text/html", type === "text/html");
    check("base64-in-file via path → decoded HTML", text === FULL_HTML);
  }

  // 3. Non-HTML large blob that is NOT decodable → throws, does NOT publish.
  {
    const garbage = "x".repeat(20000); // large, not base64 (x-only IS base64 alphabet though)
    // Use content that is clearly not base64-of-html and large.
    const notHtml = "This is a plain sentence that is not HTML. ".repeat(500);
    const before = calls.length;
    let err = null;
    try {
      await runDrop(makeCtx(), { html: notHtml, anonymous: true });
    } catch (e) {
      err = e;
    }
    check("large non-HTML blob → throws", err !== null);
    check("large non-HTML blob → did NOT publish", calls.length === before);
    check("error mentions no artifact_files", /artifact_files/.test(err?.message || ""));
    void garbage;
  }

  // 4. Small HTML fragment/snippet → still wrapped-and-published.
  {
    const before = calls.length;
    await runDrop(makeCtx(), { html: "<h1>hello snippet</h1>", anonymous: true });
    check("small fragment → published", calls.length === before + 1);
    const { type, text } = await artifactPart();
    check("small fragment → text/html", type === "text/html");
    check("small fragment → wrapped in a full document", /^<!doctype html>/i.test(text) && text.includes("hello snippet"));
  }

  // 5a. @-prefixed path (local, file exists) → read as path.
  {
    const deps = { readFile: async () => Buffer.from(FULL_HTML, "utf8"), fsExists: () => true };
    await runDrop(makeCtx(), { html: "@/home/claude/deck.html", anonymous: true }, deps);
    const { type, text } = await artifactPart();
    check("@-path (exists) → read from disk as text/html", type === "text/html" && text === FULL_HTML);
  }
  // 5b. @-prefixed path (local, file missing) → clear error naming the path.
  {
    const deps = { fsExists: () => false };
    let err = null;
    try {
      await runDrop(makeCtx(), { html: "@/home/claude/missing.html", anonymous: true }, deps);
    } catch (e) {
      err = e;
    }
    check("@-path (missing) → throws naming the path", /\/home\/claude\/missing\.html/.test(err?.message || ""));
  }
  // 5c. path-looking html on web edition → hosted error, steers to inline.
  {
    let err = null;
    try {
      await runDrop(makeCtx({ edition: "web" }), { html: "/home/claude/deck.html", anonymous: true });
    } catch (e) {
      err = e;
    }
    check("web path-looking html → hosted error, mentions inline", /raw HTML inline/i.test(err?.message || ""));
  }

  // 6. path to a real .html file (plain HTML, no base64) → uploaded as text/html.
  {
    const deps = { readFile: async () => Buffer.from(FULL_HTML, "utf8"), fsExists: () => true };
    await runDrop(makeCtx(), { path: "/tmp/index.html", anonymous: true }, deps);
    const { type, text } = await artifactPart();
    check("path .html → text/html Blob type", type === "text/html");
    check("path .html → bytes unchanged", text === FULL_HTML);
  }

  // 7. Auth-aware cap.
  {
    // anon inline > 2MB → anon message.
    const big = "<!doctype html><html><body>" + "a".repeat(2_100_000) + "</body></html>";
    let err = null;
    try {
      await runDrop(makeCtx(), { html: big, anonymous: true });
    } catch (e) {
      err = e;
    }
    check("anon inline > 2MB → throws anon message", /Anonymous drops are capped at 2 MB/.test(err?.message || ""));

    // authed inline between 2MB and AUTHED cap → allowed.
    const before = calls.length;
    await runDrop(makeCtx({ token: "jwt-1" }), { html: big });
    check("authed inline > 2MB (< 25MB) → allowed (published)", calls.length === before + 1);

    // authed over AUTHED cap → authed-limit message.
    const huge = "<!doctype html><html><body>" + "a".repeat(26_000_000) + "</body></html>";
    let err2 = null;
    try {
      await runDrop(makeCtx({ token: "jwt-1" }), { html: huge });
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
