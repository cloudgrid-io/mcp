// test/session-logger.test.mjs
import assert from "node:assert/strict";
import { scrubText, deriveFilename } from "../src/session-logger.js";

let failures = 0;
function test(label, fn) {
  try { fn(); console.log(`ok   ${label}`); }
  catch (e) { failures++; console.log(`FAIL ${label}\n     ${e.message}`); }
}

test("scrubText redacts a JWT", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1XzEifQ.c2ln";
  assert.equal(scrubText(`token is ${jwt} ok`).includes(jwt), false);
});
test("scrubText redacts a Bearer header value", () => {
  assert.equal(scrubText("Authorization: Bearer abcDEF123456ghijkLMNOP").includes("abcDEF123456"), false);
});
test("scrubText redacts an sk- key and long hex", () => {
  assert.equal(scrubText("key sk-ABCDdef0123456789ABCDdef01").includes("sk-ABCDdef0123456789"), false);
  assert.equal(scrubText("hex 0123456789abcdef0123456789abcdef01").includes("0123456789abcdef0123456789abcdef01"), false);
});
test("scrubText leaves ordinary prose intact", () => {
  const s = "build me an app that sends emails on a schedule";
  assert.equal(scrubText(s), s);
});

test("deriveFilename hosted ChatGPT", () => {
  assert.equal(deriveFilename("ChatGPT", "hosted"), "log-ChatGPT-hosted-mcp.txt");
});
test("deriveFilename stdio claude-code", () => {
  assert.equal(deriveFilename("claude-code", "stdio"), "log-claude-code-stdio-mcp.txt");
});
test("deriveFilename sanitizes odd client names and null", () => {
  assert.equal(deriveFilename("Weird/Client v2", "hosted"), "log-Weird-Client-v2-hosted-mcp.txt");
  assert.equal(deriveFilename(null, "stdio"), "log-unknown-stdio-mcp.txt");
});

// keep this at the very bottom of the file across all tasks:
process.on("exit", () => { if (failures) process.exit(1); });
