---
name: api-docs
when: API documentation, API reference, endpoint docs, REST API docs, method/params/response reference. For prose developer guides or a knowledge base, use docs-site instead.
needs: none
deploy: inspiration
editions: all
capabilities_note: static — no infrastructure. Publishes as an inspiration (instant, works on hosted) via grid_plug.
summary: Fetch the api-docs template, fill it with the user's endpoints, deploy it, and return the live share URL.
---

# Workflow: api-docs

Detect the intent ("build me API docs / a REST API reference for X") and follow
this recipe. For prose guides or a general docs site, use `docs-site`; use this
one when the content is an endpoint reference. Do not ask setup questions first;
use sensible defaults and build.

1. **Fetch the template.** Call `grid_fetch("template", "api-docs")` to load
   the self-contained HTML API reference (sidebar endpoint list, method badges,
   params tables, request/response code blocks, client-side filter).
2. **Fill the template.** Replace the placeholders with the user's content:
   - The API name, base URL, and auth note.
   - One section per endpoint: method badge (GET/POST/PUT/DELETE), path,
     description, a params table, and request/response example blocks.
   - The sidebar links jump to each endpoint anchor; keep ids matching.
   - The code blocks are plain `<pre><code>` — no external highlighter or CDN.
   - Keep it a single self-contained HTML file. Do not add external scripts,
     stylesheets, fonts, or large embedded media.
3. **Deploy.** Deploy the filled HTML:
   - Hosted MCP edition: call the drop tool with the HTML.
   - Local MCP / CLI edition: write the HTML to a file and run `grid plug`.
   It is an inspiration and deploys synchronously, so you get a URL right away.
4. **Return the live share URL.** For revisions, re-deploy with the entity id
   from the first deploy — it updates the same share URL.

Keep the whole flow tight: fetch, fill, deploy, share.
