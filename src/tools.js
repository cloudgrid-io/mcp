// Shared tool core for both editions of the CloudGrid MCP server.
//
// Two editions register from here:
//   - local (stdio): full toolset, including the CLI-wrapping tools. Identity
//     comes from ~/.cloudgrid/credentials.
//   - web (HTTP, hosted): the light, CLI-free toolset (plug, claim, login).
//     Identity is a per-session token held in memory.
//
// The difference is injected as a `ctx` object, so the tool logic is written once.
//
// 0.20.x refactor: the implementation now lives in focused modules —
//   src/playbook.js        — the agent playbook + corpus retrieval
//   src/tools/constants.js — API base, CLI gate, caps, widget resources
//   src/tools/util.js      — shared MCP result-shape helpers
//   src/tools/cli.js       — CLI resolution/exec plumbing (bundled/global/npx)
//   src/tools/deploy.js    — runPlug + the direct-API verb internals
//   src/tools/register.js  — registerTools(server, ctx): all registrations
// This file is the stable barrel: it keeps exporting every public symbol so
// src/index.js, src/web.js, and the tests import from here unchanged.

export { API_BASE, MCP_VERSION, CLI_TOOL_VERBS } from "./tools/constants.js";
export { fetchCorpus } from "./playbook.js";
export { resolveBundledCli, resolveNodeRuntime, runCloudgrid } from "./tools/cli.js";
export {
  resolveGridOrAsk,
  parseManifestName,
  detectSourceManifest,
  resolvePlugUrl,
  scrubReportContext,
  runReport,
  errorGuidance,
  REPORT_OFFER,
  parseCliPlugUrl,
  plugViaCliFallback,
  runPlug,
  runPickup,
  runPull,
  runSource,
  runVisibility,
  runCheckDeploy,
  pollDeployTrace,
} from "./tools/deploy.js";
export { registerTools, buildCreateProjectArgs } from "./tools/register.js";
export { decodeJwt } from "./auth.js";
