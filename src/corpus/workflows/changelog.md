---
name: changelog
when: changelog, release notes, what's new, product updates page, version history. Reverse-chronological entries with added/fixed/changed/removed tags.
needs: none
deploy: inspiration
editions: all
capabilities_note: static — no infrastructure. Publishes as an inspiration (instant, works on hosted) via grid_plug.
summary: Fetch the changelog template, fill it with the user's release entries, deploy it, and return the live share URL.
---

# Workflow: changelog

Detect the intent ("build me a changelog / release notes page for X") and follow
this recipe. Do not ask setup questions first; use sensible defaults and build.

1. **Fetch the template.** Call `grid_fetch("template", "changelog")` to load
   the self-contained HTML changelog (reverse-chronological versioned entries with
   tagged change items).
2. **Fill the template.** Replace the placeholders with the user's content:
   - The product name and a short intro line.
   - One entry per release, newest first: version, date, and a list of changes.
   - Each change item carries a tag — set its class to `added`, `fixed`,
     `changed`, or `removed`.
   - Keep it a single self-contained HTML file. Do not add external scripts,
     stylesheets, fonts, or large embedded media.
3. **Deploy.** Deploy the filled HTML:
   - Hosted MCP edition: call the drop tool with the HTML.
   - Local MCP / CLI edition: write the HTML to a file and run `grid plug`.
   It is an inspiration and deploys synchronously, so you get a URL right away.
4. **Return the live share URL.** For revisions, re-deploy with the entity id
   from the first deploy — it updates the same share URL.

Keep the whole flow tight: fetch, fill, deploy, share.
