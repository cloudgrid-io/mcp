// System CA trust for Node's global fetch (undici).
//
// Node's built-in fetch uses Node's bundled Mozilla CA list and ignores the OS
// trust store. On machines with a TLS-inspecting proxy or a custom/corporate
// root CA (installed in the OS keychain but not in Node's bundle), every HTTPS
// call fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY. This module builds a
// unified CA bundle (Node defaults + OS store + NODE_EXTRA_CA_CERTS) and
// installs it as the global undici dispatcher, composing with proxy support.
//
// Fully guarded: on any failure this is a silent no-op. Never throws at startup.

import tls from "node:tls";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolveProxy } from "./proxy.js";

const CERT_ERROR_CODES = new Set([
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_UNTRUSTED",
]);

export function isCertError(err) {
  if (!err) return false;
  if (typeof err.code === "string" && CERT_ERROR_CODES.has(err.code)) return true;
  if (err.cause) return isCertError(err.cause);
  return false;
}

function parsePemFile(path) {
  try {
    const raw = readFileSync(path, "utf8");
    const certs = [];
    const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
    let m;
    while ((m = re.exec(raw)) !== null) certs.push(m[0]);
    return certs;
  } catch {
    return [];
  }
}

export function buildCaBundle() {
  const seen = new Set();
  const certs = [];

  function add(list) {
    if (!Array.isArray(list)) return;
    for (const c of list) {
      if (c && !seen.has(c)) {
        seen.add(c);
        certs.push(c);
      }
    }
  }

  try {
    if (typeof tls.getCACertificates === "function") {
      add(tls.getCACertificates("default"));
    } else {
      add(tls.rootCertificates);
    }
  } catch { /* guard */ }

  try {
    if (typeof tls.getCACertificates === "function") {
      add(tls.getCACertificates("system"));
    }
  } catch { /* guard */ }

  try {
    if (typeof tls.getCACertificates === "function") {
      add(tls.getCACertificates("extra"));
    }
  } catch { /* guard */ }

  try {
    if (process.env.NODE_EXTRA_CA_CERTS) {
      add(parsePemFile(process.env.NODE_EXTRA_CA_CERTS));
    }
  } catch { /* guard */ }

  return certs.length > 0 ? certs : null;
}

export function installTrustStore() {
  try {
    const ca = buildCaBundle();
    const cfg = resolveProxy();

    const require = createRequire(import.meta.url);
    const { setGlobalDispatcher, ProxyAgent, Agent } = require("undici");

    if (cfg) {
      setGlobalDispatcher(
        new ProxyAgent({
          uri: cfg.proxyUrl,
          noProxy: cfg.noProxy.join(","),
          ...(ca ? { requestTls: { ca }, proxyTls: { ca } } : {}),
        }),
      );
    } else if (ca) {
      setGlobalDispatcher(new Agent({ connect: { ca } }));
    }
  } catch {
    // Silent: undici unavailable or API unsupported. Never break startup.
  }
}
