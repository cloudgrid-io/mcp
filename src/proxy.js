// Corporate proxy support for Node's global fetch (undici).
//
// Node's built-in fetch ignores HTTPS_PROXY / HTTP_PROXY. This module reads
// the standard proxy env vars and, when set, installs an undici ProxyAgent as
// the global dispatcher so every subsequent fetch() honors the proxy.
//
// Fully guarded: if undici is unavailable or the env is unset, this is a
// silent no-op. Never throws at startup.

import { createRequire } from "node:module";

export function resolveProxy() {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    null;

  if (!proxyUrl) return null;

  const raw =
    process.env.NO_PROXY ||
    process.env.no_proxy ||
    "";

  const noProxy = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return { proxyUrl, noProxy };
}

export function shouldBypassProxy(hostname, noProxyList) {
  if (!noProxyList || noProxyList.length === 0) return false;
  for (const entry of noProxyList) {
    if (entry === "*") return true;
    if (hostname === entry) return true;
    if (entry.startsWith(".") && hostname.endsWith(entry)) return true;
  }
  return false;
}

export function installProxy() {
  try {
    const cfg = resolveProxy();
    if (!cfg) return;

    const require = createRequire(import.meta.url);
    const { ProxyAgent, setGlobalDispatcher } = require("undici");

    setGlobalDispatcher(
      new ProxyAgent({
        uri: cfg.proxyUrl,
        noProxy: cfg.noProxy.join(","),
      }),
    );
  } catch {
    // Silent: undici unavailable or ProxyAgent unsupported — fall through to
    // default (unproxied) fetch. Never break startup.
  }
}
