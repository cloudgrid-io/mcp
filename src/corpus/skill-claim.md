---
version: 0.2.0
name: claim
description: |
  Claim an anonymous CloudGrid drop into the user's account. Use when the user
  dropped something anonymously and now wants to keep it, own it, or stop it from
  expiring after signing in. Ownership transfers to the user and the drop re-homes
  into their grid, so its public URL changes.
argument-hint: "[claim-url-or-token]"
allowed-tools: Bash
---

# CloudGrid Claim

Turn an anonymous drop into an owned one. After an anonymous drop, the user has a
`claim_url` (or token) plus the drop's `entity_id`. Once they sign in, claiming
transfers ownership to them and resets the expiry window. Claiming
re-homes the drop into the user's grid, so its public URL changes from
`guest.cloudgrid.io/<slug>` to `<grid>.cloudgrid.io/<slug>` — share the new link.

## Step 0 — sign in first

Claiming needs an identity. If the user is not signed in, run the `cloudgrid:login`
skill (or `grid login` with the CLI) first.

## What you need

Two things: the **entity id** of the anonymous drop (the `entity_id` field the drop
returned), and the **claim token**. The claim token is the drop's `owner_token` —
the same JWT used for anonymous re-plugs. It also appears as the `token` query
parameter inside the `claim_url` the drop returned, e.g.
`https://console.cloudgrid.io/claim?token=<TOKEN>`.
A browser that still holds the `cg_anon_session` cookie from the drop can claim
without a token instead.

Note: every anonymous re-plug (edit) of the drop refreshes the `owner_token` and
resets the drop's expiry. Always claim with the token from the LATEST drop or
edit response — an older token may have been superseded.

## How to run it

Claiming is now a "pickup" of the entity into your grid. The entity id goes in the
URL path; the claim token goes in the body:

```
JWT=$(jq -r .jwt ~/.cloudgrid/credentials 2>/dev/null)
ORG=$(grep -E '^\s*active_org_slug:' ~/.cloudgrid/config.yaml | awk '{print $2}')
# ENTITY_ID from the drop response; TOKEN from claim_url's ?token=...
curl -sS -X POST "https://api.cloudgrid.io/api/v2/entities/$ENTITY_ID/pickup" \
  -H "Authorization: Bearer $JWT" -H "X-CloudGrid-Org: $ORG" \
  -H "Content-Type: application/json" \
  -d "{\"claim_token\":\"$TOKEN\"}"
```

A successful claim returns HTTP 200 with `{ entity_id, slug, grid, url,
new_expires_at, role_granted: "owner", ... }`.

## Reading the result

- HTTP 200 means it worked. Ownership transferred to the user; tell them the drop is
  now theirs and give them the new `url` and `new_expires_at`. NOTE: claiming
  re-homes the inspiration into the user's grid, so the public URL CHANGES from
  `guest.cloudgrid.io/<slug>` to `<grid>.cloudgrid.io/<slug>` — share the new one.
- HTTP 409 `ALREADY_CLAIMED` means there was nothing left to claim — it was already
  picked up. Say so plainly.
- HTTP 403 `CLAIM_TOKEN_REQUIRED` / `INVALID_CLAIM_TOKEN` means the token is missing,
  wrong, or expired (and no owning cookie was sent).

## Notes

- One pickup claims one entity. To claim several, repeat with each entity id + token.
- The MCP `grid_claim_anonymous_deploy` tool does this for you, and remembers the entity id +
  token from the last anonymous drop so you can claim with no arguments.
