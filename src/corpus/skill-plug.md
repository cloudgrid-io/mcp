---
version: 0.3.0
name: plug
description: |
  Deploy or share a creation on CloudGrid and get a public URL. Use when the user
  wants to ship, deploy, publish, share, send a friend a link, or go live — a
  single HTML page or a full app. One self-contained HTML page publishes instantly
  as an inspiration (any edition, no login needed); a multi-file app deploys from a
  directory or URL. Wraps grid plug.
argument-hint: "[path-or-url]"
allowed-tools: Bash
---

# CloudGrid Plug

Deploy or share a creation and get a public URL. This is the one deploy/share verb
— a single HTML page or a full app — and the center of the build-and-ship loop.

## Classify the artifact first

- **ONE self-contained HTML page** (a single file — CSS+JS inline, images/fonts as
  data: URIs; the normal hosted output) → an **inspiration**: instant, works on
  **any edition**, no login required. See "Share a single HTML page" below.
- **Anything more** — separate files/folders, a real `assets/` dir, separate
  `.css`/`.js`, multiple pages, a SPA build — **or** any data/server/LLM/cron need
  → a **runtime app**: `grid plug` on a linked folder, **local edition only**,
  async build. See "Deploy an app" below.

## Share a single HTML page (the fast path)

No account and no CLI needed — that is the point: anyone can publish a page. Write
the page to a single self-contained HTML file (a full document starting with
`<!doctype html>` or `<html>`; wrap a fragment in a minimal document). HTML is
capped at 2 MB for anonymous publishes. Then POST it to the unified plug endpoint:

```
curl -sS -X POST https://api.cloudgrid.io/api/v2/plug \
  -F "artifact=@/path/to/index.html;type=text/html"
```

The response is JSON (HTTP 201 anonymous). Read these fields:

- `url` — the live link, composed by the server. Use it verbatim; never compose a
  URL from the slug yourself.
- `entity_id` — the durable handle for updating this page later (see re-plug below).
- `owner_token` — a JWT proving you made this page. It authorizes an anonymous
  re-plug and doubles as the claim token; its lifetime matches the expiry (default
  7 days). Persist it with `entity_id` and `url`.
- `claim_url` / `claim_message` — the link + nudge to sign in and keep it past expiry.

Signed in, publish into your own grid instead (owned, no claim needed):

```
JWT=$(jq -r .jwt ~/.cloudgrid/credentials 2>/dev/null)
ORG=$(grep -E '^\s*active_org_slug:' ~/.cloudgrid/config.yaml | awk '{print $2}')
curl -sS -X POST https://api.cloudgrid.io/api/v2/plug \
  -H "Authorization: Bearer $JWT" -H "X-CloudGrid-Org: $ORG" \
  -F "artifact=@/path/to/index.html;type=text/html"
```

The MCP `grid_plug` tool does all of this for you: pass the page as its inline
`html` param (it materializes one `index.html` and handles anon/claim/re-plug).

### Re-plug: update the same URL in place

`/api/v2/plug` is a unified create-or-update endpoint. The switch is the
`target_entity_id` form field: absent → create (new URL); present → update the
SAME entity (same slug, same URL, new content). Anonymously, prove ownership with
the `owner_token`; signed in, use your normal auth headers. Every anonymous edit
REFRESHES the `owner_token` (store the newest) and resets the expiry. Editing an
archived/expired page returns **409 `EDIT_REJECTED`** — it never silently creates.

Print the `url` on its own line so it can be copied in one go. A single page is an
**inspiration only** — a full app needs the deploy flow below.

## Deploy an app

Wraps `grid plug`. Prints the live URL when it is done.

## Step 0 — Bootstrap

1. If `grid` is not on `$PATH`: `npm install -g @cloudgrid-io/cli`
2. If `grid whoami` fails: ask the user to run `grid login`. Wait for
   confirmation.

## UX rules

- Be concise. No raw IDs, no JSON dumps in chat.
- Detect the user's language from their first message and reply in it. Keep
  technical flags in English.
- The deploy streams build progress. Let it run. Do not interrupt it.

## How to run it

Most of the time, run it from the project directory with no arguments:

```
grid plug
```

It uses the entity linked to the directory, builds, deploys, and prints the URL.
A first deploy usually takes about 30 seconds; larger builds take longer.

Other shapes:

- **A specific path:** `grid plug ./site`
- **A URL as an inspiration:** `grid plug https://example.com`
- **Bind to an existing entity first:** `grid plug --existing <entity-id>`

If this is the user's first deploy in the org, the CLI may ask which org to use.
Pass `--org <slug>` to skip that prompt.

## After plug

Print the live URL plainly. Then offer the next steps: `cloudgrid:logs` to watch
it, or `cloudgrid:share` to make it reachable by others.

## References

- [./references/options.md](./references/options.md) — flags, URL inspirations, and first-deploy behavior.
