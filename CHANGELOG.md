# Changelog

## 0.4.0

- Added ChatGPT Apps SDK UI widgets (web edition, Task 12 Part B). Two
  MCP resource templates are registered as `text/html;profile=mcp-app`
  components, rendered deterministically in ChatGPT instead of
  paraphrased text:
  - **Live-result card** (`ui://cloudgrid/live-result.html`): shown
    after a successful drop. Displays the live URL (Open button), a
    link to the console grid, and a visibility picker with buttons
    for each access level. Changing visibility calls
    `cloudgrid_visibility` via the `window.openai.callTool` bridge.
  - **Org-picker card** (`ui://cloudgrid/org-picker.html`): shown
    when the user has multiple orgs and needs to choose. Buttons for
    each org re-invoke `cloudgrid_drop` with the selected org slug
    via the bridge.
- The `cloudgrid_drop` tool descriptor now carries
  `_meta.ui.resourceUri` and `"openai/outputTemplate"` (web edition
  only) so ChatGPT renders the live-result card by default. The
  `needs_org` result overrides to the org-picker card via per-result
  `_meta["openai/outputTemplate"]`.
- CSP metadata allows `*.cloudgrid.io` for connect and resource
  domains.
- All existing text `content` fallbacks are preserved unchanged.
  Clients that do not support the Apps SDK (Claude, MCP Inspector,
  any non-ChatGPT host) continue to work with text responses.
- No changes to tool input/output schemas, local-edition tools, or
  the anonymous/connected endpoint behavior.

## 0.3.4

- Fixed default visibility for authenticated web-edition drops: after a
  successful drop, the tool now PATCHes visibility to `link` ("Anyone with
  the link") so the published URL is shareable and the console preview
  renders without a sign-in wall. The post-drop message offers to restrict
  access (private / org) via `cloudgrid_visibility`.
- Fixed org disambiguation not firing when the user has multiple orgs: the
  tool now always validates the `org` parameter against the user's real org
  list from `GET /api/v2/orgs`. If the LLM supplies a guessed slug that
  does not match a real org, it is ignored and the tool asks which org to
  use. Previously, any non-empty `org` value skipped disambiguation.
- Updated the `org` parameter description on `cloudgrid_drop` to instruct
  the model to leave it unset and let the tool handle org selection.
- No changes to local-edition tools or behavior.

## 0.3.3

- Enriched `cloudgrid_drop` success response in the web edition: "Your app
  is live" message with the console management link and a visibility offer
  stating the current access level and how to change it. `structuredContent`
  now includes `console_url`, `current_visibility`, and
  `visibility_options` (widget-ready shapes for a future Apps SDK card).
- Added org disambiguation to `cloudgrid_drop` (web edition): when the user
  has multiple orgs and no `org` parameter, the tool returns the org list
  so the LLM (or a future widget) can ask which one. With exactly one org
  it publishes there automatically.
- Added `cloudgrid_orgs` tool (web edition, read-only) to list the
  signed-in user's organizations with slug, name, and role. Uses the
  canonical `GET /api/v2/orgs` endpoint (JWT claims do not carry orgs).
- Added sign-in guidance to `cloudgrid_drop` (web edition): unauthenticated
  non-anonymous calls return a prompt with the `cloudgrid_login` URL
  instead of silently falling through to an anonymous drop.
- Updated `cloudgrid_visibility` description to clarify it can be used
  right after a drop with no target id.
- No changes to local-edition tools or behavior.

## 0.3.2

- Added `outputSchema` to the 5 web-edition tools (`cloudgrid_drop`,
  `cloudgrid_claim`, `cloudgrid_login`, `cloudgrid_login_status`,
  `cloudgrid_visibility`). Handlers now return `structuredContent`
  alongside the human-readable text `content`, so clients that support
  structured tool results (e.g. ChatGPT Apps SDK connectors) can consume
  typed JSON directly. Clients that ignore `structuredContent` continue
  to work unchanged.
- Migrated the 5 web-edition tool registrations from the deprecated
  `server.tool()` to `server.registerTool()`, which supports
  `outputSchema`.
- No changes to the local-only CLI-wrapping tools or to tool behavior.

## 0.3.1

- Fixed stale hardcoded version in MCP `serverInfo`. Both editions (local
  and web) now read `version` from `package.json` at startup, making
  `package.json` the single source of truth for `serverInfo.version`.

## 0.3.0

- Added 17 new tools to the local edition: `cloudgrid_whoami`,
  `cloudgrid_use`, `cloudgrid_logout`, `cloudgrid_status`, `cloudgrid_info`,
  `cloudgrid_builds`, `cloudgrid_grid`, `cloudgrid_rename`,
  `cloudgrid_unplug`, `cloudgrid_delete`, `cloudgrid_rollback`,
  `cloudgrid_versions`, `cloudgrid_env`, `cloudgrid_secrets`,
  `cloudgrid_scaffold`, `cloudgrid_doctor`, `cloudgrid_open`.
  All wrap the `cloudgrid` CLI via the existing `cliTool` helper and
  register in the local edition only (after the edition guard).
- Destructive tools (`cloudgrid_unplug`, `cloudgrid_delete`) require an
  explicit entity name and `confirm: true`.
- `cloudgrid_secrets` exposes `set` and `list` (names) only; never returns
  secret values.
- `cloudgrid_open` returns the URL without launching a browser.
- Added MCP tool annotations (`readOnlyHint`, `destructiveHint`,
  `openWorldHint`) to all 28 tools. Read-only tools (`feedback`, `whoami`,
  `status`, `info`, `builds`, `grid`, `versions`, `doctor`, `logs`, `open`)
  are annotated accordingly; `unplug`, `delete`, and `logout` are marked
  destructive.
- No changes to the web edition tool surface. The 5 direct-API tools
  (`drop`, `claim`, `login`, `login_status`, `visibility`) are unchanged
  beyond receiving annotations.

## 0.2.8

- Moved to dedicated `cloudgrid-io/mcp` repository (clean-start import from
  `cloudgrid-io/skills/mcp-server`).
- Added CI: secret scanning (gitleaks), internal-reference linter, license
  check, smoke test, Dependabot.
- Added release pipeline: `npm publish --provenance` on version tags via
  GitHub Actions.
- No changes to the tool surface or behavior. Backward-compatible.

## 0.2.7 and earlier

Published from `cloudgrid-io/skills`. See that repository for prior history.
