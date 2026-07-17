# Example: docs-app — "Widgets SDK docs"

A filled reference imitating the `docs-app` template: a multi-page documentation
site for a fictional "Widgets SDK", built with [Astro Starlight](https://starlight.astro.build).
It has sidebar navigation, client-side full-text search, and agent-readable
`llms.txt` / `llms-full.txt` generated on every build.

`docs-app` is the buildable sibling of `docs-site`. Use `docs-app` when the docs
are more than one page and you will keep editing them; use `docs-site` for a
quick single page baked into one HTML file (instant, works on the hosted MCP).

**The proven rules for a docs-app:** (1) it is served at the entity **root**, so
there is **no `base`** in `astro.config.mjs`; (2) `cloudgrid.yaml` declares a
single `static` service with **`source: { path: . }`** (the project is at the
folder root, not under `services/site/`) plus a **`build:` block** — the platform
runs `npm run build` for you; (3) it is a multi-file **build**, so it deploys
**async** (poll to the live URL) and needs the **local edition** (the hosted MCP
cannot build it); (4) `llms.txt` / `llms-full.txt` are generated automatically at
the site root by the `starlight-llms-txt` plugin — no extra work.

## cloudgrid.yaml

```yaml
# Static site with a build step, served at the entity root. source.path: .
# points the build at the project root; without it the build looks for
# services/site/ and fails. No needs: — a docs site has no infrastructure.
name: widgets-sdk-docs
services:
  site:
    type: static
    path: /
    node_version: "22"
    source:
      path: .
    build:
      command: "npm run build"
      output: "dist"
```

## package.json

```json
{
  "name": "widgets-sdk-docs",
  "type": "module",
  "version": "0.1.0",
  "scripts": { "dev": "astro dev", "build": "astro build", "preview": "astro preview" },
  "dependencies": {
    "@astrojs/starlight": "^0.41.3",
    "astro": "^7.0.2",
    "sharp": "^0.34.5"
  },
  "devDependencies": { "starlight-llms-txt": "^0.11.0" }
}
```

## astro.config.mjs

```js
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLlmsTxt from 'starlight-llms-txt';

export default defineConfig({
  site: 'https://example.com',
  integrations: [
    starlight({
      plugins: [
        starlightLlmsTxt({
          projectName: 'Widgets SDK',
          description: 'Build, style, and ship widgets. The official Widgets SDK docs.',
        }),
      ],
      title: 'Widgets SDK',
      sidebar: [
        { label: 'Start here', items: [
          { label: 'Introduction', slug: 'index' },
          { label: 'Install', slug: 'guides/install' },
        ] },
        { label: 'Reference', items: [{ label: 'Widget API', slug: 'reference/widget-api' }] },
      ],
    }),
  ],
});
```

## src/content/docs/guides/install.md

```md
---
title: Install
description: Add the Widgets SDK to your project.
---

    npm install @widgets/sdk

Then import a widget and render it:

    import { Button } from '@widgets/sdk';
```

## Build + deploy

```sh
npm install
npm run build      # local check; the platform also builds on plug
grid plug          # async build → poll to the live URL
```

The live site serves at the entity root — pages at `/`, `/guides/install/`,
`/reference/widget-api/`, and the agent docs at `/llms.txt` and `/llms-full.txt`.
On a new deploy, ask the user what visibility they want and set it with
`grid visibility`.
