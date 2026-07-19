// Direct-API tool internals: grid_deploy (runPlug), grid, claim, report, fork,
// download, visibility, and source retrieval.
// Extracted verbatim from src/tools.js (refactor: split tools.js into modules).

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { basename, dirname, resolve, join, sep } from "node:path";
import { tmpdir } from "node:os";
import {
  API_BASE,
  MCP_VERSION,
  ANON_HTML_MAX_BYTES,
  AUTHED_HTML_MAX_BYTES,
  CONSOLE_URL,
  VISIBILITY_LABELS,
  APPS_WIDGETS_ENABLED,
  GRID_PICKER_URI,
  PLUG_UPLOAD_TIMEOUT_MS,
} from "./constants.js";
import { okResult } from "./util.js";
import { runCloudgrid } from "./cli.js";

// ── Org listing (bearer-authed, web edition) ──────────────────────────────────
// Fetches the signed-in user's orgs via GET /api/v2/orgs. The JWT does not
// carry orgs (claims: sub, email, name, iat, exp), so the API is the canonical
// source. Returns [{slug, name, role, render_ready}].
export async function fetchUserOrgs(token) {
  try {
    const res = await fetch(`${API_BASE}/api/v2/orgs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return [];
    const data = await res.json();
    // 0.8.0: read the grid-native `data.grids` (dual-emitted alongside the legacy
    // `data.orgs`, same array/order). Fall back to `data.orgs`/bare-array during soak.
    const grids = Array.isArray(data?.grids)
      ? data.grids
      : Array.isArray(data?.orgs)
        ? data.orgs
        : Array.isArray(data)
          ? data
          : [];
    return grids.map((o) => ({
      slug: o.slug ?? "",
      name: o.name ?? o.slug ?? "",
      role: o.role ?? "member",
      render_ready: o.render_ready ?? true, // default true for older APIs
    }));
  } catch {
    return [];
  }
}

// ── Shared grid disambiguation (grid_deploy) ──────────────────
// The stateless "which grid?" ask on an authed create. Given the caller's token
// and a supplied grid, it decides:
//   - supplied grid matches a membership  → { proceed: true, grid }
//   - >1 grid and none supplied           → { picker } (a ready-to-return result)
//   - exactly one grid                    → { single: annotatedOrg } — the caller
//         decides how to treat a not-ready single grid (drop blocks; plug warns)
//   - no orgs / listing failed            → { proceed: true } (fall through)
// User-facing text says "grid" (Gilad's org→grid rename); the structured payload
// carries `needs_grid` AND the `needs_org`/`orgs`/`org`-slug fields the existing
// org-picker web widget reads, so the web card keeps working. Stateless — no
// dependence on prior-call state (ChatGPT Apps SDK reconnects every call).
export async function resolveGridOrAsk(ctx, { token, suppliedGrid, edition }, deps = {}) {
  const listGrids = deps.fetchUserOrgs || fetchUserOrgs;
  const grids = await listGrids(token);
  const activeGrid = await ctx.getActiveGrid();
  const matched = suppliedGrid && grids.find((o) => o.slug === suppliedGrid);
  if (matched) {
    // Supplied grid matches — proceed. The agent should already have checked
    // render_ready and warned the user; we don't block here.
    return { proceed: true, grid: suppliedGrid };
  }
  if (grids.length > 1) {
    // No valid grid supplied and multiple grids — ask once. Mark the active
    // grid so the agent can offer it as the default.
    const annotated = grids.map((o) => ({ ...o, is_active: o.slug === activeGrid }));
    // Sort: active grid first, then ready grids, then not-ready grids.
    annotated.sort((a, b) => {
      if (a.is_active !== b.is_active) return b.is_active ? 1 : -1;
      if (a.render_ready !== b.render_ready) return b.render_ready ? 1 : -1;
      return 0;
    });
    const lines = ["Which grid should this be published to?"];
    for (const o of annotated) {
      const tags = [];
      if (o.is_active) tags.push("your active grid");
      if (!o.render_ready) tags.push("not set up yet");
      const suffix = tags.length ? ` (${tags.join(", ")})` : "";
      lines.push(`  ${o.slug} — ${o.name} (${o.role})${suffix}`);
    }
    lines.push("Pass the grid slug in the `grid` parameter.");
    const readyCount = annotated.filter((o) => o.render_ready).length;
    if (readyCount === 0) {
      lines.push("Note: none of your grids are fully set up yet. You can use anonymous: true as a fallback.");
    }
    return {
      picker: {
        text: lines.join("\n"),
        // `needs_grid` is the new field; `needs_org`/`orgs` are kept as aliases
        // so the existing org-picker.html web widget (reads data.orgs) still works.
        structured: { needs_grid: true, needs_org: true, grids: annotated, orgs: annotated },
        ...(edition === "web" && APPS_WIDGETS_ENABLED ? { meta: { "openai/outputTemplate": GRID_PICKER_URI } } : {}),
      },
    };
  }
  if (grids.length === 1) {
    return { single: { ...grids[0], is_active: grids[0].slug === activeGrid } };
  }
  return { proceed: true };
}

// ── Direct-API tools (both editions) ───────────────────────────────────────────
function looksLikeFullHtml(s) {
  const head = s.replace(/^﻿/, "").trimStart().slice(0, 256).toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

// A real user (heavy persona-deck in Claude Desktop) hit an agent that worried
// about inline size, base64-encoded the HTML, and passed the base64 blob as
// `html` — which used to get wrapped in an HTML shell and published as a wall of
// text (an empty-looking page). Rescue that case: if the candidate text is not
// already full HTML but is a strict-base64 blob that DECODES to full HTML, use
// the decoded HTML. Applied to both the inline `html` string and the bytes read
// via `path` (a base64 `.txt` file). Returns the original text unchanged when it
// isn't base64-of-HTML, so genuine snippets are untouched.
function decodeIfBase64Html(text) {
  if (typeof text !== "string" || looksLikeFullHtml(text)) {
    return { html: text, wasBase64: false };
  }
  const stripped = text.replace(/\s+/g, "");
  if (
    stripped.length < 64 ||
    stripped.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(stripped)
  ) {
    return { html: text, wasBase64: false };
  }
  let decoded;
  try {
    decoded = Buffer.from(stripped, "base64").toString("utf8");
  } catch {
    return { html: text, wasBase64: false };
  }
  if (looksLikeFullHtml(decoded)) {
    return { html: decoded, wasBase64: true };
  }
  return { html: text, wasBase64: false };
}

// Heuristic: does the string look like a bare filesystem path (not HTML)? Used
// to catch a model that passes a file path — or an invented `@/home/...`
// shorthand — as `html`. Single line, no HTML tag, path-ish shape.
function looksLikePath(s) {
  if (typeof s !== "string") return false;
  const t = s.trim();
  if (t.length === 0 || t.length > 4096) return false;
  if (/[\n\r]/.test(t)) return false;
  if (/<[a-z!/]/i.test(t)) return false; // contains a tag → not a path
  return /^(~|\.{0,2}\/|[A-Za-z]:[\\/]|\/)/.test(t) || /\.[A-Za-z0-9]{1,8}$/.test(t);
}

// Normalize an inline `html` string — grid_deploy's ergonomic single-file publish
// path — into ONE index.html artifact, reusing the same hardening the old drop
// verb used (decodeIfBase64Html, the @-path/file-path rejection, the base64
// guard, and the small-fragment wrap). Returns { path, buffer, type }. Throws on
// a file-path-looking or non-HTML input so a path/base64 blob is never published
// as page content. The auth-aware inline size cap is enforced later in runPlug
// (it depends on the anon-vs-authed wire).
function htmlToArtifact(html, filename) {
  if (typeof html !== "string" || html.length === 0) {
    throw new Error("`html` must be the complete HTML document as a string.");
  }
  // Strip an invented `@`-prefix shorthand, then reject a bare file path — the
  // inline html path takes HTML CONTENT, not a path (use `path` for a file).
  let candidate = html.startsWith("@") ? html.slice(1) : html;
  if (!looksLikeFullHtml(candidate) && looksLikePath(candidate)) {
    throw new Error(
      `This looks like a file path (\`${candidate.trim()}\`), not HTML. Pass the raw HTML inline as ` +
        "`html`, or pass the file/folder via `path` — do not pass a path as `html`.",
    );
  }
  // Rescue a base64-of-HTML blob passed as `html` (real user repro): decode it
  // rather than publishing a wall of base64 text.
  const { html: resolved } = decodeIfBase64Html(candidate);
  let content = resolved;
  if (!looksLikeFullHtml(content)) {
    const stripped = content.replace(/\s+/g, "");
    const looksBase64 =
      stripped.length >= 64 && stripped.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(stripped);
    const isShortFragment = Buffer.byteLength(content, "utf8") <= 8192;
    const hasTag = /<[a-z][\s\S]*>/i.test(content);
    if (isShortFragment && (hasTag || (!looksBase64 && !looksLikePath(content)))) {
      // Legit "share this snippet" — wrap a small text/markup fragment into a
      // full document (preserve the old drop's friendly behavior).
      content =
        `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8">` +
        `<title>Shared on CloudGrid</title></head>\n<body>\n${content}\n</body>\n</html>\n`;
    } else {
      // Large, or base64 that failed to decode to HTML, or a bare file path:
      // refuse instead of silently publishing garbage.
      const kind = looksBase64 ? "base64" : looksLikePath(content) ? "a file path" : "raw data";
      throw new Error(
        `This doesn't look like an HTML document (it looks like ${kind}). Pass the raw HTML as \`html\`, ` +
          "or in the local edition pass `path` to the .html file — do NOT base64-encode it.",
      );
    }
  }
  return { path: filename || "index.html", buffer: Buffer.from(content, "utf8"), type: "text/html" };
}

// Anonymous drops are owned by the platform Guest Org, whose slug is the apex
// the public URL hangs off (https://guest.cloudgrid.io/<slug>).
const GUEST_ORG_SLUG = "guest";

// FALLBACK-ONLY URL composition. Since the unified plug contract (spec v2 /
// the unified plug spec), `/api/v2/plug` returns a server-composed canonical `url` on every
// path (create + edit, anon + authed) — flat-arch-aware per grid, matching the
// host that actually serves. ALWAYS prefer `data.url` (see resolvePlugUrl);
// this client-side derivation exists only for the rare response where `url`
// came back empty (the server composes it best-effort). It mirrors the legacy
// `entityUrl()` rules and is WRONG on flat-arch grids (which serve
// `<slug>--<grid>.cloudgrid.io`), so it must never be the primary source:
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

// Parse the top-level `name:` from a cloudgrid.yaml manifest (issue #48). The
// manifest is the source of truth for the entity name on a create, but the
// inline-create wire never forwarded it, so an `artifact_files` create landed as
// an auto `drop-XXXX` slug. Deliberately a tiny top-level-scalar scan (no YAML
// dep, matching the rest of this module): the FIRST unindented `name:` key wins,
// nested `services:`/`needs:` `name:` keys (indented) are ignored, and quotes +
// inline `# comments` are stripped. Returns null when absent/unparseable.
export function parseManifestName(yaml) {
  if (typeof yaml !== "string" || yaml.length === 0) return null;
  for (const rawLine of yaml.split(/\r?\n/)) {
    // Top-level keys only — a leading space/tab means it is nested under a map.
    if (/^\s/.test(rawLine)) continue;
    const m = /^name:\s*(.+?)\s*$/.exec(rawLine);
    if (!m) continue;
    let val = m[1];
    // Strip an inline comment on an unquoted scalar.
    if (!/^["']/.test(val)) val = val.replace(/\s+#.*$/, "").trim();
    // Strip surrounding quotes.
    val = val.replace(/^(["'])(.*)\1$/, "$2").trim();
    return val.length > 0 ? val : null;
  }
  return null;
}

// Detect whether a CREATE's source already carries a cloudgrid.yaml (i.e. it's
// a pre-configured runtime app). Returns a light summary { name, services, needs, raw }
// or null. Pure except the injectable disk read (path source).
export function detectSourceManifest(input, deps = {}) {
  const readManifestFile = deps.readManifestFile || ((p) => {
    try { return existsSync(p) ? readFileSync(p, "utf8") : null; } catch { return null; }
  });
  let yaml = null;
  if (typeof input?.cloudgrid_yaml === "string" && input.cloudgrid_yaml.trim()) {
    yaml = input.cloudgrid_yaml;
  } else if (Array.isArray(input?.artifact_files)) {
    // Only the ROOT cloudgrid.yaml is a runtime manifest — the server builds
    // from the root. A nested one (services/web/cloudgrid.yaml) is not.
    const entry = input.artifact_files.find((f) => f?.path === "cloudgrid.yaml");
    if (entry?.content) yaml = entry.content;
  } else if (typeof input?.path === "string" && input.path) {
    yaml = readManifestFile(join(input.path, "cloudgrid.yaml"));
  }
  if (!yaml) return null;
  const name = parseManifestName(yaml);
  // lightweight surface for the confirm prompt (no full YAML parser needed).
  // Scope each list to its own top-level block: collect only the immediate
  // child keys of `services:`/`needs:` — a shared 2-space regex would grab a
  // `needs:` child (e.g. `database`) as a bogus service.
  const lines = yaml.split(/\r?\n/);
  const blockChildren = (blockKey) => {
    const out = [];
    let inBlock = false;
    let childIndent = null;
    for (const line of lines) {
      if (/^\S/.test(line)) {
        // a top-level key: enters the target block, or ends it
        inBlock = new RegExp(`^${blockKey}:\\s*$`).test(line);
        childIndent = null;
        continue;
      }
      if (!inBlock || line.trim() === "") continue;
      const indent = line.match(/^(\s*)/)[1].length;
      if (childIndent === null) childIndent = indent;
      if (indent !== childIndent) continue; // deeper nesting (a child's props)
      const m = line.trim().match(/^([a-z0-9-]+):/i);
      if (m) out.push(m[1]);
    }
    return out;
  };
  const services = blockChildren("services");
  const needs = blockChildren("needs");
  return { name: name || null, services, needs, raw: yaml };
}

// The public URL of a `/plug` response: the server-composed `url` verbatim
// (canonical, flat-arch-aware — the unified plug spec), falling back to client-side composition
// ONLY when the server left it empty (its composition is best-effort).
export function resolvePlugUrl(data) {
  if (typeof data?.url === "string" && data.url.length > 0) return data.url;
  return composePlugUrl(data);
}


// ── Consent-gated error reporting (Task 34 / 0.8.1) ──────────────────────────
// Key names that look like they carry a secret. Mirrors the server's
// SECRET_KEY_PATTERNS (packages/api/src/routes/errors.ts) so the MCP scrubs the
// same shapes client-side — defense-in-depth on top of the server redaction.
const REPORT_SECRET_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /auth/i,
  /credential/i,
  /private[_-]?key/i,
  /access[_-]?key/i,
];

// Light client-side scrub of obviously secret-looking values in the report
// context. Redacts values under secret-looking KEYS; leaves everything else
// intact (the server does the authoritative redaction). Bounded depth so a
// pathological object can't loop.
export function scrubReportContext(obj, depth = 0) {
  if (depth > 5 || obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((item) => scrubReportContext(item, depth + 1));
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const isSecret = REPORT_SECRET_KEY_PATTERNS.some((re) => re.test(key));
    out[key] = isSecret ? "[REDACTED]" : scrubReportContext(value, depth + 1);
  }
  return out;
}

// Send a consent-gated bug report to the CloudGrid team. The agent calls this
// ONLY after the user explicitly agrees (see errorGuidance + the PLAYBOOK rule).
//
// Matches the CLI reporter (packages/cli error-reporter.ts → client.reportError):
// POST /api/v2/errors with the CLI payload shape
//   { type:'error', category, app, message, stack?, context, trace_id?,
//     failed_step?, http_status?, cli_version, node_version, platform }
// so CLI + MCP reports land uniformly in the `errors` collection.
//
// Source attribution (Gilad's ask): every report says WHERE it came from —
// source (mcp-stdio | mcp-hosted), client (the calling agent from MCP clientInfo),
// platform, mcp_version. Sent BOTH as top-level fields AND mirrored in
// `context.origin`. The POST /errors handler only persists known top-level keys
// (it drops unknown ones), and `context` is stored + secret-stripped server-side,
// so `context.origin` is the durable carrier — belt-and-suspenders.
//
// Auth: signed-in → Bearer; anon+web → the trusted-server headers (works once the
// endpoint accepts the credential; until then a 401 degrades to "sign in to
// report"). Honors CLOUDGRID_TELEMETRY=off (matches the CLI). Never throws.
export async function runReport(
  ctx,
  { message, context, include_conversation, category, trace_id, failed_step, http_status } = {},
) {
  const summary = typeof message === "string" ? message.trim() : "";
  if (!summary) {
    return okResult({
      text: "Nothing to report — provide a short `message` describing what failed.",
      structured: { status: "skipped" },
    });
  }

  // Privacy escape hatch — no telemetry when explicitly disabled (matches the CLI
  // reporter's CLOUDGRID_TELEMETRY=off). Consent still gates the call regardless;
  // this is the belt-and-suspenders global opt-out. Nothing leaves the process.
  if (process.env.CLOUDGRID_TELEMETRY === "off") {
    return okResult({
      text: "Error reporting is disabled (CLOUDGRID_TELEMETRY=off) — nothing was sent.",
      structured: { status: "disabled" },
    });
  }

  // ── Source attribution ──────────────────────────────────────────────────────
  // source: mcp-stdio (local edition) | mcp-hosted (web edition).
  const source = ctx.edition === "web" ? "mcp-hosted" : "mcp-stdio";
  // client: the calling agent captured from the MCP clientInfo at initialize.
  // Falls back to "unknown" — a report must never fail on missing client info.
  const ci = ctx.state?.client;
  const client =
    ci && ci.name
      ? ci.version
        ? `${ci.name} ${ci.version}`
        : String(ci.name)
      : "unknown";
  const platform = `${process.platform} ${process.arch}`;

  // Belt-and-suspenders scrub before the value ever leaves the process. The
  // origin block is authored by us (not user/agent input), so it is appended
  // AFTER the scrub — it carries no secrets and must survive verbatim.
  const scrubbed =
    context && typeof context === "object" ? scrubReportContext(context) : {};
  const safeContext = {
    ...scrubbed,
    origin: {
      source,
      client,
      platform,
      mcp_version: MCP_VERSION,
    },
  };

  // The full conversation is NEVER included unless the agent explicitly set the
  // flag (which the PLAYBOOK gates on the user's explicit yes). This tool only
  // records the flag alongside the report so intent is auditable — it does not
  // itself have the transcript.
  const body = {
    type: "error",
    // category: default "mcp" (or the failing tool name the agent passes).
    category: typeof category === "string" && category.trim() ? category.trim() : "mcp",
    app: "mcp",
    message: summary.slice(0, 5000),
    context: safeContext,
    // Diagnostic pivots (match the CLI) — only when the agent forwards them.
    ...(typeof trace_id === "string" && trace_id ? { trace_id } : {}),
    ...(typeof failed_step === "string" && failed_step ? { failed_step } : {}),
    ...(typeof http_status === "number" && Number.isFinite(http_status) ? { http_status } : {}),
    // Attribution, ALSO top-level (persisted once the handler accepts these keys;
    // context.origin is the fallback until then).
    source,
    client,
    platform,
    // cli_version stays null for MCP-originated reports; mcp_version carries our
    // version in context.origin (the CLI-analog lives there).
    cli_version: null,
    node_version: process.version,
    ...(include_conversation === true ? { include_conversation: true } : {}),
  };

  // Auth: signed-in → Bearer; anon + web edition → trusted-server headers.
  const headers = { "content-type": "application/json" };
  let token = null;
  try {
    token = await ctx.getToken();
  } catch {
    token = null;
  }
  let usedTrustedServer = false;
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  } else if (ctx.trustedServer?.secret && ctx.trustedServer?.endUserId) {
    // Web edition anon path — works ONCE the endpoint accepts the trusted-server
    // credential (Gilad-side change). Until then the server 401s and we degrade.
    headers["X-CloudGrid-Trusted-Server-Auth"] = ctx.trustedServer.secret;
    headers["X-CloudGrid-Trusted-Server-End-User"] = ctx.trustedServer.endUserId;
    usedTrustedServer = true;
  }

  let res;
  try {
    res = await fetch(`${API_BASE}/api/v2/errors`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    return okResult({
      text: `Couldn't reach the CloudGrid team right now (${err.message}). Nothing was sent — you can try again later.`,
      structured: { status: "error" },
    });
  }

  if (res.status === 201 || res.ok) {
    return okResult({
      text: "Reported to the CloudGrid team — thank you.",
      structured: { status: "recorded" },
    });
  }
  if (res.status === 429) {
    return okResult({
      text: "Already reported a lot recently; try again later.",
      structured: { status: "rate_limited" },
    });
  }
  if (res.status === 401) {
    // Anon reporting isn't accepted yet (needs the Gilad-side endpoint change);
    // degrade gracefully rather than erroring.
    return okResult({
      text: usedTrustedServer || !token
        ? "Sign in to send a report to the CloudGrid team (grid_login), then try again."
        : "That didn't authorize a report. Sign in again (grid_login) and retry.",
      structured: { status: "unauthorized" },
    });
  }
  return okResult({
    text: "Couldn't send the report to the CloudGrid team right now. Nothing else was sent — you can try again later.",
    structured: { status: "error" },
  });
}

export async function runClaim(ctx, { claim_token, claim_url, entity_id }) {
  const token = await ctx.getToken();
  if (!token) {
    throw new Error("You are not signed in. Run grid_login first, then claim.");
  }

  // `/api/v2/anon-claim` (claim-token-in-body, returns a list) was retired; the
  // claim now runs through `POST /api/v2/entities/:id/pickup`, which takes the
  // entity id in the PATH and the `claim_token` in the body, and re-homes the
  // Guest-Org inspiration into the caller's grid (ownership transfer). The
  // claim token IS the anonymous owner token (Anon owner-token contract: one bearer
  // capability for both edit and claim); an anon edit re-mints it, and the
  // session state always holds the freshest one. The anon-session cookie is the
  // token-less alternative auth.
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
  const targetId =
    entity_id ||
    ctx.state.lastAnonClaim?.entity_id ||
    // The last drop counts only when it is anon-owned (it holds an owner token).
    (ctx.state.lastDrop?.owner_token ? ctx.state.lastDrop.entity_id : null);
  if (!claimToken && targetId && ctx.state.lastDrop?.entity_id === targetId) {
    claimToken = ctx.state.lastDrop.owner_token ?? null;
  }
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
  const orgSlug = await ctx.getActiveGrid();
  // Grid-native header + X-CloudGrid-Org alias (same slug) during the soak.
  if (orgSlug) {
    headers["X-CloudGrid-Grid"] = orgSlug;
    headers["X-CloudGrid-Org"] = orgSlug;
  }
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
  // The entity is authed-owned now — the anon owner token is dead weight (a
  // claimed drop can no longer be edited anonymously). Future re-drops of it
  // must ride the authed wire.
  if (ctx.state.lastDrop?.entity_id === targetId) {
    ctx.state.lastDrop.owner_token = null;
  }
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


// ── grid_deploy — the unified create/re-plug verb (spec v2 §3) ──────────────

// Total upload budget mirrors the server's multipart cap (100 MB).
const PLUG_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const PLUG_MAX_FILES = 2000;

// Directories never worth uploading, regardless of ignore files.
const PLUG_ALWAYS_SKIP = new Set([".git", "node_modules", ".DS_Store", ".cloudgrid"]);

// Compile one .gitignore/.cloudgridignore pattern into a matcher over
// repo-relative paths. A pragmatic subset (no negation `!` — those lines are
// skipped): `#` comments, `*`/`?`/`**` globs, a leading `/` anchors to the
// root, a trailing `/` matches directories only, and a bare name matches at
// any depth (standard gitignore semantics for patterns without a slash).
function compileIgnorePattern(line) {
  let pat = line.trim();
  if (!pat || pat.startsWith("#") || pat.startsWith("!")) return null;
  const dirOnly = pat.endsWith("/");
  if (dirOnly) pat = pat.slice(0, -1);
  // A pattern containing a slash is anchored to the root (gitignore rule).
  const anchored = pat.includes("/");
  if (pat.startsWith("/")) pat = pat.slice(1);
  const rx = pat
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, " ")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/ /g, ".*");
  const body = anchored ? `^${rx}` : `(^|/)${rx}`;
  const re = new RegExp(`${body}(/|$)`);
  return { re, dirOnly };
}

function loadIgnoreMatchers(rootDir) {
  const patterns = [];
  for (const f of [".gitignore", ".cloudgridignore"]) {
    try {
      const p = join(rootDir, f);
      if (existsSync(p)) {
        for (const line of readFileSync(p, "utf-8").split("\n")) {
          const compiled = compileIgnorePattern(line);
          if (compiled) patterns.push(compiled);
        }
      }
    } catch {
      /* unreadable ignore file — upload everything */
    }
  }
  return (relPath, isDir) =>
    patterns.some((p) => (!p.dirOnly || isDir) && p.re.test(relPath));
}

// ── Zip deploys (local edition) ──────────────────────────────────────────────
// "Build me a gallery site with the attached images (zip)" — the local server
// CAN open archives even though the model cannot. `path` accepts a .zip: it is
// extracted to a temp dir and deployed. Because the platform's multi-file
// INSPIRATION create currently persists only the primary HTML (see the
// inline-create issue filed 2026-07-17), a multi-file zip is ALWAYS shaped as
// a static RUNTIME project — a synthesized cloudgrid.yaml (type: static) with
// the files under services/web/ — which the server builds and serves fully.
// A zip that ships its own cloudgrid.yaml is deployed as-is.
//
// `html` is allowed TOGETHER with a zip path (the one source combo): it becomes
// services/web/index.html, so an agent on a no-filesystem client can generate
// the page inline while the archive supplies the assets.

function isZipPath(srcPath) {
  const abs = resolve(srcPath);
  if (!existsSync(abs) || !statSync(abs).isFile()) return false;
  if (/\.zip$/i.test(abs)) return true;
  // Magic sniff so "photos.ZIP.download"-style names still work.
  try {
    const fd = readFileSync(abs);
    return fd.length >= 4 && fd[0] === 0x50 && fd[1] === 0x4b && fd[2] === 0x03 && fd[3] === 0x04;
  } catch {
    return false;
  }
}

// Extract a zip safely and return the directory to deploy. Throws on traversal.
async function expandZipToProject(zipPath, inlineHtml) {
  const { unzipSync } = await import("fflate");
  const raw = readFileSync(resolve(zipPath));
  if (raw.byteLength > PLUG_MAX_TOTAL_BYTES) {
    throw new Error("The zip exceeds the 100MB plug limit. Trim it or split the content.");
  }
  let entries;
  try {
    entries = unzipSync(new Uint8Array(raw));
  } catch (err) {
    throw new Error(`Could not read the zip archive: ${err.message}`);
  }
  // Sanitize: reject traversal, skip macOS metadata + always-skip dirs.
  const files = [];
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith("/")) continue; // directory entry
    const norm = name.replace(/\\/g, "/");
    if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm) || norm.split("/").includes("..")) {
      throw new Error(`Refusing zip entry outside the archive root: ${name}`);
    }
    const parts = norm.split("/");
    if (parts.includes("__MACOSX") || parts.some((p) => PLUG_ALWAYS_SKIP.has(p))) continue;
    files.push({ path: norm, data });
  }
  if (files.length === 0) throw new Error("The zip contains no deployable files.");
  if (files.length > PLUG_MAX_FILES) {
    throw new Error(`The zip has more than ${PLUG_MAX_FILES} files — too large to plug.`);
  }
  // Strip a single common root folder (the usual zip-of-a-folder shape) — but
  // ONLY when stripping surfaces an index.html or cloudgrid.yaml at the root.
  // An assets-only archive like img/a.png shares a common root too, and
  // flattening it would break the page's relative img/ references.
  const firstSeg = files[0].path.split("/")[0];
  const singleRoot =
    files.every((f) => f.path.split("/")[0] === firstSeg) && files.every((f) => f.path.includes("/"));
  if (singleRoot) {
    const stripped = files.map((f) => f.path.slice(firstSeg.length + 1));
    if (stripped.some((p) => /^index\.html?$/i.test(p) || p === "cloudgrid.yaml")) {
      files.forEach((f, i) => { f.path = stripped[i]; });
      if (files.some((f) => !f.path)) throw new Error("Unexpected zip layout (empty path after root strip).");
    }
  }

  const hasManifest = files.some((f) => f.path === "cloudgrid.yaml");
  const hasIndex = files.some((f) => /^index\.html?$/i.test(f.path));
  const hasInlineHtml = typeof inlineHtml === "string" && inlineHtml.length > 0;
  if (hasInlineHtml && hasManifest) {
    throw new Error(
      "The zip already contains a cloudgrid.yaml project — deploy it as-is (drop the `html` param), " +
        "or re-plug the entity and edit its files instead.",
    );
  }
  if (hasInlineHtml && hasIndex) {
    throw new Error(
      "The zip already has an index.html — pass either the zip alone, or `html` with a zip of assets only.",
    );
  }
  if (!hasManifest && !hasIndex && !hasInlineHtml) {
    throw new Error(
      "The zip has no index.html and no cloudgrid.yaml. Generate the page first and pass it as `html` " +
        "alongside the zip (the archive then supplies the assets), or add an index.html to the archive.",
    );
  }

  // A zip that is JUST one HTML page (no manifest, no assets) rides the
  // instant single-file inspiration path instead of a runtime build.
  if (!hasManifest && !hasInlineHtml && files.length === 1 && /^index\.html?$/i.test(files[0].path)) {
    return { singleHtml: Buffer.from(files[0].data).toString("utf8") };
  }

  const dir = await mkdtemp(join(tmpdir(), "cloudgrid-zip-"));
  const writeAll = async (base) => {
    for (const f of files) {
      const dest = resolve(join(base, f.path));
      if (dest !== base && !dest.startsWith(base + sep)) {
        throw new Error(`Refusing to write zip entry outside the temp dir: ${f.path}`);
      }
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, f.data);
    }
  };

  if (hasManifest) {
    // The archive is already a CloudGrid project — deploy verbatim.
    await writeAll(resolve(dir));
    return { projectDir: dir, name: null };
  }

  // Synthesize a static-runtime wrapper: name from the archive, files under
  // services/web/. (Static RUNTIME, not inspiration, so every file survives.)
  const rawName = basename(resolve(zipPath)).replace(/\.zip$/i, "");
  const slugged = rawName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 42);
  const name = slugged.length >= 2 && /^[a-z0-9]/.test(slugged) ? slugged : "zip-site";
  const webDir = resolve(join(dir, "services", "web"));
  await mkdir(webDir, { recursive: true });
  await writeAll(webDir);
  if (hasInlineHtml) {
    const art = htmlToArtifact(inlineHtml);
    await writeFile(join(webDir, "index.html"), art.buffer);
  }
  await writeFile(
    join(dir, "cloudgrid.yaml"),
    `name: ${name}\ndescription: Deployed from ${basename(zipPath)}.\nservices:\n  web:\n    type: static\n    path: /\n`,
  );
  return { projectDir: dir, name };
}

// Deploy an extracted zip PROJECT through the CLI (`grid init --here` +
// `grid plug`). The direct-API inline wire cannot be used here: verified live
// 2026-07-17, it drops secondary files on inspiration creates AND never starts
// the build for runtime creates from path-mode ("charged, not yet live" —
// entities drop-df1f / drop-e86d). The CLI plug path builds correctly (every
// runtime this week shipped through it), so zip projects ride it.
async function plugZipProjectViaCli(ctx, { projectDir, name }, input, deps = {}) {
  const { cliRun = runCloudgrid } = deps;
  const grid = input?.grid || (await ctx.getActiveGrid?.()) || null;
  const plugArgs = ["plug", "--no-progress", "--no-clipboard", "--no-notify"];
  // CLI >= 0.15.14: `plug` auto-creates the entity in an unlinked dir from the
  // manifest (init semantics folded into plug), honoring its name:. Try that
  // first — one command, no stash dance.
  let stdout = null;
  try {
    stdout = String((await cliRun(plugArgs, { cwd: projectDir })) || "");
  } catch (err) {
    const msg = String(err?.message || err);
    // Older CLIs (< 0.15.14) refuse an unlinked dir and point at init. Fall
    // back to the legacy dance: stash the manifest (old `init --here` refuses
    // a dir that already has one), init (mints the real slug), restore the
    // manifest with the assigned slug, then plug. `--here` exists on every
    // CLI that takes this branch; 0.15.14+ (which dropped it) never gets here.
    if (!/isn't linked|not linked|grid init|grid new/i.test(msg)) throw err;
    const manifestPath = join(projectDir, "cloudgrid.yaml");
    const manifestBody = readFileSync(manifestPath, "utf8");
    const yamlName =
      name ||
      (() => {
        const m = /^name:\s*(.+?)\s*$/m.exec(manifestBody);
        return m ? m[1].replace(/^["']|["']$/g, "") : "zip-site";
      })();
    await rm(manifestPath, { force: true });
    const initArgs = ["init", "app", yamlName, "--here", ...(grid ? ["--grid", grid] : [])];
    const initOut = String((await cliRun(initArgs, { cwd: projectDir })) || "");
    let assignedSlug = /Slug:\s+(\S+)/.exec(initOut)?.[1] ?? null;
    if (!assignedSlug) {
      try {
        assignedSlug = JSON.parse(readFileSync(join(projectDir, ".cloudgrid", "link.json"), "utf8")).entity_slug;
      } catch {
        assignedSlug = yamlName;
      }
    }
    await writeFile(manifestPath, manifestBody.replace(/^name:.*$/m, `name: ${assignedSlug}`));
    stdout = String((await cliRun(plugArgs, { cwd: projectDir })) || "");
  }
  const url = parseCliPlugUrl(stdout);
  if (!url) {
    throw new Error(
      `The zip project deployed via the CLI but no live URL was found in its output.\n${stdout.slice(0, 500)}`,
    );
  }
  return {
    text:
      `Live: ${url}\n` +
      "(Deployed from the zip archive as a static app via the bundled CloudGrid CLI.)",
    structured: { url, status: "created", via: "zip-cli" },
  };
}

// Walk a local folder into `[{path, buffer}]` artifacts (repo-relative paths),
// honoring .gitignore/.cloudgridignore at the root plus the always-skip set.
// A single file becomes one artifact named by its basename.
function collectPathArtifacts(srcPath) {
  const abs = resolve(srcPath);
  if (!existsSync(abs)) throw new Error(`Path does not exist: ${abs}`);
  const st = statSync(abs);
  if (st.isFile()) {
    return [{ path: basename(abs), buffer: readFileSync(abs) }];
  }
  if (!st.isDirectory()) throw new Error(`Not a file or directory: ${abs}`);
  const isIgnored = loadIgnoreMatchers(abs);
  const out = [];
  let total = 0;
  const walk = (dir, rel) => {
    for (const nm of readdirSync(dir)) {
      if (PLUG_ALWAYS_SKIP.has(nm)) continue;
      const childAbs = join(dir, nm);
      const childRel = rel ? `${rel}/${nm}` : nm;
      let cst;
      try {
        cst = statSync(childAbs);
      } catch {
        continue; // broken symlink etc.
      }
      if (isIgnored(childRel, cst.isDirectory())) continue;
      if (cst.isDirectory()) {
        walk(childAbs, childRel);
      } else if (cst.isFile()) {
        if (out.length >= PLUG_MAX_FILES) {
          throw new Error(
            `The folder has more than ${PLUG_MAX_FILES} files after ignores — too large to plug inline. Trim it or add a .cloudgridignore.`,
          );
        }
        total += cst.size;
        if (total > PLUG_MAX_TOTAL_BYTES) {
          throw new Error("The upload exceeds the 100MB plug limit. Trim the folder or add a .cloudgridignore.");
        }
        out.push({ path: childRel, buffer: readFileSync(childAbs) });
      }
    }
  };
  walk(abs, "");
  if (out.length === 0) throw new Error(`Nothing to upload in ${abs} (everything ignored or empty).`);
  return out;
}

// ── Self-healing error guidance (Task 31 / 0.7.2) ────────────────────────────
// Map a KNOWN failure code to a short, agent-facing next-step sentence appended
// to the raw server error. Returns null for anything unknown — callers MUST let
// unknown errors pass through UNCHANGED (no blanket rewriting). Pure and
// exported so the unit tests can assert the mapping directly.
//
// Context flags:
//   edition   — "local" | "web"; steers the SCOPE_INVALID wording (the local
//               edition self-heals via the bundled CLI; the web edition cannot).
//   isEdit    — a re-plug (target_entity_id present) vs a create.
//   isAnon    — the call already rode the anonymous wire.
//   signedIn  — the caller has a usable auth token (steers the 429 wording).
export function errorGuidance({ status, code, edition, isEdit, isAnon, signedIn } = {}) {
  // 400 SCOPE_INVALID — the known platform bug: the /plug create branch ignores
  // scope/visibility on a signed-in create and 400s (scope=personal,
  // visibility=grid). It does NOT affect re-plug of an existing entity.
  if (status === 400 && code === "SCOPE_INVALID") {
    // Anonymous creates don't hit this branch; if one somehow reports it, there
    // is no self-heal path — say nothing edition-specific.
    if (isAnon) return null;
    if (isEdit) {
      // A re-plug that 400s here is not the create bug — no special guidance.
      return null;
    }
    if (edition === "local") {
      return "Known platform issue with signed-in creates via the plug API. Falling back to the bundled CloudGrid CLI…";
    }
    // web (and any non-local edition): no CLI to fall back to.
    return (
      "Known platform issue with signed-in creates via the plug API. " +
      "Re-plug of an existing entity still works; creating new entities is temporarily affected — " +
      "do NOT retry with other parameters and do NOT fall back to anonymous."
    );
  }
  // 429 — the daily anonymous cap. Never a sign-in problem; do not loop on login.
  if (status === 429) {
    return (
      "Do not retry today and do not treat this as a sign-in problem. " +
      "If the user is signed in, use the signed-in path instead of anonymous."
    );
  }
  // 409 EDIT_REJECTED — an in-place re-plug the server won't take.
  if (status === 409) {
    return "The entity cannot be updated right now (a deploy is in progress, or it is archived/expired/claimed). An explicit re-plug never silently creates; retry later, or omit target_entity_id to create a new entity.";
  }
  // 401 on an edit — the credential didn't authorize this entity.
  if (status === 401) {
    return isEdit
      ? "That did not authorize this entity (wrong entity, expired, or already claimed). Sign in if you own it (grid_login), pass its owner_token for an anonymously-created drop, or omit target_entity_id to create a new entity."
      : "Sign in (grid_login), or for an anonymously-created drop pass its owner_token.";
  }
  if (status === 403) {
    return "You lack the role to plug this target. To re-plug someone else's entity, pick it up first (grid_edit_existing_app / grid_claim_anonymous_deploy).";
  }
  // ── Consent-gated report offer (Task 34) ──────────────────────────────────
  // GENUINE bugs only: a build/deploy failure, any 5xx, INTERNAL_ERROR, or an
  // unknown/unmapped error. Everything above (429 rate-limit, needs_grid picker,
  // 401 sign-in prompts, 409 EDIT_REJECTED, 403) is an EXPECTED condition, not a
  // bug — those returned already and never reach here, so they never get the
  // offer. The offer tells the agent to ask permission first and never send the
  // full conversation without an explicit yes.
  const isServerError = typeof status === "number" && status >= 500;
  const isInternalError = code === "INTERNAL_ERROR";
  const isBuildFailure = code === "BUILD_FAILED" || code === "DEPLOY_FAILED";
  if (isServerError || isInternalError || isBuildFailure) {
    return REPORT_OFFER;
  }
  // A 4xx with an unknown/unmapped code is a client-side condition (validation,
  // bad input), not a server bug — pass through unchanged so callers don't
  // rewrite it or wrongly offer to report it.
  return null;
}

// The consent-gated report affordance appended to genuine-bug guidance. It
// instructs the agent to get explicit permission before calling grid_report,
// and to never send the whole conversation without an explicit yes.
export const REPORT_OFFER =
  "If this looks like a CloudGrid bug, ASK the user for permission to report it to the CloudGrid team, " +
  "then call grid_report with the error + the failed request context. " +
  "Do NOT report without an explicit yes, and do NOT include the full conversation unless the user explicitly agrees.";

// Map friendly plug error statuses to actionable messages (spec v2 §3.3).
// Appends errorGuidance() for known codes; unknown codes pass through as the
// bare `base` line, unchanged.
function plugErrorMessage(status, code, msg, ctxFlags = {}) {
  const base = `Plug failed (HTTP ${status}${code ? ` ${code}` : ""}): ${msg}`;
  const guidance = errorGuidance({ status, code, ...ctxFlags });
  return guidance ? `${base} — ${guidance}` : base;
}

// Parse the live URL the CLI prints on a successful `plug`. The CLI prints the
// canonical https://…cloudgrid.io URL somewhere in stdout (labelled "Outlet"
// / "Live" / bare); take the last cloudgrid.io URL it emits — the final line is
// the deployed URL, not an intermediate build/log link.
export function parseCliPlugUrl(stdout) {
  const matches = String(stdout || "").match(/https?:\/\/[^\s'"<>)\]]*cloudgrid\.io[^\s'"<>)\]]*/g);
  if (!matches || matches.length === 0) return null;
  return matches[matches.length - 1].replace(/[.,;]+$/, "");
}

// LOCAL-EDITION SELF-HEAL RUNG (Task 31). When a signed-in CREATE via /plug hits
// the known 400 SCOPE_INVALID platform bug, re-run the create through the
// bundled CloudGrid CLI (whose wire is unaffected). Writes the in-memory
// artifacts to a temp dir, runs `plug <dir> --no-clipboard --no-notify`, parses
// the live URL, and returns a normal runPlug-shaped success. Always cleans up
// the temp dir. The `run` dep is a seam for tests (defaults to runCloudgrid).
//
// Caller MUST gate this: local edition, create only (never edits), signed-in
// (never anonymous), and only for the SCOPE_INVALID failure.
export async function plugViaCliFallback(ctx, artifacts, deps = {}) {
  const { run = runCloudgrid, makeTmp = () => mkdtemp(join(tmpdir(), "cloudgrid-plug-")) } = deps;
  const dir = await makeTmp();
  try {
    const root = resolve(dir);
    for (const a of artifacts) {
      const dest = resolve(root, a.path);
      // Containment guard: never let an artifact path escape the temp dir.
      if (dest !== root && !dest.startsWith(root + sep)) {
        throw new Error(`Refusing to write artifact outside the temp dir: ${a.path}`);
      }
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, a.buffer);
    }
    const stdout = await run(["plug", dir, "--no-clipboard", "--no-notify"]);
    const url = parseCliPlugUrl(stdout);
    if (!url) {
      throw new Error(
        `CLI fallback ran but no live URL was found in its output.\n${String(stdout || "").slice(0, 500)}`,
      );
    }
    // The CLI created the entity; keep session continuity loosely (no entity_id
    // is parsed from stdout, so a later re-plug rides the create path again).
    ctx.state.lastAnonClaim = null;
    return {
      text:
        `Live: ${url}\n` +
        "(Recovered via the bundled CloudGrid CLI — the signed-in plug API hit a known platform issue, so the CLI published this instead.)",
      structured: { url, status: "created", via: "cli-fallback" },
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * The unified create/re-plug verb (spec v2 §3). Two intents on one tool, keyed
 * by `target_entity_id`:
 *   - absent → CREATE: mint a new entity from the artifact (server detection
 *     decides the kind unless hinted). Authed → the caller's grid; anon → a
 *     Guest-Grid drop with a claim_url + owner_token.
 *   - present → RE-PLUG: update the SAME entity in place (same id, slug, URL,
 *     history). Authed for entities in your grid; `owner_token` for a drop
 *     minted anonymously (anon owner-token contract).
 * Source is `path` (local edition — the folder/file is read and uploaded) XOR
 * `artifact_files` (hosted — inline file entries).
 */
export async function runPlug(ctx, input, deps = {}) {
  const { fetchImpl = fetch, uploadTimeoutMs = PLUG_UPLOAD_TIMEOUT_MS } = deps;
  const {
    path: srcPath,
    artifact_files,
    html,
    filename,
    cloudgrid_yaml,
    target_entity_id,
    grid,
    slug,
    hints,
    anon,
    owner_token,
  } = input || {};

  // ── Source: exactly one of html | artifact_files | path ─────────────────────
  // One allowed combo: `html` + a `path` that is a ZIP archive — the html
  // becomes index.html and the archive supplies the assets (the Desktop
  // "gallery from a zip" flow, where the model can generate a page but cannot
  // write files).
  let hasHtml = typeof html === "string" && html.length > 0;
  const hasArtifacts = Array.isArray(artifact_files) && artifact_files.length > 0;
  let hasPath = Boolean(srcPath);
  let effectivePath = srcPath;
  const zipSource = hasPath && ctx.edition !== "web" && isZipPath(srcPath);
  if ((hasHtml ? 1 : 0) + (hasArtifacts ? 1 : 0) + (hasPath ? 1 : 0) > 1 && !(zipSource && hasHtml && !hasArtifacts)) {
    throw new Error(
      "Pass exactly one source: `html` (a single inline HTML document), `artifact_files` " +
        "(multiple inline files), or `path` (a local file/folder/zip). Exception: `html` " +
        "may accompany a .zip `path` — it becomes the index.html over the archive's assets.",
    );
  }
  if (ctx.edition === "web" && hasPath) {
    throw new Error(
      "The hosted server cannot read local files — pass the source inline via `html` or `artifact_files`.",
    );
  }
  let zipSingleHtml = null;
  if (zipSource) {
    if (target_entity_id || (slug && grid)) {
      throw new Error(
        "Re-plugging an existing entity from a zip is not supported yet — pick up the app " +
          "(grid_edit_existing_app) and re-plug the folder, or deploy the zip as a new entity.",
      );
    }
    if (anon) {
      throw new Error("A zip deploy creates a static app and needs sign-in — it cannot be anonymous.");
    }
    const expanded = await expandZipToProject(srcPath, hasHtml ? html : null);
    if (expanded.singleHtml) {
      // One-page archive → instant inspiration via the proven html wire.
      zipSingleHtml = expanded.singleHtml;
      hasPath = false;
      hasHtml = true;
    } else {
      // Multi-file / project archive → CLI deploy (see plugZipProjectViaCli).
      return plugZipProjectViaCli(ctx, expanded, input, deps);
    }
  }
  let artifacts;
  // Set on the single-file `html` path so the auth-aware inline size cap can be
  // enforced once the anon-vs-authed wire is known (see below).
  let inlineHtmlBytes = null;
  if (hasHtml) {
    // The ergonomic single-file publish path (the old drop verb): one self-
    // contained HTML document → one index.html artifact, with the shared
    // hardening (base64 rescue, @-path/file-path rejection, fragment wrap).
    const art = htmlToArtifact(zipSingleHtml ?? html, filename);
    inlineHtmlBytes = art.buffer.byteLength;
    artifacts = [art];
  } else if (hasPath) {
    artifacts = collectPathArtifacts(effectivePath);
  } else if (hasArtifacts) {
    let total = 0;
    artifacts = artifact_files.map((f) => {
      if (!f || typeof f.path !== "string" || typeof f.content !== "string") {
        throw new Error("Each artifact_files entry needs `path` and `content`.");
      }
      const buffer = Buffer.from(f.content, f.encoding === "base64" ? "base64" : "utf8");
      total += buffer.byteLength;
      if (total > PLUG_MAX_TOTAL_BYTES) {
        throw new Error("The upload exceeds the 100MB plug limit.");
      }
      return { path: f.path, buffer };
    });
  } else {
    throw new Error(
      ctx.edition === "web"
        ? "Provide the source via `html` (a single inline HTML document) or `artifact_files`."
        : "Provide the source via `html` (a single inline HTML document), `path` (a local file " +
          "or folder), or `artifact_files`.",
    );
  }

  // grid+slug re-plug handle (the pickup contract's `replug_handle`): when no
  // explicit target_entity_id was given but a grid+slug pair is, resolve it to
  // an existing entity_id and re-plug that in place. A slug that does NOT resolve
  // to an existing entity → targetEntityId stays empty → this is a CREATE (no
  // false-positive re-plug). target_entity_id remains the primary/documented
  // handle. Best-effort resolve (pickup contract); never fetches the public URL.
  let targetEntityId = target_entity_id;
  if ((typeof targetEntityId !== "string" || targetEntityId.length === 0) && grid && slug) {
    const resolved = await resolveEntityViaPickup(ctx, { target: slug, grid });
    if (resolved?.entity_id) targetEntityId = resolved.entity_id;
  }

  const isEdit = typeof targetEntityId === "string" && targetEntityId.length > 0;

  // An inspiration edit content-versions the FIRST uploaded artifact — when a
  // multi-file folder rides a re-plug, put the primary entry first so the edit
  // swaps the right file (index.html > any .html > everything else).
  if (isEdit && artifacts.length > 1) {
    const prio = (a) =>
      a.path === "index.html" ? 0 : /\.html?$/i.test(a.path) ? 1 : a.path.startsWith(".") ? 3 : 2;
    artifacts = artifacts
      .map((a, i) => ({ a, i }))
      .sort((x, y) => prio(x.a) - prio(y.a) || x.i - y.i)
      .map((x) => x.a);
  }

  // ── Auth wire selection ─────────────────────────────────────────────────────
  const authToken = anon === true ? null : await ctx.getToken();
  let ownerToken = typeof owner_token === "string" && owner_token.length > 0 ? owner_token : null;
  if (isEdit && !ownerToken) {
    // Recover the owner token from session state when re-plugging the drop this
    // session made anonymously.
    if (ctx.state.lastDrop?.entity_id === targetEntityId && ctx.state.lastDrop.owner_token) {
      ownerToken = ctx.state.lastDrop.owner_token;
    } else if (
      ctx.state.lastAnonClaim?.entity_id === targetEntityId &&
      ctx.state.lastAnonClaim.token
    ) {
      ownerToken = ctx.state.lastAnonClaim.token;
    }
  }
  // An anon-minted (Guest-Grid) drop is edited via the owner-token wire even
  // when signed in — the entity is not in the caller's grid, so an authed edit
  // of it would 404. Otherwise an edit needs the authed wire.
  const useAnonWire = isEdit ? Boolean(ownerToken) : !authToken;
  if (isEdit && !ownerToken && !authToken) {
    throw new Error(
      "Re-plugging needs authorization: sign in (grid_login) for an entity in your grid, or pass the " +
        "owner_token that came back when the drop was created anonymously.",
    );
  }

  // Auth-aware inline size cap for the single-file `html` path (the old drop
  // cap). Anonymous inline pages stay capped at 2 MB; signed-in inline pages get
  // the larger AUTHED cap. `path` (read from disk) and `artifact_files` are
  // bounded by PLUG_MAX_TOTAL_BYTES instead, so they never set inlineHtmlBytes.
  if (inlineHtmlBytes != null) {
    if (useAnonWire) {
      if (inlineHtmlBytes > ANON_HTML_MAX_BYTES) {
        throw new Error(
          `This HTML is ${(inlineHtmlBytes / 1e6).toFixed(2)} MB. Anonymous drops are capped at 2 MB. ` +
            "Trim it, or sign in to publish larger.",
        );
      }
    } else if (inlineHtmlBytes > AUTHED_HTML_MAX_BYTES) {
      throw new Error(
        `This HTML is ${(inlineHtmlBytes / 1e6).toFixed(2)} MB. Inline drops are capped at ` +
          `${(AUTHED_HTML_MAX_BYTES / 1e6).toFixed(0)} MB. In the local edition pass \`path\` to the ` +
          ".html file (read from disk — no inline size limit) instead of pasting it inline.",
      );
    }
  }

  const headers = {};
  // The authed target grid — also reused for the post-create visibility upgrade.
  let orgSlug = null;
  if (!useAnonWire && authToken) {
    headers["Authorization"] = `Bearer ${authToken}`;
    // On create, `grid` picks where the entity lands. On re-plug the entity's
    // home grid is authoritative (it never moves) — but the API still resolves
    // the caller's membership from this header and requires it to MATCH the
    // entity's grid, so pass `grid` here too when the target lives outside the
    // active grid.
    orgSlug = grid || (await ctx.getActiveGrid());
    // Grid-native header + X-CloudGrid-Org alias (same slug) during the soak.
    if (orgSlug) {
      headers["X-CloudGrid-Grid"] = orgSlug;
      headers["X-CloudGrid-Org"] = orgSlug;
    }
  }
  if (useAnonWire && ctx.trustedServer?.secret && ctx.trustedServer?.endUserId) {
    headers["X-CloudGrid-Trusted-Server-Auth"] = ctx.trustedServer.secret;
    headers["X-CloudGrid-Trusted-Server-End-User"] = ctx.trustedServer.endUserId;
  }
  if (useAnonWire && ctx.state.anonCookie) headers["Cookie"] = ctx.state.anonCookie;

  // ── CREATE manifest injection (issue #48) ───────────────────────────────────
  // On a folder-walk create, a `cloudgrid.yaml` on disk is walked into the tree
  // and — because directory reads surface it before the nested `services/…`
  // files — rides the multipart body as the FIRST `artifact` part, with the
  // walk's uniform `application/octet-stream` content-type. The runtime build
  // orchestrator relies on the manifest leading the bundle (it drives the
  // service graph + the entity name). The inline `artifact_files` create used to
  // APPEND the `cloudgrid_yaml` manifest LAST and as `text/plain`, so a
  // multi-service runtime rolled out with no service graph (0 replicas /
  // rollout_failed) and an auto `drop-XXXX` name. Fold the manifest into the
  // artifact list as the first entry (deduping any `cloudgrid.yaml` the caller
  // already inlined) so both create paths emit a byte-equivalent bundle.
  if (!isEdit && cloudgrid_yaml) {
    const manifest = { path: "cloudgrid.yaml", buffer: Buffer.from(cloudgrid_yaml, "utf8") };
    const rest = artifacts.filter((a) => a.path !== "cloudgrid.yaml");
    artifacts = [manifest, ...rest];
  }

  // ── Wire assembly ───────────────────────────────────────────────────────────
  const form = new FormData();
  for (const a of artifacts) {
    // Folder-walk / artifact_files parts ride as octet-stream (server sniffs by
    // name); the single-file `html` path carries text/html so a bare inline page
    // renders instead of downloading (the old drop behavior).
    form.append("artifact", new Blob([a.buffer], { type: a.type || "application/octet-stream" }), a.path);
  }
  if (isEdit) {
    form.append("target_entity_id", targetEntityId);
    if (useAnonWire) {
      form.append("owner_token", ownerToken);
    } else {
      // The authed update path requires a `cloudgrid.yaml` part
      // (materializePlugTarball); an inspiration edit ignores its content.
      form.append(
        "cloudgrid.yaml",
        new Blob([cloudgrid_yaml || ""], { type: "text/plain" }),
        "cloudgrid.yaml",
      );
    }
  }
  // Honor the manifest name (issue #48): send `name:` parsed from `cloudgrid_yaml`
  // as an explicit name/slug hint so the created entity uses it instead of an
  // auto `drop-XXXX` slug. Harmless if the server owns slug generation; on a
  // re-plug the entity's name is authoritative, so only send on create.
  if (!isEdit) {
    const manifestName = parseManifestName(cloudgrid_yaml);
    if (manifestName) {
      form.append("name", manifestName);
      form.append("slug", manifestName);
    }
  }
  if (hints?.kind) {
    // `kind_hint` is what the create orchestrator reads; `hints_kind` is the
    // route's structured field on the update path. Send both — each path
    // ignores the other's.
    form.append("kind_hint", hints.kind);
    form.append("hints_kind", hints.kind);
  }
  if (hints?.yaml) form.append("hints_yaml", hints.yaml);

  let res;
  try {
    res = await fetchImpl(`${API_BASE}/api/v2/plug`, {
      method: "POST",
      headers,
      body: form,
      signal: AbortSignal.timeout(uploadTimeoutMs),
    });
  } catch (err) {
    if (err?.name === "AbortError" || err?.name === "TimeoutError") {
      throw new Error(
        `The deploy request timed out after ${Math.round(uploadTimeoutMs / 1000)}s. ` +
          `The build may still be running on CloudGrid — check the deploy status ` +
          `(poll_url / grid_status, or your grid) before deploying again, so you don't create a duplicate.`,
      );
    }
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
    const code = data?.error?.code;
    const msg = data?.error?.message || data?.message || raw || `HTTP ${res.status}`;
    const flags = {
      edition: ctx.edition,
      isEdit,
      isAnon: useAnonWire,
      signedIn: Boolean(authToken),
    };
    // Self-heal rung: a signed-in CREATE that hits the known 400 SCOPE_INVALID
    // platform bug is retried through the bundled CLI — LOCAL edition only,
    // create only (never edits), never anonymous.
    if (
      res.status === 400 &&
      code === "SCOPE_INVALID" &&
      ctx.edition === "local" &&
      !isEdit &&
      !useAnonWire &&
      authToken
    ) {
      return plugViaCliFallback(ctx, artifacts, deps);
    }
    throw new Error(plugErrorMessage(res.status, code, msg, flags));
  }

  // Anon-session cookie continuity.
  const setCookies = res.headers.getSetCookie
    ? res.headers.getSetCookie()
    : [res.headers.get("set-cookie")].filter(Boolean);
  const anonCookie = (setCookies || [])
    .map((c) => (c || "").split(";")[0])
    .find((c) => c.startsWith("cg_anon_session="));
  if (anonCookie) ctx.state.anonCookie = anonCookie;

  const url = resolvePlugUrl(data);
  let freshOwnerToken = typeof data.owner_token === "string" && data.owner_token.length > 0
    ? data.owner_token
    : null;
  if (!freshOwnerToken && data.claim_url) {
    try {
      freshOwnerToken = new URL(data.claim_url).searchParams.get("token");
    } catch {
      freshOwnerToken = null;
    }
  }

  // Session continuity — remember the last plug for re-plug handles.
  if (data.entity_id || url) {
    ctx.state.lastDrop = {
      entity_id: data.entity_id ?? null,
      url: url ?? null,
      owner_token: useAnonWire ? (freshOwnerToken ?? ownerToken ?? null) : null,
    };
  }
  if (useAnonWire && (data.claim_url || freshOwnerToken)) {
    ctx.state.lastAnonClaim = {
      token: freshOwnerToken,
      entity_id: data.entity_id ?? null,
      url,
    };
  } else if (!useAnonWire) {
    ctx.state.lastAnonClaim = null;
  }

  const structured = {
    ...(data.entity_id ? { entity_id: data.entity_id } : {}),
    ...(data.slug ? { slug: data.slug } : {}),
    grid: data.grid ?? null,
    ...(url ? { url } : {}),
    ...(data.poll_url ? { poll_url: data.poll_url } : {}),
    status: data.status ?? (isEdit ? "updated" : "created"),
    ...(data.claim_url ? { claim_url: data.claim_url } : {}),
    ...(data.claim_message ? { claim_message: data.claim_message } : {}),
    // Spec v2 omits owner_token from the output block — a spec bug (the anon
    // wire cannot re-plug without it). Included deliberately; flagged upstream.
    ...(freshOwnerToken ? { owner_token: freshOwnerToken } : {}),
  };

  // Accurate status (issue #48): a runtime create/edit is an ASYNC build — the
  // server replies `status: "building"` (+ a poll_url) while the rollout is still
  // in flight. Do NOT claim "Live"/"Updated in place" for a build that has not
  // finished; that reported success for apps that then rolled-out-failed. Only
  // the terminal states get the live wording; anything still building points at
  // the poll_url and grid_status.
  const isBuilding = data.status === "building" || Boolean(data.poll_url);

  // An authed CREATE of an INSPIRATION (the single-file `html` path, or a server-
  // detected inspiration — NOT a runtime app/agent, NOT a build in flight, NOT an
  // anon guest drop). This is the case that (on the hosted edition) must be made
  // link-visible so the shared URL renders without a sign-in wall.
  const detectedKind = data.detection?.kind;
  const isInspirationCreate =
    !isEdit &&
    !useAnonWire &&
    !isBuilding &&
    detectedKind !== "app" &&
    detectedKind !== "agent" &&
    (inlineHtmlBytes != null || detectedKind === "inspiration");

  const lines = [];
  if (isBuilding) {
    lines.push(
      isEdit
        ? `Building (async): ${url} — the update is deploying, not live yet.`
        : `Building (async): ${url} — the deploy is in progress, not live yet.`,
    );
    lines.push(
      data.poll_url
        ? `Poll ${data.poll_url} or run grid_status until it is ready (trace ${data.trace_id ?? "n/a"}). Do not report it as live until then.`
        : "Run grid_status until it is ready. Do not report it as live until then.",
    );
  } else if (isEdit) {
    lines.push(`Updated in place: ${url}`);
  } else if (isInspirationCreate) {
    // Authed inspiration create — owned by the caller. Wording mirrors the drop verb.
    lines.push(ctx.edition === "web" ? `Your app is live: ${url}` : `Published to your org: ${url}`);
    if (ctx.edition !== "web") lines.push("Owned by you.");
  } else {
    lines.push(`Live: ${url}`);
  }
  if (data.entity_id) {
    lines.push(
      `Re-plug handle: entity_id=${data.entity_id} — persist it (with the url) and pass it back as target_entity_id to update this entity later.`,
    );
  }
  if (data.claim_message) lines.push(data.claim_message);
  if (isEdit && useAnonWire) {
    lines.push("The owner_token was re-minted for the reset expiry — replace the stored one.");
  }

  // Visibility is the user's choice — never set silently. On a NEW deploy,
  // surface the current visibility + the full option set and have the agent ASK
  // the user, then apply their answer via grid_set_sharing. On an edit, leave the
  // entity's existing visibility untouched (don't re-ask on every re-plug).
  if (!isEdit && data.entity_id) {
    const current = typeof data.visibility === "string" ? data.visibility : null;
    structured.console_url = CONSOLE_URL;
    if (current) structured.current_visibility = current;
    structured.visibility_options = Object.entries(VISIBILITY_LABELS).map(([v, l]) => ({ value: v, label: l }));
    lines.push(`Manage all your apps in your grid: ${CONSOLE_URL}`);
    lines.push(
      `Now ASK the user who should be able to open this${current ? ` (currently ${VISIBILITY_LABELS[current] ?? current})` : ""}, then set their choice with grid_set_sharing — do not decide it for them. Options: ${
        Object.entries(VISIBILITY_LABELS)
          .map(([v, l]) => `${v} (${l})`)
          .join("; ")
      }.`,
    );
  }
  return { text: lines.join("\n"), structured };
}

// ── grid_copy_app / grid_download_source — direct-API verbs (spec v2 §5–6) ────────

async function authedApiCall(ctx, { method, pathName, body, verb }) {
  const token = await ctx.getToken();
  if (!token) {
    throw new Error(`${verb} requires sign-in. Run grid_login first.`);
  }
  const headers = { Authorization: `Bearer ${token}` };
  const orgSlug = await ctx.getActiveGrid();
  // Grid-native header + X-CloudGrid-Org alias (same slug) during the soak.
  if (orgSlug) {
    headers["X-CloudGrid-Grid"] = orgSlug;
    headers["X-CloudGrid-Org"] = orgSlug;
  }
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(`${API_BASE}${pathName}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
    const msg = data?.error?.message || data?.message || raw || `HTTP ${res.status}`;
    const codeStr = data?.error?.code || null;
    const err = new Error(`${verb} failed (HTTP ${res.status}${codeStr ? ` ${codeStr}` : ""}): ${msg}`);
    // Expose the structured status/code so callers can branch (e.g. runFork's
    // NOT_A_RUNTIME → inspiration-route fallback). Additive: existing callers
    // only read `.message`.
    err.status = res.status;
    err.code = codeStr;
    throw err;
  }
  return data;
}

// Fork: start a NEW entity from an existing source, copy-on-write with lineage.
// Kind-aware (one fork verb, mirrors the CLI `fork` command): the caller may
// not know the source's kind, so try the runtime route first and, when the
// server reports the target is an inspiration (`400 NOT_A_RUNTIME`, emitted by
// requireEntityAccess before the runtime handler runs), retry the inspiration
// route. The inspiration remix lands in the caller's active grid, so no
// `into_org_slug`; `source_version_id` has no meaning for inspirations.
export async function runFork(ctx, { id, into_org_slug, name, source_version_id }) {
  let data;
  try {
    data = await authedApiCall(ctx, {
      method: "POST",
      pathName: `/api/v2/runtimes/${encodeURIComponent(id)}/fork`,
      body: {
        ...(into_org_slug ? { into_org_slug } : {}),
        ...(name ? { name } : {}),
        ...(source_version_id ? { source_version_id } : {}),
      },
      verb: "Fork",
    });
  } catch (err) {
    if (err && err.code === "NOT_A_RUNTIME") {
      data = await authedApiCall(ctx, {
        method: "POST",
        pathName: `/api/v2/inspirations/${encodeURIComponent(id)}/fork`,
        body: { ...(name ? { name } : {}) },
        verb: "Fork",
      });
    } else {
      throw err;
    }
  }
  const gridSlug = data?.grid_slug ?? data?.org?.slug ?? null;
  const lines = [
    `Forked: ${data?.name ?? id} (entity_id=${data?.entity_id ?? "?"})${gridSlug ? ` in grid ${gridSlug}` : ""}`,
    `Lineage: forked_from=${data?.forked_from ?? "?"}${data?.forked_from_version_id ? ` @ ${data.forked_from_version_id}` : ""}`,
  ];
  return {
    text: lines.join("\n"),
    structured: {
      entity_id: data?.entity_id ?? null,
      name: data?.name ?? null,
      kind: data?.kind ?? null,
      grid_slug: gridSlug,
      forked_from: data?.forked_from ?? null,
      forked_from_version_id: data?.forked_from_version_id ?? null,
      current_version_id: data?.current_version_id ?? null,
    },
  };
}

// Download: signed, time-limited (15-minute) source-bundle URLs. No entity is
// created and no registry state changes.
export async function runDownload(ctx, { id, version }) {
  const qs = version ? `?version=${encodeURIComponent(version)}` : "";
  const data = await authedApiCall(ctx, {
    method: "GET",
    pathName: `/api/v2/runtimes/${encodeURIComponent(id)}/source${qs}`,
    verb: "Download",
  });
  const services = data?.services && typeof data.services === "object" ? data.services : {};
  const lines = [`Source bundle URLs for ${data?.name ?? id} (valid ~15 minutes):`];
  for (const [svc, u] of Object.entries(services)) lines.push(`  ${svc}: ${u}`);
  if (Object.keys(services).length === 0) lines.push("  (no services returned)");
  return {
    text: lines.join("\n"),
    structured: {
      entity_id: data?.entity_id ?? null,
      name: data?.name ?? null,
      services,
      domain: data?.domain ?? null,
    },
  };
}

// Change an inspiration's visibility. Authed, direct API — works on the hosted
// edition where the CLI-wrapping share tool is unavailable. Defaults to the drop
// made in this session, so "make it private" needs no ids.
export async function runVisibility(ctx, { target, visibility, org }) {
  const token = await ctx.getToken();
  if (!token) {
    throw new Error("Changing visibility needs an owner. Run grid_login first.");
  }
  const id = target || ctx.state.lastDrop?.entity_id;
  if (!id) {
    throw new Error("No target. Pass the entity id, or drop something first in this session.");
  }
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const orgSlug = org || (await ctx.getActiveGrid());
  // Grid-native header + X-CloudGrid-Org alias (same slug) during the soak.
  if (orgSlug) {
    headers["X-CloudGrid-Grid"] = orgSlug;
    headers["X-CloudGrid-Org"] = orgSlug;
  }
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

// Max HTML we'll return inline from runSource. Past this, we return the first
// slice with truncated:true — a re-plug needs the complete document, so a
// truncated body is a signal the drop is likely multi-file rather than a single
// editable HTML document.
const SOURCE_MAX_BYTES = 1_500_000;

// Reject anything whose host is not `*.cloudgrid.io` (apex `cloudgrid.io`
// included). SSRF guard for runSource: we only ever fetch live CloudGrid drops
// server-side, never arbitrary hosts. Returns true when the host is allowed.
function isCloudgridHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "cloudgrid.io" || h.endsWith(".cloudgrid.io");
}

// Shape an HTML string into the grid_get_app_source result (shared by the API-read
// and the public-fetch paths). Caps the body at SOURCE_MAX_BYTES. `extra` carries
// optional edition metadata resolved from the pickup contract (kind, single_html,
// capabilities, replug_handle, source_download_url) — merged into structured.
function shapeSourceResult(sourceUrl, entityId, htmlStr, extra = {}) {
  const buf = Buffer.from(htmlStr, "utf-8");
  const totalBytes = buf.length;
  const truncated = totalBytes > SOURCE_MAX_BYTES;
  const html = truncated ? buf.subarray(0, SOURCE_MAX_BYTES).toString("utf-8") : htmlStr;
  const lines = [
    `Current source for ${sourceUrl} (${totalBytes} bytes) — edit this and re-plug with target_entity_id to update the same URL:`,
  ];
  if (truncated) {
    lines.push(
      "(too large to return in full; re-plug needs the complete document — consider that this drop may be multi-file)",
    );
  }
  lines.push("", html);
  return {
    text: lines.join("\n"),
    structured: { url: sourceUrl, entity_id: entityId ?? null, bytes: totalBytes, truncated, html, ...extra },
  };
}

// Read an inspiration's HTML via the API (server-side storage read) instead of
// fetching the public *.cloudgrid.io URL. Critical on the hosted edition: the
// MCP pod can reach the API (it POSTs /api/v2/plug) but CANNOT egress to the
// public ingress ("fetch failed"). getInspirationSource resolves directly by
// entity_id when the path segment is a UUID (no org context needed), else by
// slug + the X-CloudGrid-Grid active-org header. Returns the html string, or
// null if the API can't serve it (→ caller falls back to the direct fetch).
async function readInspirationSourceViaApi(ctx, { entityId, slug, grid }) {
  let token = null;
  try { token = await ctx.getToken(); } catch { /* anonymous is fine for public */ }
  const baseHeaders = token ? { Authorization: `Bearer ${token}` } : {};
  const attempts = [];
  if (entityId) attempts.push({ seg: entityId, grid: null });   // UUID → resolves by id, no org ctx
  if (slug) attempts.push({ seg: slug, grid: grid || null });   // slug → needs org (grid) context
  for (const a of attempts) {
    try {
      const headers = { ...baseHeaders };
      if (a.grid) headers["X-CloudGrid-Grid"] = a.grid;
      const res = await fetch(
        `${API_BASE}/api/v2/inspirations/${encodeURIComponent(a.seg)}/source`,
        { method: "GET", headers, signal: AbortSignal.timeout(15_000) },
      );
      if (!res.ok) continue;
      // The route (GET /v2/inspirations/:seg/source) serves the RAW HTML bytes
      // as text/html — NOT a JSON { html } envelope. Read the body as text.
      // (Tolerate a JSON { html } shape too, in case a variant ever returns it.)
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (ct.includes("application/json")) {
        const data = await res.json().catch(() => null);
        if (data && typeof data.html === "string") return data.html;
        continue;
      }
      const html = await res.text().catch(() => null);
      if (typeof html === "string" && html.length > 0) return html;
    } catch {
      // try the next attempt, then the public-fetch fallback
    }
  }
  return null;
}

// Resolve a public URL / grid+slug to a REAL entity_id (+ edition metadata) via
// the deployed pickup contract (POST /api/v2/entities/:target/pickup — the same
// endpoint runClaim uses). Used by runSource when a bare URL arrives with no
// session entity_id (a fresh chat): the contract returns
//   { entity_id, slug, grid, kind, single_html, capabilities, replug_handle,
//     source_download_url, ... }
// so the agent can re-plug the SAME entity in place. This is a metadata resolve
// (no claim_token in the body → no ownership transfer). Best-effort: returns null
// on any failure so the caller falls back to today's behavior — and NEVER fetches
// the public *.cloudgrid.io URL (the hosted pod cannot egress to it).
async function resolveEntityViaPickup(ctx, { target, url, grid }) {
  const pathSeg = target || url;
  if (!pathSeg) return null;
  let token = null;
  try { token = await ctx.getToken(); } catch { /* anonymous is fine */ }
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  // Grid-native header + X-CloudGrid-Org alias (same slug) during the soak.
  if (grid) {
    headers["X-CloudGrid-Grid"] = grid;
    headers["X-CloudGrid-Org"] = grid;
  }
  if (ctx.state.anonCookie) headers["Cookie"] = ctx.state.anonCookie;
  try {
    const res = await fetch(
      `${API_BASE}/api/v2/entities/${encodeURIComponent(pathSeg)}/pickup`,
      {
        method: "POST",
        headers,
        // Send the URL as a resolution key too (the contract accepts id, slug, or
        // a {url} body). NO claim_token → resolve only, never a claim.
        body: JSON.stringify(url ? { url } : {}),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (data && typeof data.entity_id === "string" && data.entity_id.length > 0) return data;
    return null;
  } catch {
    return null;
  }
}

// Fetch a drop's/inspiration's current deployed HTML inline as text so an agent
// that lost the content can edit it and re-plug in place. Resolves the fetch URL
// (explicit url → session lastDrop → composed grid+slug), then reads the HTML
// via the API (reachable) BEFORE falling back to a direct `*.cloudgrid.io` fetch
// (SSRF-guarded, capped at SOURCE_MAX_BYTES). Uses the global `fetch` seam so
// tests can mock it.
export async function runSource(ctx, { entity_id, url, grid, slug } = {}) {
  const last = ctx.state.lastDrop;
  // Resolution order: explicit url → session lastDrop.url (if entity_id matches
  // or no entity_id was given) → composePlugUrl(grid, slug) → fail.
  let target = null;
  if (typeof url === "string" && url.length > 0) {
    target = url;
  } else if (last?.url && (!entity_id || last.entity_id === entity_id)) {
    target = last.url;
  } else if (grid && slug) {
    // Inspirations/HTML drops are path-based at the org apex.
    target = composePlugUrl({ slug, grid });
  }
  if (!target) {
    throw new Error(
      "I don't have this drop's URL — pass the url (e.g. https://<grid>.cloudgrid.io/<slug>) or grid+slug.",
    );
  }

  let parsed;
  try {
    parsed = new URL(target);
  } catch {
    throw new Error(`Not a valid URL: ${target}`);
  }
  if (parsed.protocol !== "https:" || !isCloudgridHost(parsed.hostname)) {
    throw new Error(
      `Refusing to fetch ${target}: source retrieval is limited to https://*.cloudgrid.io drops.`,
    );
  }

  const resolvedUrl = parsed.toString();
  let eid = entity_id ?? (last && (!entity_id || last.entity_id === entity_id) ? last.entity_id : null);

  // Derive the grid/slug hint from the inspiration path URL (`grid.cloudgrid.io/slug`).
  const host = parsed.hostname;
  const gridHint = grid ?? (host.endsWith(".cloudgrid.io") && !host.includes("--") && host.split(".").length === 3
    ? host.split(".")[0] : null);
  const slugHint = slug ?? (parsed.pathname.replace(/^\/+/, "").split("/")[0] || null);

  // ── URL → entity_id (fresh chat, no session) via the pickup contract ──────
  // When a bare URL/slug arrived with no known entity_id, resolve a REAL
  // entity_id (+ edition metadata) so the agent can re-plug in place. Best-
  // effort: a failure falls back to today's behavior (never regress the read),
  // and we NEVER fetch the public URL for resolution.
  let extra = {};
  if (!eid) {
    const pickup = await resolveEntityViaPickup(ctx, { target: slugHint, url: resolvedUrl, grid: gridHint });
    if (pickup?.entity_id) {
      eid = pickup.entity_id;
      extra = {
        ...(pickup.kind ? { kind: pickup.kind } : {}),
        ...(typeof pickup.single_html === "boolean" ? { single_html: pickup.single_html } : {}),
        ...(pickup.capabilities ? { capabilities: pickup.capabilities } : {}),
        ...(pickup.replug_handle ? { replug_handle: pickup.replug_handle } : {}),
        ...(pickup.source_download_url ? { source_download_url: pickup.source_download_url } : {}),
      };
    }
  }

  // ── API-first (reachable) ────────────────────────────────────────────────
  // Read the HTML from the API server-side rather than fetching the public URL.
  // The hosted MCP pod can reach the API but NOT the public *.cloudgrid.io
  // ingress ("fetch failed") — this is the fix for hosted edit-in-place.
  const apiHtml = await readInspirationSourceViaApi(ctx, { entityId: eid, slug: slugHint, grid: gridHint });
  if (apiHtml != null) return shapeSourceResult(resolvedUrl, eid, apiHtml, extra);

  // ── Fallback: direct public fetch ────────────────────────────────────────
  // Local edition has normal egress; last resort on hosted (e.g. a runtime app
  // whose source the inspiration route can't serve).
  let res;
  try {
    res = await fetch(resolvedUrl, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(`Could not reach the live drop at ${resolvedUrl}: ${err.message}`);
  }

  // A redirect must not escape the allow-list (fetch follows automatically; the
  // final response URL is the one we actually read).
  if (res.url && res.url !== resolvedUrl) {
    let finalHost;
    try { finalHost = new URL(res.url).hostname; } catch { finalHost = ""; }
    if (!isCloudgridHost(finalHost)) {
      throw new Error(
        `Refusing to follow a redirect off CloudGrid (${res.url}): source retrieval is limited to https://*.cloudgrid.io.`,
      );
    }
  }

  if (!res.ok) {
    // Graceful fail — never throw a raw fetch error at the model.
    throw new Error(
      `Couldn't read the live drop (HTTP ${res.status}). It may be expired, private, or claimed.`,
    );
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return shapeSourceResult(resolvedUrl, eid, buf.toString("utf-8"), extra);
}
