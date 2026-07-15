// test/plug-timeout.test.mjs — the plug upload POST must abort (not hang) when
// the server never responds, and surface a clear "may still be building" error.
import assert from "node:assert/strict";
import { runPlug } from "../src/tools.js";

let failures = 0;
async function test(label, fn) {
  try { await fn(); console.log(`ok   ${label}`); }
  catch (e) { failures++; console.log(`FAIL ${label}\n     ${e.message}`); }
}

const ctx = { edition: "web", getToken: async () => "t", getActiveGrid: async () => null, state: {} };

test("plug upload aborts instead of hanging when the server stalls", async () => {
  // fetch that never resolves unless aborted → proves the AbortSignal fires.
  // The keep-alive timer models a stalled-but-connected server (an open socket):
  // it holds the event loop open so AbortSignal.timeout's own (unref'd) timer
  // actually fires, exactly as a real pending fetch would.
  const hangingFetch = (_url, opts) => new Promise((_res, rej) => {
    const keepAlive = setTimeout(() => {}, 60_000);
    if (opts?.signal) opts.signal.addEventListener("abort", () => {
      clearTimeout(keepAlive);
      rej(new DOMException("aborted", "AbortError"));
    });
  });
  const start = Date.now();
  await assert.rejects(
    () => runPlug(ctx, { html: "<h1>x</h1>", anon: true }, { fetchImpl: hangingFetch, uploadTimeoutMs: 150 }),
    (err) => /timed out|still be building|check.*status/i.test(err.message),
  );
  assert.ok(Date.now() - start < 5000, "should abort ~150ms, not hang");
});

process.on("exit", () => { if (failures) process.exit(1); });
