# status-page

A single self-contained HTML service status page: an overall banner, a component list with up / degraded / down pills, per-component uptime bars, and an incident history log. Status is baked into the page.

Static inspiration — a single self-contained `index.html` (inline CSS and JS,
no external CDNs). It deploys instantly via `grid_plug` and works on every
CloudGrid edition, including hosted.

## Fill it in

Fetch the template with `grid_fetch("template", "status-page")`, then replace the
placeholders:

   - The overall status banner text and state class (`ok` / `degraded` / `down`).
   - One row per component: name, a status pill, and a 90-day uptime bar (the bar segments are inline divs you set to ok/degraded/down).
   - The incident history entries: date, title, state, and a short resolution note.
   - All state is baked into the markup — this is a display-only static page, no live polling.

Keep it a single self-contained HTML file. Do not add external scripts,
stylesheets, fonts, or large embedded media.

## Deploy

- Hosted MCP edition: call the drop tool with the HTML.
- Local MCP / CLI edition: write the HTML to a file and run `grid plug`.

It deploys as an inspiration and returns a live share URL right away. Re-deploy
with the same entity id to update the same URL.
