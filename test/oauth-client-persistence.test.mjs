// OAuth client-registration persistence across process death and replicas — #3060.
//
// The defect: dynamic client registrations lived in a process-local Map with no
// persistence, so every deploy or pod restart wiped them and every user hit
// "Unknown client or redirect_uri. Re-add the connector and try again." at
// /oauth/authorize. The fix makes client_id a signed, self-describing token
// (HMAC over the registered redirect set under MCP_OAUTH_HMAC_SECRET), so a
// registration survives restarts and any replica count with no datastore.
//
// This is deliberately an INTEGRATION test with REAL process death, not a
// same-process Map assertion — a unit test that only proves "the map works"
// reproduces the bug's blind spot. It boots the connected edition
// (MCP_REQUIRE_AUTH=1) as child processes sharing one fixed secret, registers a
// client against one, and proves /oauth/authorize accepts it:
//   1. after the SAME process is killed and reborn with empty memory (restart)
//   2. against a SECOND, independent process on another port (replicas > 1)
// and proves the secret actually BINDS (a third process with a different secret
// rejects it; a tampered client_id is rejected) and that PKCE / redirect
// validation are NOT loosened.
//
// Observable: a VALID client at /oauth/authorize renders the sign-in
// interstitial (200 HTML, no upstream CloudGrid needed); an UNKNOWN/forged one
// gets the 400 "Unknown client" the bug produced. 200-vs-400 is the whole test.

import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const SECRET_A = "test-oauth-hmac-secret-alpha-0000000000000000";
const SECRET_B = "test-oauth-hmac-secret-bravo-1111111111111111";
const REDIRECT = "https://chatgpt.com/connector/oauth/callback";

const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function listen(server, p = 0) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(p, "127.0.0.1", resolve);
  });
  return server.address().port;
}
async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}
async function reservePort() {
  const reservation = createServer();
  const p = await listen(reservation);
  await closeServer(reservation);
  return p;
}

function childEnv(h) {
  return {
    PORT: String(h.port),
    MCP_PUBLIC_URL: h.baseUrl,
    MCP_REQUIRE_AUTH: "1",
    MCP_OAUTH_HMAC_SECRET: h.secret,
    // Point every upstream at a closed loopback port so no test touches prod.
    CLOUDGRID_API_URL: "http://127.0.0.1:1",
    CLOUDGRID_PUBLIC_API_URL: "http://127.0.0.1:1",
    CLOUDGRID_QA_SLACK_WEBHOOK: "",
    MCP_TRUSTED_SERVER_SECRET: "",
    HTTPS_PROXY: "", HTTP_PROXY: "", ALL_PROXY: "",
    https_proxy: "", http_proxy: "", all_proxy: "",
    NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1",
  };
}

function makeHandle(secret) {
  return { secret, port: null, baseUrl: null, child: null, childClosed: null };
}

async function waitForHealth(h, getStderr) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (h.child.exitCode !== null || h.child.signalCode !== null) {
      throw new Error(`web child exited before healthy (${h.child.exitCode}):\n${getStderr()}`);
    }
    try {
      if ((await fetch(`${h.baseUrl}/healthz`)).ok) return;
    } catch {
      // still starting
    }
    await sleep(50);
  }
  throw new Error(`web child did not become healthy:\n${getStderr()}`);
}

async function startChild(h) {
  let stderr = "";
  for (let attempt = 1; attempt <= 20; attempt++) {
    stderr = "";
    h.child = spawn(process.execPath, ["src/web.js"], {
      env: childEnv(h),
      stdio: ["ignore", "ignore", "pipe"],
    });
    h.childClosed = new Promise((resolve) => h.child.once("close", resolve));
    h.child.stderr.setEncoding("utf8");
    h.child.stderr.on("data", (chunk) => { stderr += chunk; });
    try {
      await waitForHealth(h, () => stderr);
      return;
    } catch (err) {
      await stopChild(h);
      if (attempt < 20 && /EADDRINUSE/.test(stderr)) { await sleep(100); continue; }
      throw err;
    }
  }
}

async function stopChild(h) {
  if (!h.child) return;
  if (h.child.exitCode === null && h.child.signalCode === null) h.child.kill("SIGTERM");
  const closed = await Promise.race([h.childClosed.then(() => true), sleep(1500).then(() => false)]);
  if (!closed) { h.child.kill("SIGKILL"); await h.childClosed; }
  h.child = null;
  h.childClosed = null;
}

// A full process death + rebirth on the SAME port with empty memory — the pod
// restart / rollout the bug is about. (A genuine image-change rollout reaches
// the same end state: a new process boots with no in-memory registrations; this
// test cannot build an image, but the surviving-state property it proves is
// identical.)
async function restart(h) {
  await stopChild(h);
  await startChild(h);
}

async function register(h, redirectUris) {
  const res = await fetch(`${h.baseUrl}/oauth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ redirect_uris: redirectUris }),
  });
  const text = await res.text();
  assert.equal(res.status, 201, `register should 201:\n${text}`);
  return JSON.parse(text);
}

// GET /oauth/authorize with a valid PKCE challenge. Returns { status, body }.
// 200 + interstitial marker = client accepted; 400 = rejected.
async function authorize(h, clientId, redirectUri = REDIRECT) {
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const url =
    `${h.baseUrl}/oauth/authorize?response_type=code` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=st1&code_challenge=${challenge}&code_challenge_method=S256`;
  const res = await fetch(url);
  return { status: res.status, body: await res.text() };
}

const ACCEPTED = (r) => r.status === 200 && /Connect CloudGrid/.test(r.body) && /authorize\/poll\?sid=/.test(r.body);

const instanceA = makeHandle(SECRET_A);
const instanceB = makeHandle(SECRET_A); // same secret as A — the "second replica"
const instanceWrong = makeHandle(SECRET_B); // different secret — must reject A's clients

before(async () => {
  for (const h of [instanceA, instanceB, instanceWrong]) {
    h.port = await reservePort();
    h.baseUrl = `http://127.0.0.1:${h.port}`;
  }
  await Promise.all([startChild(instanceA), startChild(instanceB), startChild(instanceWrong)]);
});

after(async () => {
  await Promise.all([stopChild(instanceA), stopChild(instanceB), stopChild(instanceWrong)]);
});

test("[#3060] a client registered before a restart still authorizes after it", async () => {
  const reg = await register(instanceA, [REDIRECT]);
  assert.ok(typeof reg.client_id === "string" && reg.client_id.length > 0, "got a client_id");

  // Pre-restart it authorizes (baseline).
  assert.ok(ACCEPTED(await authorize(instanceA, reg.client_id)), "authorizes before restart");

  // The pod dies and is reborn with EMPTY memory — the exact event that wiped
  // the old in-memory Map and produced "Unknown client" for every user.
  await restart(instanceA);

  const after = await authorize(instanceA, reg.client_id);
  assert.ok(
    ACCEPTED(after),
    `after process death the SAME client_id must still authorize, not 400:\n${after.status} ${after.body}`,
  );
});

test("[#3060] a client registered against one replica authorizes against another", async () => {
  // Registered on A; never seen by B's memory. Same shared secret → B accepts it.
  const reg = await register(instanceA, [REDIRECT]);
  const onB = await authorize(instanceB, reg.client_id);
  assert.ok(
    ACCEPTED(onB),
    `a client registered on replica A must authorize on replica B:\n${onB.status} ${onB.body}`,
  );
});

test("[#3060] the secret BINDS — a different secret rejects the client_id", async () => {
  // Proves the check is a real signature check, not "accept anything shaped like
  // a client_id". Without this, the fix could pass every restart test and be inert.
  const reg = await register(instanceA, [REDIRECT]);
  const onWrong = await authorize(instanceWrong, reg.client_id);
  assert.equal(onWrong.status, 400, "a client_id signed under a different secret must be rejected");
  assert.match(onWrong.body, /Unknown client/);
});

test("[#3060] a tampered client_id is rejected (integrity)", async () => {
  const reg = await register(instanceA, [REDIRECT]);
  // Flip the last char of the signature segment.
  const parts = reg.client_id.split(".");
  parts[2] = (parts[2].slice(0, -1) + (parts[2].endsWith("A") ? "B" : "A"));
  const forged = parts.join(".");
  const res = await authorize(instanceA, forged);
  assert.equal(res.status, 400, "a tampered signature must be rejected");
});

test("[#3060] redirect_uri is still validated strictly against the signed set", async () => {
  const reg = await register(instanceA, [REDIRECT]);
  const res = await authorize(instanceA, reg.client_id, "https://evil.example.com/cb");
  assert.equal(res.status, 400, "a redirect_uri not in the registered set must be rejected");
  assert.match(res.body, /Unknown client/);
});

test("[#3060] PKCE is still mandatory (S256) for a valid client", async () => {
  const reg = await register(instanceA, [REDIRECT]);
  // Valid client + valid redirect, but NO code_challenge → must still 400.
  const url =
    `${instanceA.baseUrl}/oauth/authorize?response_type=code` +
    `&client_id=${encodeURIComponent(reg.client_id)}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT)}&state=st1`;
  const res = await fetch(url);
  assert.equal(res.status, 400, "missing PKCE must be rejected even for a valid client");
  assert.match(await res.text(), /PKCE/);
});
