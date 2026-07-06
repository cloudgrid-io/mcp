# docs-site

A single self-contained HTML documentation site: a sidebar nav, a scrolling content column with headings and code blocks, and a client-side search box that filters the nav. No backend.

Static inspiration — a single self-contained `index.html` (inline CSS and JS,
no external CDNs). It deploys instantly via `gridctl_drop` and works on every
CloudGrid edition, including hosted.

## Fill it in

Fetch the template with `gridctl_fetch("template", "docs-site")`, then replace the
placeholders:

   - The project/doc name and the sidebar section links.
   - One content section per topic (heading + prose + optional code block).
   - The code blocks are plain `<pre><code>` — no external highlighter or CDN.
   - The search box filters the sidebar links client-side with inline JS; leave the script inline.

Keep it a single self-contained HTML file. Do not add external scripts,
stylesheets, fonts, or large embedded media.

## Deploy

- Hosted MCP edition: call the drop tool with the HTML.
- Local MCP / CLI edition: write the HTML to a file and run `gridctl plug`.

It deploys as an inspiration and returns a live share URL right away. Re-deploy
with the same entity id to update the same URL.
