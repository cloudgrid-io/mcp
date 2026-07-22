---
name: status-page
when: status page, service status, uptime page, incident history, is-it-down page, system status board. Display-only — status is baked into the page, no live monitoring.
needs: none
deploy: inspiration
editions: all
capabilities_note: static — no infrastructure, status baked into the page. Publishes as an inspiration (instant, works on hosted) via grid_plug.
summary: Fetch the status-page template, fill it with the user's components and incidents, deploy it, and return the live share URL.
---

# Workflow: status-page

Detect the intent ("build me a status page / uptime page for X") and follow this
recipe. This is a display-only static page — the status is baked into the markup,
there is no live polling. Do not ask setup questions first; use sensible defaults
and build.

1. **Fetch the template.** Call `grid_get_template("template", "status-page")` to load
   the self-contained HTML status page (overall banner, component list with
   up/degraded/down pills, per-component uptime bars, incident history).
2. **Fill the template.** Replace the placeholders with the user's content:
   - The overall banner text and its state class (`ok` / `degraded` / `down`).
   - One row per component: name, a status pill, and the 90-day uptime bar. Mark
     any non-ok bar segments with class `degraded` or `down`.
   - The incident history entries: date, title, state, and a short note.
   - Keep it a single self-contained HTML file. Do not add external scripts,
     stylesheets, fonts, or large embedded media.
3. **Deploy.** Deploy the filled HTML:
   - Hosted MCP edition: call the drop tool with the HTML.
   - Local MCP / CLI edition: write the HTML to a file and run `grid plug`.
   It is an inspiration and deploys synchronously, so you get a URL right away.
4. **Return the live share URL.** For revisions, re-deploy with the entity id
   from the first deploy — it updates the same share URL.

Keep the whole flow tight: fetch, fill, deploy, share.
