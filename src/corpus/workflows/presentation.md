---
name: presentation
when: The user wants to build a presentation, slide deck, or set of slides about a topic.
summary: Fetch the deck template, fill it with the user's content, deploy it, and return the live share URL.
---

# Workflow: presentation

Detect the intent ("build me a presentation / deck / slides about X") and follow
this recipe. Do not ask setup questions first; use sensible defaults and build.

1. **Fetch the template.** Call `gridctl_fetch("template", "deck")` to load the
   self-contained HTML deck template.
2. **(Optional) Fetch the example.** Call `gridctl_fetch("example", "deck")` to
   see a filled deck as a reference for tone and structure.
3. **Fill the template.** Replace the placeholders with the user's content:
   - The deck title and subtitle.
   - One slide per key point. Each slide has a heading and body content.
   - Keep it a single self-contained HTML file. Do not add external scripts,
     stylesheets, fonts, or large embedded media.
4. **Deploy.** Deploy the filled HTML:
   - Hosted MCP edition: call the drop tool with the HTML.
   - Local MCP / CLI edition: write the HTML to a file and run `gridctl plug`.
   An HTML deck is an inspiration and deploys synchronously, so you get a URL
   right away.
5. **Return the live share URL.** Give the user the URL that serves the deck.

Keep the whole flow tight: fetch, fill, deploy, share.
