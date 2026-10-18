// Terminal error handling for the hosted web edition (src/web-errors.js).
//
// An error that reaches Express from a route — thrown synchronously, rejected from
// an async handler, or raised by the body parser — must come back as a fixed,
// generic response: a JSON-RPC 2.0 error on /mcp, plain text elsewhere. Never the
// error's message, never a stack frame, never a file path. NODE_ENV is left unset
// throughout, because that is the case where Express's default handler is verbose.
//
// Two layers:
//   - Unit: a small Express app with deliberately failing routes and the same
//     handler web.js mounts. The only way to drive a route that throws, since the
//     real routes are written not to.
//   - Integration: the real src/web.js, spawned, sent a malformed JSON body on
//     POST /mcp. Proves the handler is actually mounted on the real server.
//
// Run: node --test test/web-errors.test.mjs

import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import express from "express";

import { createErrorHandler } from "../src/web-errors.js";

delete process.env.NODE_ENV;

// The thrown message carries a marker and a path, so a leak of either is visible.
const MARKER = "SENSITIVE-DETAIL-7f3a /srv/app/secret-module.js";

// Nothing in a client-facing error body may look like error internals.
function assertGeneric(text) {
  assert.ok(!text.includes("SENSITIVE-DETAIL"), `body leaks the error message: ${text}`);
  assert.ok(!/\bat\s+\S+\s*\(/.test(text) && !/\n\s+at\s/.test(text), `body has a stack frame: ${text}`);
  assert.ok(!/\.m?js\b/.test(text), `body names a source file: ${text}`);
  assert.ok(!/stack/i.test(text), `body mentions a stack: ${text}`);
  assert.ok(!/node_modules|file:\/\/|\/srv\/|\/private\/|\/Users\//.test(text), `body has a path: ${text}`);
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

describe("unit: generic responses from failing routes", () => {
  let server;
  let base;
  const logged = [];

  before(async () => {
    const app = express();
    app.use(express.json({ limit: "1kb" }));
    const boom = () => { throw new Error(MARKER); };
    app.post("/mcp", (req, _res) => {
      if (req.headers["x-mode"] === "async") return Promise.reject(new Error(MARKER));
      if (req.headers["x-mode"] === "async-await") return (async () => { await sleep(1); boom(); })();
      boom();
    });
    app.get("/other", (req) => {
      if (req.query.mode === "async") return Promise.reject(new Error(MARKER));
      boom();
    });
    app.get("/partial", (_req, res) => {
      res.status(200).type("text/plain");
      res.write("partial-");
      throw new Error(MARKER);
    });
    app.use(createErrorHandler({ emit: (...a) => logged.push(a.join(" ")) }));
    server = createServer(app);
    base = `http://127.0.0.1:${await listen(server)}`;
  });

  after(() => new Promise((r) => server.close(r)));

  const post = (headers, body = '{"jsonrpc":"2.0","id":1,"method":"x"}') =>
    fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

  for (const mode of ["sync", "async", "async-await"]) {
    test(`/mcp ${mode} failure -> 500 JSON-RPC Internal error, nothing else`, async () => {
      const res = await post({ "x-mode": mode });
      assert.equal(res.status, 500);
      assert.match(res.headers.get("content-type"), /application\/json/);
      const text = await res.text();
      assertGeneric(text);
      assert.deepEqual(JSON.parse(text), {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal error" },
        id: null,
      });
    });
  }

  for (const mode of ["sync", "async"]) {
    test(`other path ${mode} failure -> 500 plain generic text`, async () => {
      const res = await fetch(`${base}/other?mode=${mode}`);
      assert.equal(res.status, 500);
      assert.match(res.headers.get("content-type"), /text\/plain/);
      const text = await res.text();
      assertGeneric(text);
      assert.equal(text, "Internal Server Error");
    });
  }

  test("/mcp malformed JSON -> 400 JSON-RPC Parse error, body not echoed", async () => {
    const res = await post({}, '{"jsonrpc": SENSITIVE-DETAIL-7f3a');
    assert.equal(res.status, 400);
    const text = await res.text();
    assertGeneric(text);
    assert.deepEqual(JSON.parse(text), {
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error" },
      id: null,
    });
  });

  test("/mcp oversized body -> 413 JSON-RPC Invalid Request", async () => {
    const res = await post({}, JSON.stringify({ pad: "x".repeat(4096) }));
    assert.equal(res.status, 413);
    const text = await res.text();
    assertGeneric(text);
    assert.equal(JSON.parse(text).error.code, -32600);
  });

  test("headers already sent -> connection closed, nothing more written", async () => {
    let text = "";
    try {
      const res = await fetch(`${base}/partial`);
      text = await res.text();
    } catch {
      // An aborted body is the expected outcome; whatever arrived is checked below.
    }
    assertGeneric(text);
  });

  test("log names the failure but never the request body", () => {
    const joined = logged.join("\n");
    assert.match(joined, /unhandled error on POST \/mcp -> 500/);
    assert.match(joined, /rejected request on POST \/mcp -> 400 \(entity\.parse\.failed\)/);
    // The 4xx line must not carry the body-parser message, which quotes the body.
    const parseLine = logged.find((l) => l.includes("entity.parse.failed"));
    assert.ok(!parseLine.includes("SENSITIVE-DETAIL"), parseLine);
  });
});

describe("integration: the real web edition", () => {
  const handle = { child: null, baseUrl: "", closed: null };
  let stderr = "";

  before(async () => {
    const probe = createServer();
    const port = await listen(probe);
    await new Promise((r) => probe.close(r));
    handle.baseUrl = `http://127.0.0.1:${port}`;
    const env = {
      PATH: process.env.PATH,
      PORT: String(port),
      MCP_PUBLIC_URL: handle.baseUrl,
      CLOUDGRID_API_URL: "http://127.0.0.1:9",
      CLOUDGRID_PUBLIC_API_URL: "http://127.0.0.1:9",
      CLOUDGRID_QA_SLACK_WEBHOOK: "",
      MCP_TRUSTED_SERVER_SECRET: "",
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
      HTTPS_PROXY: "", HTTP_PROXY: "", https_proxy: "", http_proxy: "",
    };
    handle.child = spawn(process.execPath, ["src/web.js"], { env, stdio: ["ignore", "ignore", "pipe"] });
    handle.closed = new Promise((resolve) => handle.child.once("close", resolve));
    handle.child.stderr.setEncoding("utf8");
    handle.child.stderr.on("data", (c) => { stderr += c; });
    for (let i = 0; i < 100; i++) {
      if (handle.child.exitCode !== null) throw new Error(`web child exited early:\n${stderr}`);
      try { if ((await fetch(`${handle.baseUrl}/healthz`)).ok) return; } catch { /* starting */ }
      await sleep(50);
    }
    throw new Error(`web child did not become healthy:\n${stderr}`);
  });

  after(async () => {
    if (handle.child && handle.child.exitCode === null) handle.child.kill("SIGTERM");
    await handle.closed;
  });

  test("POST /mcp with a malformed body -> JSON-RPC Parse error, no internals", async () => {
    const res = await fetch(`${handle.baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: '{"jsonrpc": SENSITIVE-DETAIL-7f3a',
    });
    const text = await res.text();
    assert.equal(res.status, 400, text);
    assertGeneric(text);
    assert.deepEqual(JSON.parse(text), {
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error" },
      id: null,
    });
    assert.ok(!stderr.includes("SENSITIVE-DETAIL"), "the request body reached the log");
  });

  test("the server is still up afterwards", async () => {
    const res = await fetch(`${handle.baseUrl}/healthz`);
    assert.equal(res.status, 200);
  });
});
