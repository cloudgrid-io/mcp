# waitlist

A single self-contained HTML launch waitlist / coming-soon page: a hero, an email capture form, and a social-proof counter.

Static inspiration — a single self-contained `index.html` (inline CSS and JS,
no external CDNs). It deploys instantly via `grid_deploy` and works on every
CloudGrid edition, including hosted.

## Fill it in

Fetch the template with `grid_fetch("template", "waitlist")`, then replace the
placeholders:

   - The product name, coming-soon headline, and subheadline.
   - The signup counter and any social-proof line.
   - The form action: set the `<form>` `action` to a `mailto:` address or an external form endpoint (for example a hosted form provider). The default is a `mailto:` that opens the visitor's mail client.

Keep it a single self-contained HTML file. Do not add external scripts,
stylesheets, fonts, or large embedded media.

## Deploy

- Hosted MCP edition: call the drop tool with the HTML.
- Local MCP / CLI edition: write the HTML to a file and run `grid plug`.

It deploys as an inspiration and returns a live share URL right away. Re-deploy
with the same entity id to update the same URL.

## Note on storing signups

The signup form here is **static**. It posts to a configurable action — a
`mailto:` (the default) or an external form endpoint you set on the `<form>`.
It does NOT store submissions anywhere on CloudGrid.

To actually **store** waitlist signups (persist them, count them, export them),
you need a runtime app with a database — `needs: { database: true }`. That is a
CRUD app, coming in the crud-app archetype (Wave 1b). Do not pretend this static
page persists data.
