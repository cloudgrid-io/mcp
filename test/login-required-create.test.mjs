// #395 — close the anonymous CREATE path: every published entity must be owned
// by a signed-in user, and the publisher is logged.
//
// The load-bearing assertions here are NEGATIVE: on each refused path we assert
// NO plug request was made (globalThis.__PLUG_CALLS__ === 0). A test that only
// inspects the returned text would pass a tool that published first and refused
// afterwards — the exact trap mcp#336 called out.
//
// Scope guard (the thing most likely to be got wrong): the gate is on CREATE
// ONLY. Existing anonymous drops live in the `guest` org and are edited via an
// `owner_token`, not a login (deploy.js:1892-1894). So two regression guards run
// FIRST and must stay green before AND after the change:
//   - an existing guest drop still re-plugs with its owner_token (no login);
//   - grid_pull still claims an anon drop with its claim_token.
//
// Run: node test/login-required-create.test.mjs
import { registerTools } from "../src/tools.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "ok  " : "FAIL"} ${label}`); if (!cond) failures++; };

// Minimal server shim: capture the registered handlers by name.
function capture(ctx, names = ["grid_plug", "grid_pull", "grid_login"]) {
  const handlers = {};
  const server = {
    registerTool: (name, _cfg, h) => { if (names.includes(name)) handlers[name] = h; },
    tool: () => {},
    registerResource: () => {},
  };
  registerTools(server, ctx);
  return handlers;
}

function makeCtx({ token = null, grids = [], edition = "local" } = {}) {
  return {
    edition,
    state: { pendingLoginCode: null, lastAnonClaim: null, lastDrop: null, anonCookie: null },
    canOpenBrowser: false,
    getToken: async () => token,
    getActiveGrid: async () => (grids[0]?.slug ?? null),
    saveToken: async () => ({}),
    savedLocationNote: () => "",
    logger: null,
  };
}

const HTML = { html: "<h1>hi</h1>" };
const parse = (r) => r?.structuredContent ?? r?.structured ?? {};
const textOf = (r) => r?.content?.[0]?.text ?? "";

// base64url a JSON payload into the middle segment of a fake JWT.
const b64url = (obj) =>
  Buffer.from(JSON.stringify(obj)).toString("base64").replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const USER_ID = "user-abc-123";
const LEAK_EMAIL = "leaky-secret@example.com";
const JWT = `h.${b64url({ sub: USER_ID, email: LEAK_EMAIL })}.s`;

// A fetch mock that RECORDS every request so negative ("no plug call") and
// positive ("owner_token on the wire, no Authorization") assertions are possible.
const realFetch = globalThis.fetch;
globalThis.__PLUG_CALLS__ = 0;
let calls = [];
const resetCalls = () => { calls = []; globalThis.__PLUG_CALLS__ = 0; };
const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } });

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const headers = opts.headers || {};
  if (u.endsWith("/api/v2/grids") || u.endsWith("/api/v2/orgs")) {
    return json({ grids: globalThis.__GRIDS__ ?? [] });
  }
  if (u.includes("/api/v2/plug")) {
    globalThis.__PLUG_CALLS__++;
    const rec = { kind: "plug", url: u, headers, owner_token: null, target_entity_id: null };
    try {
      if (opts.body && typeof opts.body.get === "function") {
        rec.owner_token = opts.body.get("owner_token");
        rec.target_entity_id = opts.body.get("target_entity_id");
      }
    } catch { /* body not FormData */ }
    calls.push(rec);
    return json({ entity_id: "e1", slug: "s1", url: "https://grid-a.cloudgrid.io/s1", grid: "grid-a", status: "live", detection: { kind: "inspiration" } });
  }
  if (u.includes("/pickup")) {
    let body = null;
    try { body = typeof opts.body === "string" ? JSON.parse(opts.body) : null; } catch { /* noop */ }
    calls.push({ kind: "pickup", url: u, headers, body });
    return json({ url: "https://grid-a.cloudgrid.io/s1", slug: "s1", grid: "grid-a", owner: { is_you: true }, capabilities: { replug: true } });
  }
  calls.push({ kind: "other", url: u, headers });
  return json({});
};

const ONE_GRID = [{ slug: "grid-a", name: "A", role: "owner", render_ready: true }];

try {
  // ══ REGRESSION GUARDS FIRST — must be green before AND after the change ══

  // An EXISTING guest drop is edited via its owner_token even when signed in —
  // the entity is not in the caller's grid, so an authed edit would 404. The
  // create gate must NOT touch this path.
  {
    resetCalls();
    globalThis.__GRIDS__ = ONE_GRID;
    const h = capture(makeCtx({ token: JWT, grids: ONE_GRID }));
    await h.grid_plug({ ...HTML, target_entity_id: "guest-e1", owner_token: "otok-123" });
    const plug = calls.find((c) => c.kind === "plug");
    check("REGRESSION owner-token edit: a plug request WAS made", globalThis.__PLUG_CALLS__ === 1);
    check("REGRESSION owner-token edit: owner_token rode the wire", plug?.owner_token === "otok-123");
    check("REGRESSION owner-token edit: target_entity_id rode the wire", plug?.target_entity_id === "guest-e1");
    check("REGRESSION owner-token edit: NO Authorization header (anon wire, signed in)", !("Authorization" in (plug?.headers || {})));
  }

  // grid_pull still claims a pre-cutover anon drop with its claim_token.
  {
    resetCalls();
    globalThis.__GRIDS__ = ONE_GRID;
    const h = capture(makeCtx({ token: JWT, grids: ONE_GRID }));
    const res = await h.grid_pull({ claim_token: "ctok-9", entity_id: "guest-e1" });
    const pickup = calls.find((c) => c.kind === "pickup");
    check("REGRESSION claim: a pickup request WAS made", Boolean(pickup));
    check("REGRESSION claim: claim_token rode the body", pickup?.body?.claim_token === "ctok-9");
    check("REGRESSION claim: entity id is in the pickup path", (pickup?.url || "").includes("guest-e1"));
    check("REGRESSION claim: reports the drop is now owned", parse(res).owner_is_you === true);
  }

  // ══ THE NEW GATE — CREATE requires sign-in ══

  // Unauthenticated create WITH anon:true → refused, nothing published.
  for (const edition of ["local", "web"]) {
    resetCalls();
    globalThis.__GRIDS__ = [];
    const h = capture(makeCtx({ token: null, edition }));
    const res = await h.grid_plug({ ...HTML, anon: true });
    check(`[${edition}] anon:true create did NOT publish`, globalThis.__PLUG_CALLS__ === 0);
    check(`[${edition}] anon:true create returns needs_auth`, parse(res).needs_auth === true);
  }

  // A second anon:true call in the SAME session is STILL refused — there is no
  // "offer once then allow" escape hatch any more (the old authChoiceOffered
  // bypass is gone for guest publishing).
  {
    resetCalls();
    globalThis.__GRIDS__ = [];
    const ctx = makeCtx({ token: null });
    const h = capture(ctx);
    await h.grid_plug({ ...HTML, anon: true });
    await h.grid_plug({ ...HTML, anon: true });
    check("anon:true is refused on EVERY call, not just the first", globalThis.__PLUG_CALLS__ === 0);
  }

  // Unauthenticated create WITHOUT anon → refused (unchanged).
  {
    resetCalls();
    globalThis.__GRIDS__ = [];
    const h = capture(makeCtx({ token: null }));
    const res = await h.grid_plug({ ...HTML });
    check("no-auth create did NOT publish", globalThis.__PLUG_CALLS__ === 0);
    check("no-auth create returns needs_auth", parse(res).needs_auth === true);
  }

  // The signed-out message offers ONLY sign-in — no guest option, no cross-tool
  // hop. mcp#336: offering a path the server won't honour strands the model.
  {
    resetCalls();
    globalThis.__GRIDS__ = [];
    const h = capture(makeCtx({ token: null }));
    const t = textOf(await h.grid_plug({ ...HTML }));
    check("signed-out text routes to grid_login", /grid_login/.test(t));
    check("signed-out text offers NO guest/anonymous option", !/guest/i.test(t) && !/anon/i.test(t));
    check("signed-out text makes no cross-tool hop (no anon: true instruction)", !/anon:\s*true/i.test(t));
    check("signed-out text: §23 voice — no emoji, no exclamation", !/[!]/.test(t) && !/\p{Extended_Pictographic}/u.test(t));
  }

  // Authenticated create publishes into the caller's grid (authed wire).
  {
    resetCalls();
    globalThis.__GRIDS__ = ONE_GRID;
    const h = capture(makeCtx({ token: JWT, grids: ONE_GRID }));
    await h.grid_plug({ ...HTML, grid: "grid-a" });
    const plug = calls.find((c) => c.kind === "plug");
    check("authed create published", globalThis.__PLUG_CALLS__ === 1);
    check("authed create carried the Authorization header", /^Bearer /.test(plug?.headers?.Authorization || ""));
    check("authed create targeted the caller's grid", plug?.headers?.["X-CloudGrid-Grid"] === "grid-a");
    check("authed create did NOT ride the owner-token wire", !plug?.owner_token);
  }

  // Even with anon:true, a SIGNED-IN create goes to the caller's grid on the
  // authed wire — anon no longer selects the guest wire on create.
  {
    resetCalls();
    globalThis.__GRIDS__ = ONE_GRID;
    const h = capture(makeCtx({ token: JWT, grids: ONE_GRID }));
    await h.grid_plug({ ...HTML, grid: "grid-a", anon: true });
    const plug = calls.find((c) => c.kind === "plug");
    check("signed-in anon:true create still published", globalThis.__PLUG_CALLS__ === 1);
    check("signed-in anon:true create used the AUTHED wire (Authorization present)", /^Bearer /.test(plug?.headers?.Authorization || ""));
    check("signed-in anon:true create did NOT ride the owner-token wire", !plug?.owner_token);
  }

  // grid_login is reachable while signed out — never gated behind auth (0.21.4
  // regression guard: a gate in front of the recovery path bricked every session).
  {
    resetCalls();
    globalThis.__GRIDS__ = [];
    const h = capture(makeCtx({ token: null }));
    const res = await h.grid_login({});
    check("grid_login returns a login_url while signed out", typeof parse(res).login_url === "string" && parse(res).login_url.length > 0);
    check("grid_login does not report needs_auth", parse(res).needs_auth !== true);
  }

  // The publisher log line names a stable user id and whether the entity is
  // ephemeral — and NEVER an email or token.
  {
    resetCalls();
    globalThis.__GRIDS__ = ONE_GRID;
    const realErr = console.error;
    const logged = [];
    console.error = (m) => { logged.push(String(m)); };
    try {
      const h = capture(makeCtx({ token: JWT, grids: ONE_GRID }));
      await h.grid_plug({ ...HTML, grid: "grid-a" });
    } finally {
      console.error = realErr;
    }
    const line = logged.find((l) => /grid_plug create/.test(l) && /publisher|user_id/.test(l));
    check("a create publisher log line was emitted", Boolean(line));
    check("publisher log names the stable user id", (line || "").includes(USER_ID));
    check("publisher log names the grid", /grid=grid-a/.test(line || ""));
    check("publisher log states whether the entity is ephemeral", /ephemeral=(true|false)/.test(line || ""));
    check("REDACTION: publisher log carries NO email", !(line || "").includes(LEAK_EMAIL) && !/@/.test(line || ""));
    check("REDACTION: publisher log carries NO token", !(line || "").includes(JWT));
  }
} finally {
  globalThis.fetch = realFetch;
  delete globalThis.__GRIDS__;
  delete globalThis.__PLUG_CALLS__;
}

console.log(failures === 0 ? "\nAll login-required-create checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
