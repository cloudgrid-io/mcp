// System CA trust tests.
// Exercises buildCaBundle, installTrustStore, isCertError, and the cert-error
// login preflight against a self-signed HTTPS server. Run: node test/system-ca.test.mjs

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import https from "node:https";
import tls from "node:tls";
import { createRequire } from "node:module";

let failures = 0;
const check = (label, cond) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
};

// ── Generate a self-signed CA + leaf cert at runtime ────────────────────────

const certDir = mkdtempSync(join(tmpdir(), "cgmcp-tls-test-"));

execSync(
  `openssl req -x509 -newkey rsa:2048 -keyout ca.key -out ca.crt -days 1 -nodes -subj '/CN=TestCA' 2>/dev/null`,
  { cwd: certDir },
);
execSync(
  `openssl req -newkey rsa:2048 -keyout leaf.key -out leaf.csr -nodes -subj '/CN=localhost' 2>/dev/null`,
  { cwd: certDir },
);
writeFileSync(
  join(certDir, "ext.cnf"),
  "subjectAltName=DNS:localhost,IP:127.0.0.1\n",
);
execSync(
  `openssl x509 -req -in leaf.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out leaf.crt -days 1 -extfile ext.cnf 2>/dev/null`,
  { cwd: certDir },
);

const caCert = readFileSync(join(certDir, "ca.crt"), "utf8");
const leafKey = readFileSync(join(certDir, "leaf.key"), "utf8");
const leafCert = readFileSync(join(certDir, "leaf.crt"), "utf8");
const caPath = join(certDir, "ca.crt");

// ── Helper: start an HTTPS server with the self-signed leaf ─────────────────

function startServer() {
  return new Promise((resolve) => {
    const server = https.createServer({ key: leafKey, cert: leafCert }, (req, res) => {
      if (req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, method: "POST", body }));
        });
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "not_started" }));
      }
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

// ── 1. isCertError classification ───────────────────────────────────────────

{
  const { isCertError } = await import("../src/system-ca.js");

  check("isCertError: UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    isCertError({ code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" }));
  check("isCertError: SELF_SIGNED_CERT_IN_CHAIN",
    isCertError({ code: "SELF_SIGNED_CERT_IN_CHAIN" }));
  check("isCertError: DEPTH_ZERO_SELF_SIGNED_CERT",
    isCertError({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" }));
  check("isCertError: UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    isCertError({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" }));
  check("isCertError: CERT_HAS_EXPIRED",
    isCertError({ code: "CERT_HAS_EXPIRED" }));
  check("isCertError: ERR_TLS_CERT_ALTNAME_INVALID",
    isCertError({ code: "ERR_TLS_CERT_ALTNAME_INVALID" }));
  check("isCertError: CERT_UNTRUSTED",
    isCertError({ code: "CERT_UNTRUSTED" }));

  check("isCertError: nested cause",
    isCertError({ cause: { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } } }));

  check("isCertError: false for ECONNREFUSED",
    !isCertError({ code: "ECONNREFUSED" }));
  check("isCertError: false for ETIMEDOUT",
    !isCertError({ code: "ETIMEDOUT" }));
  check("isCertError: false for ENOTFOUND",
    !isCertError({ code: "ENOTFOUND" }));
  check("isCertError: false for ECONNRESET",
    !isCertError({ code: "ECONNRESET" }));
  check("isCertError: false for null",
    !isCertError(null));
  check("isCertError: false for undefined",
    !isCertError(undefined));
}

// ── 2. buildCaBundle includes default roots ─────────────────────────────────

{
  const { buildCaBundle } = await import("../src/system-ca.js");
  const bundle = buildCaBundle();

  check("buildCaBundle returns array", Array.isArray(bundle));
  check("buildCaBundle includes default roots (>= rootCertificates.length)",
    bundle.length >= tls.rootCertificates.length);

  const knownDefault = tls.rootCertificates[0];
  check("buildCaBundle contains a known default root",
    bundle.includes(knownDefault));
}

// ── 3. buildCaBundle folds in NODE_EXTRA_CA_CERTS ───────────────────────────

{
  const savedExtra = process.env.NODE_EXTRA_CA_CERTS;
  process.env.NODE_EXTRA_CA_CERTS = caPath;

  const url = new URL("../src/system-ca.js", import.meta.url);
  url.searchParams.set("t", "extra");
  const { buildCaBundle } = await import(url.href);
  const bundle = buildCaBundle();

  check("buildCaBundle with NODE_EXTRA_CA_CERTS includes the custom CA",
    bundle.some((c) => c.includes("BEGIN CERTIFICATE") && caCert.includes(c)));
  check("buildCaBundle with NODE_EXTRA_CA_CERTS still includes defaults",
    bundle.length >= tls.rootCertificates.length);

  if (savedExtra === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
  else process.env.NODE_EXTRA_CA_CERTS = savedExtra;
}

// ── 4. Fails by default: fetch self-signed HTTPS → cert error ───────────────

const { server, port } = await startServer();
const baseUrl = `https://127.0.0.1:${port}`;

{
  let caughtErr;
  try {
    await fetch(`${baseUrl}/auth/status?code=test`);
  } catch (err) {
    caughtErr = err;
  }

  const { isCertError } = await import("../src/system-ca.js");
  check("plain fetch to self-signed server fails", !!caughtErr);
  check("plain fetch error is a cert error", isCertError(caughtErr));
}

// ── 5. Succeeds after installTrustStore with the CA ─────────────────────────

{
  const savedExtra = process.env.NODE_EXTRA_CA_CERTS;
  process.env.NODE_EXTRA_CA_CERTS = caPath;

  const url = new URL("../src/system-ca.js", import.meta.url);
  url.searchParams.set("t", "install");
  const { installTrustStore } = await import(url.href);
  installTrustStore();

  // GET request (sign-in status poll shape)
  let getRes;
  try {
    getRes = await fetch(`${baseUrl}/auth/status?code=test`);
  } catch (err) {
    check("GET after installTrustStore: no error", false);
    console.log("  GET error:", err.message, err.cause?.code);
  }
  if (getRes) {
    check("GET after installTrustStore: 200", getRes.status === 200);
    const body = await getRes.json();
    check("GET response body is correct", body.status === "not_started");
  }

  // POST request (deploy / API call shape)
  let postRes;
  try {
    postRes = await fetch(baseUrl + "/api/v2/plug", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: true }),
    });
  } catch (err) {
    check("POST after installTrustStore: no error", false);
    console.log("  POST error:", err.message, err.cause?.code);
  }
  if (postRes) {
    check("POST after installTrustStore: 200", postRes.status === 200);
    const body = await postRes.json();
    check("POST response body is correct", body.ok === true && body.method === "POST");
  }

  if (savedExtra === undefined) delete process.env.NODE_EXTRA_CA_CERTS;
  else process.env.NODE_EXTRA_CA_CERTS = savedExtra;
}

// ── 6. pollStatusOnce + checkApiConnectivity against the fake server ────────

{
  const savedApiUrl = process.env.CLOUDGRID_API_URL;
  process.env.CLOUDGRID_API_URL = baseUrl;

  const authUrl = new URL("../src/auth.js", import.meta.url);
  authUrl.searchParams.set("t", "system-ca");
  const { pollStatusOnce, checkApiConnectivity } = await import(authUrl.href);

  // checkApiConnectivity should succeed (the server is up and we trust its CA
  // from the installTrustStore call in test 5)
  let connectivityOk = false;
  try {
    await checkApiConnectivity();
    connectivityOk = true;
  } catch (err) {
    console.log("  checkApiConnectivity error:", err.message);
  }
  check("checkApiConnectivity succeeds against fake server", connectivityOk);

  // pollStatusOnce should return not_started (404 maps to not_started, 200
  // returns the JSON body — our fake returns { status: "not_started" })
  let pollResult;
  try {
    pollResult = await pollStatusOnce("test-code");
  } catch (err) {
    console.log("  pollStatusOnce error:", err.message);
  }
  check("pollStatusOnce returns not_started", pollResult?.status === "not_started");

  if (savedApiUrl === undefined) delete process.env.CLOUDGRID_API_URL;
  else process.env.CLOUDGRID_API_URL = savedApiUrl;
}

// ── 7. Proxy composition: ProxyAgent carries the CA ─────────────────────────

{
  const savedProxy = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = "http://proxy.test:8080";
  process.env.NODE_EXTRA_CA_CERTS = caPath;

  const require = createRequire(import.meta.url);
  const undici = require("undici");

  const caUrl = new URL("../src/system-ca.js", import.meta.url);
  caUrl.searchParams.set("t", "proxy-compose");
  const { buildCaBundle, installTrustStore } = await import(caUrl.href);
  const ca = buildCaBundle();

  // Instead of calling installTrustStore (which would break our existing
  // working dispatcher), assert the ProxyAgent can be constructed with TLS opts
  let agent;
  let constructed = false;
  try {
    agent = new undici.ProxyAgent({
      uri: "http://proxy.test:8080",
      requestTls: { ca },
      proxyTls: { ca },
    });
    constructed = true;
  } catch (err) {
    console.log("  ProxyAgent construction error:", err.message);
  }
  check("ProxyAgent with requestTls.ca + proxyTls.ca constructs", constructed);
  if (agent) {
    try { agent.close(); } catch { /* ignore */ }
  }

  delete process.env.HTTPS_PROXY;
  delete process.env.NODE_EXTRA_CA_CERTS;
  if (savedProxy) process.env.HTTPS_PROXY = savedProxy;
}

// ── 8. Cert error login preflight: pollStatusOnce throws cert guidance ──────

{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const inner = new Error("connect");
    inner.code = "UNABLE_TO_GET_ISSUER_CERT_LOCALLY";
    throw new TypeError("fetch failed", { cause: inner });
  };

  const authUrl = new URL("../src/auth.js", import.meta.url);
  authUrl.searchParams.set("t", "cert-poll");
  const { pollStatusOnce, checkApiConnectivity } = await import(authUrl.href);

  // pollStatusOnce cert error path
  let pollErr;
  try {
    await pollStatusOnce("test-code");
  } catch (err) {
    pollErr = err;
  }
  check("pollStatusOnce cert error: throws", !!pollErr);
  check("pollStatusOnce cert error: certError flag", pollErr?.certError === true);
  check("pollStatusOnce cert error: mentions hosted connector",
    pollErr?.message?.includes("mcp-connected.cloudgrid.io"));
  check("pollStatusOnce cert error: mentions NODE_EXTRA_CA_CERTS",
    pollErr?.message?.includes("NODE_EXTRA_CA_CERTS"));
  check("pollStatusOnce cert error: does not say 'try again'",
    !pollErr?.message?.toLowerCase().includes("try again"));

  // checkApiConnectivity cert error path
  let connectErr;
  try {
    await checkApiConnectivity();
  } catch (err) {
    connectErr = err;
  }
  check("checkApiConnectivity cert error: throws", !!connectErr);
  check("checkApiConnectivity cert error: certError flag", connectErr?.certError === true);
  check("checkApiConnectivity cert error: mentions hosted connector",
    connectErr?.message?.includes("mcp-connected.cloudgrid.io"));

  globalThis.fetch = originalFetch;
}

// ── 9. Transient error still gets network/proxy message (no regression) ─────

{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
  };

  const authUrl = new URL("../src/auth.js", import.meta.url);
  authUrl.searchParams.set("t", "transient");
  const { pollStatusOnce } = await import(authUrl.href);

  let errMsg;
  try {
    await pollStatusOnce("test-code");
  } catch (err) {
    errMsg = err.message;
  }
  check("transient error: surfaces ECONNREFUSED", errMsg?.includes("ECONNREFUSED"));
  check("transient error: mentions HTTPS_PROXY", errMsg?.includes("HTTPS_PROXY"));
  check("transient error: no certError flag", !errMsg?.certError);

  globalThis.fetch = originalFetch;
}

// ── 10. installTrustStore never throws (guard test) ─────────────────────────

{
  const url = new URL("../src/system-ca.js", import.meta.url);
  url.searchParams.set("t", "guard");
  const { installTrustStore } = await import(url.href);

  let threw = false;
  try {
    installTrustStore();
  } catch {
    threw = true;
  }
  check("installTrustStore: never throws", !threw);
}

// ── 11. Older Node fallback: no getCACertificates ───────────────────────────

{
  const saved = tls.getCACertificates;
  tls.getCACertificates = undefined;

  const url = new URL("../src/system-ca.js", import.meta.url);
  url.searchParams.set("t", "fallback");
  const { buildCaBundle } = await import(url.href);
  const bundle = buildCaBundle();

  check("fallback: buildCaBundle still returns array", Array.isArray(bundle));
  check("fallback: includes rootCertificates",
    bundle.length >= tls.rootCertificates.length);
  check("fallback: contains a known default root",
    bundle.includes(tls.rootCertificates[0]));

  tls.getCACertificates = saved;
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

server.close();

if (failures > 0) {
  console.log(`\n${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log("\nAll system-ca checks passed.");
