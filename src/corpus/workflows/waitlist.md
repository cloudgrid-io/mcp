---
name: waitlist
when: waitlist, coming soon, early access, join the list, launch page, sign-up teaser with an email capture form. NOTE the form is static — to actually STORE signups you need a runtime app (needs: database), coming in the crud-app archetype.
needs: none
deploy: inspiration
editions: all
capabilities_note: static — no infrastructure. The email form posts to a configurable mailto/external endpoint; it does NOT store signups. Publishes as an inspiration (instant, works on hosted) via grid_deploy.
summary: Fetch the waitlist template, fill it with the user's launch copy, wire the form to a mailto or external endpoint, deploy it, and return the live share URL.
---

# Workflow: waitlist

Detect the intent ("build me a waitlist / coming-soon / early-access page") and
follow this recipe. Do not ask setup questions first; use sensible defaults and
build.

**Important — the form is static.** This template captures an email and posts it
to a configurable action: a `mailto:` (the default, which opens the visitor's
mail client) or an external form endpoint you set on the `<form action>`. It does
NOT store signups anywhere on CloudGrid. To actually **store** waitlist signups
(persist, count, export them), you need a runtime app with a database
(`needs: { database: true }`) — that is a CRUD app, coming in the crud-app
archetype (Wave 1b). Do not claim this static page persists data.

1. **Fetch the template.** Call `grid_get_template("template", "waitlist")` to load
   the self-contained HTML waitlist page (hero, email form, social-proof counter).
2. **Fill the template.** Replace the placeholders with the user's content:
   - The product name, coming-soon headline, and subheadline.
   - The signup counter and any social-proof line.
   - The form action: set `<form action>` to a `mailto:` address or an external
     form endpoint. Default is `mailto:`.
   - Keep it a single self-contained HTML file. Do not add external scripts,
     stylesheets, fonts, or large embedded media.
3. **Deploy.** Deploy the filled HTML:
   - Hosted MCP edition: call the drop tool with the HTML.
   - Local MCP / CLI edition: write the HTML to a file and run `grid plug`.
   It is an inspiration and deploys synchronously, so you get a URL right away.
4. **Return the live share URL.** For revisions, re-deploy with the entity id
   from the first deploy — it updates the same share URL. If the user needs
   signups stored, tell them that needs the runtime crud-app archetype (Wave 1b).

Keep the whole flow tight: fetch, fill, deploy, share.
