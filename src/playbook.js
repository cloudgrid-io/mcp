// Agent Core playbook + corpus retrieval for the CloudGrid MCP server.
// Extracted verbatim from src/tools.js (refactor: split tools.js into modules).

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";

// ── Agent Core: orientation playbook + corpus fetch ─────────────────────────
// The playbook lives in corpus/playbook.md (markdown, not a JS string - a
// backticked word once terminated the old template literal and broke the
// build). Loaded once at startup; also retrievable via
// grid_get_template({kind:"doc", name:"playbook"}) like any corpus doc.
// It front-loads the operating rule for any agent that reaches for CloudGrid. It is returned verbatim by grid_start so the model orients once
// and then follows the workflow → template → build → deploy → share loop.
export const PLAYBOOK = readFileSync(
  new URL("./corpus/playbook.md", import.meta.url),
  "utf-8",
).trim();

// The corpus subdirectories that grid_get_template serves, keyed by `kind`. Each
// lives in its own subtree of src/corpus/ (populated by scripts/snapshot-corpus.mjs
// via directory-walk) so it is NOT chunked into the BM25 docs index, which reads
// only the top-level *.md files. `doc` maps to those top-level files; `rule`
// reads an optional rules/ subtree.
const CORPUS_ROOT = new URL("./corpus/", import.meta.url);
const FETCH_KIND_DIRS = {
  workflow: "workflows",
  template: "templates",
  example: "examples",
  rule: "rules",
  troubleshooting: "troubleshooting",
  doc: "", // top-level src/corpus/*.md
};

// Read the primary file of a corpus entry directory: prefer index.html, else the
// single file, else null when the directory has no single obvious entry.
function readEntryDir(dirUrl) {
  let names;
  try {
    names = readdirSync(dirUrl).filter((n) => !n.startsWith("."));
  } catch {
    return null;
  }
  const files = names.filter((n) => {
    try {
      return statSync(new URL(n, dirUrl)).isFile();
    } catch {
      return false;
    }
  });
  const pick =
    files.find((n) => n === "index.html") ||
    files.find((n) => n === "index.md") ||
    files.find((n) => n.endsWith(".html")) ||
    files.find((n) => n.endsWith(".md")) ||
    (files.length === 1 ? files[0] : null);
  if (!pick) return null;
  try {
    return readFileSync(new URL(pick, dirUrl), "utf-8");
  } catch {
    return null;
  }
}

// Deterministic corpus retrieval for grid_get_template. Resolves {kind, name} to a
// single content string, or null when nothing matches. Name is sanitized to a
// safe slug so it can never escape the corpus directory.
export function fetchCorpus(kind, name) {
  const subdir = FETCH_KIND_DIRS[kind];
  if (subdir === undefined) return null;
  const slug = String(name || "").replace(/[^a-zA-Z0-9._-]/g, "");
  if (!slug || slug === "." || slug === "..") return null;

  const base = subdir ? new URL(`${subdir}/`, CORPUS_ROOT) : CORPUS_ROOT;

  // 1. Direct file: <base>/<slug>.md or <base>/<slug>.html
  for (const ext of [".md", ".html"]) {
    const fileUrl = new URL(`${slug}${ext}`, base);
    if (existsSync(fileUrl) && statSync(fileUrl).isFile()) {
      return readFileSync(fileUrl, "utf-8");
    }
  }
  // 2. Entry directory: <base>/<slug>/ (index.html or single file)
  const dirUrl = new URL(`${slug}/`, base);
  if (existsSync(dirUrl) && statSync(dirUrl).isDirectory()) {
    return readEntryDir(dirUrl);
  }
  return null;
}

// The workflow index for grid_start: read from the front-matter of each
// corpus/workflows/*.md file (name / when / summary / deploy). Falls back
// gracefully when the directory is absent (e.g. corpus not yet snapshotted).
export function listWorkflows() {
  const dirUrl = new URL("workflows/", CORPUS_ROOT);
  let files;
  try {
    files = readdirSync(dirUrl).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  return files.map((file) => {
    const name = file.replace(/\.md$/, "");
    const meta = { name, when: "", summary: "", deploy: "" };
    try {
      const content = readFileSync(new URL(file, dirUrl), "utf-8");
      const fm = content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (fm) {
        for (const line of fm[1].split("\n")) {
          const m = line.match(/^(name|when|summary|deploy):\s*(.+)$/);
          if (m) meta[m[1]] = m[2].trim();
        }
      }
    } catch {
      /* keep defaults */
    }
    return meta;
  });
}

// ── MCP server `instructions` (initialize result) ────────────────────────────
// The one orientation channel that reaches hosts with no hooks or skills. It
// states what CloudGrid does, which user requests each tool serves, what it
// does not do, and the plug contract — nothing about other products and no
// priority or preference wording (directory review criteria; #432). Under
// 4,096 characters, most important first; a test pins both.
export const INSTRUCTIONS_WEB = `CloudGrid runs the user's web apps at a live public URL and provides the infrastructure they need: managed MongoDB, Redis, pgvector, persistent disk, and an AI gateway that needs no API key. Every tool here is grid_*.

What it does, and the requests each tool serves:
- One self-contained HTML file becomes a live public URL in seconds: grid_plug with html. Serves "make it live", "put it online", "give me a link", "host this page", "share it with friends", "plug it".
- A multi-file or framework app, or anything that needs a database, a server, scheduled jobs, or an AI model, runs as a runtime app: grid_plug with artifact_files (inline files, plus a cloudgrid.yaml that declares needs). Serves "deploy this app", "add a database", "let it call an AI model without my own key".
- Iterating keeps the same link: grid_plug with target_entity_id updates in place; grid_get_app_source fetches the current HTML when it is not in context.
- Sharing and access: grid_visibility sets who can see it (private, grid, link, public); grid_collab grants a collaborator push access; grid_pickup copies any visible app's source into the user's grid.
- grid_check_deploy reports whether a runtime build has come live.

What it does not do: it is not a shell, a container or VM host, or a Kubernetes target; it does not deploy a git repository from a URL; it does not run desktop or mobile apps. Say so plainly when asked.

How a plug works:
- Browsing (grid_start, grid_get_template, grid_get_app_source) works signed out. Creating or changing anything needs a signed-in CloudGrid account: the user's AI tool asks them to sign in the first time a tool needs one, then the call can be made again. There is no sign-in-free publish.
- No grid yet: grid_plug returns needs_grid_create; suggest a slug, confirm it with the user, call grid_create_grid, then grid_plug with that grid. More than one grid: it returns needs_grid; ask which.
- Never put an API key in page HTML or app code: a plugged page's source is public, and grid_plug rejects known key shapes. needs: { ai: true } in cloudgrid.yaml gives the app the managed AI gateway with no key; other keys go in grid secrets.
- A runtime build is asynchronous: grid_plug returns status "building"; poll grid_check_deploy with its entity_id until it reports success before saying the app is live.
- End with the live URL.

grid_start returns a short orientation and the workflow index; grid_get_template loads a workflow, template, or reference doc (cloudgrid-yaml, capability-map, playbook). Nothing from this conversation is sent to CloudGrid except what the user asks to send through grid_note or grid_report.`;

export const INSTRUCTIONS_LOCAL = `CloudGrid runs the user's web apps at a live public URL and provides the infrastructure they need: managed MongoDB, Redis, pgvector, persistent disk, and an AI gateway that needs no API key. Every tool here is grid_*.

What it does, and the requests each tool serves:
- One self-contained HTML file becomes a live public URL in seconds: grid_plug with html (or path to the file). Serves "make it live", "put it online", "give me a link", "share it with friends", "plug it".
- A folder with several files, a framework, or anything that needs a database, a server, scheduled jobs, or an AI model, runs as a runtime app: grid_plug with path to the folder, with a cloudgrid.yaml that declares needs (needs: { database: true }, needs: { ai: true }); read the injected env vars lazily, inside handlers. Serves "deploy this app", "add a database", "let it call an AI model without my own key".
- Iterating keeps the same link: grid_plug with target_entity_id updates in place.
- Sharing and access: grid_visibility sets who can see it; grid_collab grants push access; grid_pickup copies any visible app's source.

What it does not do: it is not a shell, a container or VM host, or a Kubernetes target; it does not deploy a git repository from a URL; it does not run desktop or mobile apps.

How a plug works: creating anything needs a signed-in account (a signed-out create returns needs_auth; call grid_login). Never write an API key into page source or app code — needs: { ai: true } gives the app the managed AI gateway with no key, and other keys go in grid secrets (grid_plug rejects known key shapes). A runtime build is asynchronous: poll grid_check_deploy with its entity_id until success before saying it is live. For shell steps, run the CLI as \`npx -y @cloudgrid-io/cli@latest <command>\` (never a bare \`grid\`); \`grid dev\` runs the app locally with the same services. grid_start returns a short orientation and the workflow index; grid_get_template loads workflows, templates, and reference docs.`;

// ── grid_start orientation ───────────────────────────────────────────────────
// Short on purpose: the decisions a model makes on the first plug, and where
// the details live. The full operating playbook stays retrievable as
// grid_get_template({kind:"doc", name:"playbook"}).
export const ORIENTATION = `CloudGrid runs web apps at a live public URL and provides managed MongoDB, Redis, pgvector, persistent disk, and an AI gateway with no API key.

Choose the plug by the artifact:
- ONE self-contained HTML page (CSS and JS inline, images as data: URIs) → grid_plug with html. Live in seconds, on every edition.
- Separate files, a framework, or anything that needs data, a server, cron, or an AI model → a runtime app: grid_plug with artifact_files (hosted) or path to a folder (local), with a cloudgrid.yaml. Declare infrastructure with needs: (database → Mongo, cache → Redis, vector → pgvector, disk, ai → the AI gateway); read injected env vars inside handlers, never at module top level. Fetch grid_get_template({kind:"doc", name:"cloudgrid-yaml"}) before writing the manifest. The build is asynchronous: poll grid_check_deploy with its entity_id until success before saying it is live.
- A page that must SAVE data (submissions, shared state, sign-in) is a runtime app, not a static page: use the app-with-data workflow.

Before a new plug: sign-in is required (on the local edition, needs_auth → grid_login; on the hosted edition the AI tool asks the user to sign in). With no grid, grid_plug returns needs_grid_create → suggest a slug, confirm it, grid_create_grid, then plug with that grid (no wait needed). With more than one grid, ask which. Then ask who should see it and set it with grid_visibility (private | grid | link | public); when the user defers, pick the most private option that satisfies the request and say so.

Iterate on the same link: grid_plug with target_entity_id. Editing a page whose HTML is not in context: grid_get_app_source first (it returns the HTML, entity_id, and whether it is a single-HTML page you may re-plug), then grid_plug with target_entity_id. An app someone else owns: grid_pickup copies it into the user's grid; grid_collab grants push access to the same entity.

Never embed an API key in page or app source: a plugged page's source is public and grid_plug rejects known key shapes. needs: { ai: true } gives the app the AI gateway with no key; other keys go in grid secrets.

Details on demand: grid_get_template({kind:"workflow"|"template"|"example"|"doc", name}). The capability-map doc matches requests to templates; the playbook doc holds the full operating rules (visibility table, failure handling, CLI usage).`;

