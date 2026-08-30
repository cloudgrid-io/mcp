import test from "node:test";
import assert from "node:assert/strict";

import { createWebIdentity } from "../src/web-identity.js";

const NOW = 2_000_000_000_000;

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.`;
}

const expiredTransport = jwt({
  sub: "old-user",
  email: "old-user@example.com",
  exp: NOW / 1000 - 60,
});
const freshExplicit = jwt({
  sub: "chosen-user",
  email: "chosen-user@example.com",
  exp: NOW / 1000 + 3600,
});
const refreshedTransport = jwt({
  sub: "old-user",
  email: "old-user@example.com",
  exp: NOW / 1000 + 3600,
  jti: "refreshed",
});
const differentTransport = jwt({
  sub: "other-user",
  email: "other-user@example.com",
  exp: NOW / 1000 + 3600,
});

test("explicit login survives a same-subject transport refresh", async () => {
  const identity = createWebIdentity({
    initialTransportToken: expiredTransport,
    now: () => NOW,
  });

  assert.equal(await identity.getToken(), null);
  assert.deepEqual(await identity.getCredentialsStatus(), { creds: null, expired: true });

  const saved = await identity.saveToken(freshExplicit);
  assert.equal(saved.email, "chosen-user@example.com");

  const captured = identity.captureTransportToken(refreshedTransport);
  assert.equal(captured.identityChanged, false);
  assert.equal(await identity.getToken(), freshExplicit);
  assert.deepEqual(await identity.getCredentialsStatus(), {
    creds: { jwt: freshExplicit },
    expired: false,
  });
});

test("expired explicit login does not silently fall back to transport identity", async () => {
  const identity = createWebIdentity({
    initialTransportToken: differentTransport,
    now: () => NOW,
  });
  const expiredExplicit = jwt({
    sub: "chosen-user",
    email: "chosen-user@example.com",
    exp: NOW / 1000 - 60,
  });

  await identity.saveToken(expiredExplicit);

  assert.equal(await identity.getToken(), null);
  assert.deepEqual(await identity.getCredentialsStatus(), { creds: null, expired: true });
});

test("a different transport subject clears the explicit login", async () => {
  const identity = createWebIdentity({
    initialTransportToken: refreshedTransport,
    now: () => NOW,
  });
  await identity.saveToken(freshExplicit);

  const captured = identity.captureTransportToken(differentTransport);

  assert.equal(captured.identityChanged, true);
  assert.equal(await identity.getToken(), differentTransport);
  assert.deepEqual(await identity.getCredentialsStatus(), {
    creds: { jwt: differentTransport },
    expired: false,
  });
});

test("transport identity changes are reported before explicit login", async () => {
  const firstTransport = jwt({
    sub: "first-user",
    email: "first-user@example.com",
    exp: NOW / 1000 + 3600,
  });
  const identity = createWebIdentity({
    initialTransportToken: firstTransport,
    now: () => NOW,
  });

  const captured = identity.captureTransportToken(differentTransport);

  assert.equal(captured.identityChanged, true);
  assert.equal(await identity.getToken(), differentTransport);
});

// hasUsableCredential answers the transport guard's question: "is there any
// usable credential right now?" — so the guard consults the identity object
// rather than inspecting the raw Bearer in isolation.

test("hasUsableCredential is false when the only credential is an expired transport token", () => {
  const identity = createWebIdentity({
    initialTransportToken: expiredTransport,
    now: () => NOW,
  });

  assert.equal(identity.hasUsableCredential(), false);
});

test("hasUsableCredential is true when a valid explicit login shadows an expired transport token", async () => {
  const identity = createWebIdentity({
    initialTransportToken: expiredTransport,
    now: () => NOW,
  });

  await identity.saveToken(freshExplicit);

  // #279: the explicit credential is authoritative, so a usable credential
  // exists even though the transport Bearer has expired.
  assert.equal(identity.hasUsableCredential(), true);
});

test("hasUsableCredential is false when there is no credential at all", () => {
  const identity = createWebIdentity({ now: () => NOW });

  assert.equal(identity.hasUsableCredential(), false);
});

test("hasUsableCredential is false for a malformed, undecodable token", () => {
  const identity = createWebIdentity({
    initialTransportToken: "not-a-real-jwt",
    now: () => NOW,
  });

  assert.equal(identity.hasUsableCredential(), false);
});

test("hasUsableCredential is false for a well-formed token missing an exp claim", () => {
  const noExp = jwt({ sub: "old-user", email: "old-user@example.com" });
  const identity = createWebIdentity({
    initialTransportToken: noExp,
    now: () => NOW,
  });

  assert.equal(identity.hasUsableCredential(), false);
});

test("hasUsableCredential is true for a valid transport token", () => {
  const identity = createWebIdentity({
    initialTransportToken: refreshedTransport,
    now: () => NOW,
  });

  assert.equal(identity.hasUsableCredential(), true);
});

test("a revoked token is treated as unusable by getToken", async () => {
  const identity = createWebIdentity({
    initialTransportToken: refreshedTransport,
    now: () => NOW,
  });
  assert.equal(await identity.getToken(), refreshedTransport);

  identity.markRevoked(refreshedTransport);

  assert.equal(await identity.getToken(), null);
});

test("a revoked token is treated as expired by getCredentialsStatus", async () => {
  const identity = createWebIdentity({
    initialTransportToken: refreshedTransport,
    now: () => NOW,
  });
  identity.markRevoked(refreshedTransport);

  assert.deepEqual(await identity.getCredentialsStatus(), { creds: null, expired: true });
});

test("hasUsableCredential is false for a revoked token", () => {
  const identity = createWebIdentity({
    initialTransportToken: refreshedTransport,
    now: () => NOW,
  });
  identity.markRevoked(refreshedTransport);

  assert.equal(identity.hasUsableCredential(), false);
});

test("revoking the transport token does not affect a valid explicit login", async () => {
  const identity = createWebIdentity({
    initialTransportToken: refreshedTransport,
    now: () => NOW,
  });
  await identity.saveToken(freshExplicit);
  identity.markRevoked(refreshedTransport);

  assert.equal(await identity.getToken(), freshExplicit);
  assert.equal(identity.hasUsableCredential(), true);
});

test("revoking the explicit token falls through to transport", async () => {
  const identity = createWebIdentity({
    initialTransportToken: refreshedTransport,
    now: () => NOW,
  });
  await identity.saveToken(freshExplicit);
  identity.markRevoked(freshExplicit);

  assert.equal(await identity.getToken(), null);
  assert.equal(identity.hasUsableCredential(), false);
});
