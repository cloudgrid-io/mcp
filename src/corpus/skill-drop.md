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

Then POST it:

```
curl -sS -X POST https://api.cloudgrid.io/api/v2/drop/auto \
  -F "artifact=@/path/to/index.html;type=text/html"
```

The response is JSON. Read two fields:

- `url` — the live, shareable link. Give this to the user.
- `claim_url` — the link to sign in and keep it past the 7-day expiry.

## If the user is signed in

A signed-in user can publish into their own org instead of anonymously — the drop
is owned, lasts 30 days, and needs no claim. Add their token and org to the same
request:

```
JWT=$(jq -r .jwt ~/.cloudgrid/credentials 2>/dev/null)
ORG=$(grep -E '^\s*active_org_slug:' ~/.cloudgrid/config.yaml | awk '{print $2}')
curl -sS -X POST https://api.cloudgrid.io/api/v2/drop/auto \
  -H "Authorization: Bearer $JWT" -H "X-CloudGrid-Org: $ORG" \
  -F "artifact=@/path/to/index.html;type=text/html" -F "org_slug=$ORG"
```

The response has `owned_by: "authenticated"` and no `claim_url`. If the user is a
member of several orgs and `X-CloudGrid-Org` is missing, the API replies with the
list of orgs to choose from. The MCP `cloudgrid_drop` tool does this automatically
when credentials are present.

## Re-dropping (update in place)

A re-drop of the same artifact updates it in place — same URL, new version, views
and reactions intact. The platform matches ownership through the anon-session
cookie, so keep a cookie jar across drops:

```
curl -sS -c jar.txt -X POST https://api.cloudgrid.io/api/v2/drop/auto \
  -F "artifact=@index.html;type=text/html"                      # first drop
curl -sS -b jar.txt -X POST https://api.cloudgrid.io/api/v2/drop/auto \
  -F "previous_id=<entity_id from the first response>" \
  -F "artifact=@index.html;type=text/html"                      # re-drop
```

Send `previous_id` before the artifact part. Read the status:

- `200` — updated in place; the same `url` now serves the new bytes.
- `202` — no change; this exact content is already live.
- `201` — created new: no `previous_id`, or the previous drop was claimed, expired,
  or not yours — the server falls back to create and never hard-fails.

Omit `previous_id` to start a separate new drop. The MCP `cloudgrid_drop` tool does
all of this for you (re-drops update in place; `fresh: true` forces a new one).

## After the drop

Print the `url` on its own line, by itself, so it can be copied in one go. Then add
one line of context: an anonymous drop lasts 7 days and can be claimed to keep it;
a signed-in drop is already owned. Do not bury the URL in prose.

## Limits and errors

- Anonymous drops are **inspirations only**. A full app needs sign-in — if the
  artifact is an app, the API returns 401; switch to `cloudgrid:plug`.
- HTML over 2 MB is rejected. Trim it or suggest signing in.
- There is a per-IP and per-device daily cap. If you hit 429, tell the user to try
  again later.
