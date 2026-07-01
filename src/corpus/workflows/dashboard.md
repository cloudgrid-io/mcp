---
name: dashboard
when: The user wants to build a dashboard showing metrics, status, or KPIs with cards and charts.
summary: Fetch the dashboard template, fill it with the user's metrics and inline charts, deploy it, and return the live share URL.
---

# Workflow: dashboard

Detect the intent ("build me a dashboard for X metrics / status") and follow
this recipe. Do not ask setup questions first; use sensible defaults and build.

1. **Fetch the template.** Call `gridctl_fetch("template", "dashboard")` to load
   the self-contained HTML dashboard template.
2. **(Optional) Fetch the example.** Call `gridctl_fetch("example", "dashboard")`
   to see a filled dashboard as a reference for structure and layout.
3. **Fill the template.** Replace the placeholders with the user's content:
   - The dashboard title and (optional) status line.
   - One metric card per KPI. Each card has a label, a value, and a trend note.
   - The chart data: edit the inline data arrays that the hand-rolled SVG and
     inline JS read from. Keep every chart inline — do not add an external chart
     library or CDN.
   - Keep it a single self-contained HTML file. Do not add external scripts,
     stylesheets, fonts, or large embedded media.
4. **Deploy.** Deploy the filled HTML:
   - Hosted MCP edition: call the drop tool with the HTML.
   - Local MCP / CLI edition: write the HTML to a file and run `gridctl plug`.
   A dashboard is an inspiration and deploys synchronously, so you get a URL
   right away.
5. **Return the live share URL.** Give the user the URL that serves the dashboard.

Keep the whole flow tight: fetch, fill, deploy, share.
