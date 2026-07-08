---
version: 0.2.0
name: drop
description: |
  Share an artifact and get a public URL. Use when the user wants to share,
  publish, send, or deploy an HTML page or file, or wants a link for a friend.
  Works with no login (anonymous, claimable later) or signed in (published
  into the user's org, owned). Re-plugging updates the same URL in place.
  Inspirations only.
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

- `url` — the live link, composed by the server. Use it verbatim; never compose a
  URL from the slug yourself.
- `entity_id` — the durable handle for updating this drop later (see re-plug below).
- `owner_token` — a JWT proving you made this drop. It lets you re-plug the drop
  anonymously and doubles as the claim token. Its lifetime matches the drop's
  expiry (default 7 days). Persist it together with `entity_id` and `url`.
- `claim_url` — the link to sign in and keep the drop past its expiry.
- `claim_message` — a ready-to-show nudge to sign in and claim.

## If the user is signed in

A signed-in user can publish into their own org instead of anonymously — the drop
is owned and needs no claim. Add their token and org to the same request:

```
JWT=$(jq -r .jwt ~/.cloudgrid/credentials 2>/dev/null)
ORG=$(grep -E '^\s*active_org_slug:' ~/.cloudgrid/config.yaml | awk '{print $2}')
curl -sS -X POST https://api.cloudgrid.io/api/v2/plug \
  -H "Authorization: Bearer $JWT" -H "X-CloudGrid-Org: $ORG" \
  -F "artifact=@/path/to/index.html;type=text/html"
```

A signed-in drop returns HTTP 202 with `entity_id`, `url`, `slug` + `grid` and no
`claim_url` (it is already owned). Use the returned `url` as the live link — do
not compose it. The org is taken from the `X-CloudGrid-Org` header — there is no
`org_slug` form field. If the user is a member of several orgs and the header is
missing, the API replies with the list of orgs to choose from. The MCP
`grid_drop` tool does this automatically when credentials are present.

## Re-plug: update the same URL in place

`/api/v2/plug` is a unified create-or-update endpoint. The switch is the
`target_entity_id` form field:

- **Absent** → create: a new entity, a new URL.
- **Present** → re-plug: the SAME entity is updated — same slug, same URL, new
  content. This is how you iterate on one shareable link.

Signed in, re-plug with the entity id and your normal auth headers:

```
curl -sS -X POST https://api.cloudgrid.io/api/v2/plug \
  -H "Authorization: Bearer $JWT" -H "X-CloudGrid-Org: $ORG" \
  -F "target_entity_id=$ENTITY_ID" \
  -F "artifact=@/path/to/index.html;type=text/html"
```

Anonymously, prove ownership with the `owner_token` the drop returned:

```
curl -sS -X POST https://api.cloudgrid.io/api/v2/plug \
  -F "target_entity_id=$ENTITY_ID" \
  -F "owner_token=$OWNER_TOKEN" \
  -F "artifact=@/path/to/index.html;type=text/html"
```

Rules that matter:

- `entity_id` + `url` (+ `owner_token` when anonymous) are the durable re-plug
  handle. Persist them after every drop.
- Every anonymous edit REFRESHES the `owner_token` — store the one from the
  latest response; the old one is superseded. Each edit also resets the drop's
  expiry window.
- Editing an archived or expired drop returns **409 `EDIT_REJECTED`** — it never
  silently creates a new entity. Drop again (without `target_entity_id`) if the
  user wants a new link.
- An anonymous edit without a valid `owner_token` returns **401**.
- Anonymous edits count against the same daily anonymous cap as creates.
- Only re-plug when the user is iterating on an existing artifact. If they want a
  separate new link, omit `target_entity_id` (the MCP `grid_drop` tool's
  `fresh` flag does the same: it forces a new entity instead of updating).

## After the drop

Print the `url` from the response on its own line, by itself, so it can be copied
in one go. Then add one line of context: an anonymous drop expires (default 7 days,
reset on every edit) and can be claimed to keep it; a signed-in drop is already
owned. Do not bury the URL in prose. Keep `entity_id` (and `owner_token` if
anonymous) so a follow-up "change X" can re-plug the same URL.

## Limits and errors

- Anonymous drops are **inspirations only**. A full app needs sign-in — if the
  artifact is an app, the API returns 401; switch to `cloudgrid:plug`.
- HTML over 2 MB is rejected. Trim it or suggest signing in.
- There is a per-IP and per-device daily cap. If you hit 429, tell the user to try
  again later.
