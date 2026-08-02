// The root index page and favicon for the hosted web edition.
//
// Nothing in the MCP spec lives at "/" — clients discover this server at /mcp and,
// on the sign-in-required host, through the OAuth metadata under /.well-known. So
// this page exists purely for the human who pastes the hostname into a browser: it
// says what the endpoint is, which URL to give an MCP client, and which auth
// posture THIS host is on. Both hosts run the same image and are otherwise
// indistinguishable from the outside, so the posture line is the point.
//
// One template, both postures. The auth line is derived from the same
// requireAuth flag that gates the OAuth routes and the 401 challenge, so the page
// cannot drift from the behaviour it describes.
//
// Self-contained by design: no third-party scripts, no external fonts, no
// analytics. This origin also serves the OAuth interstitial, and an auth surface
// is the wrong place to introduce a third-party beacon.

import { readFileSync } from "node:fs";

// Read once at boot: the file ships inside the package (see "files" in
// package.json) and the container runs a read-only root filesystem, so this is a
// single image-layer read rather than per-request disk IO.
const FAVICON_PNG = readFileSync(new URL("./assets/favicon.png", import.meta.url));

const DOCS_URL = "https://docs.cloudgrid.io";

// Attribute-context escape. The public base comes from the environment, so it is
// interpolated into href/content attributes rather than trusted verbatim.
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const DESCRIPTION =
  "Model Context Protocol endpoint for CloudGrid. Connect an MCP client to build, " +
  "plug and publish apps from the conversation you are already in.";

export function landingHtml({ base, requireAuth }) {
  const b = esc(base);
  // The two postures. Each says only what is true of the host serving it.
  const posture = requireAuth
    ? "This endpoint requires sign-in. Your client prompts you to connect the first time you add it."
    : "This endpoint is anonymous-first. You can start without an account, and sign in when you want to keep what you build.";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CloudGrid MCP</title>
<link rel="icon" type="image/png" href="/favicon.png">
<meta name="description" content="${esc(DESCRIPTION)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="CloudGrid">
<meta property="og:title" content="CloudGrid MCP">
<meta property="og:description" content="${esc(DESCRIPTION)}">
<meta property="og:url" content="${b}/">
<meta property="og:image" content="${b}/favicon.png">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="CloudGrid MCP">
<meta name="twitter:description" content="${esc(DESCRIPTION)}">
<meta name="twitter:image" content="${b}/favicon.png">
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font-family: Inter, system-ui, sans-serif; background:#0d0d0f; color:#fafafa; }
  main { max-width:34rem; padding:2.5rem; }
  h1 { font-size:1.5rem; margin:0 0 .75rem; }
  p { line-height:1.6; margin:0 0 1rem; }
  p.lead { opacity:.85; }
  p.posture { opacity:.7; font-size:.95rem; }
  .label { font-size:.75rem; letter-spacing:.08em; text-transform:uppercase;
           opacity:.5; margin:0 0 .5rem; }
  code { display:block; padding:.85rem 1rem; border-radius:8px; background:#17171b;
         border:1px solid #2a2a31; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
         font-size:.95rem; overflow-x:auto; }
  footer { margin-top:2rem; font-size:.9rem; opacity:.6; }
  a { color:#fafafa; }
</style>
</head>
<body><main>
  <h1>CloudGrid MCP</h1>
  <p class="lead">${esc(DESCRIPTION)}</p>
  <p class="label">Endpoint</p>
  <code>${b}/mcp</code>
  <p class="posture">${esc(posture)}</p>
  <footer><a href="${DOCS_URL}">Documentation</a></footer>
</main></body>
</html>`;
}

/**
 * Mounts the index page and favicon routes.
 *
 * These are unauthenticated static reads on both postures, alongside the existing
 * /healthz. The sign-in-required host's 401 challenge lives inside the POST /mcp
 * handler rather than in middleware, so serving a page here does not weaken it and
 * does not interfere with a client's OAuth connect.
 *
 * publicBase — this server's public origin, used for the absolute Open Graph URLs.
 * opts.requireAuth — mirrors the MCP_REQUIRE_AUTH posture; selects the auth line.
 */
export function mountLanding(app, publicBase, opts = {}) {
  const base = String(publicBase).replace(/\/+$/, "");
  const requireAuth = Boolean(opts.requireAuth);
  const html = landingHtml({ base, requireAuth });

  app.get("/", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(html);
  });

  function sendIcon(_req, res) {
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(FAVICON_PNG);
  }

  app.get("/favicon.png", sendIcon);
  // A browser requests /favicon.ico on its own whenever a document declares no
  // icon, so the legacy path answers with the same PNG bytes instead of 404ing.
  // Browsers sniff the actual image format; the .ico extension is not binding.
  app.get("/favicon.ico", sendIcon);
}
