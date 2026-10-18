// Live test for a signed-in plug + claiming an anonymous drop.
//
// Since v0.21.19 (#396) an anonymous drop can no longer be created: a
// signed-out create returns needs_auth and publishes nothing. An anonymous drop
// made before that can still be claimed into a signed-in account with
// grid_pull and its claim_token. So this script no longer creates the drop it
// claims. It takes everything from the environment:
//
//   CLOUDGRID_TOKEN                 a signed-in token (needed for 1 and 2)
//   CLOUDGRID_SMOKE_GRID            grid slug (or argv[2]); needed when the
//                                   account has more than one grid
//   CLOUDGRID_SMOKE_CLAIM_ENTITY_ID the anonymous drop's entity_id   (for 2)
//   CLOUDGRID_SMOKE_CLAIM_TOKEN     its claim_token (the owner token) (for 2)
//
// Checks:
//   1. Signed-in plug — publishes a REAL owned page into the grid.
//   2. Claim — moves the anonymous drop into the account. This is a one-way
//      ownership transfer: a drop can be claimed once. Re-running with the same
//      drop and account reports "Already yours", which also passes.
// Each step is skipped, with the reason, when its variables are missing.
//
// The server runs with its own CLOUDGRID_HOME holding only the given token, so
// a signed-in CLI in ~/.cloudgrid is neither used nor touched.
//
// Run: CLOUDGRID_TOKEN=... npm run smoke:claim

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  check,
  env,
  finish,
  isolatedHome,
  logOutput,
  registerSecret,
  textOf,
} from "./smoke-live-env.mjs";

const token = env("CLOUDGRID_TOKEN");
const grid = env("CLOUDGRID_SMOKE_GRID") || process.argv[2] || null;
const claimEntityId = env("CLOUDGRID_SMOKE_CLAIM_ENTITY_ID");
const claimToken = env("CLOUDGRID_SMOKE_CLAIM_TOKEN");
registerSecret(claimToken);

if (!token) {
  console.log("skip 1. signed-in plug — CLOUDGRID_TOKEN is not set");
  console.log("skip 2. claim — CLOUDGRID_TOKEN is not set (claiming needs sign-in)");
  finish("Claim smoke: nothing to run without CLOUDGRID_TOKEN.");
  process.exit(0);
}

const home = isolatedHome(token);
const transport = new StdioClientTransport({
  command: "node",
  args: ["src/index.js"],
  env: { ...process.env, CLOUDGRID_HOME: home.dir, CLOUDGRID_NO_BROWSER: "1" },
});
const client = new Client({ name: "cloudgrid-mcp-claim-smoke", version: "0.0.0" });

try {
  await client.connect(transport);

  // 1. Signed-in plug — should land in the user's grid, owned.
  const idDrop = await client.callTool({
    name: "grid_plug",
    arguments: { html: "<h1>identity plug smoke</h1>", filename: "id-smoke.html", ...(grid ? { grid } : {}) },
  });
  logOutput("signed-in plug", idDrop);
  const s1 = idDrop.structuredContent ?? {};
  if (s1.needs_grid) {
    check("1. signed-in plug — account has several grids; set CLOUDGRID_SMOKE_GRID", false);
  } else {
    check("1. signed-in plug succeeded", idDrop.isError !== true);
    check("1. signed-in plug did not ask for sign-in", s1.needs_auth !== true);
    check("1. signed-in plug returned an entity_id", typeof s1.entity_id === "string" && s1.entity_id.length > 0);
    check("1. signed-in plug is owned, not anonymous (no owner_token)", !s1.owner_token);
    if (grid) check(`1. signed-in plug landed in ${grid}`, textOf(idDrop).includes(grid));
  }

  // 2. Claim an existing anonymous drop.
  if (!claimEntityId || !claimToken) {
    console.log(
      "skip 2. claim — set CLOUDGRID_SMOKE_CLAIM_ENTITY_ID and CLOUDGRID_SMOKE_CLAIM_TOKEN " +
        "for an existing anonymous drop",
    );
  } else {
    const claim = await client.callTool({
      name: "grid_pull",
      arguments: { entity_id: claimEntityId, claim_token: claimToken, ...(grid ? { grid } : {}) },
    });
    logOutput("claim", claim);
    const s2 = claim.structuredContent ?? {};
    check("2. claim succeeded", claim.isError !== true);
    check("2. claim did not ask for a grid", s2.needs_grid_create !== true && !s2.error);
    check("2. claimed drop is now yours", s2.owner_is_you === true);
    check("2. claimed drop is editable", s2.can_edit === true);
  }
} finally {
  try {
    await client.close();
  } catch {
    /* ignore */
  }
  home.cleanup();
}

finish("All signed-in plug + claim checks passed.");
