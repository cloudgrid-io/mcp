# portfolio

A single self-contained HTML personal / freelancer portfolio: a hero intro, an about section, a skills list, a projects grid, and a contact section.

Static inspiration — a single self-contained `index.html` (inline CSS and JS,
no external CDNs). It deploys instantly via `grid_deploy` and works on every
CloudGrid edition, including hosted.

## Fill it in

Fetch the template with `grid_fetch("template", "portfolio")`, then replace the
placeholders:

   - The person's name, role/title, and short intro.
   - The about paragraph.
   - The skills — one pill per skill.
   - One card per project: title, short description, tags, and an optional link.
   - The contact links (email as a mailto, plus optional social/profile links).

Keep it a single self-contained HTML file. Do not add external scripts,
stylesheets, fonts, or large embedded media.

## Deploy

- Hosted MCP edition: call the drop tool with the HTML.
- Local MCP / CLI edition: write the HTML to a file and run `grid plug`.

It deploys as an inspiration and returns a live share URL right away. Re-deploy
with the same entity id to update the same URL.
