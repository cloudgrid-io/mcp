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
const rotatedTransport = jwt({
  sub: "other-user",
  email: "other-user@example.com",
  exp: NOW / 1000 + 3600,
});

test("explicit login overrides an expired and later rotating transport token", async () => {
  const identity = createWebIdentity({
    initialTransportToken: expiredTransport,
    now: () => NOW,
  });

  assert.equal(await identity.getToken(), null);
  assert.deepEqual(await identity.getCredentialsStatus(), { creds: null, expired: true });

  const saved = await identity.saveToken(freshExplicit);
  assert.equal(saved.email, "chosen-user@example.com");

  const captured = identity.captureTransportToken(rotatedTransport);
  assert.equal(captured.identityChanged, false);
  assert.equal(await identity.getToken(), freshExplicit);
  assert.deepEqual(await identity.getCredentialsStatus(), {
    creds: { jwt: freshExplicit },
    expired: false,
  });
});

test("expired explicit login does not silently fall back to transport identity", async () => {
  const identity = createWebIdentity({
    initialTransportToken: rotatedTransport,
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

  const captured = identity.captureTransportToken(rotatedTransport);

  assert.equal(captured.identityChanged, true);
  assert.equal(await identity.getToken(), rotatedTransport);
});
