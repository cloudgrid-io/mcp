// Unit test for the auth helpers — the parts that do not need a real Google login.
// Exercises decodeJwt and writeCredentials against a throwaway CLOUDGRID_HOME, so
// it never touches the real ~/.cloudgrid/credentials. Run: node test/auth.test.mjs

import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the helpers at a temp home BEFORE importing them.
const home = mkdtempSync(join(tmpdir(), "cgmcp-auth-"));
process.env.CLOUDGRID_HOME = home;

const { decodeJwt, writeCredentials, credentialsPath } = await import("../src/auth.js");

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) failures++;
}

// Build a synthetic JWT (header.payload.sig) with known claims.
function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const claims = { sub: "u_test_123", email: "pm@example.com", name: "PM Test" };
const jwt = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(claims)}.signaturepart`;

const decoded = decodeJwt(jwt);
check("decodeJwt reads email", decoded.email === "pm@example.com");
check("decodeJwt reads sub", decoded.sub === "u_test_123");
check("decodeJwt is safe on garbage", Object.keys(decodeJwt("not-a-jwt")).length === 0);

const creds = await writeCredentials(jwt);
check("writeCredentials returns jwt", creds.jwt === jwt);
check("writeCredentials maps email", creds.email === "pm@example.com");
check("writeCredentials maps user_id from sub", creds.user_id === "u_test_123");
check("writeCredentials set issued_at", typeof creds.issued_at === "string" && creds.issued_at.length > 0);

const path = credentialsPath();
check("credentials file is under the temp home", path.startsWith(home));
const onDisk = JSON.parse(readFileSync(path, "utf8"));
check("on-disk jwt matches", onDisk.jwt === jwt);
check("on-disk shape is {jwt,issued_at,email,user_id}", JSON.stringify(Object.keys(onDisk).sort()) === JSON.stringify(["email", "issued_at", "jwt", "user_id"]));
const mode = statSync(path).mode & 0o777;
check(`credentials file is 0600 (got ${mode.toString(8)})`, mode === 0o600);

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll auth unit checks passed.");
