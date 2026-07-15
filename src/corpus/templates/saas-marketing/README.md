# saas-marketing

A single self-contained HTML SaaS marketing site (hero, features, pricing tiers, testimonials, FAQ, and a closing call to action). Richer than the landing-page template.

Static inspiration — a single self-contained `index.html` (inline CSS and JS,
no external CDNs). It deploys instantly via `grid_deploy` and works on every
CloudGrid edition, including hosted.

## Fill it in

Fetch the template with `grid_get_template("template", "saas-marketing")`, then replace the
placeholders:

   - The product name, tagline, and hero eyebrow/headline/subheadline.
   - The call-to-action label and (optional) target for the primary button.
   - One block per feature (title + short description). Add or remove `.feature` blocks.
   - The three pricing plans: name, price, period, and feature list. The middle plan is marked "Most popular".
   - The testimonial quotes and who said them.
   - The FAQ question/answer pairs (`<details>` blocks, client-side accordion).

Keep it a single self-contained HTML file. Do not add external scripts,
stylesheets, fonts, or large embedded media.

## Deploy

- Hosted MCP edition: call the drop tool with the HTML.
- Local MCP / CLI edition: write the HTML to a file and run `grid plug`.

It deploys as an inspiration and returns a live share URL right away. Re-deploy
with the same entity id to update the same URL.
