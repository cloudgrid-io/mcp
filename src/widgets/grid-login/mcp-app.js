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
    "Finish signing in on the page that opened, then come back and select Check sign-in.";
  els.check.hidden = false;
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
});

// Check sign-in: ask the server to finish the flow (grid_login_status). It
// returns { status, email } and NEVER a token, so the card stays token-free.
els.check.addEventListener("click", async () => {
  els.check.disabled = true;
  els.status.textContent = "Checking sign-in.";
  try {
    const result = await app.callServerTool({ name: "grid_login_status", arguments: {} });
    const status = result?.structuredContent?.status;
    const email = result?.structuredContent?.email;
    if (status === "authenticated") {
      els.status.textContent = email ? `Signed in as ${email}.` : "Signed in.";
      els.signin.hidden = true;
      els.check.hidden = true;
    } else {
      els.status.textContent =
        "Still waiting for sign-in. Finish on the page that opened, then check again.";
      els.check.disabled = false;
    }
  } catch (err) {
    console.error("[grid-login card] status check failed", err);
    els.status.textContent =
      "Could not check sign-in from here. Complete it in the browser and I will continue.";
    els.check.disabled = false;
  }
});

showSignInReady();
app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) app.onhostcontextchanged(ctx);
});
