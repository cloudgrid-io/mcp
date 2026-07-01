// Shared tool core for both editions of the CloudGrid MCP server.
//
// Two editions register from here:
//   - local (stdio): full toolset, including the CLI-wrapping tools. Identity
//     comes from ~/.cloudgrid/credentials.
//   - web (HTTP, hosted): the light, CLI-free toolset (drop, claim, login).
//     Identity is a per-session token held in memory.
//
// The difference is injected as a `ctx` object, so the tool logic is written once.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { readFileSync, existsSync, statSync } from "node:fs";
import { basename, dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { newLoginCode, buildLoginUrl, pollStatusOnce, decodeJwt } from "./auth.js";

const execFileAsync = promisify(execFile);

export const API_BASE = (process.env.CLOUDGRID_API_URL || "https://api.cloudgrid.io").replace(
  /\/+$/,
  "",
);

const ANON_HTML_MAX_BYTES = 2_000_000;
const CONSOLE_URL = "https://console.cloudgrid.io/";

// ── Widget resources (ChatGPT Apps SDK, web edition only) ────────────────────
const LIVE_RESULT_URI = "ui://cloudgrid/live-result.html";
const ORG_PICKER_URI = "ui://cloudgrid/org-picker.html";
const LIVE_RESULT_HTML = readFileSync(new URL("./widgets/live-result.html", import.meta.url), "utf-8");
const ORG_PICKER_HTML = readFileSync(new URL("./widgets/org-picker.html", import.meta.url), "utf-8");
const WIDGET_CSP = {
  connectDomains: ["https://*.cloudgrid.io"],
  resourceDomains: ["https://*.cloudgrid.io"],
};

const VISIBILITY_LABELS = {
  private: "Only you",
  org: "Your org",
  authenticated: "Anyone signed in",
  space: "A space",
  link: "Anyone with the link",
};

function ok(text) {
  return { content: [{ type: "text", text }] };
}
function fail(text) {
  return { content: [{ type: "text", text }], isError: true };
}
function okResult({ text, structured, meta }) {
  return {
    content: [{ type: "text", text }],
    structuredContent: structured,
    ...(meta ? { _meta: meta } : {}),
  };
}

// ── CLI wrapping (local edition only) ──────────────────────────────────────────

// Resolve and validate a caller-supplied working directory. Returns the resolved
// absolute path, or process.cwd() when omitted.
function resolveCwd(cwd) {
  if (cwd === undefined || cwd === null || cwd === "") return undefined; // let execFile default
  const abs = resolve(cwd);
  if (!existsSync(abs)) {
    throw new Error(`Directory does not exist: ${abs}`);
  }
  if (!statSync(abs).isDirectory()) {
    throw new Error(`Not a directory: ${abs}`);
  }
  return abs;
}

// Pin the CLI version for the lazy npx fallback so behaviour is reproducible.
// MCP 0.5.2 is tested against CLI 0.10.1.
const CLI_NPX_PKG = "@cloudgrid-io/cli@~0.10.1";

// Minimum CLI version that supports the verbs and flags the MCP passes.
const MIN_CLI_VERSION = "0.10.1";

// Verb map for the drift guard: each CLI-wrapping tool's top-level verb(s).
// The drift-guard test imports this and asserts every verb exists in `cloudgrid --help`.
export const CLI_TOOL_VERBS = {
  cloudgrid_init:     ["init"],
  cloudgrid_plug:     ["plug"],
  cloudgrid_logs:     ["logs"],
  cloudgrid_share:    ["visibility"],
  cloudgrid_feedback: ["feedback"],
  cloudgrid_whoami:   ["whoami"],
  cloudgrid_use:      ["use"],
  cloudgrid_logout:   ["logout"],
  cloudgrid_status:   ["status"],
  cloudgrid_info:     ["info"],
  cloudgrid_get:          ["get"],
  cloudgrid_describe_grid: ["describe"],
  cloudgrid_pickup:        ["pickup"],
  cloudgrid_rename:   ["rename"],
  cloudgrid_unplug:   ["unplug"],
  cloudgrid_delete:   ["delete"],
  cloudgrid_rollback: ["rollback"],
  cloudgrid_versions: ["versions"],
  cloudgrid_env:      ["env"],
  cloudgrid_secrets:  ["secrets"],
  cloudgrid_scaffold: ["scaffold"],
  cloudgrid_doctor:   ["doctor"],
  cloudgrid_open:     ["open"],
};

// Simple semver comparison: true when `version` >= MIN_CLI_VERSION.
function meetsMinVersion(version) {
  if (!version) return false;
  const parse = (s) => s.replace(/^v/, "").split(".").map((p) => parseInt(p, 10) || 0);
  const v = parse(version);
  const m = parse(MIN_CLI_VERSION);
  for (let i = 0; i < 3; i++) {
    if ((v[i] || 0) > (m[i] || 0)) return true;
    if ((v[i] || 0) < (m[i] || 0)) return false;
  }
  return true;
}

// Resolve the bundled CLI from this package's OWN node_modules only — never
// walk up to parent directories (which may contain stale CLI versions).
// Returns { entry, version } or null.
//
// `fileURLToPath` (not `new URL(url).pathname`) is required for Windows: on a
// Windows `file://` URL, `.pathname` is `/C:/Users/.../src` — a leading slash
// before the drive letter, which is NOT a valid fs path, so `existsSync` fails
// and the bundled CLI is never found even though the `.mcpb` bundles it.
// `fileURLToPath` yields a proper `C:\Users\...\src`. macOS/Linux are unaffected.
//
// The `deps` seam (moduleUrl + path/fs impls) exists ONLY so the Windows-URL
// regression test can drive the win32 code path deterministically on a POSIX CI
// box. Production always uses the real `import.meta.url` and host path/fs.
export function resolveBundledCli(deps = {}) {
  const {
    moduleUrl = import.meta.url,
    urlToPath = fileURLToPath,
    pathImpl = { dirname, join },
    fsExists = existsSync,
    fsRead = readFileSync,
  } = deps;
  try {
    const srcDir = pathImpl.dirname(urlToPath(moduleUrl));
    const pkgPath = pathImpl.join(srcDir, "..", "node_modules", "@cloudgrid-io", "cli", "package.json");
    if (!fsExists(pkgPath)) return null;
    const pkg = JSON.parse(fsRead(pkgPath, "utf-8"));
    const bin = pkg.bin && pkg.bin.cloudgrid;
    if (!bin) return null;
    return { entry: pathImpl.join(pathImpl.dirname(pkgPath), bin), version: pkg.version || null };
  } catch {
    return null;
  }
}

// Windows `.cmd`/`.bat` shims (cloudgrid.cmd, npx.cmd) cannot be launched by
// `execFile` without a shell — modern patched Node (CVE-2024-27980) rejects it
// with EINVAL, and even where it doesn't, ENOENT results because the bare name
// resolves to a `.cmd`. On win32 we route those through `cmd.exe /d /s /c` with
// an explicitly quoted command line so args with spaces/quotes stay intact.
// macOS/Linux never take this branch — they keep the plain execFile path.
const IS_WIN = process.platform === "win32";

// Quote a single Windows command-line token for cmd.exe. Wrap in double quotes,
// escape embedded quotes/backslash-before-quote per Windows argv rules, and also
// caret-escape cmd.exe metacharacters so nothing is interpreted by the shell.
function winQuoteArg(arg) {
  const s = String(arg);
  // Escape backslashes that precede a quote, then the quotes themselves.
  let inner = s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  inner = `"${inner}"`;
  // Caret-escape cmd.exe special chars (they live outside the quoted-arg parsing).
  return inner.replace(/[()%!^"<>&|]/g, "^$&");
}

// execFile a command that may be a Windows `.cmd` shim, safely on every OS.
function execMaybeCmd(command, args, options) {
  if (!IS_WIN) return execFileAsync(command, args, options);
  const line = [command, ...args].map(winQuoteArg).join(" ");
  return execFileAsync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", line], {
    ...options,
    windowsVerbatimArguments: true,
  });
}

async function runCloudgrid(args, opts = {}) {
  const cwd = resolveCwd(opts.cwd);
  const execOpts = {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10 * 60 * 1000,
    stdio: ["ignore", "pipe", "pipe"],
    ...(cwd ? { cwd } : {}),
  };

  const extract = (err) => {
    const detail = [err && err.stdout, err && err.stderr, err && err.message]
      .filter(Boolean)
      .join("\n")
      .trim();
    return new Error(detail || "cloudgrid command failed");
  };

  // 1. Bundled CLI — own node_modules only, version-gated
  const bundled = resolveBundledCli();
  if (bundled && meetsMinVersion(bundled.version)) {
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [bundled.entry, ...args],
        execOpts,
      );
      return (stdout || stderr || "").trim() || "Done.";
    } catch (err) {
      throw extract(err);
    }
  } else if (bundled) {
    console.error(
      `cloudgrid-mcp: bundled CLI ${bundled.version} < ${MIN_CLI_VERSION}, skipping`,
    );
  }

  // 2. Global `cloudgrid` on PATH — version-gated.
  //    On Windows the bin is `cloudgrid.cmd`; run it via cmd.exe (execMaybeCmd).
  {
    const globalBin = IS_WIN ? "cloudgrid.cmd" : "cloudgrid";
    let useGlobal = false;
    try {
      const { stdout: vOut } = await execMaybeCmd(globalBin, ["--version"], {
        timeout: 5_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const ver = vOut.trim().match(/(\d+\.\d+\.\d+)/)?.[1];
      if (meetsMinVersion(ver)) {
        useGlobal = true;
      } else {
        console.error(
          `cloudgrid-mcp: global CLI ${ver || vOut.trim()} < ${MIN_CLI_VERSION}, skipping`,
        );
      }
    } catch {
      // Not on PATH or --version failed — skip
    }
    if (useGlobal) {
      try {
        const { stdout, stderr } = await execMaybeCmd(globalBin, args, execOpts);
        return (stdout || stderr || "").trim() || "Done.";
      } catch (err) {
        throw extract(err);
      }
    }
  }

  // 3. Lazy fetch: npx -y @cloudgrid-io/cli@<pinned> <args>
  //    One-time download; npx caches it for subsequent invocations.
  //    On Windows this is `npx.cmd`, run via cmd.exe (execMaybeCmd) so patched
  //    Node doesn't EINVAL on the `.cmd` shim.
  console.error("cloudgrid-mcp: fetching the CloudGrid CLI (first use)…");
  const npx = IS_WIN ? "npx.cmd" : "npx";
  try {
    const { stdout, stderr } = await execMaybeCmd(
      npx,
      ["-y", CLI_NPX_PKG, ...args],
      execOpts,
    );
    return (stdout || stderr || "").trim() || "Done.";
  } catch (err) {
    throw extract(err);
  }
}

function cliTool(buildArgs, { cwdParam = false } = {}) {
  return async (input) => {
    try {
      const params = input || {};
      const opts = {};
      if (cwdParam) {
        // Accept cwd, directory, or dir as the working-directory override.
        opts.cwd = params.cwd ?? params.directory ?? params.dir;
      }
      return ok(await runCloudgrid(buildArgs(params), opts));
    } catch (err) {
      return fail(err.message);
    }
  };
}

function tryOpenBrowser(url) {
  if (process.env.CLOUDGRID_NO_BROWSER === "1") return;
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    execFile(cmd, [url], () => {});
  } catch {
    // ignore — the URL is returned to the user anyway
  }
}

// ── Org listing (bearer-authed, web edition) ──────────────────────────────────
// Fetches the signed-in user's orgs via GET /api/v2/orgs. The JWT does not
// carry orgs (claims: sub, email, name, iat, exp), so the API is the canonical
// source. Returns [{slug, name, role, render_ready}].
async function fetchUserOrgs(token) {
  try {
    const res = await fetch(`${API_BASE}/api/v2/orgs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const orgs = Array.isArray(data?.orgs) ? data.orgs : Array.isArray(data) ? data : [];
    return orgs.map((o) => ({
      slug: o.slug ?? "",
      name: o.name ?? o.slug ?? "",
      role: o.role ?? "member",
      render_ready: o.render_ready ?? true, // default true for older APIs
    }));
  } catch {
    return [];
  }
}

// After an authenticated web drop, upgrade visibility to "link" so the artifact
// is shareable and its preview renders without a sign-in wall. Best-effort — a
// failure here does not fail the drop; the user can always call cloudgrid_visibility.
async function upgradeVisibilityToLink(ctx, entityId, orgSlug) {
  const token = await ctx.getToken();
  if (!token || !entityId) return false;
  try {
    const hdrs = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    if (orgSlug) hdrs["X-CloudGrid-Org"] = orgSlug;
    const res = await fetch(`${API_BASE}/api/v2/inspirations/${encodeURIComponent(entityId)}`, {
      method: "PATCH",
      headers: hdrs,
      body: JSON.stringify({ visibility: "link" }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Direct-API tools (both editions) ───────────────────────────────────────────
function looksLikeFullHtml(s) {
  const head = s.replace(/^﻿/, "").trimStart().slice(0, 256).toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

// Anonymous drops are owned by the platform Guest Org, whose slug is the apex
// the public URL hangs off (https://guest.cloudgrid.io/<slug>).
const GUEST_ORG_SLUG = "guest";

// Compose an entity's public URL from the `/api/v2/plug` response. Unlike the
// retired `/drop/auto`, `/plug` does NOT return a `url` field — it returns
// `slug` + `grid` (+ a `detection.kind`) and expects the client to derive the
// canonical URL, mirroring the platform's `entityUrl()` URL derivation:
//   - inspiration (HTML drops): path-based at the org apex
//       https://<grid>.cloudgrid.io/<slug>
//   - runtime (app/agent):      subdomain
//       https://<slug>.<grid>.cloudgrid.io
// Anonymous drops are grid-less in the response (`grid: null`); they live under
// the Guest Org, so the apex slug is the constant `guest`.
function composePlugUrl(data) {
  const slug = data?.slug;
  if (!slug) return null;
  const grid = data?.grid || GUEST_ORG_SLUG;
  const kind = data?.detection?.kind;
  if (kind === "app" || kind === "agent") {
    return `https://${slug}.${grid}.cloudgrid.io`;
  }
  // inspiration (and any unknown/static kind) — path-based at the org apex.
  return `https://${grid}.cloudgrid.io/${slug}`;
}

async function runDrop(ctx, { html, path: filePath, filename, anonymous, org, fresh }) {
  // Defensive: the web edition schema excludes `path`, but if a model still
  // passes one (e.g. from a cached tool description), reject early with a
  // clear explanation.
  if (ctx.edition === "web" && filePath) {
    throw new Error(
      "The hosted server cannot read local files — pass the full document as `html` instead of a `path`.",
    );
  }

  let bytes;
  let name;
  let type;

  if (filePath) {
    bytes = await readFile(filePath);
    name = filename || basename(filePath);
    type = "application/octet-stream";
  } else if (typeof html === "string" && html.length > 0) {
    let content = html;
    if (!looksLikeFullHtml(content)) {
      content =
        `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8">` +
        `<title>Shared on CloudGrid</title></head>\n<body>\n${content}\n</body>\n</html>\n`;
    }
    bytes = Buffer.from(content, "utf8");
    name = filename || "index.html";
    type = "text/html";
    if (bytes.byteLength > ANON_HTML_MAX_BYTES) {
      throw new Error(
        `This HTML is ${(bytes.byteLength / 1e6).toFixed(2)} MB. Anonymous drops are capped at 2 MB. ` +
          `Trim it, or sign in to publish larger.`,
      );
    }
  } else {
    throw new Error("Provide either `html` (inline content) or `path` (a local file).");
  }

  const headers = {};
  let orgSlug = null;
  if (anonymous !== true) {
    const token = await ctx.getToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
      orgSlug = org || (await ctx.getActiveOrg());
      if (orgSlug) headers["X-CloudGrid-Org"] = orgSlug;
    }
  }

  // Hosted server: attach the trusted-server credential when available.
  // Falls back gracefully server-side if absent. Only the web edition sets ctx.trustedServer.
  if (!headers["Authorization"] && ctx.trustedServer?.secret && ctx.trustedServer?.endUserId) {
    headers["X-CloudGrid-Trusted-Server-Auth"] = ctx.trustedServer.secret;
    headers["X-CloudGrid-Trusted-Server-End-User"] = ctx.trustedServer.endUserId;
  }

  const isAnonymousCall = !headers["Authorization"];

  // Ownership continuity: replay the platform's anon-session cookie across drops in
  // this session, so cookie-class callers can redrop (and claim) what they dropped.
  if (isAnonymousCall && ctx.state.anonCookie) {
    headers["Cookie"] = ctx.state.anonCookie;
  }

  const form = new FormData();
  // The unified `/plug` create path is the same orchestrator `/drop/auto` used,
  // but it is CREATE-ONLY for the drop flow: an anonymous caller naming a
  // `target_entity_id` is rejected 401, and the authed create path mints a NEW
  // entity. So `/plug` has NO in-place redrop / `previous_id` concept — every
  // drop creates a fresh entity (new URL). `fresh` is accepted for backward
  // compatibility but is now a no-op. See PR notes: the in-place-update +
  // `202 unchanged` no-op semantics from `/drop/auto` are gone with M7.
  void fresh;
  // The artifact part name is unchanged from `/drop/auto` (`artifact`); the plug
  // create path treats every non-`cloudgrid.yaml` part as raw artifact bytes.
  form.append("artifact", new Blob([bytes], { type }), name);
  // `/plug` resolves the authed org from the `X-CloudGrid-Org` header (set
  // above), not a form field — so `org_slug` is no longer sent.

  let res;
  try {
    res = await fetch(`${API_BASE}/api/v2/plug`, { method: "POST", headers, body: form });
  } catch (err) {
    throw new Error(`Could not reach CloudGrid at ${API_BASE}: ${err.message}`);
  }

  const raw = await res.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    /* handled below */
  }
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || raw || `HTTP ${res.status}`;
    const hint = data?.error?.details?.[0]?.hint;
    throw new Error(`Drop failed (HTTP ${res.status}): ${msg}${hint ? ` ${hint}` : ""}`);
  }

  // Persist the platform's anon-session cookie for ownership continuity (so a
  // cookie-class caller can claim — via pickup — what it dropped).
  const setCookies = res.headers.getSetCookie
    ? res.headers.getSetCookie()
    : [res.headers.get("set-cookie")].filter(Boolean);
  const anonCookie = (setCookies || [])
    .map((c) => (c || "").split(";")[0])
    .find((c) => c.startsWith("cg_anon_session="));
  if (anonCookie) ctx.state.anonCookie = anonCookie;

  // `/plug` returns no `url`; derive the canonical public URL from slug + grid.
  const url = composePlugUrl(data);

  // Remember the drop for session continuity — any caller class.
  if (data.entity_id || url) {
    ctx.state.lastDrop = {
      entity_id: data.entity_id ?? ctx.state.lastDrop?.entity_id ?? null,
      url: url ?? ctx.state.lastDrop?.url ?? null,
    };
  }

  // Authenticated create (202): the drop minted an entity owned by the caller.
  // `/plug`'s authed branch is reached only when an Authorization header was
  // sent, so distinguish on the call class rather than a (now-absent) `owned_by`.
  if (!isAnonymousCall) {
    ctx.state.lastAnonClaim = null;
    const lines = ctx.edition === "web"
      ? [`Your app is live: ${url}`]
      : [`Published to your org: ${url}`, "Owned by you."];
    const structured = {
      url,
      status: "created",
      owned_by: "authenticated",
    };
    if (ctx.edition === "web") {
      // Default authed web drops to "link" visibility so the URL is shareable
      // and the console thumbnail renders without a sign-in wall.
      if (data.entity_id) {
        await upgradeVisibilityToLink(ctx, data.entity_id, orgSlug);
      }
      lines.push(`See and manage all your apps in your grid: ${CONSOLE_URL}`);
      const vis = "link";
      lines.push(`Visible to: ${VISIBILITY_LABELS[vis]}. Want to restrict access? I can set it to only you or your org.`);
      structured.console_url = CONSOLE_URL;
      structured.current_visibility = vis;
      structured.visibility_options = Object.entries(VISIBILITY_LABELS).map(([v, l]) => ({ value: v, label: l }));
    }
    return { text: lines.join("\n"), structured };
  }

  // Anonymous create (201) — Guest-Org inspiration, 7-day expiry, claimable.
  // `/plug` carries the reward fields (`claim_url` + `claim_message`) and the
  // real `entity_id`; pickup-by-id is how it is later claimed.
  if (data.claim_url || data.entity_id) {
    let token = null;
    try {
      token = data.claim_url ? new URL(data.claim_url).searchParams.get("token") : null;
    } catch {
      token = null;
    }
    ctx.state.lastAnonClaim = {
      token,
      entity_id: data.entity_id ?? null,
      url,
    };
  }
  const lines = [ctx.edition === "web" ? `Your app is live: ${url}` : `Live: ${url}`];
  if (data.claim_message) {
    lines.push(data.claim_message);
  } else if (data.claim_url) {
    lines.push("Sign in, then run cloudgrid_claim to keep it past 7 days.");
  }
  return {
    text: lines.join("\n"),
    structured: {
      url,
      status: "created",
    },
  };
}

async function runClaim(ctx, { claim_token, claim_url, entity_id }) {
  const token = await ctx.getToken();
  if (!token) {
    throw new Error("You are not signed in. Run cloudgrid_login first, then claim.");
  }

  // `/api/v2/anon-claim` (claim-token-in-body, returns a list) was retired; the
  // claim now runs through `POST /api/v2/entities/:id/pickup`, which takes the
  // entity id in the PATH and the `claim_token` in the body, and re-homes the
  // Guest-Org inspiration into the caller's grid (ownership transfer). The
  // anon-session cookie is the token-less alternative auth.
  let claimToken = claim_token;
  if (!claimToken && claim_url) {
    try {
      claimToken = new URL(claim_url).searchParams.get("token");
    } catch {
      claimToken = null;
    }
  }
  if (!claimToken && ctx.state.lastAnonClaim) claimToken = ctx.state.lastAnonClaim.token;

  // Pickup needs the target entity id in the URL path. Prefer an explicit one,
  // else the entity remembered from this session's anonymous drop.
  const targetId = entity_id || ctx.state.lastAnonClaim?.entity_id;
  if (!targetId) {
    throw new Error(
      "No drop to claim. Pass entity_id (or drop something anonymously first in this session), " +
        "so the pickup knows which entity to claim.",
    );
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  // The claim re-homes the inspiration into the caller's grid; the platform
  // resolves the destination from the active-org context, so send the org
  // header (the same header every other authed write uses).
  const orgSlug = await ctx.getActiveOrg();
  if (orgSlug) headers["X-CloudGrid-Org"] = orgSlug;
  // Replay the anon-session cookie so a cookie-class caller can claim what it
  // dropped, even without a claim token.
  if (ctx.state.anonCookie) headers["Cookie"] = ctx.state.anonCookie;

  let res;
  try {
    res = await fetch(`${API_BASE}/api/v2/entities/${encodeURIComponent(targetId)}/pickup`, {
      method: "POST",
      headers,
      body: JSON.stringify(claimToken ? { claim_token: claimToken } : {}),
    });
  } catch (err) {
    throw new Error(`Could not reach CloudGrid at ${API_BASE}: ${err.message}`);
  }

  const raw = await res.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    /* handled below */
  }
  if (!res.ok) {
    // 409 ALREADY_CLAIMED is the idempotent "nothing left to do" outcome.
    if (res.status === 409) {
      ctx.state.lastAnonClaim = null;
      return {
        text: "Nothing to claim — it was already claimed.",
        structured: { claimed: 0, urls: [] },
      };
    }
    const msg = data?.error?.message || data?.message || raw || `HTTP ${res.status}`;
    throw new Error(`Claim failed (HTTP ${res.status}): ${msg}`);
  }

  ctx.state.lastAnonClaim = null;
  const url = data?.url || data?.redirect_url || ctx.state.lastDrop?.url || null;
  const lines = ["Claimed 1, now yours:"];
  lines.push(`${url ?? ""}${data?.new_expires_at ? ` (expires ${data.new_expires_at})` : ""}`.trim());
  return {
    text: lines.join("\n"),
    structured: {
      claimed: 1,
      urls: url ? [url] : [],
    },
  };
}


// Change an inspiration's visibility. Authed, direct API — works on the hosted
// edition where the CLI-wrapping share tool is unavailable. Defaults to the drop
// made in this session, so "make it private" needs no ids.
async function runVisibility(ctx, { target, visibility, org }) {
  const token = await ctx.getToken();
  if (!token) {
    throw new Error("Changing visibility needs an owner. Run cloudgrid_login first.");
  }
  const id = target || ctx.state.lastDrop?.entity_id;
  if (!id) {
    throw new Error("No target. Pass the entity id, or drop something first in this session.");
  }
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const orgSlug = org || (await ctx.getActiveOrg());
  if (orgSlug) headers["X-CloudGrid-Org"] = orgSlug;
  let res;
  try {
    res = await fetch(`${API_BASE}/api/v2/inspirations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ visibility }),
    });
  } catch (err) {
    throw new Error(`Could not reach CloudGrid at ${API_BASE}: ${err.message}`);
  }
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { /* handled below */ }
  if (!res.ok) {
    const msg = data?.error?.message || raw || `HTTP ${res.status}`;
    const hint = data?.error?.details?.[0]?.hint;
    throw new Error(`Visibility change failed (HTTP ${res.status}): ${msg}${hint ? ` ${hint}` : ""}`);
  }
  const lines = [`Visibility is now ${visibility}.`];
  if (data?.url) lines.push(data.url);
  return {
    text: lines.join("\n"),
    structured: {
      visibility,
      ...(data?.url ? { url: data.url } : {}),
    },
  };
}

// ── Registration ───────────────────────────────────────────────────────────────
// Registers the tools onto `server`. ctx.edition decides whether the CLI-wrapping
// tools are included (they need a local machine).
export function registerTools(server, ctx) {
  // ── Widget resources (web edition, ChatGPT Apps SDK) ──────────────────────
  if (ctx.edition === "web") {
    server.registerResource("cloudgrid-live-result", LIVE_RESULT_URI, {
      description: "Live result card after a CloudGrid drop — shows URL, grid link, and visibility controls.",
      mimeType: "text/html;profile=mcp-app",
    }, async () => ({
      contents: [{
        uri: LIVE_RESULT_URI,
        mimeType: "text/html;profile=mcp-app",
        text: LIVE_RESULT_HTML,
        _meta: { ui: { csp: WIDGET_CSP } },
      }],
    }));

    server.registerResource("cloudgrid-org-picker", ORG_PICKER_URI, {
      description: "Org picker card — lets the user choose which organization to publish into.",
      mimeType: "text/html;profile=mcp-app",
    }, async () => ({
      contents: [{
        uri: ORG_PICKER_URI,
        mimeType: "text/html;profile=mcp-app",
        text: ORG_PICKER_HTML,
        _meta: { ui: { csp: WIDGET_CSP } },
      }],
    }));
  }

  // ── Direct-API tools (both editions) ──────────────────────────────────────

  // Drop — both editions, but the input schema is edition-aware: the web
  // edition removes `path` (the cloud server cannot read local files) and
  // strengthens `html` so the model always pastes the full document inline.
  const dropInputSchema = ctx.edition === "web"
    ? {
        html: z.string().optional().describe(
          "The COMPLETE HTML document to publish — paste the full file contents here (not a path). " +
          "For a game, include all HTML/CSS/JS inline so it runs standalone. " +
          "A fragment is wrapped into a full document automatically.",
        ),
        filename: z.string().optional().describe("Filename to present. Defaults to index.html for inline HTML."),
        anonymous: z.boolean().optional().describe("Force an anonymous drop even if the user is signed in."),
        org: z.string().optional().describe("Leave unset; the tool will ask the user which org to publish into. Only set this after the user picks from the list the tool returns."),
        fresh: z.boolean().optional().describe("Force a new drop even if you already dropped in this session (default: update in place)."),
      }
    : {
        html: z.string().optional().describe("Inline HTML to publish. A fragment is wrapped into a full document."),
        path: z.string().optional().describe("Path to a local file to upload instead of inline HTML."),
        filename: z.string().optional().describe("Filename to present. Defaults to index.html for inline HTML."),
        anonymous: z.boolean().optional().describe("Force an anonymous drop even if the user is signed in."),
        org: z.string().optional().describe("Leave unset; the tool will ask the user which org to publish into. Only set this after the user picks from the list the tool returns."),
        fresh: z.boolean().optional().describe("Force a new drop even if you already dropped in this session (default: update in place)."),
      };

  server.registerTool(
    "cloudgrid_drop",
    {
      description: "Publish an HTML page or file to CloudGrid and get a public shareable URL. Use when the user wants to share, publish, send, or 'deploy' an artifact, or wants a link to send a friend. Re-drops in the same session update the existing drop in place — same link, new version; pass fresh: true to force a new one. If signed in, it publishes into the user's org as an owned inspiration (30-day expiry); if not, it drops anonymously (7-day expiry, claimable later). Calls the API directly.",
      inputSchema: dropInputSchema,
      outputSchema: {
        url: z.string().optional().describe("The public URL of the drop."),
        status: z.enum(["created", "updated", "unchanged"]).optional().describe("What happened to the drop."),
        owned_by: z.string().optional().describe("Ownership class, e.g. 'authenticated'."),
        expires_at: z.string().optional().describe("Expiry timestamp, if any."),
        console_url: z.string().optional().describe("URL to manage all apps in the grid."),
        current_visibility: z.string().optional().describe("Current visibility of the drop."),
        visibility_options: z.array(z.object({
          value: z.string().describe("Visibility value to pass to cloudgrid_visibility."),
          label: z.string().describe("Human-readable label."),
        })).optional().describe("Available visibility levels."),
        needs_org: z.boolean().optional().describe("True when the user must choose an org before dropping."),
        orgs: z.array(z.object({
          slug: z.string().describe("Org slug to pass as the org parameter."),
          name: z.string().describe("Human-readable org name."),
          role: z.string().describe("User's role in the org."),
          is_active: z.boolean().optional().describe("True if this is the user's currently active org."),
        })).optional().describe("The user's orgs, when org choice is needed."),
        needs_sign_in: z.boolean().optional().describe("True when sign-in is needed before dropping."),
        login_url: z.string().optional().describe("Sign-in URL when authentication is needed."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      ...(ctx.edition === "web" ? {
        _meta: {
          ui: { resourceUri: LIVE_RESULT_URI, csp: WIDGET_CSP },
          "openai/outputTemplate": LIVE_RESULT_URI,
        },
      } : {}),
    },
    async (input) => {
      try {
        // Web edition: reject `path` early — the hosted server cannot read
        // local files. The schema already omits it, but a model with a
        // cached tool description might still send one.
        if (ctx.edition === "web" && input?.path) {
          return fail(
            "The hosted server cannot read local files — pass the full document as `html` instead of a `path`.",
          );
        }

        // Web edition: sign-in guidance when unauthenticated.
        if (ctx.edition === "web" && input?.anonymous !== true) {
          const token = await ctx.getToken();
          if (!token) {
            const url = buildLoginUrl(newLoginCode());
            return okResult({
              text: `Sign in to publish to your org.\n${url}`,
              structured: { needs_sign_in: true, login_url: url },
            });
          }
        }

        // Stateless org disambiguation — both editions, when authenticated.
        // No dependency on prior-call state so it works even when the client
        // reconnects on every tool call (ChatGPT Apps SDK behaviour).
        if (input?.anonymous !== true) {
          const token = await ctx.getToken();
          if (token) {
            const orgs = await fetchUserOrgs(token);
            const activeOrg = await ctx.getActiveOrg();
            const suppliedOrg = input?.org;
            const matchedOrg = suppliedOrg && orgs.find((o) => o.slug === suppliedOrg);
            if (matchedOrg) {
              // Supplied org matches — proceed with it. The agent should have
              // already checked render_ready via cloudgrid_orgs and warned the
              // user if this org isn't set up yet. We don't block here.
              input = { ...(input || {}), org: suppliedOrg };
            } else if (orgs.length > 1) {
              // No valid org supplied and multiple orgs — ask once.
              // Mark the active org so the agent can offer it as the default.
              const annotated = orgs.map((o) => ({
                ...o,
                is_active: o.slug === activeOrg,
              }));
              // Sort: active org first, then ready orgs, then not-ready orgs.
              annotated.sort((a, b) => {
                if (a.is_active !== b.is_active) return b.is_active ? 1 : -1;
                if (a.render_ready !== b.render_ready) return b.render_ready ? 1 : -1;
                return 0;
              });
              const lines = ["Which org should this be published to?"];
              for (const o of annotated) {
                const tags = [];
                if (o.is_active) tags.push("your active org");
                if (!o.render_ready) tags.push("not set up yet");
                const suffix = tags.length ? ` (${tags.join(", ")})` : "";
                lines.push(`  ${o.slug} — ${o.name} (${o.role})${suffix}`);
              }
              lines.push("Pass the org slug in the org parameter to publish.");
              const readyCount = annotated.filter((o) => o.render_ready).length;
              if (readyCount === 0) {
                lines.push("Note: none of your orgs are fully set up yet. You can use anonymous: true as a fallback.");
              }
              return okResult({
                text: lines.join("\n"),
                structured: { needs_org: true, orgs: annotated },
                ...(ctx.edition === "web" ? { meta: { "openai/outputTemplate": ORG_PICKER_URI } } : {}),
              });
            } else if (orgs.length === 1) {
              if (!orgs[0].render_ready) {
                // Single org but not set up — tell the agent so it can warn
                // the user and offer anonymous drop as fallback.
                const annotated = [{ ...orgs[0], is_active: orgs[0].slug === activeOrg, render_ready: false }];
                return okResult({
                  text: `Your only org "${orgs[0].slug}" isn't fully set up yet — pages published there may not load. You can drop anonymously (set anonymous: true) or wait until provisioning completes, then re-run.`,
                  structured: { needs_org: true, org_not_ready: true, orgs: annotated },
                });
              }
              input = { ...(input || {}), org: orgs[0].slug };
            }
          }
        }
        return okResult(await runDrop(ctx, input || {}));
      } catch (err) {
        return fail(err.message);
      }
    },
  );

  // Claim — both editions.
  server.registerTool(
    "cloudgrid_claim",
    {
      description: "Claim an anonymous drop into the signed-in account, so it becomes owned and stops expiring in 7 days. Use after the user signs in to keep something they dropped anonymously. The public URL does not change. Requires sign-in (cloudgrid_login). Calls the API directly.",
      inputSchema: {
        claim_token: z.string().optional().describe("The claim token from an anonymous drop."),
        claim_url: z.string().optional().describe("The claim_url from an anonymous drop; the token is read from it."),
        entity_id: z.string().optional().describe("The entity id of the anonymous drop to claim. Defaults to this session's last anonymous drop."),
      },
      outputSchema: {
        claimed: z.number().describe("Number of drops claimed."),
        urls: z.array(z.string()).describe("URLs of the claimed drops."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        return okResult(await runClaim(ctx, input || {}));
      } catch (err) {
        return fail(err.message);
      }
    },
  );

  // Login — both editions. Local opens a browser and saves to the credentials
  // file; web returns the URL and saves to the session.
  server.registerTool(
    "cloudgrid_login",
    {
      description: "Start a CLI-free CloudGrid sign-in. Use when the user wants to log in, sign in, or authenticate, or to claim an anonymous drop. Returns a URL to open in the browser; then call cloudgrid_login_status to finish. Uses CloudGrid's existing OAuth.",
      inputSchema: {},
      outputSchema: {
        login_url: z.string().describe("URL to open in a browser to complete sign-in."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      const code = newLoginCode();
      ctx.state.pendingLoginCode = code;
      const url = buildLoginUrl(code);
      if (ctx.canOpenBrowser) tryOpenBrowser(url);
      return {
        content: [{ type: "text", text:
          `To sign in, open this URL in your browser and finish with Google:\n${url}\n\n` +
          `After you complete it, run cloudgrid_login_status to finish signing in.`,
        }],
        structuredContent: { login_url: url },
      };
    },
  );

  server.registerTool(
    "cloudgrid_login_status",
    {
      description: "Finish a sign-in started by cloudgrid_login. Polls once: if you have completed the browser sign-in, it saves your session; otherwise it tells you to finish and try again.",
      inputSchema: {
        code: z.string().optional().describe("The sign-in code. Defaults to the most recent cloudgrid_login."),
      },
      outputSchema: {
        status: z.enum(["authenticated", "pending"]).describe("Current sign-in state."),
        email: z.string().optional().describe("Signed-in email, when authenticated."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (input) => {
      const code = input?.code || ctx.state.pendingLoginCode;
      if (!code) return fail("No sign-in is in progress. Run cloudgrid_login first.");
      let status;
      try {
        status = await pollStatusOnce(code);
      } catch (err) {
        return fail(err.message);
      }
      if (status.status === "authenticated" && status.jwt) {
        let info;
        try {
          info = await ctx.saveToken(status.jwt);
        } catch (err) {
          return fail(`Signed in, but could not save credentials: ${err.message}`);
        }
        ctx.state.pendingLoginCode = null;
        const who = info?.email ? ` as ${info.email}` : "";
        return {
          content: [{ type: "text", text: `Signed in${who}. ${ctx.savedLocationNote()}` }],
          structuredContent: { status: "authenticated", ...(info?.email ? { email: info.email } : {}) },
        };
      }
      if (status.status === "pending" || status.status === "not_started") {
        return {
          content: [{ type: "text", text:
            "Still waiting for you to finish signing in. Open the URL from cloudgrid_login " +
            "in your browser, complete it with Google, then run cloudgrid_login_status again.",
          }],
          structuredContent: { status: "pending" },
        };
      }
      return fail("The sign-in window expired (5 minutes). Run cloudgrid_login to start again.");
    },
  );

  server.registerTool(
    "cloudgrid_visibility",
    {
      description: "Change who can see a CloudGrid inspiration: private, space, authenticated, org, or link (anyone with the URL). Use when the user wants to make a drop private, restrict who sees it, or open it up — including right after a drop, with no target id needed. Defaults to the drop made in this session. Requires sign-in. Calls the API directly.",
      inputSchema: {
        visibility: z.enum(["private", "space", "authenticated", "org", "link"]).describe("The new scope."),
        target: z.string().optional().describe("Entity id. Defaults to this session's last drop."),
        org: z.string().optional().describe("Org of the entity. Defaults to the active org."),
      },
      outputSchema: {
        visibility: z.string().describe("The visibility that was set."),
        url: z.string().optional().describe("URL of the entity, if returned."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        return okResult(await runVisibility(ctx, input || {}));
      } catch (err) {
        return fail(err.message);
      }
    },
  );

  // Org listing — both editions.
  server.registerTool(
    "cloudgrid_orgs",
    {
      description: "List the signed-in user's organizations. Returns each org's slug, name, role, and render_ready status. Orgs where render_ready is false are still provisioning — pages published there may not load yet. Prefer a render_ready org; if the user insists on a not-ready one, warn them that pages may not load and suggest waiting or choosing a ready org instead. Requires sign-in.",
      inputSchema: {},
      outputSchema: {
        orgs: z.array(z.object({
          slug: z.string().describe("Org slug."),
          name: z.string().describe("Human-readable org name."),
          role: z.string().describe("User's role in the org."),
          is_active: z.boolean().optional().describe("True if this is the user's currently active org."),
          render_ready: z.boolean().describe("True if the org's DNS and TLS are provisioned and pages will load. False means the org is still being set up."),
        })).describe("The user's org memberships."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      const token = await ctx.getToken();
      if (!token) {
        return fail("You are not signed in. Run cloudgrid_login first.");
      }
      const orgs = await fetchUserOrgs(token);
      if (orgs.length === 0) {
        return okResult({ text: "No organizations found.", structured: { orgs: [] } });
      }
      const activeOrg = await ctx.getActiveOrg();
      const annotated = orgs.map((o) => ({
        ...o,
        is_active: o.slug === activeOrg,
      }));
      // Sort: active org first, then ready orgs, then not-ready orgs.
      annotated.sort((a, b) => {
        if (a.is_active !== b.is_active) return b.is_active ? 1 : -1;
        if (a.render_ready !== b.render_ready) return b.render_ready ? 1 : -1;
        return 0;
      });
      const lines = annotated.map((o) => {
        const tags = [];
        if (o.is_active) tags.push("your active org");
        if (!o.render_ready) tags.push("not set up yet");
        const suffix = tags.length ? ` (${tags.join(", ")})` : "";
        return `${o.slug} — ${o.name} (${o.role})${suffix}`;
      });
      const readyCount = annotated.filter((o) => o.render_ready).length;
      if (readyCount === 0 && annotated.length > 0) {
        lines.push("\nNone of your orgs are fully set up yet. You can use an anonymous drop as a fallback, or wait until provisioning completes.");
      }
      return okResult({ text: lines.join("\n"), structured: { orgs: annotated } });
    },
  );

  if (ctx.edition !== "local") return; // web edition stops here — no CLI tools

  // ── CLI-wrapping tools (local edition only) ───────────────────────────────

  server.tool(
    "cloudgrid_init",
    "Register a new CloudGrid app or agent, optionally seeding a web service. Wraps `cloudgrid init`.",
    {
      kind: z.enum(["app", "agent"]).describe("Entity kind."),
      name: z.string().describe("Slug: 3-40 lowercase alphanumerics and hyphens."),
      type: z.enum(["node", "nextjs", "python", "static"]).optional().describe("Seed a web service of this type."),
      description: z.string().optional().describe("Initial one-line description."),
      dir: z.string().optional().describe("Target directory. Defaults to ./<name>."),
      org: z.string().optional().describe("Override the active org for this init."),
      cwd: z.string().optional().describe("Working directory. The CLI runs in this directory. Defaults to the MCP server's working directory."),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    cliTool(({ kind, name, type, description, dir, org }) => {
      const args = ["init", kind, name];
      if (type) args.push("--type", type);
      if (description) args.push("--description", description);
      if (dir) args.push("--dir", dir);
      if (org) args.push("--org", org);
      return args;
    }, { cwdParam: true }),
  );

  server.tool(
    "cloudgrid_plug",
    "Build and deploy a directory or URL. Prints the live URL. Wraps `cloudgrid plug`.",
    {
      target: z.string().optional().describe("Path or URL. Omit to deploy the entity linked to the current directory."),
      org: z.string().optional().describe("Pick or override the org."),
      no_deploy: z.boolean().optional().describe("Register the entity but do not build or deploy."),
      cwd: z.string().optional().describe("Working directory. The CLI runs in this directory. Defaults to the MCP server's working directory."),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    cliTool(({ target, org, no_deploy }) => {
      const args = ["plug"];
      if (target) args.push(target);
      if (org) args.push("--org", org);
      if (no_deploy) args.push("--no-deploy");
      args.push("--auto", "--no-clipboard", "--no-notify");
      return args;
    }, { cwdParam: true }),
  );

  server.tool(
    "cloudgrid_logs",
    "Tail recent logs for an entity. Does not stream; returns a snapshot. Wraps `cloudgrid logs`.",
    {
      name: z.string().optional().describe("Entity name. Omit to use the entity linked to the current directory."),
      tail: z.number().int().positive().optional().describe("Number of recent lines. Default 100."),
      since: z.string().optional().describe("Only logs newer than this, e.g. 5m, 1h, 2d."),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    cliTool(({ name, tail, since }) => {
      const args = ["logs"];
      if (name) args.push(name);
      args.push("--tail", String(tail ?? 100));
      if (since) args.push("--since", since);
      return args;
    }),
  );

  server.tool(
    "cloudgrid_share",
    "Set an entity's visibility and print its URL. Defaults to link (anyone with the URL). Wraps `cloudgrid visibility set`.",
    {
      name: z.string().describe("Entity slug."),
      mode: z.enum(["link", "private", "authenticated", "grid"]).optional().describe("Visibility mode. Default link."),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    cliTool(({ name, mode }) => ["visibility", "set", name, mode ?? "link"]),
  );

  server.tool(
    "cloudgrid_feedback",
    "List recent feedback events for the active org. Read-only. Wraps `cloudgrid feedback list`.",
    {
      since: z.string().optional().describe("Only events newer than this, e.g. 24h, 7d."),
      limit: z.number().int().positive().max(200).optional().describe("Number of events. Default 50, max 200."),
      org: z.string().optional().describe("Read another org's feed where you have access."),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    cliTool(({ since, limit, org }) => {
      const args = ["feedback", "list"];
      if (since) args.push("--since", since);
      if (limit) args.push("--limit", String(limit));
      if (org) args.push("--org", org);
      return args;
    }),
  );

  // ── New CLI-wrapping tools (local edition only) ───────────────────────────

  server.tool(
    "cloudgrid_whoami",
    "Show the signed-in user and active org. Wraps `cloudgrid whoami`.",
    {},
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    cliTool(() => ["whoami"]),
  );

  server.tool(
    "cloudgrid_use",
    "Switch the active org. Wraps `cloudgrid use`.",
    { org: z.string().describe("Org slug to switch to.") },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    cliTool(({ org }) => ["use", org]),
  );

  server.tool(
    "cloudgrid_logout",
    "Sign out and clear local credentials. Wraps `cloudgrid logout`.",
    {},
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    cliTool(() => ["logout"]),
  );

  server.tool(
    "cloudgrid_status",
    "Org dashboard, entity detail, or deploy snapshot. Wraps `cloudgrid status`.",
    { name: z.string().optional().describe("Entity name or trace id. Omit for the org dashboard.") },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    cliTool(({ name }) => (name ? ["status", name] : ["status"])),
  );

  server.tool(
    "cloudgrid_info",
    "Show metadata for a CloudGrid entity. Wraps `cloudgrid info`.",
    { name: z.string().optional().describe("Entity name. Omit for the entity linked to the current directory.") },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    cliTool(({ name }) => {
      const args = ["info"];
      if (name) args.push(name);
      return args;
    }),
  );

  // cloudgrid_get is the single canonical lister for grids, entities, and spaces
  // (wraps `cloudgrid get <resource> --json`). It replaces the former
  // cloudgrid_grid (which wrapped only `get entities`) — retired here so there is
  // exactly one way to list entities. resource="entities" reproduces the old
  // cloudgrid_grid behaviour with `grid` mapping to the CLI's `--grid` flag.
  server.tool(
    "cloudgrid_get",
    "List CloudGrid grids, entities, or spaces. Wraps `cloudgrid get <grids|entities|spaces> --json`.",
    {
      resource: z.enum(["grids", "entities", "spaces"]).describe("What to list: grids, entities, or spaces."),
      grid: z.string().optional().describe("Grid slug (entities/spaces only). Omit for the active grid."),
      kind: z.enum(["app", "agent", "inspiration"]).optional().describe("Filter by kind (entities only)."),
      status: z.enum(["charged", "live", "dark", "archived"]).optional().describe("Filter by status (entities only)."),
      space: z.string().optional().describe("Only entities scoped to this space slug (entities only)."),
      archived: z.boolean().optional().describe("Include archived entities (entities only)."),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    cliTool(({ resource, grid, kind, status, space, archived }) => {
      const args = ["get", resource];
      // --grid applies to entities and spaces; grids has no such flag.
      if (grid && resource !== "grids") args.push("--grid", grid);
      if (resource === "entities") {
        if (kind) args.push("--kind", kind);
        if (status) args.push("--status", status);
        if (space) args.push("--space", space);
        if (archived) args.push("--archived");
      }
      args.push("--json");
      return args;
    }),
  );

  server.tool(
    "cloudgrid_describe_grid",
    "Show a grid's detail: role, members, spaces, tier, wildcard-TLS state. Wraps `cloudgrid describe grid <slug> --json`.",
    { grid: z.string().describe("Grid slug to describe.") },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    cliTool(({ grid }) => ["describe", "grid", grid, "--json"]),
  );

  server.tool(
    "cloudgrid_pickup",
    "Download an entity's source + cloudgrid.yaml and link the folder to it. Overwrites with --force. Wraps `cloudgrid pickup`.",
    {
      name: z.string().describe("Entity slug or id to pick up."),
      target_dir: z.string().optional().describe("Directory to pick up into (relative to cwd). Defaults to the entity name."),
      grid: z.string().optional().describe("Grid to resolve the entity in. Defaults to the active grid."),
      version: z.string().optional().describe("Pick up an older version's source instead of HEAD."),
      force: z.boolean().optional().describe("Pick up into a non-empty directory."),
      no_bind: z.boolean().optional().describe("Download source only — skip cloudgrid.yaml and the link."),
      cwd: z.string().optional().describe("Working directory the CLI runs in. The download lands here; pass an explicit, writable directory."),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    cliTool(({ name, target_dir, grid, version, force, no_bind }) => {
      const args = ["pickup", name];
      if (target_dir) args.push(target_dir);
      // The CLI's pickup --help exposes `--org <slug>` (legacy naming) for the grid.
      if (grid) args.push("--org", grid);
      if (version) args.push("--version", version);
      if (force) args.push("--force");
      if (no_bind) args.push("--no-bind");
      return args;
    }, { cwdParam: true }),
  );

  server.tool(
    "cloudgrid_rename",
    "Rename a CloudGrid entity's display name (slug stays the same). Wraps `cloudgrid rename`.",
    {
      name: z.string().describe("Entity slug."),
      new_name: z.string().describe("New display name."),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    cliTool(({ name, new_name }) => ["rename", name, new_name]),
  );

  server.tool(
    "cloudgrid_unplug",
    "Take an entity off the grid. Destructive. Wraps `cloudgrid unplug`.",
    {
      name: z.string().describe("Entity slug to take down (required)."),
      confirm: z.literal(true).describe("Must be true to proceed."),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    cliTool(({ name }) => ["unplug", name, "--skip-confirm"]),
  );

  server.tool(
    "cloudgrid_delete",
    "Archive a CloudGrid inspiration. Destructive. Wraps `cloudgrid delete entity`.",
    {
      name: z.string().describe("Entity slug to delete (required)."),
      confirm: z.literal(true).describe("Must be true to proceed."),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    cliTool(({ name }) => ["delete", "entity", name, "--yes"]),
  );

  server.tool(
    "cloudgrid_rollback",
    "Rollback an entity to a previous version. Wraps `cloudgrid rollback`.",
    {
      name: z.string().describe("Entity slug."),
      to: z.string().optional().describe("Target version tag or id. Omit to roll back one version."),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    cliTool(({ name, to }) => {
      const args = ["rollback", name, "--yes"];
      if (to) args.push("--to", to);
      return args;
    }),
  );

  server.tool(
    "cloudgrid_versions",
    "List published versions for an entity. Wraps `cloudgrid versions`.",
    { name: z.string().optional().describe("Entity name. Omit for the entity linked to the current directory.") },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    cliTool(({ name }) => {
      const args = ["versions"];
      if (name) args.push(name);
      return args;
    }),
  );

  server.tool(
    "cloudgrid_env",
    "Manage environment variables for an entity. Wraps `cloudgrid env`.",
    {
      action: z.enum(["get", "set", "list"]).describe("get, set, or list."),
      name: z.string().describe("Entity slug."),
      key: z.string().optional().describe("Variable name. Required for get and set."),
      value: z.string().optional().describe("Variable value. Required for set."),
      cwd: z.string().optional().describe("Working directory. The CLI runs in this directory. Defaults to the MCP server's working directory."),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    cliTool(({ action, name, key, value }) => {
      if (action === "set") {
        if (!key || value === undefined) throw new Error("key and value are required for set");
        return ["env", "set", name, `${key}=${value}`];
      }
      if (action === "get") {
        if (!key) throw new Error("key is required for get");
        return ["env", "get", key, name];
      }
      return ["env", "list", name];
    }, { cwdParam: true }),
  );

  server.tool(
    "cloudgrid_secrets",
    "Set or list secret names for an entity. Never returns secret values. Wraps `cloudgrid secrets`.",
    {
      action: z.enum(["set", "list"]).describe("set or list (names only)."),
      name: z.string().describe("Entity slug."),
      key: z.string().optional().describe("Secret name. Required for set."),
      value: z.string().optional().describe("Secret value. Required for set."),
      cwd: z.string().optional().describe("Working directory. The CLI runs in this directory. Defaults to the MCP server's working directory."),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    cliTool(({ action, name, key, value }) => {
      if (action === "set") {
        if (!key || value === undefined) throw new Error("key and value are required for set");
        return ["secrets", "set", name, `${key}=${value}`];
      }
      return ["secrets", "list", name];
    }, { cwdParam: true }),
  );

  server.tool(
    "cloudgrid_scaffold",
    "Scaffold service folders declared in cloudgrid.yaml (idempotent). Wraps `cloudgrid scaffold`.",
    {
      cwd: z.string().optional().describe("Working directory. The CLI runs in this directory. Defaults to the MCP server's working directory."),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    cliTool(() => ["scaffold"], { cwdParam: true }),
  );

  server.tool(
    "cloudgrid_doctor",
    "Run CloudGrid diagnostics on the local environment. Wraps `cloudgrid doctor`.",
    {},
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    cliTool(() => ["doctor"]),
  );

  server.tool(
    "cloudgrid_open",
    "Return the public URL for an entity. Does not open a browser. Wraps `cloudgrid open --print`.",
    { name: z.string().optional().describe("Entity name. Omit for the entity linked to the current directory.") },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    cliTool(({ name }) => {
      const args = ["open", "--print"];
      if (name) args.push(name);
      return args;
    }),
  );
}

export { decodeJwt };
