# Changelog

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
