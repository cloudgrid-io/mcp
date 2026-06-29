---
version: 0.2.0
name: share
description: |
  Make a CloudGrid entity shareable and print its URL. Use when the user wants to
  share a link, make something public, send an app to someone, or get a shareable
  URL. Wraps cloudgrid visibility.
argument-hint: "[name]"
allowed-tools: Bash
---

# CloudGrid Share

Set an entity's visibility so others can reach it, then print the URL. Wraps
`cloudgrid visibility set`.

## Step 0 — Bootstrap

1. If `cloudgrid` is not on `$PATH`: `npm install -g @cloudgrid-io/cli`
2. If `cloudgrid whoami` fails: ask the user to run `cloudgrid login`. Wait for
   confirmation.

## UX rules

- Be concise. The result the user wants is the URL. Print it plainly.
- Detect the user's language from their first message and reply in it. Keep
  technical flags in English.

## How to run it

To make an entity reachable by anyone with the link:

```
cloudgrid visibility set my-thing link
```

The command prints the outlet URL. Hand that URL to the user.

## Visibility modes

`cloudgrid visibility set <slug> <mode>` accepts:

- `link` — anyone with the URL can open it. Use this for sharing.
- `private` — only the owner.
- `authenticated` — any logged-in user.
- `org` — members of the org.
- `space` — members of the entity's space.

Default to `link` when the user says "share" or "make it public". Confirm before
using a wider mode than they asked for.

## After share

Print the outlet URL on its own line, by itself, so it can be copied in one go.
Then, if it fits, offer the `feedback` skill to see what people say about it.
