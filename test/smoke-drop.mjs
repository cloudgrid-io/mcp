// Live drop smoke: spawn the stdio server and call grid_plug with inline HTML.
//
// Since v0.21.19 (#396) a new plug needs sign-in. So this script checks two
// things:
//
//   1. Signed out — always runs. A create with `anon: true` returns needs_auth
//      and publishes nothing. The server refuses before any publish request is
//      sent, so this is safe to run against the live API at any time. The
//      server runs with an empty CLOUDGRID_HOME, so it is signed out even on a
//      machine that has a signed-in CLI.
//   2. Signed in — runs only when CLOUDGRID_TOKEN is set. Publishes a REAL
//      owned page into the account's grid, then fetches the live URL. Set
//      CLOUDGRID_SMOKE_GRID when the account has more than one grid.
//
// Run: npm run smoke:drop
//      CLOUDGRID_TOKEN=... [CLOUDGRID_SMOKE_GRID=<slug>] npm run smoke:drop

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  assertSignedOutCreateRefused,
  check,
  env,
  finish,
  isolatedHome,
  logOutput,
  textOf,
} from "./smoke-live-env.mjs";

async function withServer(home, fn) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["src/index.js"],
    env: { ...process.env, CLOUDGRID_HOME: home.dir, CLOUDGRID_NO_BROWSER: "1" },
  });
  const client = new Client({ name: "cloudgrid-mcp-drop-smoke", version: "0.0.0" });
  try {
    await client.connect(transport);
    return await fn(client);
  } finally {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    home.cleanup();
  }
}

const html = "<h1>Plugged from the MCP smoke test</h1>";

// 1. Signed out: refused, nothing published.
await withServer(isolatedHome(), async (client) => {
  const res = await client.callTool({
    name: "grid_plug",
    arguments: { html, anon: true, filename: "drop-smoke.html" },
  });
  logOutput("signed-out create (anon: true)", res);
  assertSignedOutCreateRefused("1.", res);
});

// 2. Signed in: publishes an owned page.
const token = env("CLOUDGRID_TOKEN");
if (!token) {
  console.log("skip 2. signed-in create — CLOUDGRID_TOKEN is not set");
} else {
  const grid = env("CLOUDGRID_SMOKE_GRID");
  await withServer(isolatedHome(token), async (client) => {
    const res = await client.callTool({
      name: "grid_plug",
      arguments: { html, filename: "drop-smoke.html", ...(grid ? { grid } : {}) },
    });
    logOutput("signed-in create", res);
    const s = res.structuredContent ?? {};
    if (s.needs_grid) {
      check("2. signed-in create — account has several grids; set CLOUDGRID_SMOKE_GRID", false);
      return;
    }
    check("2. signed-in create returned without error", res.isError !== true);
    check("2. signed-in create did not ask for sign-in", s.needs_auth !== true);
    check("2. signed-in create returned an entity_id", typeof s.entity_id === "string" && s.entity_id.length > 0);
    check("2. signed-in create is owned, not anonymous (no owner_token)", !s.owner_token);
    const url = textOf(res).match(/(?:Plugged into your grid|Your app is live|Live):\s*(https:\/\/\S+)/)?.[1];
    check("2. signed-in create returned a URL", !!url);
    if (url) {
      const page = await fetch(url);
      check(`2. live URL serves (HTTP ${page.status})`, page.ok);
    }
  });
}

finish("All drop smoke checks passed.");
