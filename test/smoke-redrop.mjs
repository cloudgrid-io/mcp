// Redrop smoke: drop → redrop (changed) → redrop (identical) → fresh, through the
// web edition against the live API. Creates real ephemeral drops (7-day expiry).
// Run from mcp-server: node test/smoke-redrop.mjs
//
// Hard assertions: every call succeeds; `fresh: true` yields a different URL.
// The in-place outcome (updated vs fell-back-to-create) is REPORTED, not asserted —
// it depends on the platform's redrop ownership path being live for this caller
// class. The client behaviour is correct either way (the server never hard-fails).

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
const urlOf = (r) => (r.content?.[0]?.text ?? "").match(/https:\/\/guest\.cloudgrid\.io\/\S+/)?.[0];

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
    name: "cloudgrid_drop",
    arguments: { html: "<h1>redrop smoke v1</h1>", anonymous: true, filename: "redropsmoke.html" },
  });
  const url1 = urlOf(d1);
  check("1. first drop returned a URL", !!url1 && d1.isError !== true);

  const d2 = await client.callTool({
    name: "cloudgrid_drop",
    arguments: { html: "<h1>redrop smoke v2 CHANGED</h1>", anonymous: true, filename: "redropsmoke.html" },
  });
  const t2 = d2.content?.[0]?.text ?? "";
  check("2. redrop succeeded", d2.isError !== true);
  console.log(
    t2.includes("Updated in place")
      ? "    -> UPDATED IN PLACE (platform redrop path live for this caller)"
      : `    -> fell back to create (new URL ${urlOf(d2)}) — platform ownership path not matching yet`,
  );

  const d3 = await client.callTool({
    name: "cloudgrid_drop",
    arguments: { html: "<h1>redrop smoke v2 CHANGED</h1>", anonymous: true, filename: "redropsmoke.html" },
  });
  check("3. identical redrop succeeded", d3.isError !== true);
  console.log(
    (d3.content?.[0]?.text ?? "").includes("No change")
      ? "    -> 202 no-op (idempotent)"
      : "    -> not a no-op (fallback or update)",
  );

  const d4 = await client.callTool({
    name: "cloudgrid_drop",
    arguments: { html: "<h1>redrop smoke fresh</h1>", anonymous: true, fresh: true, filename: "redropsmoke.html" },
  });
  const url4 = urlOf(d4);
  check("4. fresh: true returned a NEW URL", !!url4 && url4 !== urlOf(d3) && url4 !== url1);

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
