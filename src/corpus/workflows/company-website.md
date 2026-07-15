---
name: company-website
when: company website, business site, corporate site, about-us site, small-business homepage
needs: none
deploy: inspiration
editions: all
capabilities_note: static — no infrastructure. Publishes as an inspiration (instant, works on hosted) via grid_deploy.
summary: Fetch the company-website template, fill it with the user's content across hero/about/services/team/contact, deploy it, and return the live share URL.
---

# Workflow: company-website

Detect the intent ("build me a company website / business site / about-us page
for X") and follow this recipe. Do not ask setup questions first; use sensible
defaults from what the user tells you and build.

1. **Fetch the template.** Call `grid_get_template("template", "company-website")` to
   load the self-contained multi-section HTML company site.
2. **(Optional) Fetch the example.** Call `grid_get_template("example", "company-website")`
   to see a filled site as a reference for tone and structure.
3. **Fill the template.** Replace the `{{PLACEHOLDER}}` tokens with the user's
   content, section by section:
   - **Identity + hero:** company name, tagline, headline, subheadline, and the
     two call-to-action labels.
   - **About:** headline, two short paragraphs, and four stat number/label pairs.
   - **Services:** one card per offering — a single-emoji icon, title, and short
     description. Duplicate a `.card` block between the `SERVICES_START` /
     `SERVICES_END` comments to add more.
   - **Team:** one member per person — avatar initials, name, role, short bio.
     Duplicate a `.member` block between `TEAM_START` / `TEAM_END` to add more.
   - **Contact:** headline, subheadline, email, phone, address, hours.
   - Keep it a single self-contained HTML file. Do not add external scripts,
     stylesheets, fonts, or large embedded media. Recolor via the `:root` CSS
     variables (`--accent`, `--bg`, `--fg`) if the user has brand colors.
4. **Deploy.** Deploy the filled HTML:
   - Hosted MCP edition: call the drop tool with the HTML.
   - Local MCP / CLI edition: write the HTML to a file and run `grid plug`.
   A company website is an inspiration and deploys synchronously, so you get a
   URL right away.
5. **Return the live share URL.** Give the user the URL that serves the page.
   For revisions, re-deploy with the entity id from the first deploy — it updates
   the same share URL, so the user iterates on one link.

Keep the whole flow tight: fetch, fill, deploy, share. The contact form is
client-side only; mention the user can wire it to their own email service or
form endpoint if they want real submissions.
