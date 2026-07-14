---
name: publish-fallbacks
when: A deploy or drop fails and you are deciding whether to retry, change approach, or stop.
summary: The decision tree for deploy errors — when to switch to the CLI, when to stop, and when to never fall back to anonymous.
---

# Rule: publish fallbacks

When a deploy fails, do not guess. Match the error to one of these cases and
follow it exactly. The wrong reaction burns quota, downgrades ownership, or
loops forever.

## SCOPE_INVALID

This is a known platform issue, not a mistake in your request. Do not retry with
different flag or path permutations — they will all fail the same way. If a
terminal is available, deploy from the CLI instead (`grid plug <path>`).
If no terminal is available, stop and tell the user
this is a known issue and needs the CLI.

## 429 anonymous cap

The anonymous deploy quota is exhausted. Stop. Do not log in to work around it —
that is a login-loop and it does not reset the cap. Do not retry the same deploy
again today. Tell the user the anonymous cap is reached and they can try again
later or sign in for a higher limit as a deliberate choice, not as a retry.

## Signed in + server error

When you are signed in and the deploy hits a server error, retry the signed-in
deploy or stop. Never fall back to an anonymous deploy. Anonymous deploys burn
the anonymous quota and downgrade ownership — the entity is no longer tied to
the user's account, and the share URL and edit rights change hands to an
`owner_token`. Keep the deploy signed in.

## EDIT_REJECTED

The entity you are re-plugging is archived or expired, so it cannot be edited.
Do not silently create a new entity — that mints a new URL and orphans the one
the user has been sharing. Ask the user first whether to create a fresh entity,
then create one only if they say yes.

Match the error, take the one correct action, and stop. Do not permute.
