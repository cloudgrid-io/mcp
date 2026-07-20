// Proxy support + fetch error surface tests.
// Run: node test/proxy.test.mjs

import { strict as assert } from "node:assert";

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};

// ── 1. Proxy module: resolveProxy (pure, no side effects) ────────────────────

// Clean env before each import — the module reads env at call time, not import
// time, so we can manipulate process.env between calls.

// 1a. HTTPS_PROXY set → returns { proxyUrl, noProxy[] }
{
  process.env.HTTPS_PROXY = "http://corp-proxy:8080";
  process.env.NO_PROXY = "localhost,127.0.0.1,.private.example.test";
  const { resolveProxy } = await import("../src/proxy.js");
  const r = resolveProxy();
  check("HTTPS_PROXY → proxyUrl", r.proxyUrl === "http://corp-proxy:8080");
  check("NO_PROXY → parsed list", Array.isArray(r.noProxy) && r.noProxy.length === 3);
  check("NO_PROXY includes .private.example.test", r.noProxy.includes(".private.example.test"));
  delete process.env.HTTPS_PROXY;
  delete process.env.NO_PROXY;
}

// 1b. https_proxy (lowercase) works
{
  process.env.https_proxy = "http://lower:3128";
  const { resolveProxy } = await import("../src/proxy.js");
  const r = resolveProxy();
  check("https_proxy (lowercase) → proxyUrl", r.proxyUrl === "http://lower:3128");
  delete process.env.https_proxy;
}

// 1c. HTTP_PROXY fallback when no HTTPS_PROXY
{
  process.env.HTTP_PROXY = "http://http-only:8080";
  const { resolveProxy } = await import("../src/proxy.js");
  const r = resolveProxy();
  check("HTTP_PROXY fallback → proxyUrl", r.proxyUrl === "http://http-only:8080");
  delete process.env.HTTP_PROXY;
}

// 1d. No proxy env → null
{
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.HTTP_PROXY;
  delete process.env.http_proxy;
  const { resolveProxy } = await import("../src/proxy.js");
  const r = resolveProxy();
  check("no proxy env → null", r === null);
}

// 1e. HTTPS_PROXY takes precedence over HTTP_PROXY
{
  process.env.HTTPS_PROXY = "http://secure:8080";
  process.env.HTTP_PROXY = "http://insecure:8080";
  const { resolveProxy } = await import("../src/proxy.js");
  const r = resolveProxy();
  check("HTTPS_PROXY wins over HTTP_PROXY", r.proxyUrl === "http://secure:8080");
  delete process.env.HTTPS_PROXY;
  delete process.env.HTTP_PROXY;
}

// ── 2. shouldBypassProxy (NO_PROXY matching) ─────────────────────────────────

{
  process.env.HTTPS_PROXY = "http://proxy:8080";
  process.env.NO_PROXY = "localhost,127.0.0.1,.private.example.test,api.example.com";
  const { resolveProxy, shouldBypassProxy } = await import("../src/proxy.js");
  const cfg = resolveProxy();

  check("bypass: localhost", shouldBypassProxy("localhost", cfg.noProxy));
  check("bypass: 127.0.0.1", shouldBypassProxy("127.0.0.1", cfg.noProxy));
  check("bypass: suffix .private.example.test", shouldBypassProxy("foo.private.example.test", cfg.noProxy));
  check("bypass: exact api.example.com", shouldBypassProxy("api.example.com", cfg.noProxy));
  check("no bypass: api.cloudgrid.io", !shouldBypassProxy("api.cloudgrid.io", cfg.noProxy));
  check("bypass: wildcard *", (() => {
    return shouldBypassProxy("anything.at.all", ["*"]);
  })());
  delete process.env.HTTPS_PROXY;
  delete process.env.NO_PROXY;
}

// ── 3. installProxy: never throws ───────────────────────────────────────────

{
  const { installProxy } = await import("../src/proxy.js");
  // No env set — should be a silent no-op
  delete process.env.HTTPS_PROXY;
  delete process.env.https_proxy;
  delete process.env.HTTP_PROXY;
  delete process.env.http_proxy;
  let threw = false;
  try {
    installProxy();
  } catch {
    threw = true;
  }
  check("installProxy with no env: no throw", !threw);
}

// ── 4. pollStatusOnce error path: surfaces cause + proxy hint ────────────────

{
  // Mock global fetch to throw a TypeError with a cause, as undici does behind
  // a corporate proxy that blocks the connection.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  };

  // Clear module cache so auth.js picks up our mock fetch
  // We need a fresh import — use a query param to bust the module cache.
  const authUrl = new URL("../src/auth.js", import.meta.url);
  authUrl.searchParams.set("t", Date.now());

  let errMsg;
  try {
    const { pollStatusOnce } = await import(authUrl.href);
    await pollStatusOnce("test-code");
  } catch (err) {
    errMsg = err.message;
  }

  check("pollStatusOnce: surfaces ECONNREFUSED", errMsg && errMsg.includes("ECONNREFUSED"));
  check("pollStatusOnce: mentions HTTPS_PROXY", errMsg && errMsg.includes("HTTPS_PROXY"));
  check("pollStatusOnce: mentions hosted connector", errMsg && errMsg.includes("mcp-connected.cloudgrid.io"));

  globalThis.fetch = originalFetch;
}

// ── 5. pollStatusOnce error path: ETIMEDOUT ──────────────────────────────────

{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed", { cause: { code: "ETIMEDOUT" } });
  };

  const authUrl = new URL("../src/auth.js", import.meta.url);
  authUrl.searchParams.set("t", Date.now() + 1);

  let errMsg;
  try {
    const { pollStatusOnce } = await import(authUrl.href);
    await pollStatusOnce("test-code");
  } catch (err) {
    errMsg = err.message;
  }

  check("pollStatusOnce: surfaces ETIMEDOUT", errMsg && errMsg.includes("ETIMEDOUT"));
  globalThis.fetch = originalFetch;
}

// ── 6. pollStatusOnce: 404 still returns not_started (no regression) ─────────

{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("", { status: 404 });

  const authUrl = new URL("../src/auth.js", import.meta.url);
  authUrl.searchParams.set("t", Date.now() + 2);

  const { pollStatusOnce } = await import(authUrl.href);
  const result = await pollStatusOnce("test-code");
  check("pollStatusOnce: 404 → not_started (no regression)", result.status === "not_started");
  globalThis.fetch = originalFetch;
}

// ── 7. pollStatusOnce: plain Error (no cause) still gets hint ────────────────

{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("some network issue");
  };

  const authUrl = new URL("../src/auth.js", import.meta.url);
  authUrl.searchParams.set("t", Date.now() + 3);

  let errMsg;
  try {
    const { pollStatusOnce } = await import(authUrl.href);
    await pollStatusOnce("test-code");
  } catch (err) {
    errMsg = err.message;
  }

  check("pollStatusOnce: plain Error gets hint", errMsg && errMsg.includes("HTTPS_PROXY"));
  check("pollStatusOnce: plain Error includes original message", errMsg && errMsg.includes("some network issue"));
  globalThis.fetch = originalFetch;
}

// ── Done ─────────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll proxy checks passed.");
