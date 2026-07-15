# changelog

A single self-contained HTML changelog / release-notes page: reverse-chronological versioned entries, each with a date and tagged change items (added / fixed / changed / removed).

Static inspiration — a single self-contained `index.html` (inline CSS and JS,
no external CDNs). It deploys instantly via `grid_deploy` and works on every
CloudGrid edition, including hosted.

## Fill it in

Fetch the template with `grid_get_template("template", "changelog")`, then replace the
placeholders:

   - The product name and page intro.
   - One entry per release, newest first: version, date, and a list of changes.
   - Each change carries a tag pill — added, fixed, changed, or removed — set by its CSS class.

Keep it a single self-contained HTML file. Do not add external scripts,
stylesheets, fonts, or large embedded media.

## Deploy

- Hosted MCP edition: call the drop tool with the HTML.
- Local MCP / CLI edition: write the HTML to a file and run `grid plug`.

It deploys as an inspiration and returns a live share URL right away. Re-deploy
with the same entity id to update the same URL.
