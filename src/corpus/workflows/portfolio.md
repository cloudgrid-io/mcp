---
name: portfolio
when: portfolio, personal site, freelancer site, my work, showcase, resume site, developer/designer portfolio with a projects grid, about, skills, and contact. For a plain single-section link-in-bio, landing-page also works.
needs: none
deploy: inspiration
editions: all
capabilities_note: static — no infrastructure. Publishes as an inspiration (instant, works on hosted) via grid_deploy.
summary: Fetch the portfolio template, fill it with the user's projects and bio, deploy it, and return the live share URL.
---

# Workflow: portfolio

Detect the intent ("build me a portfolio / personal site to show my work") and
follow this recipe. Reach for this over `landing-page` when the request is about
showcasing projects with an about, skills, and contact. Do not ask setup
questions first; use sensible defaults and build.

1. **Fetch the template.** Call `grid_get_template("template", "portfolio")` to load
   the self-contained HTML portfolio (hero, about, skills, projects grid,
   contact).
2. **Fill the template.** Replace the placeholders with the user's content:
   - The person's name, role/title, and short intro.
   - The about paragraph and the skills (one pill each).
   - One card per project: title, short description, tags, optional link.
   - The contact links (email as a `mailto:`, plus optional profile links).
   - Keep it a single self-contained HTML file. Do not add external scripts,
     stylesheets, fonts, or large embedded media.
3. **Deploy.** Deploy the filled HTML:
   - Hosted MCP edition: call the drop tool with the HTML.
   - Local MCP / CLI edition: write the HTML to a file and run `grid plug`.
   It is an inspiration and deploys synchronously, so you get a URL right away.
4. **Return the live share URL.** For revisions, re-deploy with the entity id
   from the first deploy — it updates the same share URL.

Keep the whole flow tight: fetch, fill, deploy, share.
