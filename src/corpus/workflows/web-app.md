---
name: web-app
when: calculator, converter, generator, timer, quiz, interactive tool, mini-app, single-page tool, widget — anything computed client-side with no saved data.
needs: none
deploy: inspiration
editions: all
capabilities_note: static — no infrastructure, state lives only in memory. Publishes as an inspiration (instant, works on hosted) via grid_drop.
summary: Fetch the web-app template, adapt its markup and inline JS to the user's tool, deploy it, and return the live share URL.
---

# Workflow: web-app

Detect the intent ("build me a web app / tool / calculator that does X") and
follow this recipe. Do not ask setup questions first; use sensible defaults and
build.

1. **Fetch the template.** Call `grid_fetch("template", "web-app")` to load
   the self-contained interactive HTML app template.
2. **(Optional) Fetch the example.** Call `grid_fetch("example", "web-app")`
   to see a real working tool as a reference for structure and inline logic.
3. **Adapt the template.** Rework the markup and inline JavaScript into the tool
   the user asked for:
   - Set the app title and heading.
   - Build the input controls and output area for the tool's job.
   - Put all behavior in the inline `<script>`; keep state in memory.
   - Keep it a single self-contained HTML file. Do not add external scripts,
     stylesheets, fonts, or CDNs — inline everything.
4. **Deploy.** Deploy the filled HTML:
   - Hosted MCP edition: call the drop tool with the HTML.
   - Local MCP / CLI edition: write the HTML to a file and run `grid plug`.
   A web app is an inspiration and deploys synchronously, so you get a URL
   right away.
5. **Return the live share URL.** Give the user the URL that serves the app.
   For revisions, re-deploy with the entity id from the first deploy — it updates
   the same share URL, so the user iterates on one link.

Keep the whole flow tight: fetch, adapt, deploy, share.
