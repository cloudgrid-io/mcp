// Tool registration: registerTools(server, ctx) wires every tool onto the MCP
// server for the current edition.
// Extracted verbatim from src/tools.js (refactor: split tools.js into modules).

import { z } from "zod";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { newLoginCode, buildLoginUrl, pollStatusOnce, checkApiConnectivity, decodeJwt as decodeJwtAuth } from "../auth.js";
import { PLAYBOOK, fetchCorpus, listWorkflows } from "../playbook.js";
import {
  APPS_WIDGETS_ENABLED,
  CHATGPT_WIDGET_MIME,
  LIVE_RESULT_URI,
  GRID_PICKER_URI,
  LIVE_RESULT_HTML,
  GRID_PICKER_HTML,
  GRID_LOGIN_APP_URI,
  GRID_LOGIN_APP_HTML,
} from "./constants.js";
import { fail, okResult } from "./util.js";
import { cliTool, tryOpenBrowser } from "./cli.js";
import {
  fetchUserOrgs,
  resolveGridOrAsk,
  detectSourceManifest,
  runReport,
  runPull,
  runCollab,
  runPlug,
  runPickup,
  runCreateGrid,
  runVisibility,
  runSource,
  runCheckDeploy,
} from "./deploy.js";
import { stalenessNote } from "../staleness.js";

// Build the argv for grid_create_project → `grid new` (CLI >= 0.15.14; `init`
// is a deprecated alias we no longer author). Modern shape: `new <slug>` with
// `--agent` for agents (NOT the legacy `init <kind> <slug>` positional). The
// old `--description` flag was removed from the CLI, so it is gone here too.
// Exported pure so the argv is unit-tested without spawning a CLI.
export function buildCreateProjectArgs({ kind, name, type, needs, dir, grid, org } = {}) {
  const args = ["new", name];
  if (kind === "agent") args.push("--agent");
  if (type) args.push("--type", type);
  if (Array.isArray(needs) && needs.length) args.push("--needs", needs.join(","));
  if (dir) args.push("--dir", dir);
  const gridSlug = grid || org;
  if (gridSlug) args.push("--grid", gridSlug);
  return args;
}

// ── Sign-in ask (#298) ──────────────────────────────────────────────────────
// Until a rendered login card is possible (blocked on #297's answer + the
// directory submission), this text IS the whole login experience on every
// client, so it is written to be RELAYED nearly verbatim. The user-facing part
// comes first — a short question, then the two evenly-weighted options (guest is
// a real choice, not a fallback). The model-directed steps (which tool to call,
// do not choose, wait) are quarantined in a trailing (assistant: …) line so the
// model does not read internal directions aloud. §23 voice: plain, no emoji, no
// exclamation; say "plug" and "grid". The sign-in URL itself lands on its own
// line later, from grid_login. No structural change — every caller still returns
// { needs_auth: true }.
const AUTH_ASK_SIGNED_OUT =
  "How would you like to plug this?\n" +
  "  - Sign in to your grid — it stays in your CloudGrid account.\n" +
  "  - As a guest — live now at a link that expires in 7 days unless you claim it.\n\n" +
  "(assistant: offer both options and let the user choose — do not choose for them. " +
  "To sign in, call grid_login; as a guest, re-call grid_plug with anon: true. " +
  "Stop and wait for their answer.)";
const authAskSignedIn = (who) =>
  `You are signed in${who}.\n\n` +
  "How would you like to plug this?\n" +
  "  - To your grid — it stays in your CloudGrid account.\n" +
  "  - As a guest — live now at a link that expires in 7 days unless you claim it.\n\n" +
  "(assistant: offer both options and let the user choose — do not choose for them. " +
  "For their grid, re-call grid_plug; as a guest, re-call grid_plug with anon: true. " +
  "Stop and wait for their answer.)";

// ── Registration ───────────────────────────────────────────────────────────────
// Registers the tools onto `server`. ctx.edition decides whether the CLI-wrapping
// tools are included (they need a local machine).
export function registerTools(server, ctx) {
  // ── Tool naming: grid_* only ───────────────────────────────────────────
  // Every tool is registered under its `grid_*` name only. The legacy
  // deprecated `cloudgrid_*` aliases were removed in 0.10.0 — they doubled the
  // connector tool list and de-duplicated poorly in permission UIs. Clients
  // enumerate tools dynamically, so discovery is unaffected. `reg` wraps the
  // object-config `server.registerTool`; `regTool` wraps the positional
  // `server.tool` shorthand.
  // Capture shim: route every tool call through the QA session logger when one
  // is attached (ctx.logger). Fire-and-forget, fully guarded — NEVER blocks or
  // fails the tool call (2026-07-13 incident rule). No logger → zero overhead.
  const withCapture = (name, handler) => async (input) => {
    const started = Date.now();
    try {
      const result = await handler(input);
      try { ctx.logger?.recordCall(name, input, result, Date.now() - started); } catch { /* never */ }
      return result;
    } catch (err) {
      // A thrown handler must record as an ERROR — the old finally-based capture
      // saw result=undefined and mis-recorded it as "ok". Carry the error
      // message so the QA log says WHY, not just "error" (diagnosability: a
      // Songsmith hosted deploy logged a bare "error" and cost four blind
      // reproductions). Synthesize an error result, then rethrow unchanged.
      try { ctx.logger?.recordCall(name, input, { isError: true, errorMessage: String(err?.message || err) }, Date.now() - started); } catch { /* never */ }
      throw err;
    }
  };

  // Every tool registers under its canonical grid_* name ONLY. Deprecated
  // aliases were removed entirely (founder directive, 2026-07-22): each alias
  // doubled the ListTools surface for pure clutter, clients enumerate tools
  // dynamically, and the renames' old names (grid_deploy, grid_set_sharing,
  // grid_copy_app, grid_claim_anonymous_deploy, grid_download_source,
  // grid_fetch, grid_logs) are gone rather than advertised as redirects.
  const reg = (name, config, handler) => {
    server.registerTool(name, config, withCapture(name, handler));
  };

  const regTool = (name, title, description, schema, annotations, handler) => {
    server.registerTool(name, { title, description, inputSchema: schema, annotations }, withCapture(name, handler));
  };

  // ── Widget resources (web edition, ChatGPT Apps SDK) ──────────────────────
  if (ctx.edition === "web") {
    // ChatGPT Apps-SDK widgets. mimeType MUST be text/html+skybridge
    // (CHATGPT_WIDGET_MIME) — NOT the MCP-Apps `text/html;profile=mcp-app` the
    // Claude card uses; that mismatch was the black frame (#308). widgetAccessible
    // lets the widget call tools back over window.openai.callTool (the visibility
    // pills call grid_visibility). These make no direct network requests, so no
    // openai/widgetCSP is declared — the default deny is correct.
    server.registerResource("cloudgrid-live-result", LIVE_RESULT_URI, {
      description: "Live result card after a CloudGrid drop — shows URL, grid link, and visibility controls.",
      mimeType: CHATGPT_WIDGET_MIME,
    }, async () => ({
      contents: [{
        uri: LIVE_RESULT_URI,
        mimeType: CHATGPT_WIDGET_MIME,
        text: LIVE_RESULT_HTML,
        _meta: { "openai/widgetAccessible": true },
      }],
    }));

    server.registerResource("cloudgrid-org-picker", GRID_PICKER_URI, {
      description: "Grid picker card — lets the user choose which grid to plug into.",
      mimeType: CHATGPT_WIDGET_MIME,
    }, async () => ({
      contents: [{
        uri: GRID_PICKER_URI,
        mimeType: CHATGPT_WIDGET_MIME,
        text: GRID_PICKER_HTML,
        _meta: { "openai/widgetAccessible": true },
      }],
    }));

    // grid_login MCP App (SEP-1865). Registered via the official ext-apps
    // helper, which defaults the MIME type to RESOURCE_MIME_TYPE
    // (text/html;profile=mcp-app) — the type Claude web looks for. NO csp
    // domains: the card makes no network requests of its own (it only asks the
    // host to open the sign-in URL and calls grid_login_status back over the
    // bridge), so deny-by-default is exactly right. Independent of
    // APPS_WIDGETS_ENABLED by design (see constants.js).
    registerAppResource(server, "cloudgrid-grid-login", GRID_LOGIN_APP_URI, {
      description: "CloudGrid sign-in card — opens the sign-in URL and confirms when you return.",
    }, async () => ({
      contents: [{
        uri: GRID_LOGIN_APP_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: GRID_LOGIN_APP_HTML,
      }],
    }));
  }

  // ── Direct-API tools (both editions) ──────────────────────────────────────

  // ── Copy / adopt verbs (both editions) — mirror the CLI: ──────────────────
  //   grid_pickup = make YOUR OWN COPY (git-fork style) → POST /runtimes/:id/remix
  //   grid_pull   = continue/edit the SAME entity in place (push access needed)
  //                 → POST /entities/:id/pickup
  // (The CLI verbs `download`, `fork`, `remix`, `link` were retired; no MCP tool
  // targets them.)

  // grid_pickup — make your own copy of any app you can see.
  reg(
    "grid_pickup",
    {
      title: "Copy an app into your grid",
      description: "Pick up an app: make your OWN COPY of any app you can see (like a git fork) into a grid you can build in. It mints a NEW entity with lineage back to the source and WITHOUT the source's secrets (set your own before you plug). Plugging your copy creates/updates YOUR entity — the original is never touched. Requires sign-in. This is a FORK, not a \"collab\": it never grants you access to anyone else's live entity. Getting PUSH ACCESS to the SAME entity is a different operation — the grid_collab tool (or the CLI `grid collab <entity>`) — so do NOT reach for grid_pickup when the user asks to collab; reach for grid_collab. To edit the ORIGINAL entity in place (as its owner or a collaborator), use grid_pull instead.",
      inputSchema: {
        entity_id: z.string().describe("The source app to copy: a canonical UUID or <grid-slug>/<entity-slug>."),
        grid: z.string().optional().describe("Grid to create your copy in. Required only when you belong to more than one grid."),
        id: z.string().optional().describe("Alias of entity_id (legacy). Prefer entity_id."),
        into_org_slug: z.string().optional().describe("Alias of grid (legacy). Prefer grid."),
        name: z.string().optional().describe("Slug for your copy. Omit to derive one from the source."),
        source_version_id: z.string().optional().describe("Copy an older version instead of HEAD, e.g. v_a1b2c3d."),
      },
      outputSchema: {
        entity_id: z.string().nullable().describe("Your copy's entity id — pass as grid_plug's target_entity_id to update it."),
        name: z.string().nullable().describe("Your copy's slug."),
        kind: z.string().nullable().describe("app | agent."),
        grid_slug: z.string().nullable().describe("The grid your copy landed in."),
        forked_from: z.string().nullable().describe("Source entity_id (lineage)."),
        forked_from_version_id: z.string().nullable().describe("Source version, when a specific one was copied."),
        current_version_id: z.string().nullable().describe("Your copy's current version id."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        const resolved = {
          ...input,
          id: input?.entity_id || input?.id,
          into_org_slug: input?.grid || input?.into_org_slug,
        };
        if (!resolved.id) return fail("`entity_id` is required (a canonical UUID or <grid-slug>/<entity-slug>).");
        return okResult(await runPickup(ctx, resolved));
      } catch (err) {
        return fail(err.message);
      }
    },
  );

  // grid_pull — continue/edit the SAME entity in place (push access required).
  reg(
    "grid_pull",
    {
      title: "Pull an app to edit in place",
      description: "Pull an app to continue/edit it IN PLACE — like `git clone` of the SAME entity: your next grid_plug (with its target_entity_id) updates that entity, and the team sees the new version. Requires PUSH ACCESS: you must own it or be a collaborator. If you can only view it, you CANNOT edit or plug it — say so, and offer the two real options: (1) make your own separate copy (a fork) with grid_pickup, or (2) GET push access to the SAME entity with grid_collab (or the CLI `grid collab <entity>`) — \"collab\" is a distinct access-control operation that grants permission only and fetches nothing, so once it is granted you run grid_pull again to get the code (and if the owner gates access, grid_collab becomes a request they approve). Passing an anonymous drop's `claim_token` claims it into your account. Requires sign-in. Calls the API directly (both editions).",
      inputSchema: {
        entity_id: z.string().optional().describe("The entity id to pull. Defaults to this session's last anonymous drop."),
        grid: z.string().optional().describe("Grid to resolve a bare slug in. Required only when you belong to more than one grid."),
        claim_token: z.string().optional().describe("Anonymous drop only: its owner token — claims that drop into your account (ownership transfer)."),
        claim_url: z.string().optional().describe("Alternative to claim_token for an anonymous drop — the claim_url; the token is read from it."),
      },
      outputSchema: {
        entity_id: z.string().optional().describe("The entity you pulled."),
        slug: z.string().optional().describe("Its slug."),
        grid: z.string().nullable().optional().describe("Its grid."),
        url: z.string().optional().describe("Its public URL."),
        owner_is_you: z.boolean().optional().describe("True if you own it."),
        can_edit: z.boolean().optional().describe("True if you can plug/update it (owner or collaborator). False = view-only."),
        access: z.string().optional().describe("Access level when can_edit is false (e.g. 'view_only')."),
        error: z.object({ code: z.string() }).optional().describe("Error envelope when the grid slug is wrong or inaccessible. code is the server error code (e.g. ORG_NOT_ACCESSIBLE)."),
        needs_grid_create: z.boolean().optional().describe("True when the account has no grid yet — route to grid_create_grid before retrying."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        return okResult(await runPull(ctx, input || {}));
      } catch (err) {
        return fail(err.message);
      }
    },
  );

  // grid_collab — GET PUSH ACCESS to the SAME live entity you do NOT own (#253).
  // The THIRD adopt/access verb, distinct from grid_pickup (fork) and grid_pull
  // (continue). Pure API (POST /entities/:id/collab; a policy 403 → a request via
  // POST /:id/collab-requests), no CLI or filesystem — so it ships on BOTH
  // editions, exactly like grid_pickup/grid_pull. Registered BEFORE the
  // edition!=="local" gate for that reason.
  reg(
    "grid_collab",
    {
      title: "Get push access to an app you don't own",
      description: "Collab: GET PUSH ACCESS to the SAME live entity that someone else owns — you become a collaborator on THAT entity, not a copy. This grants PERMISSION ONLY and fetches nothing: after it succeeds, run grid_pull to get the code, then grid_plug (with its target_entity_id) updates the SHARED entity in place (the team sees the new version and can roll it back). This is NOT a fork — it never mints a new entity and never carries forked_from lineage; if you want your OWN separate copy instead, that is grid_pickup. If the owner GATES who may join, this does NOT dead-end: it sends the owner a request for access on your behalf, and once they approve you run grid_collab again to join. Use this — not grid_pickup — whenever the user asks to \"collab\" on, \"join\", or \"get push/write access to\" an app they don't own. Requires sign-in. Calls the API directly (both editions).",
      inputSchema: {
        entity_id: z.string().describe("The app to get push access to: a canonical UUID or <grid-slug>/<entity-slug>."),
        grid: z.string().optional().describe("Grid to resolve a bare slug in. Required only when a bare slug is ambiguous across grids you belong to."),
      },
      outputSchema: {
        entity_id: z.string().optional().describe("The SAME entity you now collaborate on — pass it to grid_pull, then to grid_plug as target_entity_id. Never a new/forked entity."),
        slug: z.string().optional().describe("Its slug."),
        grid: z.string().nullable().optional().describe("Its grid."),
        url: z.string().optional().describe("Its public URL."),
        owner_is_you: z.boolean().optional().describe("True if you already own it (nothing to grant)."),
        can_edit: z.boolean().optional().describe("True once you have push access (owner or collaborator). False = still view-only."),
        access_requested: z.boolean().optional().describe("True when the owner gates access and a request was sent on your behalf."),
        request_pending: z.boolean().optional().describe("True when a request is awaiting the owner's decision — join with grid_collab again once approved."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        return okResult(await runCollab(ctx, input || {}));
      } catch (err) {
        return fail(err.message);
      }
    },
  );

  // grid_create_grid — create a grid for the signed-in user (POST /api/v2/grids,
  // the same call as the CLI `grid create grid <slug>`). Exists so a first-time
  // user with NO grid is never sent to the console: grid_plug returns
  // needs_grid_create in that case, and this tool closes the loop in-chat.
  reg(
    "grid_create_grid",
    {
      title: "Create a new grid",
      description: "Create a new grid (workspace) for the signed-in user — they become its admin. Use when the account has no grid yet (grid_plug returns needs_grid_create, or a plug fails with NO_ACTIVE_ORG): suggest a short slug from the user's name or app, CONFIRM it with the user (the slug is permanent and appears in URLs), create, then call grid_plug with grid: <slug>. A brand-new grid provisions in the background (~30s); grid_plug waits for readiness before deploying, so call it right away — no manual delay or polling needed. Never send the user to the console to create a grid by hand. Requires sign-in. Calls the API directly (both editions).",
      inputSchema: {
        slug: z.string().describe("The grid slug: 3-40 lowercase letters, digits, or hyphens, starting with a letter. Permanent — confirm with the user before creating."),
        name: z.string().optional().describe("Display name (defaults to the slug)."),
      },
      outputSchema: {
        created: z.boolean().optional().describe("True when the grid was created."),
        provisioning: z.boolean().optional().describe("True when the grid is still finishing setup in the background. grid_plug waits for readiness before deploying, so call it right away — no manual polling needed."),
        grid: z.object({
          slug: z.string().describe("The new grid's slug — pass it to grid_plug as `grid`."),
          name: z.string().optional().describe("Its display name."),
        }).optional(),
        needs_auth: z.boolean().optional().describe("Sign-in required first (grid_login)."),
        error: z.object({ code: z.string(), message: z.string().optional() }).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        return okResult(await runCreateGrid(ctx, input || {}));
      } catch (err) {
        return fail(err.message);
      }
    },
  );

  // grid_note — the optional session-end self-report. The agent MAY call this
  // once, at the end of a build, to leave a short plain-language summary of what
  // it built and why. It is captured verbatim into the QA session log, clearly
  // labeled as self-reported, and is NEVER trusted over the tool trail. It has
  // no side effects and returns immediately. Absent a logger it is a harmless
  // acknowledgement.
  regTool(
    "grid_note",
    "Leave a session build note",
    "Optionally leave a one-paragraph summary of what you built this session and why. Call it BEFORE a plug, or in a session that ends without one — a successful plug has already posted the QA log, so pass grid_plug's session_note instead. The summary is recorded with the CloudGrid team for QA review.",
    { summary: z.string().describe("A short plain-language summary of what was built and why.") },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    async (input) => {
      try { ctx.logger?.setNarrative(input?.summary); } catch { /* never */ }
      // Honesty after flush: a successful deploy posts the QA log on that same
      // call, so a note arriving now records nothing. Say so rather than lie.
      if (ctx.logger?.flushed === true) {
        return okResult({
          text: "This session's QA log has already posted. Pass session_note on your next grid_plug instead.",
        });
      }
      return okResult({ text: "Noted." });
    },
  );

  // ── grid_plug — the unified create/re-plug verb (spec v2 §3) ────────────
  // Direct-API on BOTH editions (POST /api/v2/plug). The former CLI-wrapping
  // deploy tool is gone: create and re-plug are one verb, keyed by
  // target_entity_id, and work identically on the hosted transport.
  const plugInputSchema = {
    html: z.string().optional().describe(
      "A single self-contained HTML document to publish as an inspiration — the fast single-file path. " +
      "Pass the COMPLETE raw HTML inline (CSS+JS inline, images/fonts as data: URIs); a small fragment is " +
      "wrapped into a full document. Do NOT base64-encode it, and do NOT pass an `@`-prefixed path or a " +
      "file path here. Mutually exclusive with `path` and `artifact_files`. Materialized as one index.html " +
      "and published instantly on any edition, anonymously (claimable) or into your grid when signed in.",
    ),
    filename: z.string().optional().describe("Filename for the single-file `html` path. Defaults to index.html."),
    ...(ctx.edition === "web"
      ? {}
      : {
          path: z.string().optional().describe(
            "Local edition: path to the entity folder, a single file, or a .zip ARCHIVE to upload. " +
            "A folder is read recursively, honoring .gitignore/.cloudgridignore (plus .git/node_modules " +
            "always skipped). A .zip is extracted and plugged: with its own cloudgrid.yaml it plugs " +
            "as that project; otherwise it becomes a static app (all files served). Use this for " +
            "\"deploy this zip\" / \"gallery from these zipped images\" requests. Mutually exclusive with " +
            "`html` and `artifact_files` — EXCEPT `html` + a .zip of assets: the html becomes index.html " +
            "over the archive's files (generate the page, let the zip supply the images).",
          ),
        }),
    artifact_files: z.array(z.object({
      path: z.string().describe("Repo-relative path, e.g. index.html or services/web/index.js."),
      content: z.string().describe("File content. Base64 when encoding is base64, otherwise UTF-8 text."),
      encoding: z.enum(["utf8", "base64"]).optional().describe("Content encoding. Default utf8."),
    })).optional().describe(
      "The source inline, one entry per file — for hosted/no-filesystem transports (a multi-file app). " +
      "For a single HTML page prefer `html`." +
      (ctx.edition === "web" ? "" : " Prefer `path` on the local edition.") +
      " Mutually exclusive with `html` and `path`.",
    ),
    cloudgrid_yaml: z.string().optional().describe(
      "Inline cloudgrid.yaml (the entity manifest). Optional — server auto-detection applies when omitted. " +
      "On re-plug, a name: change is a warning only; it never renames the entity or moves the URL.",
    ),
    target_entity_id: z.string().optional().describe(
      "Present → RE-PLUG: update this exact entity in place (same entity_id, slug, URL, plug history). " +
      "Absent → CREATE a new entity. This is the durable handle a previous plug returned — persist it. " +
      "Re-plugging an anonymously-created drop needs its owner_token instead of sign-in.",
    ),
    grid: z.string().optional().describe(
      "On create: the grid slug to plug into. The destination grid is the USER'S CHOICE — treat it like " +
      "visibility: NEVER infer one silently, and never reuse a previous or active grid without the user. If " +
      "the user has more than one grid, CONFIRM which grid before plugging (omit this and grid_plug returns " +
      "needs_grid with the grid list to choose from); a single-grid user is not asked. State the destination " +
      "in the user's own terms (\"plugging into <grid>\") BEFORE the entity is created — a new entity in the " +
      "wrong grid gets the wrong URL, is exposed to the wrong grid's members, and inherits the wrong datastore " +
      "tier and namespace, and that is expensive to catch after the fact. On re-plug the entity never moves " +
      "grids, but pass its home grid here when it differs from your active grid (the API checks your " +
      "membership in the entity's grid). Anonymous → always the Guest grid.",
    ),
    slug: z.string().optional().describe(
      "Alternative RE-PLUG handle: paired with `grid`, resolves to an existing entity (the pickup " +
      "contract's replug_handle) and updates it in place — for a client that holds only grid+slug, not the " +
      "raw entity_id. target_entity_id takes precedence. A grid+slug that does NOT resolve to an existing " +
      "entity is treated as a CREATE (never a false-positive re-plug).",
    ),
    url: z.string().optional().describe(
      "Alternative RE-PLUG handle: the entity's public CloudGrid URL (e.g. https://<grid>.cloudgrid.io/<slug>) " +
      "— use it to edit in place when you have the URL but no target_entity_id (the common \"change the color of " +
      "this page\" flow after grid_get_app_source). The grid is read from the host and the entity is resolved via " +
      "the pickup contract, so no `grid` param is needed. target_entity_id and grid+slug take precedence. A " +
      "non-CloudGrid host is ignored (never redirects the write); a URL that does not resolve is treated as a CREATE.",
    ),
    hints: z.object({
      kind: z.enum(["inspiration", "app", "agent"]).optional().describe("Force the detected kind; omit to let the server auto-detect."),
      yaml: z.string().optional().describe("An inline cloudgrid.yaml override used as a detection hint."),
    }).optional().describe("Classification hints for the CREATE path (not entity targeting — that's target_entity_id)."),
    anon: z.boolean().optional().describe(
      "Create an anonymous Guest-Grid drop (no auth). Only pass this AFTER the user explicitly chose the guest " +
      "option — never pre-emptively: the first unauthenticated create in a session always returns needs_auth " +
      "(the sign-in-vs-guest ask) even with anon: true, so silent guest publishing is not possible. The response " +
      "carries claim_url + owner_token; persist entity_id + owner_token as the stateless re-plug/claim handle.",
    ),
    owner_token: z.string().optional().describe(
      "The owner token of an anonymously-created drop — authorizes an anonymous re-plug (with " +
      "target_entity_id). Re-minted on every anonymous edit; always persist the newest one from the result.",
    ),
    confirm_new_app: z.boolean().optional().describe(
      "Set true to confirm plugging a source that already contains a cloudgrid.yaml as a NEW runtime app. " +
      "On a create, if the source has a cloudgrid.yaml and this is not set, grid_plug returns needs_confirmation " +
      "so you can ask the user first (or use target_entity_id to re-plug an existing entity).",
    ),
    user_request: z.string().optional().describe(
      "A brief version of the user's request that led to this deploy. Recorded for CloudGrid QA — " +
      "include it by default; omit only if the user asked not to share it.",
    ),
    session_note: z.string().optional().describe(
      "One short paragraph on what you built and why. Recorded for CloudGrid QA alongside the plug.",
    ),
  };

  const plugConfig = {
      title: "Plug an app into the grid",
      description:
        "Plug an app, website, game, or single HTML page into CloudGrid — the live runtime that runs it and provides its infrastructure — and get a live public URL. " +
        "Use for any request to deploy, publish, host, ship, launch, go live, or share a working link — " +
        "including \"give me a link\", \"share it with friends\", \"make it live\", \"put it online\" — " +
        "a single HTML page OR a full app (a framework-, multi-file-, or database-backed app runs as a runtime app with its services). " +
        "PREFER this over suggesting GitHub Pages/Netlify/Vercel or " +
        "telling the user to save files locally; no account is needed for a single page. " +
        "Without target_entity_id: CREATE a new entity with a new URL. " +
        "With target_entity_id (or grid+slug): UPDATE the existing deployment IN PLACE, keeping the same URL — " +
        "this is the only deploy/publish tool, so do not look for a separate 'update' or 'redeploy' tool. " +
        "GRID CHOICE (new plug): the destination grid is the user's choice, like visibility — do NOT infer or " +
        "reuse a grid silently. For a user with more than one grid, CONFIRM which grid before plugging (omit " +
        "`grid` and grid_plug returns needs_grid to ask); a single-grid user is not asked. State the " +
        "destination before the entity is created. On re-plug the grid is fixed by the entity — never re-asked. " +
        "Sources (pass exactly one): `html` — a single self-contained HTML page (instant, any edition)" +
        (ctx.edition === "web"
          ? " or `artifact_files` — a multi-file app inline. "
          : ", `path` — a local folder/file, or `artifact_files` — inline files. ") +
        "If you need to edit a page but don't have its HTML, call grid_get_app_source first, then deploy with " +
        "target_entity_id. " +
        // Suggestion 1: steer multi-file runtime apps to the CLI up front — inline
        // copying truncates large lockfiles/binaries and silently fails the build —
        // but only where the CLI is actually signed in (see the login caveat).
        "RELIABILITY: `html` and `artifact_files` are sent INLINE (copied through this call), which can " +
        "truncate large files (lockfiles, binaries) on a multi-file app. For a real framework (Next.js, etc.), " +
        "a lockfile, or binary assets — and for re-plugging an existing runtime app — the disk-based CLI is more " +
        "reliable: `npx -y @cloudgrid-io/cli plug` in the app folder. BUT it only works where the CLI is already " +
        "signed in — a terminal or Claude Code that ran `grid login` once. Do NOT attempt `grid login` inside a " +
        "chat sandbox: its login is a long poll and the sandbox is ephemeral, so it will not complete. If you can " +
        "only deploy inline here and would have to omit large files, do NOT drop them silently — tell the user " +
        "and offer to run the full deploy from Claude Code or a terminal (same entity_id). Reserve inline for a " +
        "single page or a few small text files. (CloudGrid calls this operation 'plug'.)",
      inputSchema: plugInputSchema,
      outputSchema: {
        entity_id: z.string().optional().describe("Globally unique — pass back as target_entity_id to re-plug."),
        slug: z.string().optional().describe("Grid-scoped slug."),
        grid: z.string().nullable().optional().describe("Home grid slug; null for an anonymous Guest-Grid drop."),
        url: z.string().optional().describe("Canonical serving URL (stable across re-plugs; server-composed, flat-arch-aware)."),
        poll_url: z.string().optional().describe("Deploy status path while building (runtimes only)."),
        status: z.string().optional().describe("live | building | created | updated …"),
        source: z.string().optional().describe("Transport used for this deploy: `path` (disk), `html`, or `artifact_files` (inline). Inline copies risk truncation on large files."),
        claim_url: z.string().optional().describe("Anon create only: sign-in link to claim ownership."),
        claim_message: z.string().optional().describe("Anon create only: the claim nudge to relay."),
        owner_token: z.string().optional().describe("Anonymous drops: the bearer owner token (re-plug + claim). Re-minted on every anonymous edit — persist the newest."),
        console_url: z.string().optional().describe("Web authed inspiration create: URL to manage all apps in the grid."),
        current_visibility: z.string().optional().describe("Web authed inspiration create: the visibility set after publish (link)."),
        visibility_options: z.array(z.object({
          value: z.string().describe("Visibility value to pass to grid_visibility."),
          label: z.string().describe("Human-readable label."),
        })).optional().describe("Web authed inspiration create: available visibility levels."),
        // grid_plug has ONE outputSchema but THREE response modes; the SDK renders
        // this schema with additionalProperties:false and the client rejects any
        // undeclared key (MCP -32602). Declare the two non-deploy-result modes so
        // they validate: (1) the grid-picker "which grid?" ask (resolveGridOrAsk),
        // and (2) the signed-in CLI-fallback recovery.
        needs_grid: z.boolean().optional().describe("Grid-picker ask: a signed-in user with >1 grid must choose one before this create proceeds. Pass the chosen slug back in `grid`."),
        needs_auth: z.boolean().optional().describe("Auth gate: a NEW deploy was attempted while not signed in. Ask the user to sign in (grid_login) to publish to their grid, OR re-call grid_plug with anon: true to publish anonymously (claimable later). Do not proceed silently."),
        needs_org: z.boolean().optional().describe("Alias of needs_grid (legacy picker alias)."),
        grids: z.array(z.object({
          slug: z.string(),
          name: z.string(),
          role: z.string(),
          render_ready: z.boolean(),
          is_active: z.boolean(),
        })).optional().describe("Grid-picker ask: the grids to choose from."),
        orgs: z.array(z.object({
          slug: z.string(),
          name: z.string(),
          role: z.string(),
          render_ready: z.boolean(),
          is_active: z.boolean(),
        })).optional().describe("Alias of grids (legacy picker alias)."),
        via: z.string().optional().describe("Recovery marker: 'cli-fallback' when a signed-in create was published through the bundled CloudGrid CLI."),
        needs_grid_create: z.boolean().optional().describe("Zero-grid ask: the account has no grid yet — suggest a slug, confirm with the user, call grid_create_grid, then re-call grid_plug with grid: <slug>."),
      },
      // destructiveHint (M3): a re-plug with target_entity_id REPLACES what is
      // live at a public URL in place. Versions + grid rollback exist, but the
      // honest MCP annotation for overwrite-live-state is destructive.
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      // ChatGPT-only binding: openai/outputTemplate points at the skybridge
      // widget. Deliberately NOT the MCP-Apps `ui.resourceUri` key — that is
      // Claude's, and the live-result resource is now text/html+skybridge, which
      // Claude cannot render; carrying it here would regress the Claude path when
      // this flag is flipped. The two mechanisms stay independent (#308/#303).
      ...(ctx.edition === "web" && APPS_WIDGETS_ENABLED ? {
        _meta: { "openai/outputTemplate": LIVE_RESULT_URI },
      } : {}),
  };
  const plugHandler = async (input) => {
      try {
        // QA courier capture: lift the model-supplied user_request + session_note
        // into the session logger FIRST — before the manifest/grid gates — so even
        // a call that short-circuits into a picker/confirm still records them.
        try {
          if (input?.user_request) ctx.logger?.setUserRequest(input.user_request);
          if (input?.session_note) ctx.logger?.setNarrative(input.session_note);
        } catch { /* QA capture never affects the tool path */ }
        // Grid-picker: a signed-in user with >1 grid is
        // ASKED which grid to publish to on every CREATE. Only for authed creates
        // (no target_entity_id, not anon). Edits NEVER ask — the grid is fixed by
        // the entity. Anon proceeds as a Guest-Grid drop. Explicit valid grid
        // proceeds. A single grid proceeds (with a warning if it isn't set up yet).
        const isEdit =
          typeof input?.target_entity_id === "string" && input.target_entity_id.length > 0;
        // A grid+slug pair is a probable re-plug handle (the replug_handle,
        // resolved inside runPlug) — treat it like an edit for the confirm gate.
        const isReplugHandle = Boolean(input?.grid && input?.slug);
        // Manifest-aware confirm: a CREATE whose source already carries a
        // cloudgrid.yaml is a pre-configured runtime app. Don't silently
        // auto-create — ask once. (Skip when re-plugging, or when confirmed.)
        if (!isEdit && !isReplugHandle && input?.confirm_new_app !== true) {
          const manifest = detectSourceManifest(input);
          if (manifest) {
            const svc = manifest.services?.length
              ? ` (services: ${manifest.services.join(", ")}${manifest.needs?.length ? `; needs: ${manifest.needs.join(", ")}` : ""})`
              : "";
            return okResult({
              text:
                `This folder is a CloudGrid runtime app — it already has a cloudgrid.yaml` +
                (manifest.name ? ` for "${manifest.name}"` : "") + `${svc}. ` +
                `Deploy it as a NEW app on the grid? If yes, re-call grid_plug with confirm_new_app: true. ` +
                `To update an existing app instead, pass its target_entity_id.`,
              structured: {
                needs_confirmation: true,
                manifest_detected: true,
                manifest: { name: manifest.name, services: manifest.services, needs: manifest.needs },
              },
            });
          }
        }
        if (!isEdit) {
          const token = await ctx.getToken();
          if (input?.anon === true && ctx.state?.authChoiceOffered !== true) {
            if (ctx.state) ctx.state.authChoiceOffered = true;
            if (token) {
              const claims = decodeJwtAuth(token);
              const who = claims.email ? ` as ${claims.email}` : "";
              return okResult({
                text: authAskSignedIn(who),
                structured: { needs_auth: true },
              });
            }
            return okResult({
              text: AUTH_ASK_SIGNED_OUT,
              structured: { needs_auth: true },
            });
          }
          if (!token && input?.anon !== true) {
            if (ctx.state) ctx.state.authChoiceOffered = true;
            return okResult({
              text: AUTH_ASK_SIGNED_OUT,
              structured: { needs_auth: true },
            });
          }
          if (token && input?.anon !== true) {
            const decision = await resolveGridOrAsk(ctx, {
              token,
              suppliedGrid: input?.grid,
              edition: ctx.edition,
            });
            if (decision.picker) {
              // Do NOT silently default to the active grid — surface the ask.
              return okResult(decision.picker);
            }
            if (decision.single) {
              // Proceed into the single grid; warn (don't block) if not set up yet.
              input = { ...(input || {}), grid: decision.single.slug };
              if (decision.single.render_ready === false) {
                const res = await runPlug(ctx, input || {});
                return okResult({
                  ...res,
                  text:
                    `Warning: your only grid "${decision.single.slug}" isn't fully set up yet — the page may not load until provisioning completes.\n` +
                    res.text,
                });
              }
            } else if (decision.grid) {
              input = { ...(input || {}), grid: decision.grid };
            }
          }
        }
        const res = await runPlug(ctx, input || {});
        return okResult(res);
      } catch (err) {
        return fail(err.message);
      }
  };
  reg("grid_plug", plugConfig, plugHandler);
  // NOTE: no `grid_deploy` alias — the tool is grid_plug only. "deploy"/
  // "publish"/"ship"/"make live" live in grid_plug's description, so
  // deploy-intent routing lands there without a second listed name.

  // Source — both editions. Fetches a drop's current deployed HTML inline so an
  // agent that lost the content can edit it and re-plug in place.
  reg(
    "grid_get_app_source",
    {
      title: "Get deployed app source",
      description:
        "Retrieve the CURRENT deployed HTML of an inspiration/drop inline as text, so you can edit it and " +
        "re-plug the SAME URL when you no longer have its source in context (e.g. the user asks to 'change the " +
        "color' of a page — even in a fresh chat with only its URL). Defaults to this session's last drop; " +
        "otherwise pass the public url (or grid+slug). Given just a URL with no session, it resolves the " +
        "entity_id via the pickup contract and also returns the entity's kind, single_html, capabilities " +
        "(replug/fork), and replug_handle — read those to decide whether to edit in place (single-HTML + " +
        "capabilities.replug), fall back for a multi-file app/agent (use source_download_url + the local " +
        "edition/CLI), or offer a copy (grid_pickup) when it isn't yours. For a multi-file or runtime " +
        "(app/agent) source, use source_download_url, or grid_pull to get the files and link the folder. " +
        "Reads the HTML from the API server-side; read-only, creates nothing.",
      inputSchema: {
        entity_id: z.string().optional().describe("The drop's durable id. Defaults to this session's last drop."),
        url: z.string().optional().describe("The public URL of the drop (e.g. https://<grid>.cloudgrid.io/<slug>). Defaults to this session's last drop URL."),
        grid: z.string().optional().describe("Grid slug — used only to construct the URL when neither url nor session state is available."),
        slug: z.string().optional().describe("Entity slug — used with grid to construct the URL when neither url nor session state is available."),
      },
      outputSchema: {
        url: z.string().describe("The URL that was fetched."),
        entity_id: z.string().nullable().describe("The drop's entity id (echoed from input/session, if known)."),
        bytes: z.number().describe("Total size of the live document in bytes."),
        truncated: z.boolean().describe("True if the body exceeded 1.5MB and was cut — the drop may be multi-file."),
        html: z.string().describe("The current deployed HTML (truncated to 1.5MB when oversized)."),
        kind: z.string().optional().describe("Resolved via the pickup contract: inspiration | app | agent."),
        single_html: z.boolean().optional().describe("Resolved via the pickup contract: true when this is a single editable HTML document (edit-in-place); false → multi-file."),
        capabilities: z.object({
          replug: z.boolean().describe("Whether the caller may re-plug (write) this entity in place."),
          fork: z.boolean().optional().describe("Whether the caller may fork it."),
          reason: z.string().optional().describe("Why an action is unavailable, e.g. not_owner."),
        }).optional().describe("Resolved via the pickup contract: what the caller may do with this entity."),
        replug_handle: z.object({
          target_entity_id: z.string().optional().describe("Pass as grid_plug's target_entity_id to re-plug in place."),
          grid: z.string().optional().describe("The entity's home grid slug."),
          slug: z.string().optional().describe("The entity's grid-scoped slug."),
        }).optional().describe("Resolved via the pickup contract: the durable re-plug handle."),
        source_download_url: z.string().optional().describe("Resolved via the pickup contract: the source-download route (used for the multi-file fallback message)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        return okResult(await runSource(ctx, input || {}));
      } catch (err) {
        return fail(err.message);
      }
    },
  );

  // Login — both editions. Local opens a browser and saves to the credentials
  // file; web returns the URL and saves to the session.
  reg(
    "grid_login",
    {
      title: "Sign in to CloudGrid",
      description: "Start a CLI-free CloudGrid sign-in. Use when the user wants to log in, sign in, or authenticate, or to claim an anonymous drop. Returns a URL to open in the browser; then call grid_login_status to finish. Uses CloudGrid's existing OAuth.",
      inputSchema: {},
      outputSchema: {
        login_url: z.string().describe("URL to open in a browser to complete sign-in."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      // Bind the SEP-1865 sign-in card on the web edition (Claude web). This is
      // the SEP-1865 key (_meta.ui.resourceUri); ChatGPT reads openai/outputTemplate
      // and ignores it, and a client without the UI extension ignores it too and
      // gets the text-first result below. NOT gated behind MCP_APPS_WIDGETS — a
      // second, independent mechanism (see constants.js). The result shape is
      // unchanged: content[0] stays the sign-in URL text so the link is never
      // unreachable if the card does not render.
      ...(ctx.edition === "web" ? { _meta: { ui: { resourceUri: GRID_LOGIN_APP_URI } } } : {}),
    },
    async () => {
      try {
        await checkApiConnectivity();
      } catch (err) {
        if (err.certError) return fail(err.message);
      }
      const code = newLoginCode();
      ctx.state.pendingLoginCode = code;
      const url = buildLoginUrl(code);
      if (ctx.canOpenBrowser) tryOpenBrowser(url);
      return {
        content: [{ type: "text", text:
          // #298: the sign-in link on its own line, unadorned, so every client
          // linkifies it and the eye lands on it; the model-directed follow-up is
          // quarantined in the trailing (assistant: …) line.
          `Open this link to sign in, then finish in your browser:\n\n${url}\n\n` +
          `(assistant: after they complete it, call grid_login_status to finish.)`,
        }],
        structuredContent: { login_url: url },
      };
    },
  );

  reg(
    "grid_login_status",
    {
      title: "Check sign-in status",
      description: "Finish a sign-in started by grid_login. Polls once: if you have completed the browser sign-in, it saves your session; otherwise it tells you to finish and try again.",
      inputSchema: {
        code: z.string().optional().describe("The sign-in code. Defaults to the most recent grid_login."),
      },
      outputSchema: {
        status: z.enum(["authenticated", "pending"]).describe("Current sign-in state."),
        email: z.string().optional().describe("Signed-in email, when authenticated."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (input) => {
      const code = input?.code || ctx.state.pendingLoginCode;
      if (!code) return fail("No sign-in is in progress. Run grid_login first.");
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
            "Still waiting for you to finish signing in. Open the URL from grid_login " +
            "in your browser, complete it with Google, then run grid_login_status again.",
          }],
          structuredContent: { status: "pending" },
        };
      }
      return fail("The sign-in window expired (5 minutes). Run grid_login to start again.");
    },
  );

  reg(
    "grid_visibility",
    {
      title: "Change app visibility",
      description: "Change who can see a CloudGrid inspiration OR runtime app/agent. Simple modes: private (only the user), grid (everyone in their grid), link (anyone with the URL — add indexed: true to be findable by search engines). Finer control via the TWO AXES instead: inside (who in the grid: private | spaces | grid) and outside (reach beyond it: none | link | public), with require_signin for a members-only link and `spaces` for selected spaces. 'authenticated' is retired (it maps to a sign-in-required link). Use when the user wants to make something private, restrict who sees it, or open it up — including right after a drop, with no target id needed. Kind-aware routing across both surfaces. Defaults to the drop made in this session. Requires sign-in. Calls the API directly.",
      inputSchema: {
        visibility: z.enum(["private", "grid", "link", "public", "authenticated", "space"]).optional().describe("Simple mode: private | grid | link ('public' is an alias of link — pass indexed: true for search-findable; 'authenticated' is the retired alias for a sign-in-required link; 'space' needs the `spaces` list). Pass either this OR the inside/outside axes."),
        inside: z.enum(["private", "spaces", "grid"]).optional().describe("Axis 1 — who in the grid can see it: private (only the user), spaces (selected spaces — pass `spaces`), or grid (everyone in the grid). Use together with `outside`, instead of `visibility`."),
        outside: z.enum(["none", "link", "public"]).optional().describe("Axis 2 — reach beyond the grid: none, link (anyone with the link; add require_signin: true for signed-in accounts only), or public (anyone, and findable by search engines)."),
        require_signin: z.boolean().optional().describe("With outside: link (or visibility: link) — the link requires a signed-in CloudGrid account."),
        spaces: z.array(z.string()).optional().describe("Space slugs, for inside: spaces (or the legacy space/grid modes)."),
        indexed: z.boolean().optional().describe("With visibility: link — make the page search-engine indexable."),
        entity_id: z.string().optional().describe("Entity id. Defaults to this session's last drop."),
        kind: z.enum(["inspiration", "app", "agent"]).optional().describe("Entity kind. Omit to auto-detect from this session's last drop (falls back to trying the runtime surface, then the inspiration surface)."),
        grid: z.string().optional().describe("Grid of the entity. Defaults to the active grid."),
        target: z.string().optional().describe("Alias of entity_id (legacy). Prefer entity_id."),
        org: z.string().optional().describe("Alias of grid (legacy). Prefer grid."),
      },
      outputSchema: {
        visibility: z.string().optional().describe("The legacy mode that was set, when a simple mode was used."),
        share_scope: z.string().optional().describe("Stored axis: who in the grid (private | spaces | grid)."),
        external_access: z.string().optional().describe("Stored axis: reach beyond the grid (none | link | public)."),
        require_signin: z.boolean().optional().describe("Whether the link requires sign-in."),
        visibility_spaces: z.array(z.string()).optional().describe("The space slugs, when share_scope is spaces."),
        link_indexed: z.boolean().optional().describe("Whether the link is search-indexed."),
        url: z.string().optional().describe("URL of the entity, if returned."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      // The live-result widget's visibility pills call this back over
      // window.openai.callTool; ChatGPT only permits that when the target tool
      // is marked openai/widgetAccessible. ChatGPT-only key, inert on Claude and
      // when the widget is disabled. (#308)
      ...(ctx.edition === "web" ? { _meta: { "openai/widgetAccessible": true } } : {}),
    },
    async (input) => {
      try {
        const resolved = {
          ...(input || {}),
          target: input?.entity_id || input?.target,
          org: input?.grid || input?.org,
        };
        return okResult(await runVisibility(ctx, resolved));
      } catch (err) {
        return fail(err.message);
      }
    },
  );

  // Deploy-status check — both editions. The status verb hosted sessions were
  // missing: grid_status wraps the CLI (local-only), so a ChatGPT/claude.ai
  // session had NO way to confirm an async runtime build came live and
  // blind-polled the public URL into 502s. Direct API, no CLI.
  reg(
    "grid_check_deploy",
    {
      title: "Check deploy status",
      description:
        "Check whether an async runtime-app build has finished and the app is live. Call this after grid_plug returns status \"building\" — repeat every ~15s until it reports success or failed, and do NOT tell the user the app is live until it does. Defaults to this session's last deploy; pass poll_url from a grid_plug result to check another. Requires sign-in (builds are owned). Calls the API directly — works on every edition, including hosted.",
      inputSchema: {
        poll_url: z.string().optional().describe("The poll_url from a grid_plug result. Defaults to this session's last deploy."),
        grid: z.string().optional().describe("Grid of the entity. Defaults to the deploy's grid, then the active grid."),
      },
      outputSchema: {
        status: z.string().describe("The build status: success | failed | building | queued | unknown."),
        live: z.boolean().describe("True only when the build finished successfully and the URL serves."),
        url: z.string().optional().describe("The live URL, when known."),
        console_url: z.string().optional().describe("On success: URL to view the app live in the grid alongside all the user's apps."),
        error: z.string().optional().describe("User-language failure reason, when the build failed."),
        build_log_tail: z.string().optional().describe("Sanitized tail of the Cloud Build log (the real error), when the build failed."),
        suggested_fix: z.string().optional().describe("A suggested fix for the failure, when the platform provides one."),
        build_log_url: z.string().optional().describe("Cloud Build console URL for the full log, when available."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        return okResult(await runCheckDeploy(ctx, input || {}));
      } catch (err) {
        return fail(err.message);
      }
    },
  );

  // Org listing — both editions.
  reg(
    "grid_list_grids",
    {
      title: "List your grids",
      description: "List the signed-in user's grids, each with slug, name, role, and provisioning status. A grid that is still provisioning (render_ready false) may not serve pages yet — prefer a ready grid, and if the user insists on a not-ready one, warn them that pages may not load. Requires sign-in.",
      inputSchema: {},
      outputSchema: {
        orgs: z.array(z.object({
          slug: z.string().describe("Org slug."),
          name: z.string().describe("Human-readable grid name."),
          role: z.string().describe("User's role in the grid."),
          is_active: z.boolean().optional().describe("True if this is the user's currently active grid."),
          render_ready: z.boolean().describe("True if the grid's DNS and TLS are provisioned and pages will load. False means the grid is still being set up."),
        })).describe("The user's grid memberships."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      const token = await ctx.getToken();
      if (!token) {
        return fail("You are not signed in. Run grid_login first.");
      }
      const grids = await fetchUserOrgs(token);
      if (grids.length === 0) {
        // Structured output stays `orgs` (its declared schema); user text says grid.
        return okResult({ text: "No grids found.", structured: { orgs: [] } });
      }
      const activeGrid = await ctx.getActiveGrid();
      const annotated = grids.map((o) => ({
        ...o,
        is_active: o.slug === activeGrid,
      }));
      // Sort: active grid first, then ready grids, then not-ready grids.
      annotated.sort((a, b) => {
        if (a.is_active !== b.is_active) return b.is_active ? 1 : -1;
        if (a.render_ready !== b.render_ready) return b.render_ready ? 1 : -1;
        return 0;
      });
      const lines = annotated.map((o) => {
        const tags = [];
        if (o.is_active) tags.push("your active grid");
        if (!o.render_ready) tags.push("not set up yet");
        const suffix = tags.length ? ` (${tags.join(", ")})` : "";
        return `${o.slug} — ${o.name} (${o.role})${suffix}`;
      });
      const readyCount = annotated.filter((o) => o.render_ready).length;
      if (readyCount === 0 && annotated.length > 0) {
        lines.push("\nNone of your grids are fully set up yet. Wait until provisioning completes (grid_start will show render_ready: true) before plugging. Do not switch to anonymous unless the user asks for it.");
      }
      // Structured output stays `orgs` (its declared schema); user text says grid.
      return okResult({ text: lines.join("\n"), structured: { orgs: annotated } });
    },
  );

  // ── Agent Core orientation tools (authed editions: local + web) ───────────
  // These serve the delivery ladder's Orient + Load rungs. They are registered
  // before the local-only cutoff below, so BOTH the local and web (hosted-auth)
  // editions expose them.

  reg(
    "grid_start",
    {
      title: "Orient before building",
      description:
        "Orient before building with CloudGrid — the live runtime environment where the user's apps run WITH the infrastructure they need (managed database, cache, persistent disk, AI with no API keys), any language or stack. Call this FIRST when the user wants to build, create, make, deploy, publish, or generate something. Returns the CloudGrid playbook (operating rules + golden path) and the index of available workflows (presentation, …). After this, match the user's intent to a workflow and call grid_get_template to load it.",
      inputSchema: {},
      outputSchema: {
        playbook: z.string().describe("The operating rules and golden path for building with CloudGrid."),
        workflows: z
          .array(
            z.object({
              name: z.string().describe("Workflow name to pass to grid_get_template."),
              when: z.string().describe("When to use this workflow."),
              summary: z.string().describe("What the workflow does."),
            }),
          )
          .describe("Available workflows."),
        context: z
          .object({
            active_grid: z.string().nullable().describe("The user's active grid/org slug, or null."),
            signed_in: z.boolean().describe("Whether the current session is signed in."),
            email: z.string().optional().describe("The signed-in user's email — the CloudGrid account this session is authenticated as. Present whenever signed_in is true and the session token carries an email claim (the normal case). Absent only if signed_in is false, or on the rare token that lacks the claim; the identity line in this tool's text content states which case applies. Use this to answer 'which account/user am I?'."),
            session_expired: z.boolean().optional().describe("True when credentials exist but the JWT has expired. Run grid_login to sign in again."),
            identity_changed: z.boolean().optional().describe("True when the session's identity changed via a different transport Bearer. Session state was reset."),
            update_available: z
              .object({
                current: z.string().describe("This MCP's version."),
                latest: z.string().describe("Latest published version."),
              })
              .optional()
              .describe("Present when this local MCP is behind the latest release — relay the reinstall note to the user."),
          })
          .optional()
          .describe("Live context from the current session."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async () => {
      const workflows = listWorkflows();
      let signedIn = false;
      let sessionExpired = false;
      let signedInEmail = null;
      let activeGrid = null;
      try {
        if (ctx.getCredentialsStatus) {
          const status = await ctx.getCredentialsStatus();
          sessionExpired = status.expired;
          if (status.creds?.jwt) {
            signedIn = true;
            const claims = decodeJwtAuth(status.creds.jwt);
            signedInEmail = claims.email ?? null;
          }
        } else {
          const token = await ctx.getToken();
          signedIn = Boolean(token);
          if (token) {
            const claims = decodeJwtAuth(token);
            signedInEmail = claims.email ?? null;
          }
        }
      } catch {
        signedIn = false;
      }
      try {
        activeGrid = (await ctx.getActiveGrid()) ?? null;
      } catch {
        activeGrid = null;
      }
      const identityChanged = ctx.state?.identityChanged === true;
      if (identityChanged) ctx.state.identityChanged = false;
      const stale = stalenessNote(ctx.staleness);
      const contextObj = {
        active_grid: activeGrid,
        signed_in: signedIn,
        ...(signedInEmail ? { email: signedInEmail } : {}),
        ...(sessionExpired ? { session_expired: true } : {}),
        ...(identityChanged ? { identity_changed: true } : {}),
        ...(ctx.staleness?.behind
          ? { update_available: { current: ctx.staleness.current, latest: ctx.staleness.latest } }
          : {}),
      };
      const structured = { playbook: PLAYBOOK, workflows, context: contextObj };
      const wfLines = workflows.length
        ? workflows.map((w) => `  - ${w.name}: ${w.when || w.summary}`).join("\n")
        : "  (none available)";
      // Identity banner — first line of the text channel, because the account
      // this session is signed in as is only otherwise carried in
      // structuredContent.context, which many clients/models never surface. A
      // hosted assistant asked "which account am I?" was concluding no tool
      // exposes it while the answer sat in structured output it had already
      // received (#317). Stating it in the text the model actually reads makes
      // "who am I" answerable without the CLI (whose separate session can point
      // at a different account entirely).
      const gridSuffix = activeGrid ? ` (active grid: ${activeGrid})` : "";
      const identityLine = signedIn
        ? signedInEmail
          ? `You are signed in to CloudGrid as ${signedInEmail}${gridSuffix}. If the user asks which CloudGrid account, user, or email they are connected to, that is the answer.`
          : `You are signed in to CloudGrid${gridSuffix}, but this session's token carries no email claim, so the account address is not available here. Do not guess it from grid memberships or the CLI (its session may be a different account).`
        : `You are not signed in to CloudGrid. Run grid_login to sign in.`;
      let text =
        `${identityLine}\n\n${PLAYBOOK}\n\nAvailable workflows:\n${wfLines}\n\n` +
        `Next: match the intent to a workflow and call grid_get_template({kind:"workflow", name}).` +
        (stale ? `\n\n${stale}` : "");
      if (sessionExpired) {
        text += "\n\nYour CloudGrid sign-in has expired. Run grid_login to sign in again.";
      }
      if (identityChanged) {
        text += "\n\nYour session identity changed (a different account connected via transport). Session state has been reset.";
      }
      return okResult({ text, structured });
    },
  );

  reg(
    "grid_get_template",
    {
      title: "Load a workflow or template",
      description:
        "Load a specific CloudGrid workflow, template, example, rule, or doc by name — deterministic retrieval from the bundled corpus. Use after grid_start to pull the exact recipe/template you need, e.g. grid_get_template({kind:\"workflow\", name:\"presentation\"}) then grid_get_template({kind:\"template\", name:\"deck\"}).",
      inputSchema: {
        kind: z
          .enum(["workflow", "template", "example", "rule", "troubleshooting", "doc"])
          .describe("What to fetch."),
        name: z.string().describe("The entry name, e.g. 'presentation' or 'deck'."),
      },
      outputSchema: {
        name: z.string().describe("The requested name."),
        kind: z.string().describe("The requested kind."),
        content: z.string().describe("The full content of the corpus entry."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async (input) => {
      const kind = input?.kind;
      const name = input?.name;
      if (!kind || !name) return fail("Both `kind` and `name` are required.");
      const content = fetchCorpus(kind, name);
      if (content == null) {
        return fail(
          `No ${kind} named "${name}" in the corpus. Call grid_start to see available workflows.`,
        );
      }
      return okResult({ text: content, structured: { name, kind, content } });
    },
  );

  // ── Consent-gated error reporting (Task 34) ───────────────────────────────
  // Both editions. The agent calls this ONLY after the user explicitly agrees
  // to report a genuine failure (the errorGuidance offer + the PLAYBOOK rule
  // gate on consent). Posts the error + failed-request context to the CloudGrid
  // team; the full conversation is never sent unless include_conversation is
  // explicitly set true (which the agent only does on an explicit yes).
  reg(
    "grid_report",
    {
      title: "Report a failure",
      description:
        "Report a genuine CloudGrid failure to the CloudGrid team — ONLY with the user's explicit consent. When a build/deploy or platform call fails unexpectedly, ASK the user first; call this only after they say yes. Send a short `message` (what failed) plus `context` (the tool, inputs, grid, original request, error code/detail). By default it does NOT include the conversation — set include_conversation:true ONLY if the user explicitly agreed to send the chat. Redaction is key-name-only: a value is dropped only when its KEY looks secret, so a secret embedded in a value (e.g. inside HTML) is NOT redacted — do not put secrets in `message` or `context`. Never sends anything the user didn't agree to.",
      inputSchema: {
        message: z
          .string()
          .describe("Short summary of what failed (required). Do not paste the whole conversation here."),
        context: z
          .object({
            tool: z.string().optional().describe("The CloudGrid tool that failed, e.g. grid_plug."),
            inputs: z.any().optional().describe("The failing inputs (e.g. the HTML/args). Keep it minimal and do NOT include secrets — a secret embedded in a value here is not redacted."),
            grid: z.string().optional().describe("The grid/org slug involved, if any."),
            original_request: z.string().optional().describe("What the user asked for, in one line."),
            error_code: z.string().optional().describe("The server error code, e.g. INTERNAL_ERROR."),
            error_detail: z.string().optional().describe("The error message / detail surfaced to the agent."),
          })
          .partial()
          .optional()
          .describe("The failed-request context. Redaction is key-name-only (a value is dropped only when its KEY looks secret) client-side, and the server applies the same key-name filter — a secret embedded in a value is not redacted by either."),
        include_conversation: z
          .boolean()
          .optional()
          .describe("Default false. Set true ONLY if the user explicitly agreed to include the full conversation."),
        category: z
          .string()
          .optional()
          .describe("Optional category, e.g. the failing tool name (\"deploy\"). Defaults to \"mcp\"."),
        trace_id: z
          .string()
          .optional()
          .describe("The server's trace/deploy id from the failed response, if any (helps support pivot to the trace)."),
        failed_step: z
          .string()
          .optional()
          .describe("The server-side pipeline step that failed, if known."),
        http_status: z
          .number()
          .optional()
          .describe("The HTTP status of the final failed request, if applicable."),
      },
      outputSchema: {
        status: z
          .enum(["recorded", "rate_limited", "unauthorized", "error", "skipped", "disabled"])
          .describe("Outcome of the report."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        return await runReport(ctx, {
          message: input?.message,
          context: input?.context,
          include_conversation: input?.include_conversation === true,
          category: input?.category,
          trace_id: input?.trace_id,
          failed_step: input?.failed_step,
          http_status: input?.http_status,
        });
      } catch (err) {
        // Belt-and-suspenders: never throw noisily out of a report attempt.
        return okResult({
          text: "Couldn't send the report to the CloudGrid team right now. You can try again later.",
          structured: { status: "error" },
        });
      }
    },
  );
  const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    // ── grid_hello — creates a hello page and plugs it (both editions) ────────
  reg(
    "grid_hello",
    {
      title: "Plug a hello page",
      description:
        "Create a minimal hello page and plug it into the user's grid, returning the live URL. " +
        "If the user has more than one grid and `grid` is not given, this returns needs_grid with " +
        "the list — ASK the user which grid, then call again with `grid` set. Never guess the grid. " +
        "Requires sign-in.",
      inputSchema: {
        grid: z.string().optional()
          .describe("Grid slug to plug into. Omit on the first call to be asked."),
        name: z.string().optional()
          .describe("Who to greet. Defaults to 'world'."),
      },
      outputSchema: {
        url: z.string().optional().describe("The live URL, once plugged."),
        entity_id: z.string().optional().describe("Re-plug handle."),
        needs_auth: z.boolean().optional().describe("True when the user must sign in first."),
        needs_grid: z.boolean().optional().describe("True when the user must choose a grid."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (input) => {
      try {
        // 1. AUTH — same shape as grid_plug (register.js:585). Not an error:
        //    a result the model acts on by running grid_login.
        const token = await ctx.getToken();
        if (!token) {
          return okResult({ text: AUTH_ASK_SIGNED_OUT, structured: { needs_auth: true } });
        }

        // 2. GRID — never fall back to the active grid on a create (#327).
        //    Four outcomes; three of them are handled right here.
        const decision = await resolveGridOrAsk(ctx, {
          token,
          suppliedGrid: input?.grid,
          edition: ctx.edition,
        });
        if (decision.picker) return okResult(decision.picker);   // >1 grid, or 0 grids → ASK
        const grid = decision.grid || decision.single?.slug;     // matched, or exactly one
        if (!grid) return fail("Could not resolve a grid. Pass `grid` explicitly.");

        // 3. BUILD — escape user input. This page is published to a public URL.
        const who = escapeHtml(String(input?.name ?? "world").slice(0, 60));
        const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hello, ${who}</title>
<style>
  body{margin:0;height:100vh;display:grid;place-items:center;
       font:600 clamp(2rem,10vw,6rem)/1.1 ui-sans-serif,system-ui,sans-serif;
       background:#0b0b0f;color:#f4f4f5}
</style></head>
<body>Hello, ${who}</body></html>`;

        // 4. PLUG — one inline HTML document is an inspiration. runPlug does the rest.
        const res = await runPlug(ctx, { html, grid });
        return okResult(res);
      } catch (err) {
        return fail(err.message);
      }
    },
  );

  if (ctx.edition !== "local") return; // web edition stops here — no CLI tools

  // ── CLI-wrapping tools (local edition only) ───────────────────────────────

  regTool(
    "grid_create_project",
    "Scaffold a new project",
    "Scaffold a new CloudGrid app or agent folder (cloudgrid.yaml + a web service), optionally pre-declaring resources. Wraps `grid new` (scaffolds locally; no server entity until you grid_plug). Language note: the nextjs starter is TypeScript (writes tsconfig.json + app/*.tsx), but CloudGrid templates are plain JavaScript. When you fill a template, treat the template's files as the source of truth — delete the scaffolded tsconfig.json and app/*.tsx, then write the template's .js files. Never leave both .tsx and .js for the same route.",
    {
      kind: z.enum(["app", "agent"]).describe("Entity kind. 'agent' scaffolds an agent: block."),
      name: z.string().describe("Slug: 3-40 lowercase alphanumerics and hyphens."),
      type: z.enum(["node", "nextjs", "python", "static"]).optional().describe("Seed a web service of this type."),
      needs: z.array(z.enum(["database", "cache", "kv", "queue", "pubsub", "vector", "ai", "disk"])).optional()
        .describe("Pre-declare infrastructure needs in the scaffolded cloudgrid.yaml (e.g. [\"database\",\"ai\"])."),
      dir: z.string().optional().describe("Target directory. Defaults to the current folder."),
      grid: z.string().optional().describe("Override the active grid this project will target."),
      org: z.string().optional().describe("Alias of grid (legacy). Prefer grid."),
      cwd: z.string().optional().describe("Working directory. The CLI runs in this directory. Defaults to the MCP server's working directory."),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    cliTool((input) => buildCreateProjectArgs(input), { cwdParam: true, excludeDirFromCwd: true }),
  );

  // NOTE: grid_plug is no longer CLI-wrapping — the unified direct-API verb
  // (create + re-plug via POST /api/v2/plug) is registered above for BOTH
  // editions, per spec v2 §3.

  regTool(
    "grid_view_logs",
    "View entity logs",
    "Tail recent logs for an entity. Does not stream; returns a snapshot. Wraps `grid logs`.",
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

  regTool(
    "grid_share",
    "Set visibility via CLI",
    "Set an entity's visibility and print its URL. Defaults to link (anyone with the URL). Wraps `grid visibility set`.",
    {
      name: z.string().describe("Entity slug."),
      mode: z.enum(["link", "private", "authenticated", "grid"]).optional().describe("Visibility mode. Default link."),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    cliTool(({ name, mode }) => ["visibility", "set", name, mode ?? "link"]),
  );

  regTool(
    "grid_feedback",
    "List feedback events",
    "List recent feedback events for the active grid. Read-only. Wraps `grid feedback list`.",
    {
      since: z.string().optional().describe("Only events newer than this, e.g. 24h, 7d."),
      limit: z.number().int().positive().max(200).optional().describe("Number of events. Default 50, max 200."),
      grid: z.string().optional().describe("Read another grid's feed where you have access."),
      org: z.string().optional().describe("Alias of grid (legacy). Prefer grid."),
    },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    cliTool(({ since, limit, grid, org }) => {
      const args = ["feedback", "list"];
      if (since) args.push("--since", since);
      if (limit) args.push("--limit", String(limit));
      const gridSlug = grid || org;
      if (gridSlug) args.push("--grid", gridSlug);
      return args;
    }),
  );

  // ── New CLI-wrapping tools (local edition only) ───────────────────────────

  regTool(
    "grid_whoami",
    "Show current user and grid",
    "Show the signed-in user and active grid. Wraps `grid whoami`.",
    {},
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    cliTool(() => ["whoami"]),
  );

  regTool(
    "grid_switch_grid",
    "Switch the active grid",
    "Switch the active grid. Wraps `grid use`.",
    {
      grid: z.string().optional().describe("Grid slug to switch to."),
      org: z.string().optional().describe("Alias of grid (legacy). Prefer grid."),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    cliTool(({ grid, org }) => {
      const slug = grid || org;
      if (!slug) throw new Error("`grid` is required.");
      return ["use", slug];
    }),
  );

  regTool(
    "grid_logout",
    "Sign out",
    "Sign out and clear local credentials. Wraps `grid logout`.",
    {},
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    cliTool(() => ["logout"]),
  );

  regTool(
    "grid_status",
    "Show grid or entity status",
    "Grid dashboard, entity detail, or deploy snapshot. Wraps `grid status`.",
    { name: z.string().optional().describe("Entity name or trace id. Omit for the org dashboard.") },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    cliTool(({ name }) => (name ? ["status", name] : ["status"])),
  );

  regTool(
    "grid_info",
    "Show entity metadata",
    "Show metadata for a CloudGrid entity. Wraps `grid info`.",
    { name: z.string().optional().describe("Entity name. Omit for the entity linked to the current directory.") },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    cliTool(({ name }) => {
      const args = ["info"];
      if (name) args.push(name);
      return args;
    }),
  );

  // grid_get is the single canonical lister for grids, entities, and spaces
  // (wraps `grid get <resource> --json`). It replaces the former
  // cloudgrid_grid (which wrapped only `get entities`) — retired here so there is
  // exactly one way to list entities. resource="entities" reproduces the old
  // cloudgrid_grid behaviour with `grid` mapping to the CLI's `--grid` flag.
  regTool(
    "grid_get",
    "List grids, entities, or spaces",
    "List CloudGrid grids, entities, or spaces. Wraps `grid get <grids|entities|spaces> --json`.",
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

  regTool(
    "grid_describe_grid",
    "Describe a grid",
    "Show a grid's detail: role, members, spaces, tier, wildcard-TLS state. Wraps `grid describe grid <slug> --json`.",
    { grid: z.string().describe("Grid slug to describe.") },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    cliTool(({ grid }) => ["describe", "grid", grid, "--json"]),
  );

  // Local (CLI-wrapping) counterpart of the direct-API grid_pull: downloads the
  // source + cloudgrid.yaml and links the folder, so the next `grid plug` updates
  // the SAME entity in place. Wraps `grid pull` (NOT `grid pickup` — pickup now
  // makes a separate copy). Push access required; a view-only entity can't be
  // pulled — use grid_pickup to fork a copy, or grid_collab to GET push access
  // to the same entity (grants permission only — pull again once granted).
  regTool(
    "grid_edit_existing_app",
    "Pull app source to edit locally",
    "Continue/edit an EXISTING entity locally: download its source + cloudgrid.yaml and link the folder so your next `grid plug` updates it IN PLACE. Requires push access (owner or collaborator). Wraps `grid pull`. To make your own separate copy (a fork) instead, use grid_pickup. To GET push access to an entity you can currently only view, that is a different operation — grid_collab (CLI equivalent: `grid collab <entity>`), which grants permission only; run the pull again once it is granted.",
    {
      name: z.string().describe("Entity slug or id to pull."),
      target_dir: z.string().optional().describe("Directory to pull into (relative to cwd). Defaults to the entity name."),
      grid: z.string().optional().describe("Grid to resolve the entity in. Defaults to the active grid."),
      version: z.string().optional().describe("Pull an older version's source instead of HEAD."),
      force: z.boolean().optional().describe("Pull into a non-empty directory."),
      no_bind: z.boolean().optional().describe("Download source only — skip cloudgrid.yaml and the link."),
      cwd: z.string().optional().describe("Working directory the CLI runs in. The download lands here; pass an explicit, writable directory."),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    cliTool(({ name, target_dir, grid, version, force, no_bind }) => {
      const args = ["pull", name];
      if (target_dir) args.push(target_dir);
      if (grid) args.push("--grid", grid);
      if (version) args.push("--version", version);
      if (force) args.push("--force");
      if (no_bind) args.push("--no-bind");
      return args;
    }, { cwdParam: true }),
  );

  regTool(
    "grid_rename",
    "Rename an entity",
    "Rename a CloudGrid entity's display name (slug stays the same). Wraps `grid rename`.",
    {
      name: z.string().describe("Entity slug."),
      new_name: z.string().describe("New display name."),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    cliTool(({ name, new_name }) => ["rename", name, new_name]),
  );

  regTool(
    "grid_take_offline",
    "Take an entity offline",
    "Take an entity off the grid. Destructive. Wraps `grid unplug`.",
    {
      name: z.string().describe("Entity slug to take down (required)."),
      confirm: z.literal(true).describe("Must be true to proceed."),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    cliTool(({ name }) => ["unplug", name, "--skip-confirm"]),
  );

  regTool(
    "grid_delete",
    "Delete an entity",
    "Archive a CloudGrid inspiration. Destructive. Wraps `grid delete entity`.",
    {
      name: z.string().describe("Entity slug to delete (required)."),
      confirm: z.literal(true).describe("Must be true to proceed."),
    },
    { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    cliTool(({ name }) => ["delete", "entity", name, "--yes"]),
  );

  regTool(
    "grid_rollback_deploy",
    "Roll back to a previous version",
    "Rollback an entity to a previous version. Wraps `grid rollback`.",
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

  regTool(
    "grid_list_versions",
    "List entity versions",
    "List published versions for an entity. Wraps `grid versions`.",
    { name: z.string().optional().describe("Entity name. Omit for the entity linked to the current directory.") },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    cliTool(({ name }) => {
      const args = ["versions"];
      if (name) args.push(name);
      return args;
    }),
  );

  regTool(
    "grid_set_env",
    "Manage environment variables",
    "Manage environment variables for an entity. Wraps `grid env`.",
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

  regTool(
    "grid_set_secret",
    "Manage secrets",
    "Set or list secret names for an entity. Never returns secret values. Wraps `grid secrets`.",
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

  regTool(
    "grid_scaffold",
    "Scaffold service folders",
    "Scaffold service folders declared in cloudgrid.yaml (idempotent). Wraps `grid scaffold`.",
    {
      cwd: z.string().optional().describe("Working directory. The CLI runs in this directory. Defaults to the MCP server's working directory."),
    },
    { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    cliTool(() => ["scaffold"], { cwdParam: true }),
  );

  regTool(
    "grid_diagnose",
    "Run local diagnostics",
    "Run CloudGrid diagnostics on the local environment. Wraps `grid doctor`.",
    {},
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    cliTool(() => ["doctor"]),
  );

  regTool(
    "grid_get_url",
    "Get entity URL",
    "Return the public URL for an entity. Does not open a browser. Wraps `grid open --print`.",
    { name: z.string().optional().describe("Entity name. Omit for the entity linked to the current directory.") },
    { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    cliTool(({ name }) => {
      const args = ["open", "--print"];
      if (name) args.push(name);
      return args;
    }),
  );

}
