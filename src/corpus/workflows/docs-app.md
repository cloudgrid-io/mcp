---
name: docs-app
when: multi-page documentation SITE, developer docs portal, knowledge base, help center you'll keep editing — docs with a sidebar, full-text search, and agent-readable llms.txt, built with Astro/Starlight. SEPARATE content files, not one page. For a quick single-page doc baked into one HTML file (instant, works on the hosted MCP), use docs-site instead. For an interactive REST API endpoint reference, use api-docs.
needs: none
deploy: static build
editions: local
capabilities_note: a built, multi-page static documentation site (Astro Starlight) — sidebar nav, client-side search, and llms.txt / llms-full.txt generated on every build. No infrastructure (no needs:). Because it BUILDS from multiple files, it deploys async and needs the local edition; the hosted MCP cannot build it. Served at the entity root via grid_deploy.
summary: Scaffold an Astro Starlight docs site from the docs-app template, fill in the content, build it, deploy the folder with grid_deploy (async → poll to a live URL), then ask the user what visibility they want. llms.txt / llms-full.txt are generated automatically.
---

# Workflow: docs-app

The user wants a **real, multi-page documentation site** they will keep editing —
a docs portal / knowledge base with a sidebar, search, and agent-readable
`llms.txt`. That is a **built static site** (Astro Starlight), not a single page.

Choose the right archetype first:
- **Quick, single-page doc**, or you're on the **hosted MCP** (Claude Web) → use
  `docs-site` (one self-contained HTML file, instant inspiration, any edition).
- **Interactive REST API endpoint reference** → use `api-docs`.
- **Multi-page site you'll maintain (sidebar + search + llms.txt)** → `docs-app`,
  this workflow.

Be honest that a `docs-app` deploy is a build (async, not instant like a single
HTML drop) and that it needs the local edition.

## 1. Edition check FIRST (hard gate)

A docs-app is built (`npm run build`) from multiple files, so it requires the
**local edition** (Claude Desktop / Claude Code) or the CLI — the grid folder-plugs
and builds your project.

- **Hosted edition (Claude Web / hosted MCP):** you CANNOT build a multi-file
  site. Tell the user plainly: "A multi-page docs site needs the local edition
  (Claude Desktop/Code) or the CloudGrid CLI; the hosted edition can only publish
  a single page — I can make you a one-page `docs-site` instead." Offer the
  `docs-site` fallback; do not try to build here.
- **Local edition:** continue.

## 2. Auth + grid

1. Ensure signed in: `grid_login_status`; if not, `grid_login`.
2. A grid is required. Respect the grid picker: if the user has more than one
   grid, ask which to use; do not assume a target.

## 3. Scaffold

`grid_create_project` an app `<name>`. `init` creates the entity + `.cloudgrid/link.json`
and writes a `cloudgrid.yaml`. Then fetch the template:
`grid_get_template("template", "docs-app")` — a minimal Astro Starlight project:

```
package.json          Astro + Starlight + starlight-llms-txt
astro.config.mjs      site config, sidebar, the llms.txt plugin
tsconfig.json
cloudgrid.yaml        static + build block, served at the entity root
src/content.config.ts
src/content/docs/index.mdx + guides/ + reference/
```

Write those files into the linked folder (keep the project at the folder root —
this is a static build, so unlike a `node`/`nextjs` service the project is NOT
nested under `services/<name>/`).

## 4. Fill in the content

- Set `title`, `description`, and the `starlightLlmsTxt({ projectName, description })`
  values in `astro.config.mjs` to the user's project.
- Write the actual pages under `src/content/docs/` (Markdown/MDX, one file per
  page) and list them in the `sidebar` array in `astro.config.mjs`.
- Keep internal links root-relative (`/guides/getting-started/`). The site is
  served at the entity **root**, so do NOT set a `base`.
- Do not add external CDN scripts, fonts, or stylesheets.

## 5. cloudgrid.yaml

The template already declares the right shape — a single `static` service with a
build step, served at the root:

```yaml
name: my-docs
services:
  site:
    type: static
    path: /
    node_version: "22"
    source:
      path: .          # project is at the folder root, not under services/site/
    build:
      command: "npm run build"
      output: "dist"
```

`source.path: .` is REQUIRED for this root-level build — without it the platform
looks for `services/site/` and fails with "Service directory not found". No
`needs:` — a docs site has no infrastructure. Never author an active `needs:` and
`requires:` together (the validator rejects the combo).

## 6. Build + deploy (async)

Deploy the folder with `grid_deploy`. The platform (Cloud Build) runs `npm run
build` for you and serves the `dist/` output — you do NOT need to build first. A build deploy is **ASYNC**: the first response is
`status: "building"` with a `poll_url` / entity, NOT a live URL yet.
- Poll `grid_status` (or the returned poll_url) until the entity is live.
- Surface a liveness signal while it builds — never a bare silent wait.
- Only once it is live, return the deployed URL.

## 7. Return the live URL, point at llms.txt, and ASK visibility

- Give the user the live docs URL — that is the deliverable.
- Point out the agent-readable docs: `<url>/llms.txt` (index) and
  `<url>/llms-full.txt` (full content), generated automatically.
- This is a NEW deploy, so ASK the user who should be able to open it (private /
  a space / your grid / anyone with the link / anyone signed in) and set their
  choice with `grid_visibility`. Do not pick the visibility for them.

To iterate, edit the content and re-plug the SAME entity (`target_entity_id`) so
it updates the same URL.

Keep it honest: multi-file build, async deploy, local-edition only.
