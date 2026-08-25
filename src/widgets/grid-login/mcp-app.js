/**
 * @file grid_login MCP App — the sign-in card Claude web renders for grid_login.
 *
 * This module is the UI half of the MCP Apps (SEP-1865) mechanism. It talks to
 * the host over postMessage JSON-RPC via the official `App` class — NOT
 * `window.openai`, which does not exist in Claude's host (that global is the
 * ChatGPT Apps-SDK bridge the old org-picker widget targets).
 *
 * It is bundled into a single self-contained src/widgets/grid-login.html by
 * scripts/build-login-widget.mjs (esbuild inlines this file and the whole
 * @modelcontextprotocol/ext-apps App class). The iframe CSP is deny-by-default,
 * so nothing here may reference a remote script, stylesheet, or font.
 *
 * Security invariant (issue #302): the card NEVER receives, displays, or stores
 * a token. Its only job is to open the sign-in URL in the browser; the browser
 * performs the auth. The most we surface after sign-in is the account email,
 * which grid_login_status returns and which is not a credential.
 */
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import { createPoller } from "./poller.js";

const els = {
  root: document.getElementById("card"),
  status: document.getElementById("status"),
  signin: document.getElementById("signin"),
  check: document.getElementById("check"),
  fallback: document.getElementById("fallback"),
  fallbackUrl: document.getElementById("fallback-url"),
};

// The sign-in URL, lifted from the tool result. Never a token — just the URL
// the browser opens. Held only to wire the button.
let loginUrl = null;

// Pull the sign-in URL out of a grid_login tool result. structuredContent is
// the contract (grid_login sets { login_url }); the text content is the
// text-first fallback that ALSO carries the URL, so we read it if structured is
// missing. This mirrors the server: the URL is never hidden behind the card.
function readLoginUrl(result) {
  const fromStructured = result?.structuredContent?.login_url;
  if (typeof fromStructured === "string" && fromStructured) return fromStructured;
  const text = Array.isArray(result?.content)
    ? result.content.filter((c) => c?.type === "text").map((c) => c.text).join("\n")
    : "";
  const match = text.match(/https?:\/\/\S+/);
  return match ? match[0] : null;
}

function showSignInReady() {
  if (loginUrl) {
    els.fallbackUrl.textContent = loginUrl;
    els.fallbackUrl.setAttribute("href", loginUrl);
    els.fallback.hidden = false;
  }
  els.signin.disabled = !loginUrl;
  els.status.textContent = loginUrl
    ? "Sign in to publish to your grid."
    : "Preparing the sign-in link.";
}

function showAwaitingReturn() {
  els.status.textContent =
    "Finish signing in on the page that opened — I'll notice automatically, or select Check sign-in.";
  els.check.hidden = false;
}

// ── Bounded polling ──────────────────────────────────────────────────────────
// Once "Open sign-in" is clicked, the card polls grid_login_status until it
// resolves. The loop and all its bounds live in poller.js (interval, wall-clock
// ceiling, consecutive-error cap, hidden-tab skip) so they can be unit-tested
// deterministically. Values chosen: a 3s interval keeps it to one round-trip
// every few seconds; a 150s ceiling covers a normal sign-in with margin and
// caps a backgrounded card at ≤50 requests total; 3 consecutive errors stops a
// broken/blocked endpoint fast. The manual "Check sign-in" button stays the
// escape hatch throughout.
const POLL_INTERVAL_MS = 3000;
const POLL_CEILING_MS = 150000;
const MAX_CONSECUTIVE_ERRORS = 3;

let settled = false; // true once we've reached signed-in (never act again)

const poller = createPoller({
  intervalMs: POLL_INTERVAL_MS,
  ceilingMs: POLL_CEILING_MS,
  maxConsecutiveErrors: MAX_CONSECUTIVE_ERRORS,
  check: () => queryStatus(),
  onSuccess: (email) => onSignedIn(email),
  onCeiling: () => {
    els.status.textContent =
      "Still waiting for sign-in. Finish on the page that opened, then select Check sign-in.";
  },
  onGiveUp: () => {
    els.status.textContent =
      "Could not check sign-in automatically. Complete it in the browser, then select Check sign-in.";
  },
});

// One grid_login_status round-trip. Returns a plain outcome; NEVER a token —
// grid_login_status returns { status, email } and email is not a credential.
async function queryStatus() {
  try {
    const result = await app.callServerTool({ name: "grid_login_status", arguments: {} });
    const status = result?.structuredContent?.status;
    const email = result?.structuredContent?.email;
    return { authenticated: status === "authenticated", email, errored: false };
  } catch (err) {
    console.error("[grid-login card] status check failed", err);
    return { authenticated: false, email: null, errored: true };
  }
}

// Reached signed-in state. Update the card (email only, never a token) and tell
// the model so the conversation continues WITHOUT the user typing anything.
async function onSignedIn(email) {
  settled = true;
  poller.stop();
  els.status.textContent = email ? `Signed in as ${email}.` : "Signed in.";
  els.signin.hidden = true;
  els.check.hidden = true;
  await tellModel(email);
}

// Push the outcome to the host so the model continues on its own. Two calls,
// because they do different things (verified against the installed
// @modelcontextprotocol/ext-apps App class, not from memory):
//   • updateModelContext — pushes structured signed-in state into the model's
//     context, but by design does NOT trigger a turn (it waits for the next user
//     message). On its own it would NOT fix the complaint.
//   • sendMessage — adds a message to the conversation, which does trigger the
//     model. This is the half that lets the conversation move on with no "done".
// Both are wrapped so a host that lacks either still leaves the card signed-in
// and the manual path intact.
async function tellModel(email) {
  const who = email ? ` as ${email}` : "";
  try {
    await app.updateModelContext({
      content: [
        {
          type: "text",
          text: `The user has finished signing in to CloudGrid${who}. Sign-in is complete — continue with what they were doing; no need to ask them to confirm.`,
        },
      ],
      structuredContent: email
        ? { status: "authenticated", email }
        : { status: "authenticated" },
    });
  } catch (err) {
    console.error("[grid-login card] updateModelContext failed", err);
  }
  try {
    await app.sendMessage({
      role: "user",
      content: [
        { type: "text", text: `I've signed in to CloudGrid${who}. Please continue.` },
      ],
    });
  } catch (err) {
    console.error("[grid-login card] sendMessage failed", err);
  }
}

const app = new App({ name: "CloudGrid sign-in", version: "1.0.0" });

app.onerror = (err) => console.error("[grid-login card]", err);

app.onhostcontextchanged = (ctx) => {
  if (ctx?.theme) applyDocumentTheme(ctx.theme);
  if (ctx?.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx?.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
};

// The grid_login result arrives here after connect. It carries the URL, never
// a token.
app.ontoolresult = (result) => {
  loginUrl = readLoginUrl(result);
  showSignInReady();
};

els.signin.addEventListener("click", async () => {
  if (!loginUrl) return;
  try {
    await app.openLink({ url: loginUrl });
    showAwaitingReturn();
  } catch (err) {
    console.error("[grid-login card] openLink failed", err);
    // The link is still on-screen (fallback block); the user can open it
    // manually. Never dead-end.
    showAwaitingReturn();
  }
  // Only NOW — after Open sign-in — do we begin polling. An untouched card is
  // silent.
  poller.start();
});

// Check sign-in: the manual escape hatch. It shares queryStatus/onSignedIn with
// the poller, so it stays available even if polling is throttled, the tab was
// backgrounded past the ceiling, or the model-context push is unavailable.
els.check.addEventListener("click", async () => {
  if (settled) return;
  els.check.disabled = true;
  els.status.textContent = "Checking sign-in.";
  const outcome = await queryStatus();
  if (settled) return;
  if (outcome.authenticated) {
    await onSignedIn(outcome.email);
  } else if (outcome.errored) {
    els.status.textContent =
      "Could not check sign-in from here. Complete it in the browser and select Check sign-in.";
    els.check.disabled = false;
  } else {
    els.status.textContent =
      "Still waiting for sign-in. Finish on the page that opened, then check again.";
    els.check.disabled = false;
    // Keep automatic polling going if it stopped (e.g. after the ceiling).
    poller.start();
  }
});

showSignInReady();
app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) app.onhostcontextchanged(ctx);
});
