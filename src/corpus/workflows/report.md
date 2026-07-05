---
name: report
when: report, one-pager, summary, brief, whitepaper, case study, formatted document.
needs: none
deploy: inspiration
editions: all
capabilities_note: static — no infrastructure. Publishes as an inspiration (instant, works on hosted) via gridctl_drop.
summary: Fetch the report template, fill it with the user's content, deploy it, and return the live share URL.
---

# Workflow: report

Detect the intent ("build me a report / one-pager / brief about X") and follow
this recipe. Do not ask setup questions first; use sensible defaults and build.

1. **Fetch the template.** Call `gridctl_fetch("template", "report")` to load
   the self-contained, print-friendly HTML report template.
2. **(Optional) Fetch the example.** Call `gridctl_fetch("example", "report")`
   to see a filled report as a reference for tone and structure.
3. **Fill the template.** Replace the placeholders with the user's content:
   - The report title, subtitle, and date line.
   - A short summary paragraph.
   - One block per section. Each section has a heading and body content.
   - The data table area: fill the rows with the user's figures, or remove it
     if there is no tabular data.
   - Keep it a single self-contained HTML file. Do not add external scripts,
     stylesheets, fonts, or large embedded media.
4. **Deploy.** Deploy the filled HTML:
   - Hosted MCP edition: call the drop tool with the HTML.
   - Local MCP / CLI edition: write the HTML to a file and run `gridctl plug`.
   A report is an inspiration and deploys synchronously, so you get a URL right
   away.
5. **Return the live share URL.** Give the user the URL that serves the report.
   For revisions, re-deploy with the entity id from the first deploy — it updates
   the same share URL, so the user iterates on one link.

Keep the whole flow tight: fetch, fill, deploy, share.
