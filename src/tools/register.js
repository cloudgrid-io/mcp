// Tool registration: registerTools(server, ctx) wires every tool onto the MCP
// server for the current edition.
// Extracted verbatim from src/tools.js (refactor: split tools.js into modules).

import { z } from "zod";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { newLoginCode, buildLoginUrl, pollStatusOnce, checkApiConnectivity, decodeJwt as decodeJwtAuth } from "../auth.js";
import { ORIENTATION, fetchCorpus, listWorkflows } from "../playbook.js";
import {
  CHATGPT_WIDGET_MIME,
  LIVE_RESULT_URI,
  GRID_PICKER_URI,
  LIVE_RESULT_HTML,
  GRID_PICKER_HTML,
  previewOrigin,
  previewUrlFor,
  PREVIEW_META_KEY,
} from "./constants.js";
import { fail, okResult, signInHow } from "./util.js";
import { cliTool, tryOpenBrowser } from "./cli.js";
import {
  fetchUserOrgs,
  resolveGridOrAsk,
  detectSourceManifest,
  runReport,
  runNote,
  runPull,
  runCollab,
  runDelete,
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
// comes first. Since #395 there is one option only — sign in (grid_login); there
// is no guest publish. The model-directed steps (which tool to call,
// do not choose, wait) are quarantined in a trailing (assistant: …) line so the
// model does not read internal directions aloud. §23 voice: plain, no emoji, no
// exclamation; say "plug" and "grid". The sign-in URL itself lands on its own
// line later, from grid_login. No structural change — every caller still returns
// { needs_auth: true }.
// Escape untrusted text before it is interpolated into a page we publish at a
// public URL. `&` MUST be replaced first, or the later replacements' own
// ampersands get double-escaped. Both grid_hello sinks are element text
// (<title> RCDATA and <body>), which this covers.
const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
   .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Publishing requires sign-in (#395): every entity must be owned by a real
// account so the publisher is known. There is NO guest option — offering a path
// the server will not honour strands the model (it asks, the user picks guest,
// the next call fails). This is the same reasoning grid_hello applies at
// register.js's signed-out branch after mcp#336: say ONLY what the tool can
// actually do, and route to the one recovery action (grid_login). §23 voice:
// plain, no emoji, no exclamation; the model-directed step is quarantined in the
// trailing (assistant: …) line so it is not read aloud.
function authAskSignedOut(ctx) {
  return ctx?.edition === "web"
    ? "Plugging to a grid needs an account, so the page is saved to the user's CloudGrid " +
        "account and belongs to them. Sign in to CloudGrid when your AI tool asks, then plug again.\n\n" +
        "(assistant: ask the user to sign in through the CloudGrid connector; if no sign-in " +
        "prompt appears, ask them to reconnect it. Then retry grid_plug. Do not offer any " +
        "sign-in-free path.)"
    : "Plugging to a grid needs an account, so the page is saved to the user's CloudGrid " +
        "account and belongs to them. Call grid_login to sign in, then re-call grid_plug.\n\n" +
        "(assistant: call grid_login now; after they finish, retry grid_plug. Do not offer " +
        "any sign-in-free path. Stop and wait for the sign-in to complete.)";
}

// ── Strict tool inputs (#400) ──────────────────────────────────────────────
// Every tool's input is a z.strictObject, so `tools/list` advertises
// `additionalProperties: false` under zod 3 AND zod 4. The SDK renders a tool
// input in zod 4's "input" mode, where a plain z.object (which strips unknown
// keys rather than rejecting them) gets no `additionalProperties` at all; only a
// strict object keeps `false`. A raw shape is wrapped here; an empty shape is
// left alone (the SDK advertises it as `{type: "object", properties: {}}`, as
// before). Objects nested inside an input use z.strictObject at their own site.
// test/tools-list-contract.test.mjs holds the emitted contract.
export function strictInput(schema) {
  if (!schema || typeof schema !== "object" || schema._def || schema._zod) return schema;
  return Object.keys(schema).length > 0 ? z.strictObject(schema) : schema;
}

// ── live-result card (#434) ──────────────────────────────────────────────────
// Tool `_meta` that binds the card: the MCP Apps key plus ChatGPT's alias.
export const LIVE_RESULT_TOOL_META = {
  ui: { resourceUri: LIVE_RESULT_URI },
  "openai/outputTemplate": LIVE_RESULT_URI,
};

// Resource `_meta` for the card. Deny-by-default CSP, stated explicitly; the
// only origin it ever admits is the configured preview origin, as a frame
// source. clipboardWrite backs Copy link (the card falls back to a selection
// copy when a host does not grant it).
export function liveResultResourceMeta() {
  const origin = previewOrigin();
  return {
    ui: {
      csp: {
        connectDomains: [],
        resourceDomains: [],
        frameDomains: origin ? [origin] : [],
      },
      permissions: { clipboardWrite: {} },
      prefersBorder: false,
    },
  };
}

// Add the preview URL to a plug result's `_meta` (web edition, preview origin
// configured, result names an entity). The text and structuredContent are left
// exactly as runPlug built them, so a client with no UI loses nothing.
export function withPreviewMeta(ctx, res) {
  if (ctx?.edition !== "web") return res;
  const url = previewUrlFor(res?.structured?.entity_id);
  if (!url) return res;
  return { ...res, meta: { ...(res.meta || {}), [PREVIEW_META_KEY]: url } };
}

// ── Registration ───────────────────────────────────────────────────────────────
// Registers the tools onto `server`. ctx.edition decides whether the CLI-wrapping
// tools are included (they need a local machine).
// The structured next step on a result whose build is still running (#503).
// Some hosts show the model only structuredContent, so the step the text names
// is carried here too. Declared on every tool that can return it: the output
// schema is advertised with additionalProperties false.
const buildNextStep = () =>
  z.object({
    tool: z.string().describe("The tool that reports when the build finishes."),
    args: z.object({
      entity_id: z.string().optional().describe("The app's entity_id."),
      grid: z.string().optional().describe("The app's grid slug."),
      poll_url: z.string().optional().describe("The build's status path, when there is one."),
    }).describe("The arguments for that tool."),
    every_seconds: z.number().describe("Seconds between status checks."),
  }).optional().describe("Present while the build is still running: the status tool, its arguments, and the interval between checks.");

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
  //
  // annotations.title is derived here from the tool's top-level title, so the
  // two never drift: the Claude directory listing reads annotations.title, and
  // other clients read the top-level title (cloudgrid-io/mcp#496).
  const withTitle = (title, annotations) => ({ ...annotations, title });

  const reg = (name, config, handler) => {
    server.registerTool(
      name,
      { ...config, inputSchema: strictInput(config.inputSchema), annotations: withTitle(config.title, config.annotations) },
      withCapture(name, handler),
    );
  };

  const regTool = (name, title, description, schema, annotations, handler) => {
    server.registerTool(
      name,
      { title, description, inputSchema: strictInput(schema), annotations: withTitle(title, annotations) },
      withCapture(name, handler),
    );
  };

  // ── Widget resources (web edition, ChatGPT Apps SDK) ──────────────────────
  if (ctx.edition === "web") {
    // live-result MCP App (#434): the app card after a plug, for Claude and
    // ChatGPT. Registered via the ext-apps helper (MIME RESOURCE_MIME_TYPE,
    // `text/html;profile=mcp-app`, the type both hosts render). The CSP is
    // declared explicitly: it admits NO network, resource, or frame origin,
    // except the one configured preview origin as a frame source when
    // MCP_PREVIEW_ORIGIN is set. The card calls tools only over the host bridge
    // (grid_visibility, grid_check_deploy), which needs no CSP entry.
    registerAppResource(server, "cloudgrid-live-result", LIVE_RESULT_URI, {
      description: "App card after a plug: the live URL with Open, Copy link, Update, and who can open it.",
    }, async () => ({
      contents: [{
        uri: LIVE_RESULT_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: LIVE_RESULT_HTML,
        _meta: liveResultResourceMeta(),
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
      description: "Pick up an app: copies any app the user can see into one of their grids as a NEW, separate entity (a fork, like a git fork). The copy records lineage back to the source and does not carry the source's secrets (the copy sets its own). Plugging the copy updates only the copy; the original is not changed. This is a fork, not a collab: it grants no access to the original entity, and it does not edit the original in place. Serves requests to copy, fork, remix, or make my own version of an app. Requires sign-in. Returns the copy's entity_id, slug, kind, grid, and lineage.",
      inputSchema: {
        entity_id: z.string().describe("The source app to copy: a canonical UUID or <grid-slug>/<entity-slug>."),
        grid: z.string().optional().describe("Grid to create your copy in. Required only when you belong to more than one grid."),
        id: z.string().optional().describe("Legacy alias of entity_id."),
        into_org_slug: z.string().optional().describe("Legacy alias of grid."),
        name: z.string().optional().describe("Slug for your copy. Omit to derive one from the source."),
        source_version_id: z.string().optional().describe("Copy an older version instead of HEAD, e.g. v_a1b2c3d."),
      },
      outputSchema: {
        entity_id: z.string().nullable().describe("Your copy's entity id: the target_entity_id that updates the copy in place."),
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
      description: "Pull an app to continue or edit it IN PLACE, like `git clone` of the SAME entity: the next plug with its target_entity_id updates that entity, and the team sees the new version. Requires push access (owner or collaborator). For an app the caller can only view, it returns can_edit: false and the options that remain (a separate copy, or push access to the same entity), and changes nothing. A drop plugged outside any grid is claimed into a chosen grid with its `claim_token`; only the drop's owner can claim it. Serves requests to continue, edit, or work on an app the user owns or collaborates on. Requires sign-in. Returns the entity_id, slug, grid, url, and whether the caller can edit it.",
      inputSchema: {
        entity_id: z.string().optional().describe("The entity id to pull. Defaults to the drop made outside a grid in this session, if any."),
        grid: z.string().optional().describe("Grid to resolve a bare slug in. Required only when you belong to more than one grid."),
        claim_token: z.string().optional().describe("Claiming a drop plugged outside a grid: its owner token, which claims that drop into your grid. Only the drop's owner can claim it."),
        claim_url: z.string().optional().describe("Alternative to claim_token: the claim_url from the plug result; the token is read from it."),
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
        needs_grid_create: z.boolean().optional().describe("True when the account has no grid yet; the text names the step that creates one."),
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
      description: "Collab: grants the signed-in user PUSH ACCESS to the SAME live entity that someone else owns, as a collaborator on that entity, not a copy. It grants permission only and fetches nothing: no code is downloaded, no new entity is created, and no forked_from lineage is recorded. Plugs to the shared entity update it in place (the team sees the new version and can roll it back). When the owner gates who may join, it sends the owner an access request on the user's behalf, and access starts as soon as they approve. Serves requests to collab on, join, or get push or write access to an app the user does not own. Requires sign-in. Returns the entity_id, url, can_edit, and whether a request is pending.",
      inputSchema: {
        entity_id: z.string().describe("The app to get push access to: a canonical UUID or <grid-slug>/<entity-slug>."),
        grid: z.string().optional().describe("Grid to resolve a bare slug in. Required only when a bare slug is ambiguous across grids you belong to."),
      },
      outputSchema: {
        entity_id: z.string().optional().describe("The SAME entity you now collaborate on (not a new or forked entity)."),
        slug: z.string().optional().describe("Its slug."),
        grid: z.string().nullable().optional().describe("Its grid."),
        url: z.string().optional().describe("Its public URL."),
        owner_is_you: z.boolean().optional().describe("True if you already own it (nothing to grant)."),
        can_edit: z.boolean().optional().describe("True once you have push access (owner or collaborator). False = still view-only."),
        access_requested: z.boolean().optional().describe("True when the owner gates access and a request was sent on your behalf."),
        request_pending: z.boolean().optional().describe("True when a request is awaiting the owner's decision; access is live as soon as they approve (no re-run needed)."),
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
      description: "Create a new grid (the workspace the user's apps live in) for the signed-in user, who becomes its admin. Serves an account with no grid yet (a plug result of needs_grid_create, or a NO_ACTIVE_ORG failure) and requests to create a new grid or workspace. The slug is permanent and appears in app URLs. A new grid finishes setup in the background in about 30 seconds, and a plug into it waits for that setup. Requires sign-in. Returns the grid's slug and name, and whether setup is still running.",
      inputSchema: {
        slug: z.string().describe("The grid slug: 3-40 lowercase letters, digits, or hyphens, starting with a letter. Permanent: it appears in every app URL in the grid."),
        name: z.string().optional().describe("Display name (defaults to the slug)."),
      },
      outputSchema: {
        created: z.boolean().optional().describe("True when the grid was created."),
        provisioning: z.boolean().optional().describe("True when the grid is still finishing setup in the background. A plug into it waits for setup to finish."),
        grid: z.object({
          slug: z.string().describe("The new grid's slug, the `grid` value for a plug into it."),
          name: z.string().optional().describe("Its display name."),
        }).optional(),
        needs_auth: z.boolean().optional().describe("True when the user is not signed in; nothing was created."),
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

  // grid_note — a build note the user asks to send to the CloudGrid team.
  // Hosted (#433): the ONLY way session text leaves the hosted server. It POSTs
  // the note to the CloudGrid API's feedback endpoint under the user's bearer
  // (runNote) — there is no session-log post on hosted and no Slack sink in
  // play. Signed-out → needs_auth; a failed POST is reported as a failure.
  // Local (stdio): unchanged — the note rides the optional QA session log, which
  // the machine's operator switches on with a webhook and which flushes on its
  // own triggers. Absent a logger it is a harmless acknowledgement.
  if (ctx.edition === "web") {
    reg(
      "grid_note",
      {
        title: "Send a build note to the CloudGrid team",
        description:
          "Send a short build note to the CloudGrid team, at the user's request. It is filed with the CloudGrid API under the signed-in account. What is sent: the note text, the grid slug, and the client name, and nothing else from the conversation: no tool-call trail, no file contents, no email (the account is known from the sign-in). Requires sign-in: when signed out it returns needs_auth and sends nothing. In a hosted session, this tool and the failure report are the only ways conversation text reaches CloudGrid. Returns whether the note was recorded.",
        inputSchema: { summary: z.string().describe("A short plain-language note on what was built and why. This text is sent.") },
        outputSchema: {
          status: z.enum(["recorded", "rate_limited", "unauthorized", "error", "skipped"]).describe("recorded = the team received it; anything else = nothing was sent, and the text says why."),
          needs_auth: z.boolean().optional().describe("True when the user is not signed in; nothing was sent."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      },
      async (input) => {
        try {
          return await runNote(ctx, { summary: input?.summary });
        } catch (err) {
          return okResult({
            text: `Couldn't send the note: ${err.message}. Nothing was sent.`,
            structured: { status: "error" },
          });
        }
      },
    );
  } else {
    regTool(
      "grid_note",
      "Leave a session build note",
      "Record a one-paragraph summary of what was built this session and why, for the local edition's optional QA session log, which the CloudGrid team reads. A successful plug posts the log on that same call, so a note sent after it is not recorded (the plug's session_note field carries a note on the plug itself). The log is dark unless the operator of this machine has set CLOUDGRID_QA_SLACK_WEBHOOK. Returns a short acknowledgement.",
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
  }

  // ── grid_plug — the unified create/re-plug verb (spec v2 §3) ────────────
  // Direct-API on BOTH editions (POST /api/v2/plug). The former CLI-wrapping
  // deploy tool is gone: create and re-plug are one verb, keyed by
  // target_entity_id, and work identically on the hosted transport.
  const plugInputSchema = {
    html: z.string().optional().describe(
      "A single self-contained HTML document to publish as an inspiration: the fast single-file path, " +
      "live at a public URL in seconds. Pass the COMPLETE raw HTML inline (CSS+JS inline, images/fonts as " +
      "data: URIs); a small fragment is wrapped into a full document. Raw text, not base64, and not an " +
      "`@`-prefixed path or a file path. Mutually exclusive with `path` and `artifact_files`. " +
      "Materialized as one index.html in the signed-in user's grid.",
    ),
    filename: z.string().optional().describe("Filename for the single-file `html` path. Defaults to index.html."),
    ...(ctx.edition === "web"
      ? {}
      : {
          path: z.string().optional().describe(
            "Local edition: path to the entity folder, a single file, or a .zip ARCHIVE to upload. " +
            "A folder is read recursively, honoring .gitignore/.cloudgridignore (.git and node_modules " +
            "are skipped). A .zip is extracted and plugged: with its own cloudgrid.yaml it plugs " +
            "as that project; otherwise it becomes a static app (all files served). Serves " +
            "\"deploy this zip\" / \"gallery from these zipped images\" requests. Mutually exclusive with " +
            "`html` and `artifact_files`, EXCEPT `html` + a .zip of assets: the html becomes index.html " +
            "over the archive's files (generate the page, let the zip supply the images).",
          ),
        }),
    artifact_files: z.array(z.strictObject({
      path: z.string().describe("Repo-relative path, e.g. index.html or services/web/index.js."),
      content: z.string().describe("File content. Base64 when encoding is base64, otherwise UTF-8 text."),
      encoding: z.enum(["utf8", "base64"]).optional().describe("Content encoding. Default utf8."),
    })).optional().describe(
      "The source inline, one entry per file, for hosted/no-filesystem transports (a multi-file app). " +
      "A single HTML page fits `html`." +
      (ctx.edition === "web" ? "" : " On the local edition `path` reads the folder from disk.") +
      " Sent INLINE (copied through this call), so large files (lockfiles, binaries) can truncate and fail the build; " +
      "for a real framework, a lockfile, or binary assets, the disk-based CLI (`npx -y @cloudgrid-io/cli plug` where it is already signed in) is more reliable. " +
      "Mutually exclusive with `html` and `path`.",
    ),
    cloudgrid_yaml: z.string().optional().describe(
      "Inline cloudgrid.yaml (the entity manifest). Optional; server auto-detection applies when omitted. " +
      "On re-plug, a name: change is a warning only; the entity keeps its name and URL.",
    ),
    target_entity_id: z.string().optional().describe(
      "Present → RE-PLUG: update this exact entity in place (same entity_id, slug, URL, plug history). " +
      "Absent → CREATE a new entity. This is the durable handle a previous plug returned. " +
      "Re-plugging a drop that was plugged outside a grid also needs its owner_token.",
    ),
    grid: z.string().optional().describe(
      "On create: the grid slug to plug into, chosen by the user. Omitted for a user with more than one grid, " +
      "the result is needs_grid with the grid list to choose from; a single-grid user is not asked. The grid " +
      "sets the new entity's URL, which members can see it, and its datastore tier and namespace. On re-plug the entity stays in its grid " +
      "grids, but pass its home grid here when it differs from your active grid (the API checks your " +
      "membership in the entity's grid). A drop plugged outside a grid stays outside until its owner claims it into one.",
    ),
    slug: z.string().optional().describe(
      "Alternative RE-PLUG handle: paired with `grid`, resolves to an existing entity (the pickup " +
      "contract's replug_handle) and updates it in place, for a client that holds only grid+slug, not the " +
      "raw entity_id. target_entity_id takes precedence. A grid+slug that does NOT resolve to an existing " +
      "entity is treated as a CREATE (not a false-positive re-plug).",
    ),
    url: z.string().optional().describe(
      "Alternative RE-PLUG handle: the entity's public CloudGrid URL (e.g. https://<grid>.cloudgrid.io/<slug>) " +
      "for editing in place with the URL and no target_entity_id (the common \"change the color of " +
      "this page\" flow). The grid is read from the host and the entity is resolved via " +
      "the pickup contract, so no `grid` param is needed. target_entity_id and grid+slug take precedence. A " +
      "non-CloudGrid host is ignored (it does not redirect the write); a URL that does not resolve is treated as a CREATE.",
    ),
    hints: z.strictObject({
      kind: z.enum(["inspiration", "app", "agent"]).optional().describe("Force the detected kind; omit to let the server auto-detect."),
      yaml: z.string().optional().describe("An inline cloudgrid.yaml override used as a detection hint."),
    }).optional().describe("Classification hints for the CREATE path (not entity targeting, which is target_entity_id)."),
    anon: z.boolean().optional().describe(
      "Deprecated and ignored: it does not publish. A new plug needs sign-in: without it the result is needs_auth and " +
      "nothing is published, even with anon: true. Editing a drop " +
      "that was plugged outside a grid takes target_entity_id + owner_token.",
    ),
    owner_token: z.string().optional().describe(
      "The owner token of a drop plugged outside a grid; it authorizes its re-plug (with target_entity_id). " +
      "Re-minted on every such edit; the newest one from the result is the valid one.",
    ),
    confirm_new_app: z.boolean().optional().describe(
      "Set true to confirm plugging a source that already contains a cloudgrid.yaml as a NEW runtime app. " +
      "On a create, if the source has a cloudgrid.yaml and this is not set, the result is needs_confirmation " +
      "and nothing is created (target_entity_id re-plugs an existing entity instead).",
    ),
    // Local (stdio) edition only (#433): the hosted server sends no conversation
    // text unless the user asks for it through grid_note or grid_report, so its
    // grid_plug schema has no courier fields at all.
    ...(ctx.edition === "web"
      ? {}
      : {
          user_request: z.string().optional().describe(
            "Local edition: a brief version of the user's request that led to this deploy, for the " +
            "optional QA session log (dark unless this machine's operator set CLOUDGRID_QA_SLACK_WEBHOOK). " +
            "Omit if the user asked not to share it.",
          ),
          session_note: z.string().optional().describe(
            "Local edition: one short paragraph on what you built and why, for the optional QA session log.",
          ),
        }),
  };

  const plugConfig = {
      title: "Plug an app into the grid",
      // Kept to the decision of WHETHER to call this tool at all (#410, #432):
      // what it does, the user phrasings it serves (there is no grid_deploy
      // alias — this phrasing does the routing, mcp#337), the single-page-vs-
      // runtime-app distinction, the sign-in contract (#395), and one short
      // clause each for the signals a model must handle (needs_grid,
      // needs_grid_create, no keys in page source, building -> poll, end with
      // the URL). No other product is named and nothing is marked preferred:
      // the description states capabilities and the requests they serve
      // (directory review criteria). Detail lives in the per-parameter
      // describe() strings, the server instructions and the grid_start
      // orientation. test/tool-description-length.test.mjs caps every tool
      // description at 1,000 characters and pins these clauses.
      description:
        "Plug an app, website, game, or HTML page into CloudGrid at a live public URL. " +
        "Serves requests to deploy, publish, host, ship, launch, go live, or share a working link: " +
        "\"give me a link\", \"share it with friends\", \"make it live\", \"put it online\", \"host this\". " +
        "Takes one source: `html` (a self-contained page) or `artifact_files` (a multi-file or database-backed " +
        "runtime app; cloudgrid.yaml declares its needs)" +
        (ctx.edition === "web" ? ". " : ", or `path` (local folder, file, or .zip). ") +
        "No target_entity_id (or grid+slug) creates a new URL; with one it updates it in place. " +
        `Signed out it returns needs_auth and publishes nothing (${ctx.edition === "web" ? "the user signs in through the CloudGrid connector" : "the user signs in with the local browser sign-in"}); there is no guest publish. ` +
        "Also publishing nothing: needs_grid (several grids, listed), needs_grid_create (no grid yet), " +
        "needs_confirmation (the source has a cloudgrid.yaml). " +
        "Page source is public; known API key shapes are rejected. " +
        "A runtime app returns status building while its build runs. " +
        "Returns the URL and the entity_id (the re-plug handle).",
      inputSchema: plugInputSchema,
      outputSchema: {
        entity_id: z.string().optional().describe("Globally unique: the target_entity_id for a re-plug."),
        slug: z.string().optional().describe("Grid-scoped slug."),
        grid: z.string().nullable().optional().describe("Home grid slug; null for a drop plugged outside any grid."),
        url: z.string().optional().describe("Canonical serving URL (stable across re-plugs; server-composed, flat-arch-aware)."),
        poll_url: z.string().optional().describe("Deploy status path while building (runtimes only)."),
        status: z.string().optional().describe("live | building | created | updated …"),
        source: z.string().optional().describe("Transport used for this deploy: `path` (disk), `html`, or `artifact_files` (inline). Inline copies risk truncation on large files."),
        claim_url: z.string().optional().describe("Drops plugged outside a grid: the link the owner opens to claim it into a grid of their choosing."),
        claim_message: z.string().optional().describe("Drops plugged outside a grid: the claim note for the owner."),
        owner_token: z.string().optional().describe("Drops plugged outside a grid: the bearer owner token (re-plug + claim). Re-minted on every such edit; the newest is the valid one."),
        console_url: z.string().optional().describe("Emitted on every non-building plug (both editions): a link to the grid in the console."),
        current_visibility: z.string().optional().describe("Who can open it now, as the API reports it after this plug: private, grid, link, authenticated, space, or public. Absent when the API did not confirm it."),
        visibility_options: z.array(z.object({
          value: z.string().describe("Visibility value."),
          label: z.string().describe("Human-readable label."),
        })).optional().describe("New deploy: the visibility levels this app can be set to."),
        // grid_plug has ONE outputSchema but THREE response modes; the SDK renders
        // this schema with additionalProperties:false and the client rejects any
        // undeclared key (MCP -32602). Declare the two non-deploy-result modes so
        // they validate: (1) the grid-picker "which grid?" ask (resolveGridOrAsk),
        // and (2) the signed-in CLI-fallback recovery.
        needs_grid: z.boolean().optional().describe("Grid-picker ask: the user has more than one grid and none was given; nothing was created. The chosen slug goes in `grid`."),
        needs_auth: z.boolean().optional().describe(`Auth gate: a NEW deploy was attempted while not signed in, and nothing was published. ${ctx.edition === "web" ? "The user signs in to CloudGrid through their AI tool" : "The user signs in through the local browser sign-in"}. There is no guest or anonymous publish option.`),
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
        needs_grid_create: z.boolean().optional().describe("Zero-grid ask: the account has no grid yet, and nothing was created. The text names the steps."),
        error: z.boolean().optional().describe("True when the grid listing failed (network/auth error). The text carries a human-readable message. This is a listing failure, not a missing grid."),
        next: buildNextStep(),
      },
      // destructiveHint (M3): a re-plug with target_entity_id REPLACES what is
      // live at a public URL in place. Versions + grid rollback exist, but the
      // honest MCP annotation for overwrite-live-state is destructive.
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      // The live-result card (#434), web edition. `_meta.ui.resourceUri` is the
      // MCP Apps key Claude and ChatGPT both read; `openai/outputTemplate` is
      // ChatGPT's compatibility alias for it. The card speaks the standard
      // bridge, so it renders on both. A client without the UI extension
      // ignores both keys and gets the text result, which starts with the URL.
      ...(ctx.edition === "web" ? { _meta: LIVE_RESULT_TOOL_META } : {}),
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
        // (no target_entity_id). Edits NEVER ask — the grid is fixed by the
        // entity. A signed-out create is refused (#395). Explicit valid grid
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
          // CREATE requires sign-in (#395). Every published entity must be owned
          // by a known account so "who published this?" is answerable. `anon:
          // true` no longer selects a guest wire — an unauthenticated create is
          // refused and publishes nothing. The guest/anon path is GONE for
          // create; it survives only for editing pre-cutover drops (the
          // owner-token wire, which is an EDIT and never reaches here).
          if (!token) {
            if (ctx.state) ctx.state.authChoiceOffered = true;
            return okResult({
              text: authAskSignedOut(ctx),
              structured: { needs_auth: true },
            });
          }
          // Signed in — never ride the anon wire on a create. Drop a stale
          // `anon: true` so it cannot re-select the guest wire inside runPlug
          // (runPlug keys the wire on `anon === true` for creates).
          if (input?.anon) input = { ...(input || {}), anon: false };
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
              return okResult(withPreviewMeta(ctx, {
                ...res,
                text:
                  `Warning: your only grid "${decision.single.slug}" isn't fully set up yet — the page may not load until provisioning completes.\n` +
                  res.text,
              }));
            }
          } else if (decision.grid) {
            input = { ...(input || {}), grid: decision.grid };
          }
        }
        const res = await runPlug(ctx, input || {});
        return okResult(withPreviewMeta(ctx, res));
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
        "Retrieve the CURRENT deployed HTML of an inspiration/drop inline as text, for editing and " +
        "re-plugging the SAME URL when its source is no longer in context (e.g. the user asks to 'change the " +
        "color' of a page, even in a fresh chat with only its URL). Takes the entity_id from a plug result, " +
        "the public url, or grid+slug; the session's last drop is the fallback. Given just a URL with no session, it resolves the " +
        "entity_id via the pickup contract and also returns the entity's kind, single_html, capabilities " +
        "(whether the caller may re-plug or fork it), and replug_handle. For a multi-file or runtime " +
        "(app/agent) source it returns source_download_url, the route to the full source. " +
        "Reads the HTML from the API server-side; read-only, creates nothing.",
      inputSchema: {
        entity_id: z.string().optional().describe("The drop's durable id, from its plug result. Enough on its own: its URL is looked up. Falls back to this session's last drop."),
        url: z.string().optional().describe("The public URL of the drop (e.g. https://<grid>.cloudgrid.io/<slug>). Defaults to this session's last drop URL."),
        grid: z.string().optional().describe("Grid slug, used only to construct the URL when neither url nor session state is available."),
        slug: z.string().optional().describe("Entity slug, used with grid to construct the URL when neither url nor session state is available."),
      },
      outputSchema: {
        url: z.string().describe("The URL that was fetched."),
        entity_id: z.string().nullable().describe("The drop's entity id (echoed from input/session, if known)."),
        bytes: z.number().describe("Total size of the live document in bytes."),
        truncated: z.boolean().describe("True if the body exceeded 1.5MB and was cut; the drop may be multi-file."),
        html: z.string().describe("The current deployed HTML (truncated to 1.5MB when oversized)."),
        kind: z.string().optional().describe("Resolved via the pickup contract: inspiration | app | agent."),
        single_html: z.boolean().optional().describe("Resolved via the pickup contract: true when this is a single editable HTML document (edit-in-place); false → multi-file."),
        capabilities: z.object({
          replug: z.boolean().describe("Whether the caller may re-plug (write) this entity in place."),
          fork: z.boolean().optional().describe("Whether the caller may fork it."),
          reason: z.string().optional().describe("Why an action is unavailable, e.g. not_owner."),
        }).optional().describe("Resolved via the pickup contract: what the caller may do with this entity."),
        replug_handle: z.object({
          target_entity_id: z.string().optional().describe("The target_entity_id that re-plugs it in place."),
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

  // Login — local edition only. It opens a browser and saves to the credentials
  // file. The hosted edition has no sign-in tool: the AI tool's connector signs
  // the user in (OAuth) when a tool needs an account (src/web-auth.js).
  if (ctx.edition !== "web") {
    reg(
      "grid_login",
      {
        title: "Sign in to CloudGrid",
        description: "Start a CLI-free CloudGrid sign-in. Serves requests to log in, sign in, or authenticate, and a plug result of needs_auth. Returns a URL to open in the browser, where the user completes the sign-in. Uses CloudGrid's existing OAuth.",
        inputSchema: {},
        outputSchema: {
          login_url: z.string().describe("URL to open in a browser to complete sign-in."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        // Bind the SEP-1865 sign-in card on the web edition (Claude web) via the
        // standard `_meta.ui.resourceUri` key. It carries NO openai/outputTemplate
        // and is not gated by MCP_APPS_WIDGETS, so it is the Claude sign-in card;
        // a client without the UI extension ignores _meta.ui and gets the
        // text-first result below. NOT gated behind MCP_APPS_WIDGETS — a
        // second, independent mechanism (see constants.js). The result shape is
        // unchanged: content[0] stays the sign-in URL text so the link is never
        // unreachable if the card does not render.
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
        description: "Finish a browser sign-in started from this server. Checks once: when the browser sign-in is complete, it saves the session and returns the signed-in email; otherwise it returns status pending.",
        inputSchema: {
          code: z.string().optional().describe("The sign-in code. Defaults to the most recent sign-in started in this session."),
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
  }

  reg(
    "grid_visibility",
    {
      title: "Change app visibility",
      description: "Change who can see a CloudGrid inspiration OR runtime app/agent. Simple modes: private (only the user), grid (everyone in their grid), link (anyone with the URL; indexed: true also makes it findable by search engines). Finer control via the TWO AXES instead: inside (who in the grid: private | spaces | grid) and outside (reach beyond it: none | link | public), with require_signin for a members-only link and `spaces` for selected spaces. 'authenticated' is retired (it maps to a sign-in-required link). Serves requests to make something private, restrict who sees it, or open it up. Takes the app's entity_id (from its plug result) or its url; the drop made earlier in the session is the fallback, and some hosts start a new session for every tool call. Kind-aware routing across both surfaces. Requires sign-in. Returns the stored visibility settings.",
      inputSchema: {
        visibility: z.enum(["private", "grid", "link", "public", "authenticated", "space"]).optional().describe("Simple mode: private | grid | link ('public' is an alias of link; indexed: true makes it search-findable; 'authenticated' is the retired alias for a sign-in-required link; 'space' needs the `spaces` list). Pass either this OR the inside/outside axes."),
        inside: z.enum(["private", "spaces", "grid"]).optional().describe("Axis 1, who in the grid can see it: private (only the user), spaces (selected spaces, listed in `spaces`), or grid (everyone in the grid). Use together with `outside`, instead of `visibility`."),
        outside: z.enum(["none", "link", "public"]).optional().describe("Axis 2, reach beyond the grid: none, link (anyone with the link; add require_signin: true for signed-in accounts only), or public (anyone, and findable by search engines)."),
        require_signin: z.boolean().optional().describe("With outside: link (or visibility: link): the link requires a signed-in CloudGrid account."),
        spaces: z.array(z.string()).optional().describe("Space slugs, for inside: spaces (or the legacy space/grid modes)."),
        indexed: z.boolean().optional().describe("With visibility: link, makes the page search-engine indexable."),
        entity_id: z.string().optional().describe("The app's entity_id, from its plug result. Falls back to this session's last drop."),
        url: z.string().optional().describe("The app's public URL, when the entity_id is not at hand. Resolved to its entity_id."),
        kind: z.enum(["inspiration", "app", "agent"]).optional().describe("Entity kind. Omit to auto-detect from this session's last drop (falls back to trying the runtime surface, then the inspiration surface)."),
        grid: z.string().optional().describe("Grid of the entity. Defaults to the active grid."),
        target: z.string().optional().describe("Legacy alias of entity_id."),
        org: z.string().optional().describe("Legacy alias of grid."),
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
      // destructiveHint (#432): a visibility change alters who can reach a live
      // URL — opening a private page to the public, or cutting off people who
      // had the link — and there is no undo beyond setting it again.
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
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
        "Check whether an async runtime-app build (a deploy, which here means a plug) has finished and the app is live. Serves a plug that returned status \"building\", and questions like \"is it live yet?\". Takes the entity_id from the plug result (or the app url), plus its poll_url when there is one; the session's last plug is the fallback, and some hosts start a new session for every tool call. Returns status (success, failed, building, queued, or unknown) and live, which is true only when the build succeeded and the URL serves; a failed build adds the reason, a log tail, and a suggested fix. Requires sign-in (builds are owned). Works on every edition, including hosted.",
      inputSchema: {
        entity_id: z.string().optional().describe("The entity_id from the plug result. It finds the app's latest build. Falls back to this session's last plug."),
        url: z.string().optional().describe("The app's public URL, when the entity_id is not at hand (e.g. https://<slug>--<grid>.cloudgrid.io)."),
        poll_url: z.string().optional().describe("The poll_url from a plug result, when it has one."),
        grid: z.string().optional().describe("Grid of the entity (the grid from the plug result). Defaults to the plug's grid, then the active grid."),
      },
      outputSchema: {
        status: z.string().describe("The build status: success | failed | building | queued | unknown."),
        live: z.boolean().describe("True only when the build finished successfully and the URL serves."),
        url: z.string().optional().describe("The live URL, when known."),
        console_url: z.string().optional().describe("On success: a link to see and manage all the apps in the grid, in the console."),
        error: z.string().optional().describe("User-language failure reason, when the build failed."),
        build_log_tail: z.string().optional().describe("Sanitized tail of the Cloud Build log (the real error), when the build failed."),
        suggested_fix: z.string().optional().describe("A suggested fix for the failure, when the platform provides one."),
        build_log_url: z.string().optional().describe("Cloud Build console URL for the full log, when available."),
        entity_id: z.string().optional().describe("The app's entity_id, when known."),
        grid: z.string().optional().describe("The app's grid slug, when known."),
        next: buildNextStep(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
      // The live-result card's Check status button calls this back over the
      // host bridge (#434). ChatGPT's compatibility key for that permission;
      // inert elsewhere. Same as grid_visibility.
      ...(ctx.edition === "web" ? { _meta: { "openai/widgetAccessible": true } } : {}),
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
      description: "List the signed-in user's grids, each with slug, name, role, whether it is the active grid, and setup status (render_ready). Requires sign-in. A plug into a brand-new grid waits for its setup by itself.",
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
        return fail(ctx.edition === "web" ? `You are not signed in. ${signInHow(ctx)} first.` : "You are not signed in. Run grid_login first.");
      }
      let grids;
      try {
        grids = await fetchUserOrgs(token);
      } catch {
        return fail("Could not list your grids — please check your connection and try again.");
      }
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
      // No "none of your grids are set up yet, wait" line here (cloudgrid#2428).
      // The platform reports render_ready true for every grid, so that branch
      // never ran, and its advice (poll, then plug) is what playbook rule 3b
      // tells the model NOT to do: grid_plug waits for a new grid itself.
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
      title: "Orient on CloudGrid",
      description:
        "A short orientation for building with CloudGrid: the account this session is signed in as and its active grid, how to choose between a single-page plug and a runtime app (and what each provides: managed database, Redis, pgvector, disk, an AI gateway with no API key), the sign-in and grid steps a first plug goes through, and the index of workflows that load by name. Read-only, under 3,000 characters. Serves a first look at CloudGrid and questions about what it can do or which account is connected. The full operating playbook is the doc named playbook.",
      inputSchema: {},
      outputSchema: {
        playbook: z.string().describe("The orientation: what CloudGrid does, how to choose the plug path, and where to load details."),
        workflows: z
          .array(
            z.object({
              name: z.string().describe("Workflow name, the key it loads by."),
              deploy: z.string().describe("inspiration (one static page, instant) or runtime (an app with services, async build)."),
              when: z.string().describe("The requests this workflow serves, abridged; the workflow itself has the full list."),
            }),
          )
          .describe("The workflow index, compact. Each loads by kind \"workflow\" and its name; the capability-map doc matches a request to a workflow in detail."),
        context: z
          .object({
            active_grid: z.string().nullable().describe("The user's active grid/org slug, or null."),
            signed_in: z.boolean().describe("Whether the current session is signed in."),
            email: z.string().optional().describe("The signed-in user's email: the CloudGrid account this session is authenticated as. Present whenever signed_in is true and the session token carries an email claim (the normal case). Absent only if signed_in is false, or on the rare token that lacks the claim; the identity line in this tool's text content states which case applies. It answers 'which account/user am I?'."),
            session_expired: z.boolean().optional().describe(`True when credentials exist but the JWT has expired. ${ctx.edition === "web" ? "The user signs in to CloudGrid again through their AI tool." : "The user signs in again through the local browser sign-in."}`),
            identity_changed: z.boolean().optional().describe("True when the session's identity changed via a different transport Bearer. Session state was reset."),
            update_available: z
              .object({
                current: z.string().describe("This MCP's version."),
                latest: z.string().describe("Latest published version."),
              })
              .optional()
              .describe("Present when this local MCP is behind the latest release; the text carries the reinstall note."),
          })
          .optional()
          .describe("Live context from the current session."),
      },
      // openWorldHint false (#432): reads the session's credential and the
      // bundled corpus; it contacts no external system.
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
      // Compact index (#432): the full front-matter of 60+ workflows was ~50k
      // characters per grid_start call. The model needs the names, the kind,
      // and a hint of the intent; the workflow itself carries the rest.
      const abridge = (s, n) => {
        const t = String(s || "").trim();
        return t.length <= n ? t : `${t.slice(0, n).replace(/[\s,;]+\S*$/, "")}…`;
      };
      const index = workflows.map((w) => ({
        name: w.name,
        deploy: /inspiration/i.test(w.deploy) ? "inspiration" : "runtime",
        when: abridge(w.when || w.summary, 80),
      }));
      const structured = { playbook: ORIENTATION, workflows: index, context: contextObj };
      const names = (kind) => index.filter((w) => w.deploy === kind).map((w) => w.name).join(", ") || "(none)";
      const wfLines = workflows.length
        ? `  Single page, instant (grid_plug html): ${names("inspiration")}\n` +
          `  Runtime app, async build (needs a cloudgrid.yaml): ${names("runtime")}`
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
        : ctx.edition === "web"
          ? "You are not signed in to CloudGrid. Browsing templates and app sources works signed out; creating or changing anything needs an account, and the user's AI tool asks them to sign in when a tool needs one."
          : "You are not signed in to CloudGrid. Run grid_login to sign in.";
      let text =
        `${identityLine}\n\n${ORIENTATION}\n\nAvailable workflows:\n${wfLines}\n\n` +
        `Next: match the intent to a workflow and call grid_get_template({kind:"workflow", name}); ` +
        `to match in detail, grid_get_template({kind:"doc", name:"capability-map"}).` +
        (stale ? `\n\n${stale}` : "");
      if (sessionExpired) {
        text += ctx.edition === "web"
          ? "\n\nYour CloudGrid sign-in has expired. Sign in again when your AI tool asks."
          : "\n\nYour CloudGrid sign-in has expired. Run grid_login to sign in again.";
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
        "Load a specific CloudGrid workflow, template, example, rule, troubleshooting note, or reference doc by kind and name: deterministic retrieval from the bundled corpus, no network. Workflow and template names come from the orientation's workflow index, e.g. {kind:\"workflow\", name:\"presentation\"} or {kind:\"template\", name:\"deck\"}. Reference docs (kind \"doc\"): cloudgrid-yaml (the manifest schema and needs: vocabulary), capability-map (which template fits a request), playbook (the full operating rules). Returns the entry's full content.",
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
      // openWorldHint false (#432): a pure lookup in the bundled corpus.
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
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
  // team. It takes no conversation parameter: only the message and context the
  // user agreed to send leave the session (#456).
  reg(
    "grid_report",
    {
      title: "Report a failure",
      description:
        "Report a genuine CloudGrid failure (a build, deploy, or platform call that failed unexpectedly) to the CloudGrid team, with the user's explicit consent. What is sent: the short `message` (what failed), the `context` passed (the tool, inputs, grid, original request, error code/detail), and the client name and platform: only the message and context the user agreed to send, nothing else from the conversation. Redaction is key-name-only: a value is dropped only when its KEY looks secret, so a secret embedded in a value (e.g. inside HTML) is sent as is. Returns the outcome status.",
      inputSchema: {
        message: z
          .string()
          .describe("Short summary of what failed (required), not the whole conversation."),
        context: z
          .strictObject({
            tool: z.string().optional().describe("The CloudGrid tool that failed, e.g. plug."),
            inputs: z.any().optional().describe("The failing inputs (e.g. the HTML/args), kept minimal. A secret embedded in a value here is not redacted."),
            grid: z.string().optional().describe("The grid/org slug involved, if any."),
            original_request: z.string().optional().describe("What the user asked for, in one line."),
            error_code: z.string().optional().describe("The server error code, e.g. INTERNAL_ERROR."),
            error_detail: z.string().optional().describe("The error message / detail surfaced to the agent."),
          })
          .partial()
          .optional()
          .describe("The failed-request context. Redaction is key-name-only (a value is dropped only when its KEY looks secret) client-side, and the server applies the same key-name filter; a secret embedded in a value is not redacted by either."),
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
    // ── grid_hello — creates a hello page and plugs it (both editions) ────────
  reg(
    "grid_hello",
    {
      title: "Plug a hello page",
      description:
        "Create a minimal hello page and plug it into the user's grid, returning the live URL. " +
        "If the user has more than one grid and `grid` is not given, it returns needs_grid with " +
        "the list and plugs nothing. Serves requests for a first test page or a quick check that " +
        "plugging works. Requires sign-in.",
      inputSchema: {
        grid: z.string().optional()
          .describe("Grid slug to plug into. Omitted for a user with several grids, the result lists them."),
        name: z.string().optional()
          .describe("Who to greet. Defaults to 'world'."),
      },
      outputSchema: {
        url: z.string().optional().describe("The live URL, once plugged."),
        entity_id: z.string().optional().describe("Re-plug handle."),
        needs_auth: z.boolean().optional().describe("True when the user is not signed in; nothing was done."),
        needs_grid: z.boolean().optional().describe("True when the user has several grids and none was given; the result lists them."),
        error: z.boolean().optional().describe("True when the grid listing failed (network/auth error). The text carries a human-readable message. This is a listing failure, not a missing grid."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      // Same live-result card as grid_plug (#434): grid_hello returns a runPlug
      // result, so it gets the same binding.
      ...(ctx.edition === "web" ? { _meta: LIVE_RESULT_TOOL_META } : {}),
    },
    async (input) => {
      try {
        // 1. AUTH — same shape as grid_plug (register.js:585). Not an error:
        //    a result the model acts on by running grid_login.
        const token = await ctx.getToken();
        if (!token) {
          // NOT the shared authAskSignedOut: that tells the model to re-call
          // grid_plug, which would send it to a different tool with no source.
          // Say only what grid_hello can actually do.
          return okResult({
            text:
              `Plugging a hello page needs an account. ${signInHow(ctx)}, `
              + "then re-call grid_hello.",
            structured: { needs_auth: true },
          });
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
        return okResult(withPreviewMeta(ctx, res));
      } catch (err) {
        return fail(err.message);
      }
    },
  );

  // grid_delete (hosted edition) — archive an inspiration via the direct API
  // (#343). The local edition has a CLI-wrapping version below the edition gate;
  // this direct-API version runs on web (hosted) where the CLI is unavailable.
  if (ctx.edition !== "local") {
    reg(
      "grid_delete",
      {
        title: "Delete an inspiration",
        description:
          "Archive a CloudGrid inspiration by slug. Destructive: requires `confirm: true`. " +
          "If the user has more than one grid and `grid` is not given, it returns needs_grid with " +
          "the list and deletes nothing. Only works for inspirations (static pages); runtime apps and " +
          "agents are removed with `grid unplug --hard` from the CLI. Requires sign-in. Returns whether " +
          "it was archived.",
        inputSchema: {
          name: z.string().describe("Entity slug to delete (required)."),
          grid: z.string().optional().describe("Grid slug to delete from. Omitted for a user with several grids, the result lists them."),
          confirm: z.literal(true).describe("Set to true to confirm; the call is refused without it."),
        },
        outputSchema: {
          deleted: z.boolean().describe("True when the entity was archived."),
          entity_id: z.string().optional().describe("The archived entity's id."),
          slug: z.string().optional().describe("The archived entity's slug."),
          grid: z.string().optional().describe("The grid the entity was deleted from."),
          needs_auth: z.boolean().optional().describe("True when the user is not signed in; nothing was done."),
          needs_grid: z.boolean().optional().describe("True when the user has several grids and none was given; the result lists them."),
          error: z.boolean().optional().describe("True when the grid listing failed (network/auth error)."),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      async (input) => {
        try {
          // 1. AUTH
          const token = await ctx.getToken();
          if (!token) {
            return okResult({
              text: `Deleting an inspiration needs an account. ${signInHow(ctx)}, then re-call grid_delete.`,
              structured: { needs_auth: true },
            });
          }

          // 2. GRID — never fall back to the active grid on a destructive op (#343).
          const decision = await resolveGridOrAsk(ctx, {
            token,
            suppliedGrid: input?.grid,
            edition: ctx.edition,
          });
          if (decision.picker) return okResult(decision.picker);
          const grid = decision.grid || decision.single?.slug;
          if (!grid) return fail("Could not resolve a grid. Pass `grid` explicitly.");

          // 3. DELETE
          return okResult(await runDelete(ctx, { ...input, grid }));
        } catch (err) {
          return fail(err.message);
        }
      },
    );
  }

  if (ctx.edition !== "local") return; // web edition stops here — no CLI tools

  // ── CLI-wrapping tools (local edition only) ───────────────────────────────

  regTool(
    "grid_create_project",
    "Scaffold a new project",
    "Scaffold a new CloudGrid app or agent folder (cloudgrid.yaml + a web service), optionally pre-declaring resources. Wraps `grid new` (scaffolds locally; no server entity exists until the folder is plugged). Language note: the nextjs starter is TypeScript (writes tsconfig.json + app/*.tsx), while CloudGrid templates are plain JavaScript. A template's files are the source of truth for the folder: its .js files replace the scaffolded tsconfig.json and app/*.tsx, so no route has both a .tsx and a .js file.",
    {
      kind: z.enum(["app", "agent"]).describe("Entity kind. 'agent' scaffolds an agent: block."),
      name: z.string().describe("Slug: 3-40 lowercase alphanumerics and hyphens."),
      type: z.enum(["node", "nextjs", "python", "static"]).optional().describe("Seed a web service of this type."),
      needs: z.array(z.enum(["database", "cache", "kv", "queue", "pubsub", "vector", "ai", "disk"])).optional()
        .describe("Pre-declare infrastructure needs in the scaffolded cloudgrid.yaml (e.g. [\"database\",\"ai\"])."),
      dir: z.string().optional().describe("Target directory. Defaults to the current folder."),
      grid: z.string().optional().describe("Override the active grid this project will target."),
      org: z.string().optional().describe("Legacy alias of grid."),
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
      org: z.string().optional().describe("Legacy alias of grid."),
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
      org: z.string().optional().describe("Legacy alias of grid."),
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
    "Continue/edit an EXISTING entity locally: downloads its source + cloudgrid.yaml and links the folder so the next `grid plug` from it updates the entity IN PLACE. Requires push access (owner or collaborator). Wraps `grid pull`. It makes no copy and grants no access: a separate copy (a fork) and push access to an entity the user can only view (CLI: `grid collab <entity>`) are separate operations.",
    {
      name: z.string().describe("Entity slug or id to pull."),
      target_dir: z.string().optional().describe("Directory to pull into (relative to cwd). Defaults to the entity name."),
      grid: z.string().optional().describe("Grid to resolve the entity in. Defaults to the active grid."),
      version: z.string().optional().describe("Pull an older version's source instead of HEAD."),
      force: z.boolean().optional().describe("Pull into a non-empty directory."),
      no_bind: z.boolean().optional().describe("Download source only, without cloudgrid.yaml and the link."),
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
      confirm: z.literal(true).describe("Set to true to confirm; the call is refused without it."),
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
      confirm: z.literal(true).describe("Set to true to confirm; the call is refused without it."),
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
    "Set or list secret names for an entity. Returns secret names only, not values. Wraps `grid secrets`.",
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
