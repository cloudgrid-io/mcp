// Redrop smoke: drop → redrop (changed) → fresh, through the web edition
// against the live API. Creates real ephemeral drops (7-day expiry).
// Run from mcp-server: node test/smoke-redrop.mjs
//
// Unified plug contract (0.7.0 / spec v2): a re-plug passes `target_entity_id`
// (+ the anon `owner_token`) and UPDATES THE SAME entity — same slug, same URL,
// new content ("Updated in place"). Omitting the target mints a NEW entity
// (different URL).
//
// Anon-cap aware: a 429 means the shared daily anonymous cap is exhausted — a
// platform rate limit, not a functional failure. Each step skips on 429.

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 8767;
const child = spawn("node", ["src/web.js"], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "ignore", "inherit"],
});

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}
const textOf = (r) => r.content?.[0]?.text ?? "";
const urlOf = (r) => textOf(r).match(/https:\/\/guest\.cloudgrid\.io\/\S+/)?.[0];
const isRateLimited = (r) =>
  /HTTP 429|daily anonymous-drop limit|reached the daily/i.test(textOf(r));

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

  const d1 = await client.callTool({
    name: "grid_deploy",
    arguments: { html: "<h1>redrop smoke v1</h1>", anon: true, filename: "redropsmoke.html" },
  });
  if (isRateLimited(d1)) {
    console.log("skip redrop smoke — anon daily cap exhausted (429); nothing to assert");
  } else {
    const url1 = urlOf(d1);
    const s1 = d1.structuredContent ?? {};
    check("1. first drop returned a URL", !!url1 && d1.isError !== true);
    check("1. drop returned the entity_id re-plug handle", typeof s1.entity_id === "string" && s1.entity_id.length > 0);
    check("1. anon drop returned an owner_token", typeof s1.owner_token === "string" && s1.owner_token.length > 0);

    const d2 = await client.callTool({
      name: "grid_deploy",
      arguments: {
        html: "<h1>redrop smoke v2 CHANGED</h1>",
        anon: true,
        filename: "redropsmoke.html",
        target_entity_id: s1.entity_id,
        owner_token: s1.owner_token,
      },
    });
    if (isRateLimited(d2)) {
      console.log("skip in-place assertions — anon daily cap hit on the edit (429)");
    } else {
      const url2 = urlOf(d2);
      const s2 = d2.structuredContent ?? {};
      check("2. redrop succeeded", d2.isError !== true);
      check("2. redrop UPDATED IN PLACE (same URL)", !!url2 && url2 === url1);
      check("2. redrop reports 'Updated in place'", textOf(d2).includes("Updated in place"));
      check("2. redrop kept the same entity_id", s2.entity_id === s1.entity_id);
      check(
        "2. owner_token was refreshed (present after edit)",
        typeof s2.owner_token === "string" && s2.owner_token.length > 0,
      );

      const d3 = await client.callTool({
        name: "grid_deploy",
        arguments: { html: "<h1>redrop smoke fresh</h1>", anon: true, filename: "redropsmoke.html" },
      });
      if (isRateLimited(d3)) {
        console.log("skip fresh assertion — anon daily cap hit (429)");
      } else {
        const url3 = urlOf(d3);
        check("3. a fresh plug (no target) minted a NEW entity (different URL)", !!url3 && url3 !== url1);
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

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nRedrop smoke passed. (Drops auto-expire in 7 days.)");
