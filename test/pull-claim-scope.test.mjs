// Offline unit test for issue #418: grid_pull must attach the session's anon
// claim token only to the entity that token was minted for.
//
// The bug: runPull fell back to ctx.state.lastAnonClaim.token whenever the call
// carried no claim_token, even when entity_id named a different entity. That
// sent a capability token to a route with no use for it.
//
// These are OFFLINE tests: fetch is mocked, so they prove:
//   1. Pulling a regular entity after an anon drop sends no claim_token.
//   2. Pulling the anon drop itself (explicit id, or no id) still sends it.
//   3. An explicit claim_token argument passes through unchanged.
//   4. With no remembered entity_id, the token's `ent` claim decides.
//
// What they do NOT prove: that the live API refuses or ignores a mismatched
// token. That is cloudgrid-io/cloudgrid#5511's server-side test.
//
// Run: node test/pull-claim-scope.test.mjs

import { runPull, anonClaimTokenFor } from "../src/tools/deploy.js";

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

function makeCtx(lastAnonClaim) {
  return {
    edition: "web",
    state: { pendingLoginCode: null, lastAnonClaim, lastDrop: null, anonCookie: null },
    getToken: async () => "user-jwt",
    getActiveGrid: async () => "my-grid",
  };
}

let calls = [];
const realFetch = globalThis.fetch;
function installFetch() {
  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null });
    return new Response(
      JSON.stringify({ entity_id: "x", slug: "x", owner: { is_you: true }, capabilities: { replug: true } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
}

function fakeJwt(payload) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(payload)}.sig`;
}

try {
  // 1. A regular entity pulled after an anon drop in the same session.
  installFetch();
  await runPull(makeCtx({ token: "anon-tok", entity_id: "anon-ent", url: null }), { entity_id: "regular-ent" });
  check("regular entity: one pickup request", calls.length === 1);
  check("regular entity: path names the regular entity", calls[0]?.url.includes("/entities/regular-ent/pickup"));
  check("regular entity: no claim_token in the body", calls[0]?.body && !("claim_token" in calls[0].body));

  // 2a. The anon drop itself, by explicit id.
  installFetch();
  await runPull(makeCtx({ token: "anon-tok", entity_id: "anon-ent", url: null }), { entity_id: "anon-ent" });
  check("anon drop (explicit id): claim_token sent", calls[0]?.body?.claim_token === "anon-tok");

  // 2b. The anon drop itself, no id (falls back to the remembered entity).
  installFetch();
  await runPull(makeCtx({ token: "anon-tok", entity_id: "anon-ent", url: null }), {});
  check("anon drop (no id): path names the drop", calls[0]?.url.includes("/entities/anon-ent/pickup"));
  check("anon drop (no id): claim_token sent", calls[0]?.body?.claim_token === "anon-tok");

  // 3. An explicit claim_token argument passes through unchanged, for any entity.
  installFetch();
  await runPull(makeCtx({ token: "anon-tok", entity_id: "anon-ent", url: null }), {
    entity_id: "regular-ent",
    claim_token: "explicit-tok",
  });
  check("explicit claim_token: passed through unchanged", calls[0]?.body?.claim_token === "explicit-tok");

  // 4. No remembered entity_id: the token's `ent` claim decides.
  const entTok = fakeJwt({ ent: "anon-ent" });
  installFetch();
  await runPull(makeCtx({ token: entTok, entity_id: null, url: null }), { entity_id: "regular-ent" });
  check("ent claim, other entity: no claim_token", calls[0]?.body && !("claim_token" in calls[0].body));
  installFetch();
  await runPull(makeCtx({ token: entTok, entity_id: null, url: null }), { entity_id: "anon-ent" });
  check("ent claim, same entity: claim_token sent", calls[0]?.body?.claim_token === entTok);

  // Helper edges.
  check("helper: no claim -> null", anonClaimTokenFor(null, "e") === null);
  check("helper: no entity -> null", anonClaimTokenFor({ token: "t", entity_id: "e" }, null) === null);
  check("helper: opaque token, unknown binding -> null", anonClaimTokenFor({ token: "opaque", entity_id: null }, "e") === null);
} finally {
  globalThis.fetch = realFetch;
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall pull-claim-scope checks passed");
