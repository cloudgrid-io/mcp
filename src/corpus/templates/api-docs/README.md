# api-docs

A single self-contained HTML API reference: a sidebar endpoint list, per-endpoint method badges (GET / POST / PUT / DELETE), a params table, and request / response examples in code blocks.

Static inspiration — a single self-contained `index.html` (inline CSS and JS,
no external CDNs). It deploys instantly via `grid_deploy` and works on every
CloudGrid edition, including hosted.

## Fill it in

Fetch the template with `grid_fetch("template", "api-docs")`, then replace the
placeholders:

   - The API name, base URL, and auth note.
   - One section per endpoint: method badge, path, description, a params table, and request/response example blocks.
   - The sidebar links jump to each endpoint anchor; the filter box narrows them client-side (inline JS).
   - The code blocks are plain `<pre><code>` — no external highlighter or CDN.

Keep it a single self-contained HTML file. Do not add external scripts,
stylesheets, fonts, or large embedded media.

## Deploy

- Hosted MCP edition: call the drop tool with the HTML.
- Local MCP / CLI edition: write the HTML to a file and run `grid plug`.

It deploys as an inspiration and returns a live share URL right away. Re-deploy
with the same entity id to update the same URL.
