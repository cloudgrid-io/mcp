---
name: saas-marketing
when: SaaS marketing site, product marketing page, features and pricing page, multi-section product site with pricing tiers, testimonials, and FAQ. For a simpler single-message page, use landing-page instead.
needs: none
deploy: inspiration
editions: all
capabilities_note: static — no infrastructure. Publishes as an inspiration (instant, works on hosted) via grid_deploy.
summary: Fetch the saas-marketing template, fill it with the user's product content, deploy it, and return the live share URL.
---

# Workflow: saas-marketing

Detect the intent ("build me a SaaS marketing site / product page with pricing")
and follow this recipe. This is the richer sibling of `landing-page` — reach for
it when the request calls for pricing tiers, testimonials, and an FAQ, not just a
hero. For a plain single-section landing page, use `landing-page`. Do not ask
setup questions first; use sensible defaults and build.

1. **Fetch the template.** Call `grid_get_template("template", "saas-marketing")` to
   load the self-contained HTML marketing site.
2. **Fill the template.** Replace the placeholders with the user's content:
   - The product name, tagline, and hero eyebrow/headline/subheadline.
   - The call-to-action label and (optional) target.
   - One block per feature (title + short description).
   - The three pricing plans (name, price, period, feature list). The middle
     plan is marked "Most popular".
   - The testimonial quotes and the FAQ question/answer pairs.
   - Keep it a single self-contained HTML file. Do not add external scripts,
     stylesheets, fonts, or large embedded media.
3. **Deploy.** Deploy the filled HTML:
   - Hosted MCP edition: call the drop tool with the HTML.
   - Local MCP / CLI edition: write the HTML to a file and run `grid plug`.
   It is an inspiration and deploys synchronously, so you get a URL right away.
4. **Return the live share URL.** For revisions, re-deploy with the entity id
   from the first deploy — it updates the same share URL.

Keep the whole flow tight: fetch, fill, deploy, share.
