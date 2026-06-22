// Shared tool core for both editions of the CloudGrid MCP server.
//
// Two editions register from here:
//   - local (stdio): full toolset, including the CLI-wrapping tools. Identity
//     comes from ~/.cloudgrid/credentials.
//   - web (HTTP, hosted): the light, CLI-free toolset (drop, claim, login).
//     Identity is a per-session token held in memory.
//
// The difference is injected as a `ctx` object, so the tool logic is written once.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { newLoginCode, buildLoginUrl, pollStatusOnce, decodeJwt } from "./auth.js";

const execFileAsync = promisify(execFile);

export const API_BASE = (process.env.CLOUDGRID_API_URL || "https://api.cloudgrid.io").replace(
  /\/+$/,
  "",
);

const ANON_HTML_MAX_BYTES = 2_000_000;

function ok(text) {
  return { content: [{ type: "text", text }] };
}
function fail(text) {
  return { content: [{ type: "text", text }], isError: true };
}

// ── CLI wrapping (local edition only) ──────────────────────────────────────────
async function runCloudgrid(args) {
  try {
    const { stdout, stderr } = await execFileAsync("cloudgrid", args, {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
    });
    return (stdout || stderr || "").trim() || "Done.";
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new Error(
        "The cloudgrid CLI is not installed. Install it with: npm install -g @cloudgrid-io/cli",
      );
    }
    const detail = [err && err.stdout, err && err.stderr, err && err.message]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(detail || "cloudgrid command failed");
  }
}

function cliTool(buildArgs) {
  return async (input) => {
    try {
      return ok(await runCloudgrid(buildArgs(input || {})));
    } catch (err) {
      return fail(err.message);
    }
  };
}

function tryOpenBrowser(url) {
  if (process.env.CLOUDGRID_NO_BROWSER === "1") return;
  const cmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    execFile(cmd, [url], () => {});
  } catch {
    // ignore — the URL is returned to the user anyway
  }
}

// ── Direct-API tools (both editions) ───────────────────────────────────────────
function looksLikeFullHtml(s) {
  const head = s.replace(/^﻿/, "").trimStart().slice(0, 256).toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

async function runDrop(ctx, { html, path: filePath, filename, anonymous, org, fresh }) {
  let bytes;
  let name;
  let type;

  if (filePath) {
    bytes = await readFile(filePath);
    name = filename || basename(filePath);
    type = "application/octet-stream";
  } else if (typeof html === "string" && html.length > 0) {
    let content = html;
    if (!looksLikeFullHtml(content)) {
      content =
        `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8">` +
        `<title>Shared on CloudGrid</title></head>\n<body>\n${content}\n</body>\n</html>\n`;
    }
    bytes = Buffer.from(content, "utf8");
    name = filename || "index.html";
    type = "text/html";
    if (bytes.byteLength > ANON_HTML_MAX_BYTES) {
      throw new Error(
        `This HTML is ${(bytes.byteLength / 1e6).toFixed(2)} MB. Anonymous drops are capped at 2 MB. ` +
          `Trim it, or sign in to publish larger.`,
      );
    }
  } else {
    throw new Error("Provide either `html` (inline content) or `path` (a local file).");
  }

  const headers = {};
  let orgSlug = null;
  if (anonymous !== true) {
    const token = await ctx.getToken();
    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
      orgSlug = org || (await ctx.getActiveOrg());
      if (orgSlug) headers["X-CloudGrid-Org"] = orgSlug;
    }
  }

  // Hosted server: attach the trusted-server credential when available.
  // Falls back gracefully server-side if absent. Only the web edition sets ctx.trustedServer.
  if (!headers["Authorization"] && ctx.trustedServer?.secret && ctx.trustedServer?.endUserId) {
    headers["X-CloudGrid-Trusted-Server-Auth"] = ctx.trustedServer.secret;
    headers["X-CloudGrid-Trusted-Server-End-User"] = ctx.trustedServer.endUserId;
  }

  const isAnonymousCall = !headers["Authorization"];

  // Ownership continuity: replay the platform's anon-session cookie across drops in
  // this session, so cookie-class callers can redrop (and claim) what they dropped.
  if (isAnonymousCall && ctx.state.anonCookie) {
    headers["Cookie"] = ctx.state.anonCookie;
  }

  const form = new FormData();
  // Redrop: a re-drop in the same session updates the previous drop in place (same URL,
  // new version). `fresh: true` forces a new drop. The platform validates ownership and
  // falls back to create if the caller does not own the previous drop.
  // Field appended before the artifact so streaming parsers see it.
  if (fresh !== true && ctx.state.lastDrop?.entity_id) {
    form.append("previous_id", ctx.state.lastDrop.entity_id);
  }
  form.append("artifact", new Blob([bytes], { type }), name);
  if (orgSlug) form.append("org_slug", orgSlug);

  let res;
  try {
    res = await fetch(`${API_BASE}/api/v2/drop/auto`, { method: "POST", headers, body: form });
  } catch (err) {
    throw new Error(`Could not reach CloudGrid at ${API_BASE}: ${err.message}`);
  }

  const raw = await res.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    /* handled below */
  }
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || raw || `HTTP ${res.status}`;
    const hint = data?.error?.details?.[0]?.hint;
    throw new Error(`Drop failed (HTTP ${res.status}): ${msg}${hint ? ` ${hint}` : ""}`);
  }

  // Persist the platform's anon-session cookie for ownership continuity.
  const setCookies = res.headers.getSetCookie
    ? res.headers.getSetCookie()
    : [res.headers.get("set-cookie")].filter(Boolean);
  const anonCookie = (setCookies || [])
    .map((c) => (c || "").split(";")[0])
    .find((c) => c.startsWith("cg_anon_session="));
  if (anonCookie) ctx.state.anonCookie = anonCookie;

  // Remember the drop for redrop continuity — any caller class, any 2xx outcome.
  if (data.entity_id || data.url) {
    ctx.state.lastDrop = {
      entity_id: data.entity_id ?? ctx.state.lastDrop?.entity_id ?? null,
      url: data.url ?? ctx.state.lastDrop?.url ?? null,
    };
  }

  if (res.status === 202) {
    // Idempotent no-op — the bytes matched the live version exactly.
    return `No change — this exact content is already live: ${data.url ?? ctx.state.lastDrop?.url ?? ""}`.trim();
  }

  if (res.status === 200) {
    // Updated in place: same URL, new version, views/reactions intact.
    const lines = [`Updated in place — same link: ${data.url ?? ctx.state.lastDrop?.url ?? ""}`.trim()];
    if (data.owned_by === "authenticated") lines.push("Owned by you.");
    if (data.expires_at) lines.push(`Expires ${data.expires_at}.`);
    return lines.join("\n");
  }

  if (data.owned_by === "authenticated") {
    ctx.state.lastAnonClaim = null;
    const lines = [`Published to your org: ${data.url}`, "Owned by you."];
    if (data.expires_at) lines.push(`Expires ${data.expires_at}.`);
    lines.push("Drop again in this session to update it in place (same link); pass fresh to start a new one.");
    return lines.join("\n");
  }

  // 201 — created new (first drop, fresh: true, or the server fell back to create).
  if (data.claim_url) {
    try {
      ctx.state.lastAnonClaim = {
        token: new URL(data.claim_url).searchParams.get("token"),
        entity_id: data.entity_id,
        url: data.url,
      };
    } catch {
      ctx.state.lastAnonClaim = null;
    }
  }
  const lines = [`Live: ${data.url}`];
  if (data.expires_at) lines.push(`Expires ${data.expires_at} — anonymous drops last 7 days.`);
  if (data.claim_url) lines.push("Sign in, then run cloudgrid_claim to keep it past 7 days.");
  lines.push("Drop again in this session to update it in place (same link); pass fresh to start a new one.");
  return lines.join("\n");
}

async function runClaim(ctx, { claim_token, claim_url }) {
  const token = await ctx.getToken();
  if (!token) {
    throw new Error("You are not signed in. Run cloudgrid_login first, then claim.");
  }
  let claimToken = claim_token;
  if (!claimToken && claim_url) {
    try {
      claimToken = new URL(claim_url).searchParams.get("token");
    } catch {
      claimToken = null;
    }
  }
  if (!claimToken && ctx.state.lastAnonClaim) claimToken = ctx.state.lastAnonClaim.token;
  if (!claimToken) {
    throw new Error("No claim token. Pass claim_token or claim_url from an anonymous drop.");
  }

  let res;
  try {
    res = await fetch(`${API_BASE}/api/v2/anon-claim`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ claim_token: claimToken }),
    });
  } catch (err) {
    throw new Error(`Could not reach CloudGrid at ${API_BASE}: ${err.message}`);
  }

  const raw = await res.text();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch {
    /* handled below */
  }
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || raw || `HTTP ${res.status}`;
    throw new Error(`Claim failed (HTTP ${res.status}): ${msg}`);
  }
  const claimed = Array.isArray(data?.claimed) ? data.claimed : [];
  if (claimed.length === 0) return "Nothing to claim — it may already be claimed or expired.";
  ctx.state.lastAnonClaim = null;
  const lines = [`Claimed ${claimed.length}, now yours:`];
  for (const c of claimed) {
    lines.push(`${c.url}${c.new_expires_at ? ` (expires ${c.new_expires_at})` : ""}`);
  }
  return lines.join("\n");
}


// Change an inspiration's visibility. Authed, direct API — works on the hosted
// edition where the CLI-wrapping share tool is unavailable. Defaults to the drop
// made in this session, so "make it private" needs no ids.
async function runVisibility(ctx, { target, visibility, org }) {
  const token = await ctx.getToken();
  if (!token) {
    throw new Error("Changing visibility needs an owner. Run cloudgrid_login first.");
  }
  const id = target || ctx.state.lastDrop?.entity_id;
  if (!id) {
    throw new Error("No target. Pass the entity id, or drop something first in this session.");
  }
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const orgSlug = org || (await ctx.getActiveOrg());
  if (orgSlug) headers["X-CloudGrid-Org"] = orgSlug;
  let res;
  try {
    res = await fetch(`${API_BASE}/api/v2/inspirations/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ visibility }),
    });
  } catch (err) {
    throw new Error(`Could not reach CloudGrid at ${API_BASE}: ${err.message}`);
  }
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch { /* handled below */ }
  if (!res.ok) {
    const msg = data?.error?.message || raw || `HTTP ${res.status}`;
    const hint = data?.error?.details?.[0]?.hint;
    throw new Error(`Visibility change failed (HTTP ${res.status}): ${msg}${hint ? ` ${hint}` : ""}`);
  }
  const lines = [`Visibility is now ${visibility}.`];
  if (data?.url) lines.push(data.url);
  return lines.join("\n");
}

// ── Registration ───────────────────────────────────────────────────────────────
// Registers the tools onto `server`. ctx.edition decides whether the CLI-wrapping
// tools are included (they need a local machine).
export function registerTools(server, ctx) {
  // Drop — both editions.
  server.tool(
    "cloudgrid_drop",
    "Publish an HTML page or file to CloudGrid and get a public shareable URL. Use when the user wants to share, publish, send, or 'deploy' an artifact, or wants a link to send a friend. Re-drops in the same session update the existing drop in place — same link, new version; pass fresh: true to force a new one. If signed in, it publishes into the user's org as an owned inspiration (30-day expiry); if not, it drops anonymously (7-day expiry, claimable later). Calls the API directly.",
    {
      html: z.string().optional().describe("Inline HTML to publish. A fragment is wrapped into a full document."),
      path: z.string().optional().describe("Path to a local file to upload instead of inline HTML."),
      filename: z.string().optional().describe("Filename to present. Defaults to index.html for inline HTML."),
      anonymous: z.boolean().optional().describe("Force an anonymous drop even if the user is signed in."),
      org: z.string().optional().describe("Org slug to publish into when signed in. Defaults to the active org."),
      fresh: z
        .boolean()
        .optional()
        .describe("Force a new drop even if you already dropped in this session (default: update in place)."),
    },
    async (input) => {
      try {
        return ok(await runDrop(ctx, input || {}));
      } catch (err) {
        return fail(err.message);
      }
    },
  );

  // Claim — both editions.
  server.tool(
    "cloudgrid_claim",
    "Claim an anonymous drop into the signed-in account, so it becomes owned and stops expiring in 7 days. Use after the user signs in to keep something they dropped anonymously. The public URL does not change. Requires sign-in (cloudgrid_login). Calls the API directly.",
    {
      claim_token: z.string().optional().describe("The claim token from an anonymous drop."),
      claim_url: z.string().optional().describe("The claim_url from an anonymous drop; the token is read from it."),
    },
    async (input) => {
      try {
        return ok(await runClaim(ctx, input || {}));
      } catch (err) {
        return fail(err.message);
      }
    },
  );

  // Login — both editions. Local opens a browser and saves to the credentials
  // file; web returns the URL and saves to the session.
  server.tool(
    "cloudgrid_login",
    "Start a CLI-free CloudGrid sign-in. Use when the user wants to log in, sign in, or authenticate, or to claim an anonymous drop. Returns a URL to open in the browser; then call cloudgrid_login_status to finish. Uses CloudGrid's existing OAuth.",
    {},
    async () => {
      const code = newLoginCode();
      ctx.state.pendingLoginCode = code;
      const url = buildLoginUrl(code);
      if (ctx.canOpenBrowser) tryOpenBrowser(url);
      return ok(
        `To sign in, open this URL in your browser and finish with Google:\n${url}\n\n` +
          `After you complete it, run cloudgrid_login_status to finish signing in.`,
      );
    },
  );

  server.tool(
    "cloudgrid_login_status",
    "Finish a sign-in started by cloudgrid_login. Polls once: if you have completed the browser sign-in, it saves your session; otherwise it tells you to finish and try again.",
    {
      code: z.string().optional().describe("The sign-in code. Defaults to the most recent cloudgrid_login."),
    },
    async (input) => {
      const code = input?.code || ctx.state.pendingLoginCode;
      if (!code) return fail("No sign-in is in progress. Run cloudgrid_login first.");
      let status;
      try {
        status = await pollStatusOnce(code);
      } catch (err) {
        return fail(err.message);
      }
      if (status.status === "authenticated" && status.jwt) {
        let info;
        try {
          info = await ctx.saveToken(status.jwt);
        } catch (err) {
          return fail(`Signed in, but could not save credentials: ${err.message}`);
        }
        ctx.state.pendingLoginCode = null;
        const who = info?.email ? ` as ${info.email}` : "";
        return ok(`Signed in${who}. ${ctx.savedLocationNote()}`);
      }
      if (status.status === "pending" || status.status === "not_started") {
        return ok(
          "Still waiting for you to finish signing in. Open the URL from cloudgrid_login " +
            "in your browser, complete it with Google, then run cloudgrid_login_status again.",
        );
      }
      return fail("The sign-in window expired (5 minutes). Run cloudgrid_login to start again.");
    },
  );

  server.tool(
    "cloudgrid_visibility",
    "Change who can see a CloudGrid inspiration: private, space, authenticated, org, or link (anyone with the URL). Use when the user wants to make a drop private, restrict who sees it, or open it up. Defaults to the drop made in this session. Requires sign-in. Calls the API directly.",
    {
      visibility: z.enum(["private", "space", "authenticated", "org", "link"]).describe("The new scope."),
      target: z.string().optional().describe("Entity id. Defaults to this session's last drop."),
      org: z.string().optional().describe("Org of the entity. Defaults to the active org."),
    },
    async (input) => {
      try {
        return ok(await runVisibility(ctx, input || {}));
      } catch (err) {
        return fail(err.message);
      }
    },
  );

  if (ctx.edition !== "local") return; // web edition stops here — no CLI tools

  // ── CLI-wrapping tools (local edition only) ──
  server.tool(
    "cloudgrid_init",
    "Register a new CloudGrid app or agent, optionally seeding a web service. Wraps `cloudgrid init`.",
    {
      kind: z.enum(["app", "agent"]).describe("Entity kind."),
      name: z.string().describe("Slug: 3-40 lowercase alphanumerics and hyphens."),
      type: z.enum(["node", "nextjs", "python", "static"]).optional().describe("Seed a web service of this type."),
      description: z.string().optional().describe("Initial one-line description."),
      dir: z.string().optional().describe("Target directory. Defaults to ./<name>."),
      org: z.string().optional().describe("Override the active org for this init."),
    },
    cliTool(({ kind, name, type, description, dir, org }) => {
      const args = ["init", kind, name];
      if (type) args.push("--type", type);
      if (description) args.push("--description", description);
      if (dir) args.push("--dir", dir);
      if (org) args.push("--org", org);
      return args;
    }),
  );

  server.tool(
    "cloudgrid_plug",
    "Build and deploy a directory or URL. Prints the live URL. Wraps `cloudgrid plug`.",
    {
      target: z.string().optional().describe("Path or URL. Omit to deploy the entity linked to the current directory."),
      org: z.string().optional().describe("Pick or override the org."),
      no_deploy: z.boolean().optional().describe("Register the entity but do not build or deploy."),
    },
    cliTool(({ target, org, no_deploy }) => {
      const args = ["plug"];
      if (target) args.push(target);
      if (org) args.push("--org", org);
      if (no_deploy) args.push("--no-deploy");
      args.push("--no-clipboard", "--no-notify");
      return args;
    }),
  );

  server.tool(
    "cloudgrid_logs",
    "Tail recent logs for an entity. Does not stream; returns a snapshot. Wraps `cloudgrid logs`.",
    {
      name: z.string().optional().describe("Entity name. Omit to use the entity linked to the current directory."),
      tail: z.number().int().positive().optional().describe("Number of recent lines. Default 100."),
      since: z.string().optional().describe("Only logs newer than this, e.g. 5m, 1h, 2d."),
    },
    cliTool(({ name, tail, since }) => {
      const args = ["logs"];
      if (name) args.push(name);
      args.push("--tail", String(tail ?? 100));
      if (since) args.push("--since", since);
      return args;
    }),
  );

  server.tool(
    "cloudgrid_share",
    "Set an entity's visibility and print its URL. Defaults to link (anyone with the URL). Wraps `cloudgrid visibility set`.",
    {
      name: z.string().describe("Entity slug."),
      mode: z.enum(["link", "private", "authenticated", "org", "space"]).optional().describe("Visibility mode. Default link."),
    },
    cliTool(({ name, mode }) => ["visibility", "set", name, mode ?? "link"]),
  );

  server.tool(
    "cloudgrid_feedback",
    "List recent feedback events for the active org. Read-only. Wraps `cloudgrid feedback list`.",
    {
      since: z.string().optional().describe("Only events newer than this, e.g. 24h, 7d."),
      limit: z.number().int().positive().max(200).optional().describe("Number of events. Default 50, max 200."),
      org: z.string().optional().describe("Read another org's feed where you have access."),
    },
    cliTool(({ since, limit, org }) => {
      const args = ["feedback", "list"];
      if (since) args.push("--since", since);
      if (limit) args.push("--limit", String(limit));
      if (org) args.push("--org", org);
      return args;
    }),
  );

  server.tool(
    "cloudgrid_brain",
    "Re-run an entity's Grid Brain hooks to re-classify its description, tags, and diagram. Wraps `cloudgrid brain refresh`.",
    {
      name: z.string().describe("Entity slug."),
      wait: z.boolean().optional().describe("Wait for the refresh to finish. Default true."),
      org: z.string().optional().describe("Target an entity in another org."),
    },
    cliTool(({ name, wait, org }) => {
      const args = ["brain", "refresh", name];
      if (wait !== false) args.push("--wait");
      if (org) args.push("--org", org);
      return args;
    }),
  );
}

export { decodeJwt };
