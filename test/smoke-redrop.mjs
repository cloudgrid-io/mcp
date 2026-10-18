// Redrop smoke, through the web edition against the live API.
//
// Since v0.21.19 (#396) an anonymous drop can no longer be created: a
// signed-out create returns needs_auth and publishes nothing. An anonymous drop
// made before that still edits in place with its owner_token, no sign-in. So
// this script no longer creates a drop. It needs an existing one:
//
//   CLOUDGRID_SMOKE_REDROP_ENTITY_ID    the drop's entity_id
//   CLOUDGRID_SMOKE_REDROP_OWNER_TOKEN  its owner_token
//     or CLOUDGRID_SMOKE_REDROP_OWNER_TOKEN_FILE  a file holding it
//
// The owner_token is re-minted on every anonymous edit. When the token comes
// from a file, the fresh one is written back to that file (mode 0600), so the
// next run works. When it comes from the env var, store the new one yourself —
// this script never prints it.
//
// Checks:
//   1. Signed out — always runs. A fresh plug with `anon: true` (no target)
//      returns needs_auth and publishes nothing. Refused before any publish
//      request is sent.
//   2. Edit in place — runs when the drop's id and owner_token are given.
//      Same entity, same URL, new content, a fresh owner_token.
//
// Run: npm run smoke:redrop

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  assertSignedOutCreateRefused,
  check,
  env,
  finish,
  logOutput,
  registerSecret,
  textOf,
} from "./smoke-live-env.mjs";

const entityId = env("CLOUDGRID_SMOKE_REDROP_ENTITY_ID");
const tokenFile = env("CLOUDGRID_SMOKE_REDROP_OWNER_TOKEN_FILE");
let ownerToken = env("CLOUDGRID_SMOKE_REDROP_OWNER_TOKEN");
if (!ownerToken && tokenFile) ownerToken = readFileSync(tokenFile, "utf8").trim() || null;
registerSecret(ownerToken);

const PORT = 8767;
// The web edition takes identity only from a request's Bearer header; this
// client sends none, so every call is signed out.
const child = spawn("node", ["src/web.js"], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "ignore", "inherit"],
});

const urlOf = (r) => textOf(r).match(/Updated in place:\s*(https:\/\/\S+)/)?.[1];

let client;
try {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`http://localhost:${PORT}/healthz`)).ok) break;
    } catch {
      /* booting */
    }
    await sleep(100);
  }
  client = new Client({ name: "redrop-smoke", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`)));

  // 1. Signed out, no target: refused, nothing published.
  const fresh = await client.callTool({
    name: "grid_plug",
    arguments: { html: "<h1>redrop smoke fresh</h1>", anon: true, filename: "redropsmoke.html" },
  });
  logOutput("signed-out create (anon: true)", fresh);
  assertSignedOutCreateRefused("1.", fresh);

  // 2. Edit an existing anonymous drop in place.
  if (!entityId || !ownerToken) {
    console.log(
      "skip 2. edit in place — set CLOUDGRID_SMOKE_REDROP_ENTITY_ID and " +
        "CLOUDGRID_SMOKE_REDROP_OWNER_TOKEN (or _OWNER_TOKEN_FILE) for an existing anonymous drop",
    );
  } else {
    const stamp = new Date().toISOString();
    const edit = await client.callTool({
      name: "grid_plug",
      arguments: {
        html: `<h1>redrop smoke CHANGED ${stamp}</h1>`,
        filename: "redropsmoke.html",
        target_entity_id: entityId,
        owner_token: ownerToken,
      },
    });
    const s = edit.structuredContent ?? {};
    registerSecret(s.owner_token);
    logOutput("edit in place", edit);

    check("2. edit succeeded", edit.isError !== true);
    check("2. edit did not ask for sign-in", s.needs_auth !== true);
    check("2. edit reports 'Updated in place'", textOf(edit).includes("Updated in place"));
    check("2. edit kept the same entity_id", s.entity_id === entityId);
    check(
      "2. owner_token was re-minted (present after edit)",
      typeof s.owner_token === "string" && s.owner_token.length > 0,
    );
    const url = urlOf(edit);
    check("2. edit returned the drop's URL", !!url);
    if (url) {
      const page = await fetch(url);
      check(`2. drop URL serves (HTTP ${page.status})`, page.ok);
    }

    if (typeof s.owner_token === "string" && s.owner_token.length > 0 && s.owner_token !== ownerToken) {
      if (tokenFile) {
        writeFileSync(tokenFile, s.owner_token + "\n", { mode: 0o600 });
        chmodSync(tokenFile, 0o600);
        console.log("note: the fresh owner_token was written back to CLOUDGRID_SMOKE_REDROP_OWNER_TOKEN_FILE");
      } else {
        console.log(
          "note: the owner_token was re-minted and is not printed. Use " +
            "CLOUDGRID_SMOKE_REDROP_OWNER_TOKEN_FILE to keep the fresh one between runs.",
        );
      }
    }
  }

  await client.close();
} finally {
  try {
    await client?.close();
  } catch {
    /* ignore */
  }
  child.kill("SIGKILL");
}

finish("Redrop smoke passed.");
