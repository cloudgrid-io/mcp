// System CA trust for Node's global fetch.
//
// Node's built-in fetch uses Node's bundled Mozilla CA list and ignores the OS
// trust store. On machines with a TLS-inspecting proxy or a custom/corporate
// root CA (installed in the OS keychain but not in Node's bundle), every HTTPS
// call fails with UNABLE_TO_GET_ISSUER_CERT_LOCALLY. This module builds a
// unified CA bundle (Node defaults + OS store + NODE_EXTRA_CA_CERTS) and
// installs it process-wide via tls.setDefaultCACertificates (Node >=22.15).
//
// On older Node (< 22.15) it is a graceful no-op — NODE_EXTRA_CA_CERTS is
// still honored natively when set at launch, and the login preflight surfaces
// the hosted-connector fallback on cert errors.
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

    // Primary mechanism (Node >=22.15): set the process-wide default CA list.
    // This covers Node's built-in fetch and all TLS connections — no userland
    // undici dispatcher needed for the non-proxy case.
    if (ca && typeof tls.setDefaultCACertificates === "function") {
      tls.setDefaultCACertificates(ca);
    }

    // Proxy composition: Node's built-in fetch ignores HTTPS_PROXY, so when a
    // proxy is configured we still need undici's ProxyAgent as the global
    // dispatcher. The ProxyAgent carries the CA bundle in its TLS options.
    // Guarded: if undici fails to load (unexpected, since we pin a compatible
    // version, but guard anyway), proxy is a silent no-op.
    const cfg = resolveProxy();
    if (cfg) {
      try {
        const require = createRequire(import.meta.url);
        const { setGlobalDispatcher, ProxyAgent } = require("undici");
        setGlobalDispatcher(
          new ProxyAgent({
            uri: cfg.proxyUrl,
            noProxy: cfg.noProxy.join(","),
            ...(ca ? { requestTls: { ca }, proxyTls: { ca } } : {}),
          }),
        );
      } catch {
        // undici unavailable or API mismatch — proxy degrades silently.
      }
    }
  } catch {
    // Never break startup.
  }
}
