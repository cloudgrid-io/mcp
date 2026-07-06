---
name: docs-site
when: documentation site, docs, developer docs, guide, manual, knowledge base, help center (static, content baked in). For an interactive API endpoint reference, use api-docs instead.
needs: none
deploy: inspiration
editions: all
capabilities_note: static — no infrastructure, content baked into the page. Publishes as an inspiration (instant, works on hosted) via gridctl_drop.
summary: Fetch the docs-site template, fill it with the user's documentation, deploy it, and return the live share URL.
---

# Workflow: docs-site

Detect the intent ("build me a docs site / documentation for X") and follow this
recipe. For a REST API endpoint reference specifically, use `api-docs`. Do not
ask setup questions first; use sensible defaults and build.

1. **Fetch the template.** Call `gridctl_fetch("template", "docs-site")` to load
   the self-contained HTML docs layout (sidebar nav, content column, code blocks,
   client-side search box).
2. **Fill the template.** Replace the placeholders with the user's content:
   - The project/doc name and the sidebar section links.
   - One content section per topic (heading + prose + optional code block). Keep
     each section id matching its sidebar anchor.
   - The code blocks are plain `<pre><code>` — no external highlighter or CDN.
   - Leave the inline search script as-is; it filters the sidebar client-side.
   - Keep it a single self-contained HTML file. Do not add external scripts,
     stylesheets, fonts, or large embedded media.
3. **Deploy.** Deploy the filled HTML:
   - Hosted MCP edition: call the drop tool with the HTML.
   - Local MCP / CLI edition: write the HTML to a file and run `gridctl plug`.
   It is an inspiration and deploys synchronously, so you get a URL right away.
4. **Return the live share URL.** For revisions, re-deploy with the entity id
   from the first deploy — it updates the same share URL.

Keep the whole flow tight: fetch, fill, deploy, share.
