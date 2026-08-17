// Direct-API tool internals: grid_plug (runPlug), pull, pickup, report,
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
  VISIBILITY_OPTIONS,
  APPS_WIDGETS_ENABLED,
  GRID_PICKER_URI,
  PLUG_UPLOAD_TIMEOUT_MS,
} from "./constants.js";
import { okResult } from "./util.js";
import { runCloudgrid } from "./cli.js";

/**
 * The API refuses an infra-dependent write while a grid is still provisioning.
 *
 * The code is being renamed ORG_PROVISIONING -> GRID_PROVISIONING
 * (cloudgrid-io/cloudgrid#2673, the org->grid retirement). This accepts BOTH,
 * which is what makes the API-side rename safe: an mcp that understands both is
 * version-independent from the API's side, so the rename can land the moment
 * this ships rather than waiting for adoption.
 *
 * Keep both until the API no longer emits the old name AND the floor of
 * installed mcp versions understands the new one. mcp is published to npm, so
 * installed copies keep matching whatever they shipped with — dropping the old
 * name early breaks plugs into brand-new grids, silently, by turning a
 * retryable 409 into a hard failure.
 *
 * One predicate, two call sites, so they cannot drift.
 */
const PROVISIONING_CODES = new Set(["GRID_PROVISIONING", "ORG_PROVISIONING"]);
function isProvisioningCode(code) {
  return PROVISIONING_CODES.has(code);
}


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

// ── Shared grid disambiguation (grid_plug) ──────────────────
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
    const lines = ["Which grid should this be plugged into?"];
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
      lines.push("Note: none of your grids are fully set up yet. Wait until provisioning completes (grid_start will show render_ready: true) before plugging.");
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
  // ZERO grids for a signed-in user: do NOT proceed — the plug is a guaranteed
  // 403 NO_ACTIVE_ORG dead end. Field bug (2026-07-27, first-time user): the
  // model sent the user to the console to create a grid by hand. Grid creation
  // is a first-class API action (POST /api/v2/grids) — offer to do it here.
  return {
    picker: {
      text:
        "This account has no grid yet — a grid is the workspace the user's apps live in, and you can create it right now; do NOT send the user to the console for this. " +
        "Suggest a short slug from the user's name or the app (3-40 lowercase letters, digits, or hyphens, starting with a letter), confirm it with the user, " +
        "then call grid_create_grid with that slug and re-call grid_plug with grid: <slug>.",
      structured: { needs_grid_create: true },
    },
  };
}

// ── grid_create_grid — create the user's first (or another) grid ────────────
// Mirrors the CLI `grid create grid <slug>` (POST /api/v2/grids; the caller
// becomes the grid's admin, a "general" space is provisioned server-side).
const GRID_SLUG_RE = /^[a-z][a-z0-9-]{2,39}$/;

export async function runCreateGrid(ctx, { slug, name } = {}) {
  const token = await ctx.getToken();
  if (!token) {
    return {
      text: "Creating a grid needs an account — sign the user in first (grid_login), then re-call grid_create_grid.",
      structured: { needs_auth: true },
    };
  }
  const s = String(slug || "").trim().toLowerCase();
  if (!GRID_SLUG_RE.test(s)) {
    return {
      text: `Invalid grid slug '${s}'. Use 3-40 lowercase letters, digits, or hyphens, starting with a letter.`,
      structured: { error: { code: "INVALID_SLUG" } },
    };
  }
  const res = await fetch(`${API_BASE}/api/v2/grids`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ slug: s, name: String(name || s).trim() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = data?.error?.code || data?.code || `HTTP_${res.status}`;
    const msg = data?.error?.message || data?.message || res.statusText || "request failed";
    return {
      text: `Could not create grid '${s}' (${code}): ${msg}` + (code === "HTTP_409" || /exists|taken/i.test(msg) ? " Try a different slug." : ""),
      structured: { error: { code, message: msg } },
    };
  }
  const finalSlug = data.slug ?? s;
  // A brand-new grid provisions its infrastructure in the background: the API
  // returns 202 with { status: "provisioning", poll_url } while the org's infra
  // (bucket/GSA/WI/K8s) is still being set up. Until it is ready, an
  // infra-dependent write (grid_plug) is refused with 409 ORG_PROVISIONING.
  // There is no read endpoint that reports this readiness (render_ready and
  // /orgs/:slug/status.ready are hardwired true under the flat-arch decision),
  // so we do NOT instruct an immediate re-call that would fail: instead we say
  // the grid is finishing setup and that grid_plug itself waits for readiness
  // (it retries ORG_PROVISIONING for a bounded budget) before it deploys. Issue #235.
  const provisioning = res.status === 202 || data.status === "provisioning" || Boolean(data.poll_url);
  const lines = [`Created grid ${finalSlug} — the user is its admin.`];
  if (provisioning) {
    lines.push(
      "It's finishing setup in the background — a brand-new grid provisions its infrastructure, usually within ~30s. " +
        `Go ahead and call grid_plug with grid: ${finalSlug}: it waits for the grid to be ready, then deploys. ` +
        "You do NOT need to poll a status or insert a manual delay, and calling it right away will not fail — it holds until the grid is ready.",
    );
  } else {
    lines.push(`The grid is ready — call grid_plug with grid: ${finalSlug} to deploy.`);
  }
  return {
    text: lines.join("\n"),
    structured: {
      created: true,
      ...(provisioning ? { provisioning: true } : {}),
      grid: { slug: finalSlug, name: data.name ?? String(name || s) },
    },
  };
}

// ── Inline-source secret scan ────────────────────────────────────────────────
// Field bug (2026-07-27): the model embedded the user's OpenRouter API key in
// a public inline page ("so they can test now"). A plugged page's source is
// readable by anyone who can open it — a pasted key is leaked the moment the
// URL is shared. Hard-block the obvious key shapes client-side, before the
// upload. (Not a guarantee — a determined model can obfuscate — but it stops
// the good-faith "embed it so it works" path cold.)
const SECRET_PATTERNS = [
  [/sk-or-v1-[A-Za-z0-9]{16,}/, "an OpenRouter API key"],
  [/sk-ant-[A-Za-z0-9_-]{16,}/, "an Anthropic API key"],
  [/sk-proj-[A-Za-z0-9_-]{16,}/, "an OpenAI API key"],
  [/\bsk-[A-Za-z0-9]{32,}\b/, "an OpenAI-style secret key"],
  [/AIza[0-9A-Za-z_-]{30,}/, "a Google API key"],
  [/ghp_[A-Za-z0-9]{30,}/, "a GitHub token"],
  [/github_pat_[A-Za-z0-9_]{30,}/, "a GitHub fine-grained token"],
  [/AKIA[0-9A-Z]{16}/, "an AWS access key id"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/\bsk_(?:live|test)_[0-9A-Za-z]{16,}\b/, "a Stripe secret key"],
];

export function scanInlineSecrets(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  for (const [re, label] of SECRET_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

export function secretBlockMessage(label, where) {
  return (
    `Blocked: the ${where} contains what looks like ${label}. A plugged page is PUBLIC — anyone who opens it can read its source, so a pasted API key is leaked the moment the URL is shared. ` +
    `Remove the key, and if it was ever live, tell the user to rotate it. ` +
    `If the app needs to call an LLM, that is a RUNTIME app, not an inline page: needs: { ai: true } gives it CloudGrid's managed AI gateway with NO API key at all, and other keys go in grid secrets set — both stay server-side. Runtime apps build on the local edition (Claude Desktop/Code or a terminal).`
  );
}

// ── Direct-API tools (both editions) ───────────────────────────────────────────
function looksLikeFullHtml(s) {
  const head = s.replace(/^\uFEFF/, "").trimStart().slice(0, 256).toLowerCase();
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

// Normalize an inline `html` string — grid_plug's ergonomic single-file publish
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
// came back empty (the server composes it best-effort). It mirrors the canonical
// `entityUrl()` rules (the flat-only platform host), but only the server knows
// the per-entity nuances (custom domains, guest-org placement), so it must never
// be the primary source:
//   - inspiration (HTML drops): path-based at the org apex
//       https://<grid>.cloudgrid.io/<slug>
//   - runtime (app/agent):      flat platform host
//       https://<slug>--<grid>.cloudgrid.io
// The old nested `<slug>.<grid>.cloudgrid.io` host is retired — it falls outside
// the single `*.cloudgrid.io` platform wildcard, so it has no cert and no ingress
// (matches `composeFlatEntityHost`).
// Anonymous drops are grid-less in the response (`grid: null`); they live under
// the Guest Org, so the apex slug is the constant `guest`.
function composePlugUrl(data) {
  const slug = data?.slug;
  if (!slug) return null;
  const grid = data?.grid || GUEST_ORG_SLUG;
  const kind = data?.detection?.kind;
  if (kind === "app" || kind === "agent") {
    return `https://${slug}--${grid}.cloudgrid.io`;
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

// Value-level secret patterns — must stay in sync with TEXT_SECRET_PATTERNS
// in session-logger.js (which scrubs free text for session logs). The lists are
// separate because this module operates on structured object values via
// scrubReportContext, while session-logger operates on free text via scrubText.
// Both scan string content for the same secret shapes; if you add a pattern to
// one, add it to the other.
const REPORT_SECRET_VALUE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{0,}/g,
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-or-v1-[A-Za-z0-9]{16,}/g,
  /sk-proj-[A-Za-z0-9_-]{16,}/g,
  /\bsk-[A-Za-z0-9]{20,}/g,
  /AIza[0-9A-Za-z_-]{30,}/g,
  /ghp_[A-Za-z0-9]{30,}/g,
  /github_pat_[A-Za-z0-9_]{30,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bsk_(?:live|test)_[0-9A-Za-z]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}/gi,
];

// Replace known secret shapes inside a string value with [REDACTED].
// Complementary to the key-name check in scrubReportContext — this catches
// secrets that live inside values (e.g. an API key pasted into HTML source).
function scrubSecretValues(str) {
  if (typeof str !== "string") return str;
  let out = str;
  for (const re of REPORT_SECRET_VALUE_PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  out = out.replace(/([a-zA-Z][a-zA-Z0-9+.\-]*:\/\/)[^\s:@/]+:[^\s:@/]+@/g, "$1[REDACTED]@");
  return out;
}

// Client-side scrub of the report context. Two layers:
//   1. Key-name check: values under secret-looking KEYS are fully redacted.
//   2. Value scan: string values in the tree (up to depth 5) are scanned for known
//      secret shapes (API keys, Bearer tokens) and matches are replaced.
// Bounded depth so a pathological object can't loop.
export function scrubReportContext(obj, depth = 0) {
  if (depth > 5 || obj === null || typeof obj !== "object") {
    // Leaf value — scrub known secret shapes from strings.
    return typeof obj === "string" ? scrubSecretValues(obj) : obj;
  }
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
// (it drops unknown ones), and `context` is stored after the server's key-name
// scrub, so `context.origin` is the durable carrier — belt-and-suspenders.
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
    message: scrubSecretValues(summary).slice(0, 5000),
    context: safeContext,
    // Diagnostic pivots (match the CLI) — only when the agent forwards them.
    ...(typeof trace_id === "string" && trace_id ? { trace_id } : {}),
    ...(typeof failed_step === "string" && failed_step ? { failed_step: scrubSecretValues(failed_step) } : {}),
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

// grid_pull — continue/edit an existing entity IN PLACE (POST /entities/:id/pickup).
// Like `git clone` of the SAME entity: your next grid_plug (target_entity_id)
// updates it. Needs push access — you must OWN it or be a COLLABORATOR. A
// view-only caller is told they can't edit/plug it (fork a copy with grid_pickup,
// or GET collaborator push access with grid_collab — grants permission
// only, pull again once granted). A claim_token also
// claims an anonymous drop into your account (ownership transfer).
export async function runPull(ctx, { claim_token, claim_url, entity_id, grid } = {}) {
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
  // header (the same header every other authed write uses). The `grid`
  // parameter (added for #247: the hosted transport cannot set HTTP headers,
  // so multi-grid users must pass the grid explicitly) takes precedence, then
  // the session's active grid.
  const orgSlug = grid || (await ctx.getActiveGrid());
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
        text: "Already yours — nothing to pull.",
        structured: { owner_is_you: true, can_edit: true },
      };
    }
    const code = data?.error?.code || null;
    // ORG_NOT_ACCESSIBLE: the `grid` param has a typo or the user isn't a
    // member of that grid. The server message already contains an "Available:"
    // hint listing valid grid slugs — surface it so the agent can self-correct.
    if (code === "ORG_NOT_ACCESSIBLE") {
      const serverMsg = data?.error?.message || "The specified grid is not accessible.";
      const hint = data?.error?.details?.[0]?.hint || "";
      return {
        text:
          `${serverMsg}${hint ? ` ${hint}` : ""} ` +
          `Check the grid slug for typos and retry grid_pull with the correct \`grid\` parameter.`,
        structured: { error: { code: "ORG_NOT_ACCESSIBLE" } },
      };
    }
    // NO_ACTIVE_ORG: the account has no grid at all — route to in-flow grid
    // creation instead of the misleading "no push access" advice.
    if (code === "NO_ACTIVE_ORG") {
      return {
        text:
          "The account has no grid yet. Do not send the user to the console — create one from here: " +
          "suggest a short slug, confirm it with the user, call grid_create_grid, then re-call grid_pull.",
        structured: { needs_grid_create: true },
      };
    }
    // No push access → not an error to throw; tell the user their options.
    if (res.status === 403 || code === "NOT_ALLOWLISTED" || code === "PICKUP_DISABLED" || code === "FORBIDDEN_ROLE") {
      return {
        text:
          `You don't have push access to this entity, so you can't edit or plug it. Two options: ` +
          `make your own separate copy (a fork) with grid_pickup, or GET collaborator push access to the SAME ` +
          `entity with grid_collab (the CLI equivalent is \`grid collab <entity>\`) — that grants permission only and fetches nothing, so ` +
          `pull again once it is granted (if the owner gates access, grid_collab becomes a request they approve).`,
        structured: { can_edit: false, owner_is_you: false, access: "view_only" },
      };
    }
    let msg = data?.error?.message || data?.message || raw || `HTTP ${res.status}`;
    // The API's "Set the X-CloudGrid-Grid header" error is unactionable for an
    // MCP client (no client can set HTTP headers on a tool call). Rewrite it to
    // name the tool parameter the caller CAN set (#247).
    if (res.status === 400 && /X-CloudGrid-Grid/i.test(msg)) {
      msg = "You belong to more than one grid. Pass the `grid` parameter to specify which grid to use.";
    }
    throw new Error(`Pull failed (HTTP ${res.status}): ${msg}`);
  }

  ctx.state.lastAnonClaim = null;
  // A claimed anon drop is authed-owned now — its anon owner token is dead weight.
  if (ctx.state.lastDrop?.entity_id === targetId) {
    ctx.state.lastDrop.owner_token = null;
  }
  const url = data?.url || data?.redirect_url || ctx.state.lastDrop?.url || null;
  const slug = data?.slug || targetId;
  const where = data?.grid ? ` in ${data.grid}` : "";
  // A claim_token transfers ownership to you; otherwise read the pickup contract.
  const ownerIsYou = data?.owner?.is_you === true || Boolean(claimToken);
  const canReplug = data?.capabilities?.replug === true;
  let head, canEdit;
  if (ownerIsYou) {
    head = `${slug}${where} is yours — your next grid_plug (with target_entity_id) updates it in place.`;
    canEdit = true;
  } else if (canReplug) {
    head = `You have collaborator push access to ${slug}${where} — your next grid_plug (target_entity_id) updates the SHARED entity; the team sees the new version and can roll it back.`;
    canEdit = true;
  } else {
    head = `You can view ${slug}${where} but do NOT have push access — you can't edit or plug it. Make your own separate copy (a fork) with grid_pickup, or GET collaborator push access to the SAME entity with grid_collab (CLI equivalent: \`grid collab ${slug}\`) — it grants permission only and fetches nothing, so pull again once granted.`;
    canEdit = false;
  }
  const lines = [head];
  if (url) lines.push(`URL: ${url}`);
  if (canEdit && data?.entity_id) {
    lines.push(`Re-plug handle: entity_id=${data.entity_id} — pass it as grid_plug's target_entity_id to update in place.`);
  }
  return {
    text: lines.join("\n"),
    structured: {
      ...(data?.entity_id ? { entity_id: data.entity_id } : {}),
      ...(slug ? { slug } : {}),
      grid: data?.grid ?? null,
      ...(url ? { url } : {}),
      owner_is_you: ownerIsYou,
      can_edit: canEdit,
    },
  };
}


// grid_collab — GET PUSH ACCESS to the SAME live entity you do NOT own (issue
// #253). This is the third adopt/access verb, distinct from the other two:
//   grid_pickup = make your OWN COPY (a fork: new entity, forked_from lineage)
//   grid_pull   = continue an entity you ALREADY have access to (fetch the code)
//   grid_collab = grant yourself push access to someone else's SAME entity
//                 (permission only — fetches nothing; run grid_pull afterwards)
//
// Mirrors the CLI reference (packages/cli/src/commands/collab.ts). It records the
// grant server-side via the CANONICAL join path POST /api/v2/entities/:id/collab
// — the SAME entity, NOT a fork. The fork route is POST /runtimes/:id/remix
// (runPickup); collab never touches it, so a collab can never silently become a
// pickup (the #242 defect). On a POLICY denial (NOT_ALLOWLISTED / PICKUP_DISABLED
// — the owner gated who may join) it does NOT dead-end on the 403: it turns the
// denial into a REQUEST the owner approves, via POST /:id/collab-requests, exactly
// as the CLI does (collab.ts:129). Other 403s (NOT_A_GRID_MEMBER / FORBIDDEN_ROLE)
// are grid-boundary problems, not policy denials, so they are surfaced, never
// converted to a request. Pure authenticated API calls, no CLI or filesystem —
// so, like grid_pickup / grid_pull, it ships on BOTH editions.
export async function runCollab(ctx, { entity_id, grid } = {}) {
  const token = await ctx.getToken();
  if (!token) {
    throw new Error("You are not signed in. Run grid_login first, then collab.");
  }
  const target = entity_id;
  if (!target) {
    throw new Error("`entity_id` is required (a canonical UUID or <grid-slug>/<entity-slug>).");
  }

  const orgSlug = grid || (await ctx.getActiveGrid());
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  if (orgSlug) {
    // Grid-native header + X-CloudGrid-Org alias (same slug) during the soak, so
    // a bare-slug target resolves in the intended grid (mirrors runPull).
    headers["X-CloudGrid-Grid"] = orgSlug;
    headers["X-CloudGrid-Org"] = orgSlug;
  }

  const collabUrl = `${API_BASE}/api/v2/entities/${encodeURIComponent(target)}/collab`;
  let res;
  try {
    res = await fetch(collabUrl, { method: "POST", headers, body: JSON.stringify({}) });
  } catch (err) {
    throw new Error(`Could not reach CloudGrid at ${API_BASE}: ${err.message}`);
  }

  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { /* handled below */ }

  if (!res.ok) {
    const code = data?.error?.code || null;
    // ── Policy denial → REQUEST ACCESS (the whole point of the tool). Scoped to
    // the two policy codes ONLY: a grid-boundary 403 (NOT_A_GRID_MEMBER /
    // FORBIDDEN_ROLE) is a different problem and must NOT spam the owner. ──────
    if (res.status === 403 && (code === "NOT_ALLOWLISTED" || code === "PICKUP_DISABLED")) {
      return await requestCollabAccess(ctx, target, headers);
    }
    if (res.status === 404 || code === "RUNTIME_NOT_FOUND" || code === "NOT_FOUND" || (typeof code === "string" && code.endsWith("_NOT_FOUND"))) {
      throw new Error(`No entity matched '${target}'. Check the id or grid/slug (a canonical UUID or <grid-slug>/<entity-slug>).`);
    }
    if (res.status === 403 && code === "NOT_A_GRID_MEMBER") {
      throw new Error(data?.error?.message || `You're not a member of the grid that owns '${target}'. Ask its owner to invite you to the grid first, then collab.`);
    }
    if (res.status === 403 && code === "FORBIDDEN_ROLE") {
      throw new Error(data?.error?.message || `Collaborating on '${target}' needs builder or admin role in its grid.`);
    }
    if (res.status === 400 && code === "NOT_A_RUNTIME") {
      throw new Error(data?.error?.message || `'${target}' is an Inspiration, not an app or agent — it has no collaborators. Fork it with grid_pickup instead.`);
    }
    const msg = data?.error?.message || data?.message || raw || `HTTP ${res.status}`;
    throw new Error(`Collab failed (HTTP ${res.status}): ${msg}`);
  }

  // ── Grant recorded on the SAME entity (permission only — no code fetched) ────
  // Interpret the unified §4 pickup contract, exactly as runPull does, but frame
  // it as an access grant and point at grid_pull for the code (founder split
  // 2026-07-23: collab = permission, pull = code).
  const slug = data?.slug || target;
  const where = data?.grid ? ` in ${data.grid}` : "";
  const ownerIsYou = data?.owner?.is_you === true;
  const canReplug = data?.capabilities?.replug === true;
  let head, canEdit;
  if (ownerIsYou) {
    head = `${slug}${where} is yours — nothing to grant. Use grid_pull to get the code, then grid_plug (target_entity_id) to update it.`;
    canEdit = true;
  } else if (canReplug) {
    head = `You're now a collaborator on ${slug}${where} — you have PUSH ACCESS to the SAME entity (not a copy). This granted permission only; use grid_pull to get the code, then grid_plug (target_entity_id) updates the shared entity — the team sees the new version and can roll it back.`;
    canEdit = true;
  } else {
    head = `You can view ${slug}${where}, but the grant did not give you push access. Make your own separate copy (a fork) with grid_pickup instead.`;
    canEdit = false;
  }
  const lines = [head];
  if (data?.url) lines.push(`URL: ${data.url}`);
  return {
    text: lines.join("\n"),
    structured: {
      ...(data?.entity_id ? { entity_id: data.entity_id } : {}),
      ...(slug ? { slug } : {}),
      grid: data?.grid ?? null,
      ...(data?.url ? { url: data.url } : {}),
      owner_is_you: ownerIsYou,
      can_edit: canEdit,
      access_requested: false,
      request_pending: false,
    },
  };
}

// Turn a policy 403 into a request: POST /:id/collab-requests and tell the user
// what happens next (mirrors CLI collab-requests.ts requestCollabAccess). A
// request IS a success outcome, so this returns a normal result, never throws for
// the expected 409s (a pending ask, or an access race the owner just opened).
async function requestCollabAccess(ctx, target, headers) {
  const url = `${API_BASE}/api/v2/entities/${encodeURIComponent(target)}/collab-requests`;
  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify({}) });
  } catch (err) {
    throw new Error(`Could not reach CloudGrid at ${API_BASE}: ${err.message}`);
  }
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { /* handled below */ }
  const code = data?.error?.code || null;

  if (res.ok) {
    return {
      text:
        `The owner gates who can collaborate on '${target}', so I asked them for push access on your behalf. ` +
        `They've been notified — once they approve, run grid_collab again to join, then grid_pull to get the code.`,
      structured: { access_requested: true, request_pending: true, owner_is_you: false, can_edit: false },
    };
  }
  if (res.status === 409 && code === "COLLAB_REQUEST_EXISTS") {
    return {
      text: `You already asked for access to '${target}'. The owner hasn't decided yet — you'll be able to join once they approve.`,
      structured: { access_requested: true, request_pending: true, owner_is_you: false, can_edit: false },
    };
  }
  if (res.status === 409 && code === "COLLAB_ALREADY_ALLOWED") {
    // Race: the owner opened access between the join 403 and this request.
    return {
      text: `You already have access to '${target}'. Run grid_collab again to join, then grid_pull to get the code.`,
      structured: { access_requested: false, request_pending: false, owner_is_you: false, can_edit: false },
    };
  }
  const msg = data?.error?.message || data?.message || raw || `HTTP ${res.status}`;
  throw new Error(`Couldn't request access to '${target}' (HTTP ${res.status}): ${msg}`);
}


// ── grid_plug — the unified create/re-plug verb (spec v2 §3) ──────────────

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
    .replace(/\*\*/g, "\uFFFF")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\uFFFF/g, ".*");
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
      "The zip already contains a cloudgrid.yaml project — plug it as-is (drop the `html` param), " +
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
      `The zip project was plugged via the CLI but no live URL was found in its output.\n${stdout.slice(0, 500)}`,
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
  // 409 ORG_PROVISIONING — the target grid's infrastructure is still being set
  // up (async org provisioning), so an infra-dependent write (plug) is refused
  // for now. This is DISTINCT from EDIT_REJECTED below and must be checked first:
  // it is time-bounded and retryable, not a rejected re-plug. runPlug retries it
  // internally with a bounded budget; this guidance is the budget-exhausted tail,
  // so the wording tells the agent to wait and re-call rather than surface a raw
  // code. (Issue #235.)
  if (status === 409 && isProvisioningCode(code)) {
    return "The grid is still finishing setup — a brand-new grid provisions its infrastructure in the background (usually within ~30s). Wait ~15s and call grid_plug again with the SAME parameters; it deploys once the grid is ready. Do not switch to anonymous and do not send the user to the console.";
  }
  // 409 EDIT_REJECTED — an in-place re-plug the server won't take.
  if (status === 409) {
    return "The entity cannot be updated right now (a plug is in progress, or it is archived/expired/claimed). An explicit re-plug never silently creates; retry later, or omit target_entity_id to create a new entity.";
  }
  // 401 on an edit — the credential didn't authorize this entity.
  if (status === 401) {
    return isEdit
      ? "That did not authorize this entity (wrong entity, expired, or already claimed). Sign in if you own it (grid_login), pass its owner_token for an anonymously-created drop, or omit target_entity_id to create a new entity."
      : "Your sign-in is missing or expired. Run grid_login, then retry the same grid_plug. Do not offer anonymous publishing as a fix for a failed sign-in; anonymous is only for a user who explicitly asks to publish without attribution.";
  }
  if (status === 403) {
    // NO_ACTIVE_ORG is not a role problem — the account has no grid at all.
    // The generic pull/pickup hint here sent a first-time user in circles
    // (field bug 2026-07-27); route them to in-flow grid creation instead.
    if (code === "NO_ACTIVE_ORG") {
      return "The account has no grid yet. Do not send the user to the console — create one from here: suggest a short slug, confirm it with the user, call grid_create_grid, then re-call grid_plug with grid: <slug>.";
    }
    return "You lack the role to plug this target. To get push access to the SAME entity, use `grid_collab` — it grants permission only and fetches nothing, so run `grid_pull` again once it is granted (if the owner gates access, it becomes a request they approve). To make your own separate copy (a fork), use `grid_pickup`.";
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
  // M3: a create/re-plug with NO source at all is a caller mistake — fail it
  // here with the source list instead of letting it wander into an obscure
  // downstream error.
  if (!hasHtml && !hasArtifacts && !hasPath) {
    throw new Error(
      "No source to plug. Pass exactly one of: `html` (a single inline HTML document), " +
        "`artifact_files` (multiple inline files), or `path` (a local file/folder/zip, local edition only).",
    );
  }
  if (ctx.edition === "web" && hasPath) {
    throw new Error(
      "The hosted server cannot read local files — pass the source inline via `html` or `artifact_files`.",
    );
  }
  // Secret scan on inline sources — a plugged page is public; block pasted API
  // keys before they leave the machine. (Field bug 2026-07-27: an OpenRouter
  // key was embedded in a public page "so they can test now".)
  if (hasHtml) {
    const hit = scanInlineSecrets(html);
    if (hit) throw new Error(secretBlockMessage(hit, "inline `html`"));
  }
  if (hasArtifacts) {
    for (const f of artifact_files) {
      let body = f?.content;
      if (typeof body === "string" && f?.encoding === "base64") {
        try { body = Buffer.from(body, "base64").toString("utf8"); } catch { /* scan raw */ }
      }
      const hit = scanInlineSecrets(body);
      if (hit) throw new Error(secretBlockMessage(hit, `artifact file \`${f?.path ?? "?"}\``));
    }
  }
  let zipSingleHtml = null;
  if (zipSource) {
    if (target_entity_id || (slug && grid)) {
      throw new Error(
        "Re-plugging an existing entity from a zip is not supported yet — pick up the app " +
          "(grid_edit_existing_app) and re-plug the folder, or plug the zip as a new entity.",
      );
    }
    if (anon) {
      throw new Error("A zip plug creates a static app and needs sign-in — it cannot be anonymous.");
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
    // Same secret scan as the inline sources — a model on the local edition
    // can write a key into a file and plug the path, bypassing the inline
    // check. Scan textual files (≤1MB) read from disk too.
    for (const a of artifacts) {
      if (a.buffer && a.buffer.length <= 1024 * 1024) {
        const hit = scanInlineSecrets(a.buffer.toString("utf8"));
        if (hit) throw new Error(secretBlockMessage(hit, `file \`${a.path}\``));
      }
    }
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
  // Defence in depth: anon: true must only reach here after the explicit choice
  // prompt was surfaced (register.js sets authChoiceOffered to true). The flag is
  // undefined when runPlug is called directly (tests bypass the gate), so only
  // assert when ctx.state has authChoiceOffered as an own property.
  if (
    anon === true &&
    ctx.state &&
    "authChoiceOffered" in ctx.state &&
    ctx.state.authChoiceOffered !== true
  ) {
    throw new Error("anon: true reached runPlug without the auth choice being offered first. This is a bug.");
  }
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
  // Built fresh per attempt: the ORG_PROVISIONING retry loop below re-POSTs, and
  // a FormData body is consumed by a send, so each attempt needs its own.
  const buildForm = () => {
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
  return form;
  };

  // One POST attempt: assemble a fresh body, send, read + parse. Kept as a
  // closure so the ORG_PROVISIONING retry loop can re-run it (issue #235).
  const sendPlug = async () => {
    let res;
    try {
      res = await fetchImpl(`${API_BASE}/api/v2/plug`, {
        method: "POST",
        headers,
        body: buildForm(),
        signal: AbortSignal.timeout(uploadTimeoutMs),
      });
    } catch (err) {
      if (err?.name === "AbortError" || err?.name === "TimeoutError") {
        throw new Error(
          `The plug request timed out after ${Math.round(uploadTimeoutMs / 1000)}s. ` +
            `The build may still be running on CloudGrid — check the build status ` +
            `(poll_url / grid_status, or your grid) before plugging again, so you don't create a duplicate.`,
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
    return { res, raw, data };
  };

  // ── ORG_PROVISIONING retry (issue #235) ─────────────────────────────────────
  // A plug into a brand-new grid whose infra is still provisioning is refused
  // with 409 ORG_PROVISIONING. That write 409 is the ONLY signal that the grid
  // is not yet ready (no read endpoint reports it), so the plug IS the readiness
  // probe: retry the POST with a light backoff until it clears or the budget
  // runs out. A terminal 'failed' provisioning (hint says setup did not
  // complete) is NOT retried — it won't recover on its own. The wait is a
  // bounded server-side block matching the deploy-poll liveness pattern already
  // used after a create; the caller sees one honest result, never a raw code.
  const sleep = deps.sleep || sleepMs;
  const provisionBudgetMs = ctx.plugProvisionBudgetMs ?? PLUG_PROVISION_RETRY_BUDGET_MS;
  const provisionBaseMs = ctx.plugProvisionIntervalMs ?? PLUG_PROVISION_RETRY_BASE_MS;
  const provisionMaxMs = ctx.plugProvisionMaxMs ?? PLUG_PROVISION_RETRY_MAX_MS;
  const provisionStart = Date.now();
  let attempt = 0;
  let res, raw, data;
  for (;;) {
    ({ res, raw, data } = await sendPlug());
    if (res.ok) break;
    if (res.status === 409 && isProvisioningCode(data?.error?.code)) {
      const hint = data?.error?.details?.[0]?.hint || "";
      // Terminal failure — provisioning did not complete; retrying is futile.
      if (/did not (complete|finish)/i.test(hint)) {
        throw new Error(
          `The grid "${orgSlug || grid || "your grid"}" did not finish provisioning, so it can't accept a deploy. ${hint} ` +
            "This won't recover on its own from here — the grid likely needs to be recreated (grid_create_grid with a new slug), or an admin must retry provisioning.",
        );
      }
      const delay = Math.min(
        provisionMaxMs,
        Math.round(provisionBaseMs * Math.pow(1.5, attempt)),
      );
      if (Date.now() - provisionStart + delay <= provisionBudgetMs) {
        attempt += 1;
        await sleep(delay);
        continue;
      }
      // Budget exhausted — fall through to the error handler, which appends the
      // ORG_PROVISIONING guidance (errorGuidance): honest "still setting up,
      // wait and re-call", never the raw code or the EDIT_REJECTED wording.
    }
    break;
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
      // Kind lets grid_visibility route to the right visibility surface
      // (inspirations vs runtime entities) without a re-detect round-trip.
      kind: data.detection?.kind ?? data.kind ?? null,
      // poll_url lets grid_check_deploy default to this session's build with
      // no arguments ("is it live yet?" needs no ids).
      poll_url: data.poll_url ?? null,
      grid: data.grid ?? null,
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

  // Confirm-before-claiming-live: a runtime build is async (status "building" +
  // poll_url). Rather than returning immediately — which trained models to
  // promise URLs that then 502'd — poll the deploy trace server-side for a short
  // budget. Fast builds come back "live" in this same tool call; a build that
  // outlives the budget returns "building" with explicit do-not-claim-live copy;
  // a failed build surfaces the platform's user-language error instead of a URL.
  if ((data.status === "building" || data.poll_url) && !useAnonWire && (data.poll_url || data.entity_id)) {
    const verdict = await pollDeployTrace(ctx, {
      pollUrl: data.poll_url,
      entityId: data.entity_id,
      grid: data.grid,
      budgetMs: ctx.deployPollBudgetMs ?? DEPLOY_POLL_BUDGET_MS,
      intervalMs: ctx.deployPollIntervalMs ?? DEPLOY_POLL_INTERVAL_MS,
    });
    if (verdict.status === "success") {
      data.status = "live";
      data.poll_url = undefined;
    } else if (verdict.status === "failed") {
      const msg = verdict.error || "The build failed.";
      throw new Error(
        `Deploy failed (trace ${data.trace_id ?? "n/a"}): ${msg} The URL is NOT live — do not give it to the user as working.` +
          formatFailureDetail(verdict),
      );
    }
    // Anything else (still building / poll unreachable): fall through to the
    // building wording below — the do-not-claim-live path.
  }

  const structured = {
    ...(data.entity_id ? { entity_id: data.entity_id } : {}),
    ...(data.slug ? { slug: data.slug } : {}),
    grid: data.grid ?? null,
    ...(url ? { url } : {}),
    ...(data.poll_url ? { poll_url: data.poll_url } : {}),
    status: data.status ?? (isEdit ? "updated" : "created"),
    source: hasPath ? "path" : hasHtml && !hasArtifacts ? "html" : "artifact_files",
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

  // ── Source-transport disclosure (always) + CLI steer for multi-file apps ─────
  // Two transports with very different reliability: INLINE (`html`/`artifact_files`
  // — the source is copied THROUGH the tool call, so a large file like a lockfile
  // or a binary can silently truncate and fail the build) vs DISK (`path`, or the
  // CLI's folder plug — read straight from disk, no transcription risk). State
  // which one ran so a watching user can see it, and for a multi-file inline
  // deploy steer to the CLI, which reads from disk and cannot truncate.
  const artifactCount = Array.isArray(artifacts) ? artifacts.length : 0;
  let sourceLine;
  let cliSteer = null;
  if (hasPath) {
    sourceLine = `Source: local folder \`${effectivePath}\`, read from disk (no truncation risk).`;
  } else if (hasHtml && !hasArtifacts) {
    sourceLine = "Source: inline `html` — a single self-contained document sent through the tool call.";
  } else {
    const kb = Math.round(artifacts.reduce((n, a) => n + (a.buffer?.byteLength ?? 0), 0) / 1024);
    sourceLine = `Source: inline \`artifact_files\` — ${artifactCount} file${artifactCount === 1 ? "" : "s"}, ~${kb} KB copied through the tool call.`;
    // A multi-file app (a real framework, a lockfile, or binary assets) is exactly
    // where inline copying truncates. Steer to the CLI's disk-based plug.
    const looksRuntime =
      artifactCount > 1 ||
      artifacts.some((a) => /(^|\/)(cloudgrid\.ya?ml|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(a.path || ""));
    if (looksRuntime) {
      const gridSlug = data.grid ?? grid ?? null;
      const eid = data.entity_id ?? targetEntityId ?? null;
      // The disk CLI is the reliable route for a multi-file app — BUT it only
      // works where the CLI is already SIGNED IN: a terminal or Claude Code
      // where `grid login` was run once. Do NOT tell the agent to `grid login`
      // inside an ephemeral chat sandbox — that login is a long-lived poll (up
      // to 5 min) and the sandbox is time-bounded + non-persistent, so it won't
      // complete or won't survive to the next command (observed live). If this
      // was inline-only, the fix is to move to a signed-in shell OR ask the
      // user — never silently drop large files.
      const replug = eid
        ? `npx -y @cloudgrid-io/cli plug --existing ${eid}${gridSlug ? ` --grid ${gridSlug}` : ""} --verbose`
        : "npx -y @cloudgrid-io/cli plug";
      cliSteer =
        "Heads-up: this went in INLINE. For a multi-file app the disk-based CLI is more reliable (lockfiles/binaries can't truncate), but it must run where the CLI is already signed in — a terminal or Claude Code that has done `grid login` once. Do NOT try `grid login` inside a chat sandbox: its login poll is long-lived and the sandbox is ephemeral, so it won't stick. " +
        `If you had to leave any files out to make this inline plug safe, tell the user — offer the complete plug from Claude Code or a terminal (\`${replug}\`), or confirm they accept the reduced version. Do not drop files silently.`;
    }
  }

  const lines = [];
  if (isBuilding) {
    lines.push(
      isEdit
        ? `Building (async): ${url} — the update is plugging, not live yet.`
        : `Building (async): ${url} — the plug is in progress, not live yet.`,
    );
    // Point at a tool that exists on THIS edition. grid_status is CLI-wrapping,
    // local-only — telling a hosted (ChatGPT/claude.ai) model to "run
    // grid_status" dead-ends (observed live: a hosted session had no status
    // tool and blind-polled the public URL into a 502). grid_check_deploy is
    // direct-API and registered on both editions.
    const checkHint = ctx.edition === "web" ? "grid_check_deploy" : "grid_check_deploy (or grid_status)";
    lines.push(
      data.poll_url
        ? `Call ${checkHint} until status is "success" (trace ${data.trace_id ?? "n/a"}). Do NOT tell the user it is live until then.`
        : `Call ${checkHint} until it is ready. Do NOT tell the user it is live until then.`,
    );
  } else if (isEdit) {
    lines.push(`Updated in place: ${url}`);
  } else if (isInspirationCreate) {
    // Authed inspiration create — owned by the caller. Wording mirrors the drop verb.
    lines.push(ctx.edition === "web" ? `Your app is live: ${url}` : `Plugged into your grid: ${url}`);
    if (ctx.edition !== "web") lines.push("Owned by you.");
  } else {
    lines.push(`Live: ${url}`);
  }
  // Suggestion 3: always disclose the transport; Suggestion 1: steer multi-file
  // inline deploys to the CLI's disk-based plug.
  lines.push(sourceLine);
  if (cliSteer) lines.push(cliSteer);
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
  // the user, then apply their answer via grid_visibility. On an edit, leave the
  // entity's existing visibility untouched (don't re-ask on every re-plug).
  if (!isEdit && data.entity_id) {
    const current = typeof data.visibility === "string" ? data.visibility : null;
    structured.console_url = CONSOLE_URL;
    if (current) structured.current_visibility = current;
    structured.visibility_options = VISIBILITY_OPTIONS.map((v) => ({ value: v, label: VISIBILITY_LABELS[v] }));
    lines.push(`Manage all your apps in your grid: ${CONSOLE_URL}`);
    lines.push(
      `Now ASK the user who should be able to open this${current ? ` (currently ${VISIBILITY_LABELS[current] ?? current})` : ""}, then set their choice with grid_visibility — do not decide it for them. Options: ${
        VISIBILITY_OPTIONS
          .map((v) => `${v} (${VISIBILITY_LABELS[v]})`)
          .join("; ")
      }. Finer control: a sign-in-required link (require_signin), search-indexed (indexed), or selected spaces (inside: spaces).`,
    );
  }
  return { text: lines.join("\n"), structured };
}

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
    // Expose the structured status/code so callers can branch (e.g. runPickup's
    // NOT_A_RUNTIME → inspiration-route fallback). Additive: existing callers
    // only read `.message`.
    err.status = res.status;
    err.code = codeStr;
    throw err;
  }
  return data;
}

// grid_pickup — "make your own copy" (like a git fork). Mints a NEW entity in a
// grid you can build in, keeps lineage back to the source, and strips the
// source's secrets/connection credentials — you set your own before plugging.
// Plugging your copy creates/updates YOUR entity; the original is untouched.
// Hits POST /api/v2/runtimes/:id/remix (the copy route). Mirrors the CLI's
// `grid pickup`. To edit the ORIGINAL in place, that's grid_pull, not this.
export async function runPickup(ctx, { id, into_org_slug, name, source_version_id }) {
  const data = await authedApiCall(ctx, {
    method: "POST",
    pathName: `/api/v2/runtimes/${encodeURIComponent(id)}/remix`,
    body: {
      ...(into_org_slug ? { into_org_slug } : {}),
      ...(name ? { name } : {}),
      ...(source_version_id ? { source_version_id } : {}),
    },
    verb: "Pickup",
  });
  const gridSlug = data?.grid_slug ?? data?.org?.slug ?? null;
  const lines = [
    `Picked up a copy: ${data?.name ?? id} (entity_id=${data?.entity_id ?? "?"})${gridSlug ? ` in grid ${gridSlug}` : ""}.`,
    "This is a NEW entity — plug it (with this entity_id as target_entity_id) to create/update YOUR copy; the original is untouched.",
    `Lineage kept (forked_from=${data?.forked_from ?? "?"}). The source's secrets were NOT copied — set your own before you plug.`,
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

// Change an entity's visibility — inspiration OR runtime app/agent. Authed,
// direct API — works on the hosted edition where the CLI-wrapping share tool is
// unavailable. Kind-aware routing (see below). Defaults to the drop made in this
// session, so "make it private" needs no ids.
export async function runVisibility(ctx, { target, visibility, inside, outside, require_signin, spaces, indexed, kind, org }) {
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

  // ── Two-axis visibility model ──────────────────────────────────────
  // A scope is two independent axes:
  //   inside  (share_scope):     private | spaces | grid   — who in the grid sees it
  //   outside (external_access): none | link | public      — reach beyond the grid
  //   require_signin: link only — the link needs a signed-in CloudGrid account
  // Legacy positional modes (private|grid|link) still ride the { visibility }
  // body; `authenticated` is RETIRED as a first-class mode and maps to the axis
  // body it equals (private + link + require_signin); `org` is rejected;
  // `public` as a mode is an alias of `link` (the axis value `public` is the
  // indexed one); `space` maps to inside: spaces and needs the `spaces` list.
  const normSpaces = [...new Set((spaces || []).map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
  const useAxes = inside !== undefined || outside !== undefined;
  let body;
  let requested; // for the result text when the response is sparse
  if (useAxes) {
    if (visibility) throw new Error("Pass either `visibility` or the `inside`/`outside` axes, not both.");
    if (!inside || !outside) {
      throw new Error("Both axes are required: inside (private|spaces|grid) and outside (none|link|public).");
    }
    if (indexed === true) {
      // Search-indexing is the axis value `outside: public`, not a separate
      // flag. Accepting `indexed` here and building the body without it would
      // silently drop it (the exact accept-and-ignore class #2326 closes).
      // Mirror the CLI (visibility.ts:375-379): reject, point at the axis value.
      throw new Error("indexed does not apply with inside/outside. Use outside: public for a search-indexed link.");
    }
    if (inside === "spaces" && normSpaces.length === 0) {
      throw new Error("inside: spaces needs at least one space slug in `spaces`.");
    }
    if (inside !== "spaces" && normSpaces.length > 0) {
      throw new Error("`spaces` only applies with inside: spaces.");
    }
    if (require_signin === true && outside !== "link") {
      throw new Error("require_signin only applies when outside is link.");
    }
    body = {
      share_scope: inside,
      external_access: outside,
      ...(require_signin === true ? { require_signin: true } : {}),
      ...(inside === "spaces" ? { visibility_spaces: normSpaces } : {}),
    };
    requested = `inside: ${inside}${inside === "spaces" ? ` (${normSpaces.join(", ")})` : ""}, outside: ${outside}${require_signin === true ? " (sign-in required)" : ""}`;
  } else {
    let mode = String(visibility || "").trim().toLowerCase();
    if (!mode) throw new Error("Pass a visibility mode (private | grid | link), or the inside/outside axes.");
    if (mode === "org") {
      throw new Error("'org' visibility is deprecated. Use 'grid' (everyone in the grid).");
    }
    if (mode === "public") mode = "link"; // alias; `indexed: true` governs search-indexing
    if (mode === "authenticated") {
      // Retired as a first-class mode — the axis body it equals
      // (private + link + require_signin). Its param guards MUST match that
      // combo (below): a sign-in-gated link can be neither search-indexed nor
      // space-scoped, so `indexed`/`spaces` here must throw, not be dropped.
      if (indexed === true) {
        throw new Error("require_signin cannot combine with indexed: a sign-in-gated link cannot be search-indexed.");
      }
      if (normSpaces.length > 0) {
        throw new Error("`spaces` only applies with visibility: grid (or inside: spaces).");
      }
      body = { share_scope: "private", external_access: "link", require_signin: true };
      requested = "link with sign-in required (the retired 'authenticated')";
    } else if (mode === "space") {
      // `space` is a pure internal audience (share_scope: spaces, external_access:
      // none). require_signin/indexed are external-link concerns — they have no
      // cell here, so reject rather than silently ignore (same defect class).
      if (require_signin === true) {
        throw new Error("require_signin only applies with visibility: link (or outside: link).");
      }
      if (indexed === true) {
        throw new Error("`indexed` only applies with visibility: link.");
      }
      if (normSpaces.length === 0) {
        throw new Error("'space' visibility needs the `spaces` list (which space slugs can see it) — or use inside: spaces with outside: none.");
      }
      body = { share_scope: "spaces", external_access: "none", visibility_spaces: normSpaces };
      requested = `selected spaces (${normSpaces.join(", ")})`;
    } else if (mode === "private" || mode === "grid" || mode === "link") {
      if (require_signin === true && mode !== "link") {
        throw new Error("require_signin only applies with visibility: link (or outside: link).");
      }
      if (indexed === true && mode !== "link") {
        throw new Error("`indexed` only applies with visibility: link.");
      }
      if (normSpaces.length > 0 && mode !== "grid") {
        throw new Error("`spaces` only applies with visibility: grid (or inside: spaces).");
      }
      if (mode === "link" && require_signin === true) {
        // A sign-in-gated link is the axis cell (private, link, require_signin);
        // search-indexing is the (·, public) cell. The two are mutually
        // exclusive: the server's axis body has NO representable state for both.
        // `link_indexed` on an axis body is silently DISCARDED —
        // validateAxisBody (packages/shared/src/visibility-write.ts:113) never
        // reads it and AxisBody (:23) has no such field, and
        // axesToLegacyVisibility (:78) for (private, link, require_signin)
        // returns { visibility: 'authenticated' } with no link_indexed. So the
        // server resolves link_indexed to null and drops `indexed`. Reject the
        // combination rather than forward a key the server throws away.
        if (indexed === true) {
          throw new Error("require_signin cannot combine with indexed: a sign-in-gated link cannot be search-indexed.");
        }
        body = { share_scope: "private", external_access: "link", require_signin: true };
        requested = "link with sign-in required";
      } else {
        body = { visibility: mode };
        if (mode === "grid" && normSpaces.length > 0) body.visibility_spaces = normSpaces;
        if (mode === "link") body.link_indexed = indexed === true;
        requested = mode + (mode === "link" && indexed === true ? " (search-indexed)" : "");
      }
    } else {
      throw new Error(`Unknown visibility '${visibility}'. Use private | grid | link (public = link alias), or the inside/outside axes.`);
    }
  }

  const k = kind || ctx.state.lastDrop?.kind || null;
  const isRuntimeKind = k === "app" || k === "agent";

  const patch = async (pathName) => {
    let res;
    try {
      res = await fetch(`${API_BASE}${pathName}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`Could not reach CloudGrid at ${API_BASE}: ${err.message}`);
    }
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch { /* handled by caller */ }
    return { res, data, raw };
  };

  // BOTH realms now take the same realm-scoped visibility PATCH with the
  // same body vocabulary: /api/v2/entities/:id/visibility (runtimes) and
  // /api/v2/inspirations/:id/visibility (inspirations).
  const runtimePath = `/api/v2/entities/${encodeURIComponent(id)}/visibility`;
  const inspirationPath = `/api/v2/inspirations/${encodeURIComponent(id)}/visibility`;

  // Route order: a known runtime kind goes straight to the entities route; a
  // known inspiration to the inspiration route; unknown tries runtime first and
  // falls back on a not-found (mirrors runPickup).
  let order;
  if (isRuntimeKind) order = ["runtime"];
  else if (k === "inspiration") order = ["inspiration"];
  else order = ["runtime", "inspiration"];

  let last;
  for (let i = 0; i < order.length; i++) {
    const route = order[i];
    last = await patch(route === "runtime" ? runtimePath : inspirationPath);
    if (last.res.ok) {
      const d = last.data || {};
      // Prefer the server's stored axes (stored axes are authoritative on
      // the wire); fall back to what we asked for.
      const lines = [];
      if (d.share_scope || d.external_access) {
        const insideLine =
          d.share_scope === "private" ? "only the owner" :
          d.share_scope === "spaces" ? `selected spaces${Array.isArray(d.visibility_spaces) && d.visibility_spaces.length ? ` (${d.visibility_spaces.join(", ")})` : ""}` :
          d.share_scope === "grid" ? "everyone in the grid" : d.share_scope;
        const outsideLine =
          d.external_access === "none" ? "no one outside the grid" :
          d.external_access === "link" ? `anyone with the link${d.require_signin ? " (signed-in accounts only)" : ""}${d.link_indexed ? ", search-indexed" : ""}` :
          d.external_access === "public" ? "anyone, findable by search engines" : d.external_access;
        lines.push(`Visibility set — inside the grid: ${insideLine}; outside: ${outsideLine}.`);
      } else {
        lines.push(`Visibility is now ${d.visibility || requested}.`);
      }
      if (d.url) lines.push(d.url);
      return {
        text: lines.join("\n"),
        structured: {
          visibility: d.visibility || (useAxes ? undefined : String(visibility || "").trim().toLowerCase() || undefined),
          ...(d.share_scope ? { share_scope: d.share_scope } : {}),
          ...(d.external_access ? { external_access: d.external_access } : {}),
          ...(d.require_signin !== undefined ? { require_signin: d.require_signin === true } : {}),
          ...(Array.isArray(d.visibility_spaces) ? { visibility_spaces: d.visibility_spaces } : {}),
          ...(d.link_indexed !== undefined ? { link_indexed: d.link_indexed === true } : {}),
          ...(d.url ? { url: d.url } : {}),
        },
      };
    }
    // Fall back runtime→inspiration only when the id isn't a runtime entity
    // (a genuine 4xx like NOT_OWNER must surface, not silently re-route).
    const code = last.data?.error?.code;
    const canFallback =
      route === "runtime" &&
      i < order.length - 1 &&
      (last.res.status === 404 || code === "NOT_FOUND" || code === "NOT_A_RUNTIME");
    if (!canFallback) break;
  }

  const msg = last?.data?.error?.message || last?.raw || `HTTP ${last?.res?.status}`;
  const hint = last?.data?.error?.details?.[0]?.hint;
  throw new Error(`Visibility change failed (HTTP ${last?.res?.status}): ${msg}${hint ? ` ${hint}` : ""}`);
}

// ── Deploy-trace polling (confirm-before-claiming-live) ─────────────────────
// A runtime build is async: POST /api/v2/plug answers 202 { status: "building",
// poll_url: "/deploys/<trace_id>" } and GET {API}/deploys/<trace_id> (org-authed)
// reports { status, error } until a terminal "success" | "failed". Budget below
// is deliberately under typical host tool timeouts; slower builds fall back to
// the explicit do-not-claim-live wording + grid_check_deploy.
const DEPLOY_POLL_BUDGET_MS = 45_000;
const DEPLOY_POLL_INTERVAL_MS = 3_000;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Provisioning retry budget (issue #235) ──────────────────────────────────
// A plug into a brand-new grid is refused with 409 ORG_PROVISIONING until the
// grid's infra finishes provisioning (field estimate ~15-30s; the platform's
// own default remaining-time estimate is 30s). Since the ONLY signal that the
// grid can accept a plug is this write 409 (no read endpoint reports it), the
// plug retries the write with a light backoff until it clears or the budget
// runs out. Budget = 45s, matching DEPLOY_POLL_BUDGET_MS — a value the MCP
// client already tolerates within a single plug call (that post-create deploy
// poll blocks up to 45s today), and comfortably inside PLUG_UPLOAD_TIMEOUT_MS
// (120s). The guard rejects BEFORE parsing the upload body (plug.ts), so a
// retry is cheap server-side.
const PLUG_PROVISION_RETRY_BUDGET_MS = 45_000;
const PLUG_PROVISION_RETRY_BASE_MS = 2_000;
const PLUG_PROVISION_RETRY_MAX_MS = 8_000;

// GET one deploy-trace snapshot. Returns { status, error } — status is the
// server's word ("queued"/"building"/"success"/"failed"), error is the
// user-language message when failed. Throws only on a non-OK HTTP response.
// Resolve a pollable deploy target. The hosted inline-create 202 returns
// poll_url:null and trace_id:null (the trace is minted async), so when we only
// have an entity_id we look up its latest deploy — GET /entities/:id/deploys
// exposes a real trace_id even when the plug response omitted it — and poll the
// normal /deploys/<trace_id>. Returns a poll path, or null when there is no
// trace yet (the caller retries within its budget). Never throws.
async function resolvePollUrl(ctx, { pollUrl, entityId, grid }) {
  if (pollUrl) return pollUrl;
  if (!entityId) return null;
  try {
    const token = await ctx.getToken();
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const orgSlug = grid || (await ctx.getActiveGrid());
    if (orgSlug) {
      headers["X-CloudGrid-Grid"] = orgSlug;
      headers["X-CloudGrid-Org"] = orgSlug;
    }
    const res = await fetch(`${API_BASE}/api/v2/entities/${encodeURIComponent(entityId)}/deploys?limit=1`, { headers });
    if (!res.ok) return null;
    const data = await res.json();
    const traceId = data?.deploys?.[0]?.trace_id;
    return traceId ? `/deploys/${traceId}` : null;
  } catch {
    return null;
  }
}

async function fetchDeployTrace(ctx, { pollUrl, grid }) {
  const token = await ctx.getToken();
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const orgSlug = grid || (await ctx.getActiveGrid());
  if (orgSlug) {
    headers["X-CloudGrid-Grid"] = orgSlug;
    headers["X-CloudGrid-Org"] = orgSlug;
  }
  const path = pollUrl.startsWith("http") ? pollUrl : `${API_BASE}${pollUrl.startsWith("/") ? "" : "/"}${pollUrl}`;
  const res = await fetch(path, { headers });
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { /* handled below */ }
  if (!res.ok) {
    throw new Error(`Deploy status check failed (HTTP ${res.status}): ${data?.error?.message || data?.error || raw || res.status}`);
  }
  // Surface the real build failure, not just the generic floor message. A failed
  // deploy trace carries a structured DeployEventError: message_user (the floor),
  // build_log_excerpt.text (a sanitized ~50-line Cloud Build log tail — what the
  // CLI's --verbose prints), a Cloud Build console_url, and suggested_fixes. Pull
  // the log tail + first fix so grid_check_deploy stops dead-ending on "check the
  // build logs" with no logs.
  const e = data?.error && typeof data.error === "object" ? data.error : null;
  const excerpt = e?.build_log_excerpt && typeof e.build_log_excerpt === "object" ? e.build_log_excerpt : null;
  const logTail = (typeof excerpt?.text === "string" && excerpt.text.trim()) || (typeof excerpt?.summary === "string" && excerpt.summary.trim()) || null;
  const fix = Array.isArray(e?.suggested_fixes) && typeof e.suggested_fixes[0]?.summary === "string"
    ? e.suggested_fixes[0].summary
    : (typeof e?.ai_explanation?.message_user === "string" ? e.ai_explanation.message_user : null);
  return {
    status: data?.status ?? "unknown",
    error: e?.message_user || e?.message || null,
    logTail: logTail || null,
    consoleUrl: (typeof excerpt?.console_url === "string" && excerpt.console_url) || null,
    fix: fix || null,
  };
}

// Cap the log tail we echo into a tool result — enough to see the real error
// (a few dozen lines) without flooding the model's context.
const BUILD_LOG_TAIL_MAX = 1600;
function formatFailureDetail({ logTail, consoleUrl, fix } = {}) {
  const parts = [];
  if (logTail) {
    const t = logTail.length > BUILD_LOG_TAIL_MAX ? "…\n" + logTail.slice(-BUILD_LOG_TAIL_MAX) : logTail;
    parts.push(`Build log (tail):\n${t}`);
  }
  if (fix) parts.push(`Suggested fix: ${fix}`);
  if (consoleUrl) parts.push(`Full log: ${consoleUrl}`);
  return parts.length ? "\n" + parts.join("\n") : "";
}

// Poll until terminal or the budget runs out. Never throws — an unreachable
// poll endpoint degrades to { status: "unknown" } and the caller keeps the
// do-not-claim-live wording (the safe direction).
export async function pollDeployTrace(ctx, { pollUrl, entityId, grid, budgetMs = DEPLOY_POLL_BUDGET_MS, intervalMs = DEPLOY_POLL_INTERVAL_MS }) {
  const start = Date.now();
  let last = { status: "unknown", error: null };
  for (;;) {
    try {
      // Resolve each iteration: on the hosted inline-create path poll_url is
      // null and the trace may not exist for the first second or two, so keep
      // trying to resolve it from the entity until it appears.
      const target = await resolvePollUrl(ctx, { pollUrl, entityId, grid });
      if (target) last = await fetchDeployTrace(ctx, { pollUrl: target, grid });
    } catch {
      // transient/unauthorized/network — keep last, retry within budget
    }
    if (last.status === "success" || last.status === "failed") return last;
    if (Date.now() - start + intervalMs > budgetMs) return last;
    await sleepMs(intervalMs);
  }
}

// grid_check_deploy — one authed status check for an async build. Direct API,
// both editions: this is the status verb hosted (ChatGPT/claude.ai) sessions
// were missing — they had no way to confirm a runtime build came live and
// blind-polled the public URL into 502s.
export async function runCheckDeploy(ctx, { poll_url, grid } = {}) {
  const gridSlug = grid || ctx.state.lastDrop?.grid;
  const entityId = ctx.state.lastDrop?.entity_id;
  // poll_url may be null on the hosted inline-create path — fall back to the
  // session's entity_id and resolve the trace from /entities/:id/deploys.
  const target = await resolvePollUrl(ctx, {
    pollUrl: poll_url || ctx.state.lastDrop?.poll_url,
    entityId,
    grid: gridSlug,
  });
  if (!target) {
    throw new Error(
      "No build to check. Pass poll_url from a grid_plug result, or plug something first in this session. (Instant inspiration plugs are live on return and have no build to poll.)",
    );
  }
  const verdict = await fetchDeployTrace(ctx, { pollUrl: target, grid: gridSlug });
  const url = ctx.state.lastDrop?.url;
  if (verdict.status === "success") {
    return {
      text: `Live${url ? `: ${url}` : ""} — the build finished. Give the user the URL.`,
      structured: { status: "success", live: true, ...(url ? { url } : {}) },
    };
  }
  if (verdict.status === "failed") {
    // The project is NOT lost on a failed build: the source was uploaded
    // before the build ran and lives on the entity. On the hosted edition
    // (no filesystem, no way to iterate here) hand the user their files —
    // the source zip (grid_get_app_source → source_download_url) or the
    // pull command that downloads + links the folder so the SAME entity
    // continues locally.
    const handoff = ctx.edition === "web" && entityId
      ? `\nThe project files are NOT lost — they are saved on the entity. If it can't be fixed from this chat, hand the user their work: call grid_get_app_source for the source zip (source_download_url), or give them the local continue command: npx -y @cloudgrid-io/cli@latest pull ${gridSlug ? `${gridSlug}/` : ""}${ctx.state.lastDrop?.slug || entityId} — it downloads the project and links the folder so their next plug updates this same entity.`
      : "";
    return {
      text: `The build FAILED: ${verdict.error || "no reason reported"}. The URL is not live — do not give it to the user as working. Fix the app (or re-plug) and try again.` +
        formatFailureDetail(verdict) + handoff,
      structured: {
        status: "failed",
        live: false,
        ...(verdict.error ? { error: verdict.error } : {}),
        ...(verdict.logTail ? { build_log_tail: verdict.logTail } : {}),
        ...(verdict.fix ? { suggested_fix: verdict.fix } : {}),
        ...(verdict.consoleUrl ? { build_log_url: verdict.consoleUrl } : {}),
        ...(ctx.edition === "web" && entityId ? { source_recovery: { entity_id: entityId, via: ["grid_get_app_source", "grid pull"] } } : {}),
      },
    };
  }
  return {
    text: `Still ${verdict.status === "unknown" ? "building (status unavailable)" : verdict.status} — NOT live yet. Do not tell the user it is live. Wait ~15s and call grid_check_deploy again.`,
    structured: { status: verdict.status, live: false },
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
// endpoint runPull uses). Used by runSource when a bare URL arrives with no
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
