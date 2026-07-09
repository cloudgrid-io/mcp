---
name: product-launch
when: product launch page, launch announcement, new product page, we just launched.
needs: none
deploy: inspiration
editions: all
capabilities_note: static — no infrastructure. Publishes as an inspiration (instant, works on hosted) via grid_plug.
summary: Fetch the product-launch template, fill it with the user's product/launch content, deploy it, and return the live share URL.
---

# Workflow: product-launch

Detect the intent ("build a launch page / announcement for our new product X")
and follow this recipe. Do not ask setup questions first; use sensible defaults
and build.

1. **Fetch the template.** Call `grid_fetch("template", "product-launch")` to
   load the self-contained HTML launch-page template (hero + product image,
   countdown, features, launch offer, social proof).
2. **(Optional) Fetch the example.** Call `grid_fetch("example", "product-launch")`
   to see a filled launch page as a reference for tone and structure.
3. **Fill the template.** Replace the placeholders with the user's content:
   - Product name, hero headline, subhead, launch badge, and CTA label/target.
   - The **countdown target**: set `{{LAUNCH_DATETIME_ISO}}` to an ISO 8601
     instant (e.g. `2026-09-01T09:00:00Z`). If unset/invalid it falls back to
     +14 days.
   - One block per key feature (title + short description).
   - The launch offer (price, was-price, fine print, offer CTA).
   - Social-proof stats and testimonials.
   - Swap the hero product image (the inline `<svg>` in `.shot`) for a real
     screenshot **only** as inline SVG or a `data:` URI. Keep it a single
     self-contained HTML file — no external scripts, stylesheets, fonts, CDNs,
     or large embedded media.
4. **Deploy.** Deploy the filled HTML:
   - Hosted MCP edition: call the drop tool with the HTML.
   - Local MCP / CLI edition: write the HTML to a file and run `grid plug`.
   A launch page is an inspiration and deploys synchronously, so you get a URL
   right away.
5. **Return the live share URL.** Give the user the URL that serves the page.
   For revisions, re-deploy with the entity id from the first deploy — it updates
   the same share URL, so the user iterates on one link.

Keep the whole flow tight: fetch, fill, deploy, share.
