# Worker Report: System CA Trust for MCP (Correction Round)

## Worktree

```
pwd: /private/tmp/claude-501/-Users-michal-cloudgrid-v2/479905ff-af33-4e8c-855c-8fa474a338be/scratchpad/wt-mcp-systemca
branch: feat/system-ca-trust
node (local): v25.5.0
node (CI): 20.20.2
```

## What Changed (this round)

Two Node-20 failures from CI were fixed:

1. **`installTrustStore()` no longer requires userland undici for the CA path.**
   Refactored to use `tls.setDefaultCACertificates(certs)` (Node >=22.15) as the
   primary mechanism. This sets the process-wide default CA list that Node's
   built-in `fetch` uses — no undici dispatcher needed for the non-proxy case.
   On Node <22.15: graceful no-op (no `setDefaultCACertificates` available).
   Undici is only loaded (guarded) when a proxy is configured.

2. **Downgraded `undici` from `^8.7.0` to `^6.27.0`.**
   undici 8.x requires Node >=22 and crashes on Node 20 with
   `TypeError: webidl.util.markAsUncloneable is not a function`.
   undici 6.x supports `node>=18` and exposes the same `ProxyAgent`,
   `setGlobalDispatcher`, and `Agent` APIs with the same option names
   (`requestTls`, `proxyTls`, `connect.ca`). Verified all APIs work on both
   Node 20.20.2 and Node 25.5.0.

3. **Tests are now version-aware.**
   `test/system-ca.test.mjs` detects `HAS_CA_API = typeof tls.setDefaultCACertificates === "function"`:
   - Node >=22.15: full assertions — `installTrustStore()` makes self-signed
     fetch succeed (GET + POST), `checkApiConnectivity`/`pollStatusOnce` work.
   - Node <22.15: asserts `installTrustStore()` is a graceful no-op (no throw),
     self-signed fetch still fails (expected), `isCertError` classifies it.
   - All `require("undici")` in tests wrapped in try/catch (skips gracefully
     if undici fails to load on an unexpected Node version).

## Files Changed (this round)

| File | What |
|------|------|
| `src/system-ca.js` | Refactored `installTrustStore()`: use `tls.setDefaultCACertificates` as primary; undici only for proxy composition, guarded |
| `test/system-ca.test.mjs` | Version-aware: `HAS_CA_API` gating for sections 5-6; guarded undici require in section 7 |
| `package.json` | `undici` dep changed from `^8.7.0` to `^6.27.0` |
| `package-lock.json` | Updated for undici 6.27.0 |

## Undici Decision

**Chose the preferred approach: pin undici to 6.x** (not the fallback "just guard everything").

Reasoning:
- undici 6.27.0 `engines: { node: ">=18.17" }` — covers the project's
  declared `engines.node: ">=18"` range and CI's Node 20.20.2.
- All three APIs used (`ProxyAgent` with `requestTls`/`proxyTls`,
  `setGlobalDispatcher`, `Agent` with `connect.ca`) exist in undici 6.x
  with identical option names. Verified by constructing each on Node 20.
- This means proxy support works on Node 20 (not degraded to a no-op), which
  is better than the guard-only fallback.

## No Unconditional `require("undici")` on Startup

```
$ grep -rn 'require.*undici' src/
src/proxy.js:51     — inside installProxy()'s try/catch (lines 46-63)
src/system-ca.js:114 — inside installTrustStore()'s nested try/catch (lines 110-120)
```

Both are inside try/catch blocks. `index.js` only calls `installTrustStore()` at
startup. Neither path can crash the process.

## Verification Evidence

### Node 25.5.0 (local, >=22.15 path)

```
$ node test/system-ca.test.mjs
ok   isCertError: UNABLE_TO_GET_ISSUER_CERT_LOCALLY
ok   isCertError: SELF_SIGNED_CERT_IN_CHAIN
ok   isCertError: DEPTH_ZERO_SELF_SIGNED_CERT
ok   isCertError: UNABLE_TO_VERIFY_LEAF_SIGNATURE
ok   isCertError: CERT_HAS_EXPIRED
ok   isCertError: ERR_TLS_CERT_ALTNAME_INVALID
ok   isCertError: CERT_UNTRUSTED
ok   isCertError: nested cause
ok   isCertError: false for ECONNREFUSED
ok   isCertError: false for ETIMEDOUT
ok   isCertError: false for ENOTFOUND
ok   isCertError: false for ECONNRESET
ok   isCertError: false for null
ok   isCertError: false for undefined
ok   buildCaBundle returns array
ok   buildCaBundle includes default roots (>= rootCertificates.length)
ok   buildCaBundle contains a known default root
ok   buildCaBundle with NODE_EXTRA_CA_CERTS includes the custom CA
ok   buildCaBundle with NODE_EXTRA_CA_CERTS still includes defaults
ok   plain fetch to self-signed server fails
ok   plain fetch error is a cert error
ok   GET after installTrustStore: 200
ok   GET response body is correct
ok   POST after installTrustStore: 200
ok   POST response body is correct
ok   checkApiConnectivity succeeds against fake server
ok   pollStatusOnce returns not_started
ok   ProxyAgent with requestTls.ca + proxyTls.ca constructs
ok   pollStatusOnce cert error: throws
ok   pollStatusOnce cert error: certError flag
ok   pollStatusOnce cert error: mentions hosted connector
ok   pollStatusOnce cert error: mentions NODE_EXTRA_CA_CERTS
ok   pollStatusOnce cert error: does not say 'try again'
ok   checkApiConnectivity cert error: throws
ok   checkApiConnectivity cert error: certError flag
ok   checkApiConnectivity cert error: mentions hosted connector
ok   transient error: surfaces ECONNREFUSED
ok   transient error: mentions HTTPS_PROXY
ok   transient error: no certError flag
ok   installTrustStore: never throws
ok   fallback: buildCaBundle still returns array
ok   fallback: includes rootCertificates
ok   fallback: contains a known default root
All system-ca checks passed.
```

### Node 20.20.2 (via npx node@20, <22.15 path)

```
$ npx node@20 test/system-ca.test.mjs
ok   isCertError: UNABLE_TO_GET_ISSUER_CERT_LOCALLY
ok   isCertError: SELF_SIGNED_CERT_IN_CHAIN
ok   isCertError: DEPTH_ZERO_SELF_SIGNED_CERT
ok   isCertError: UNABLE_TO_VERIFY_LEAF_SIGNATURE
ok   isCertError: CERT_HAS_EXPIRED
ok   isCertError: ERR_TLS_CERT_ALTNAME_INVALID
ok   isCertError: CERT_UNTRUSTED
ok   isCertError: nested cause
ok   isCertError: false for ECONNREFUSED
ok   isCertError: false for ETIMEDOUT
ok   isCertError: false for ENOTFOUND
ok   isCertError: false for ECONNRESET
ok   isCertError: false for null
ok   isCertError: false for undefined
ok   buildCaBundle returns array
ok   buildCaBundle includes default roots (>= rootCertificates.length)
ok   buildCaBundle contains a known default root
ok   buildCaBundle with NODE_EXTRA_CA_CERTS includes the custom CA
ok   buildCaBundle with NODE_EXTRA_CA_CERTS still includes defaults
ok   plain fetch to self-signed server fails
ok   plain fetch error is a cert error
skip GET/POST after installTrustStore (Node <22.15 — no setDefaultCACertificates)
ok   Node <22.15: self-signed fetch still fails after installTrustStore
ok   Node <22.15: error is classified as cert error
skip pollStatusOnce + checkApiConnectivity against fake server (Node <22.15)
ok   ProxyAgent with requestTls.ca + proxyTls.ca constructs
ok   pollStatusOnce cert error: throws
ok   pollStatusOnce cert error: certError flag
ok   pollStatusOnce cert error: mentions hosted connector
ok   pollStatusOnce cert error: mentions NODE_EXTRA_CA_CERTS
ok   pollStatusOnce cert error: does not say 'try again'
ok   checkApiConnectivity cert error: throws
ok   checkApiConnectivity cert error: certError flag
ok   checkApiConnectivity cert error: mentions hosted connector
ok   transient error: surfaces ECONNREFUSED
ok   transient error: mentions HTTPS_PROXY
ok   transient error: no certError flag
ok   installTrustStore: never throws
ok   fallback: buildCaBundle still returns array
ok   fallback: includes rootCertificates
ok   fallback: contains a known default root
All system-ca checks passed.
```

### Other suites (Node 25 + Node 20)

```
npm run test:proxy     → All proxy checks passed. (Node 25 + Node 20)
npm run test:auth      → All auth unit checks passed.
npm run smoke          → All smoke checks passed. (Node 25 + Node 20)
```

### Independent self-signed repro (Node 25)

```
--- 1. FAIL without CA trust ---
Expected failure: UNABLE_TO_VERIFY_LEAF_SIGNATURE
--- 2. PASS with setDefaultCACertificates ---
Status: 200 - PASS
--- 3. Public TLS still works ---
Public TLS status: 404 - PASS
--- All reproductions passed ---
```

## PR URL

https://github.com/cloudgrid-io/mcp/pull/139
