---
version: 0.2.0
name: claim
description: |
  Claim an anonymous CloudGrid drop into the user's account. Use when the user
  dropped something anonymously and now wants to keep it, own it, or stop it from
  expiring after signing in. The public URL does not change.
argument-hint: "[claim-url-or-token]"
allowed-tools: Bash
---

# CloudGrid Claim

Turn an anonymous drop into an owned one. After an anonymous drop, the user has a
`claim_url` (or token). Once they sign in, claiming transfers ownership to them and
extends the expiry from 7 days to 30. The shareable URL stays the same, so any link
already shared keeps working.

## Step 0 — sign in first

Claiming needs an identity. If the user is not signed in, run the `cloudgrid:login`
skill (or `cloudgrid login` with the CLI) first.

## What you need

The claim token from the anonymous drop. It is the `token` query parameter inside
the `claim_url` the drop returned, for example
`https://console.cloudgrid.io/claim?token=<TOKEN>`.

## How to run it

```
JWT=$(jq -r .jwt ~/.cloudgrid/credentials 2>/dev/null)
# TOKEN is the claim token (from claim_url's ?token=...)
curl -sS -X POST https://api.cloudgrid.io/api/v2/anon-claim \
  -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d "{\"claim_token\":\"$TOKEN\"}"
```

The response is `{ "claimed": [ { "url", "new_expires_at" }, ... ] }`.

## Reading the result

- A non-empty `claimed` list means it worked. Tell the user the drop is now theirs,
  the URL is unchanged, and the new expiry.
- An empty `claimed` list means there was nothing to claim — it may already be
  claimed or expired. Say so plainly.

## Notes

- One token claims one drop. To claim several, repeat with each token.
- The MCP `cloudgrid_claim` tool does this for you, and remembers the token from the
  last anonymous drop so you can claim with no arguments.
