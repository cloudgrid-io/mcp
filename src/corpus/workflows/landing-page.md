---
name: landing-page
when: The user wants to build a landing page, marketing page, or product page for something.
summary: Fetch the landing-page template, fill it with the user's content, deploy it, and return the live share URL.
---

# Workflow: landing-page

Detect the intent ("build me a landing page / marketing page for X") and follow
this recipe. Do not ask setup questions first; use sensible defaults and build.

1. **Fetch the template.** Call `gridctl_fetch("template", "landing-page")` to
   load the self-contained HTML landing-page template.
2. **(Optional) Fetch the example.** Call `gridctl_fetch("example", "landing-page")`
   to see a filled landing page as a reference for tone and structure.
3. **Fill the template.** Replace the placeholders with the user's content:
   - The product name, hero headline, and subheadline.
   - The call-to-action label and (optional) target.
   - One block per feature. Each feature has a title and a short description.
   - Keep it a single self-contained HTML file. Do not add external scripts,
     stylesheets, fonts, or large embedded media.
4. **Deploy.** Deploy the filled HTML:
   - Hosted MCP edition: call the drop tool with the HTML.
   - Local MCP / CLI edition: write the HTML to a file and run `gridctl plug`.
   A landing page is an inspiration and deploys synchronously, so you get a URL
   right away.
5. **Return the live share URL.** Give the user the URL that serves the page.

Keep the whole flow tight: fetch, fill, deploy, share.
