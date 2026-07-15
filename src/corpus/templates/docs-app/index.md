# docs-app template

A multi-page documentation **site** for CloudGrid, built with
[Astro Starlight](https://starlight.astro.build): sidebar navigation,
client-side full-text search, and agent-readable `llms.txt` / `llms-full.txt`
generated on every build.

Use this when the docs are more than one page and you will keep editing them.
For a quick single-page doc baked into one HTML file (instant, works on the
hosted MCP), use the `docs-site` archetype instead.

## Layout

```
package.json          Astro + Starlight + starlight-llms-txt
astro.config.mjs      site config, sidebar, the llms.txt plugin
tsconfig.json
cloudgrid.yaml        static + build block, served at the entity root
src/content.config.ts
src/content/docs/
  index.mdx           the home page
  guides/getting-started.md
  reference/overview.md
```

## Build + deploy

This is a **built** static site, so it needs the local edition (Claude
Desktop/Code) or the CLI — the hosted MCP cannot build it.

```sh
npm install
npm run build      # produces dist/ (and dist/llms.txt, dist/llms-full.txt)
grid plug          # deploys the folder; live in ~30s at the entity root
```

`cloudgrid.yaml` declares a single `static` service with a `build:` block
(`npm run build` → `dist`). The deploy is async — poll to the live URL, then
return it. Add pages under `src/content/docs/` and list them in the
`sidebar` in `astro.config.mjs`.
