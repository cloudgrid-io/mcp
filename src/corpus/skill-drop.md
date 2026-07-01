---
version: 0.2.0
name: drop
description: |
  Share an artifact and get a public URL. Use when the user wants to share,
  publish, send, or deploy an HTML page or file, or wants a link for a friend.
  Works with no login (anonymous, 7-day, claimable later) or signed in (published
  into the user's org, owned, 30-day). Inspirations only.
argument-hint: "[file]"
allowed-tools: Bash
---

# CloudGrid Drop

Publish an artifact and get a shareable URL — with no account and no CLI. This is
the fastest path from "I made a thing" to "here is a link."

It calls the CloudGrid API directly. It does **not** use the `cloudgrid` CLI and it
does **not** require login. That is the point: anyone can drop.

## When to use this vs cloudgrid:plug

- **Drop (this skill):** the user is not signed in, or just wants a quick public
  link for an HTML page or file. Anonymous. Inspirations only.
- **Plug (`cloudgrid:plug`):** the user is signed in and wants a full app deploy in
  their own org. Uses the CLI.

If the user is signed in and asks to "share" a static artifact, this skill still
works and is faster; offer `cloudgrid:plug` only when they want an app.

## UX rules

- Be concise. The result the user wants is the URL. Print it plainly.
- Detect the user's language from their first message and reply in it.
- Do not ask the user to log in. The whole value here is that they do not have to.

## How to run it

You need a single HTML file. If the user gave you inline HTML, write it to a file
first. The content must be a full HTML document (start with `<!doctype html>` or
`<html>`); if you only have a fragment, wrap it in a minimal document. HTML is
capped at 2 MB for anonymous drops.

Then POST it to the unified plug endpoint:

```
curl -sS -X POST https://api.cloudgrid.io/api/v2/plug \
  -F "artifact=@/path/to/index.html;type=text/html"
```

The response is JSON (HTTP 201 for an anonymous drop). Read these fields:

- `slug` — the entity's public slug. An anonymous inspiration's live link is
  `https://guest.cloudgrid.io/<slug>`. The response has no ready-made `url`;
  compose it from the slug. (Apps/agents would be `https://<slug>.<grid>.cloudgrid.io`,
  but anonymous drops are always inspirations.)
- `claim_url` — the link to sign in and keep it past the 7-day expiry.
- `claim_message` — a ready-to-show nudge to sign in and claim.

## If the user is signed in

A signed-in user can publish into their own org instead of anonymously — the drop
is owned, lasts 30 days, and needs no claim. Add their token and org to the same
request:

```
JWT=$(jq -r .jwt ~/.cloudgrid/credentials 2>/dev/null)
ORG=$(grep -E '^\s*active_org_slug:' ~/.cloudgrid/config.yaml | awk '{print $2}')
curl -sS -X POST https://api.cloudgrid.io/api/v2/plug \
  -H "Authorization: Bearer $JWT" -H "X-CloudGrid-Org: $ORG" \
  -F "artifact=@/path/to/index.html;type=text/html"
```

A signed-in drop returns HTTP 202 with `slug` + `grid` and no `claim_url` (it is
already owned). Its live link is `https://<grid>.cloudgrid.io/<slug>` for an
inspiration. The org is taken from the `X-CloudGrid-Org` header — there is no
`org_slug` form field. If the user is a member of several orgs and the header is
missing, the API replies with the list of orgs to choose from. The MCP
`cloudgrid_drop` tool does this automatically when credentials are present.

## One drop = one entity (no in-place re-drop)

The unified `/api/v2/plug` endpoint is create-only for this flow: every drop mints
a NEW entity with a NEW URL. There is no `previous_id` / in-place-update path and no
`202 unchanged` no-op — those belonged to the retired `/drop/auto` endpoint. To
publish an update, drop again; you get a fresh link. (To update an existing app in
place, sign in and use `cloudgrid:plug`, which targets the entity by name.)

The MCP `cloudgrid_drop` tool accepts a `fresh` flag for backward compatibility,
but it is now a no-op — each drop is already a fresh create.

## After the drop

Print the composed `url` (e.g. `https://guest.cloudgrid.io/<slug>`) on its own line,
by itself, so it can be copied in one go. Then add one line of context: an anonymous
drop lasts 7 days and can be claimed to keep it; a signed-in drop is already owned.
Do not bury the URL in prose.

## Limits and errors

- Anonymous drops are **inspirations only**. A full app needs sign-in — if the
  artifact is an app, the API returns 401; switch to `cloudgrid:plug`.
- HTML over 2 MB is rejected. Trim it or suggest signing in.
- There is a per-IP and per-device daily cap. If you hit 429, tell the user to try
  again later.
