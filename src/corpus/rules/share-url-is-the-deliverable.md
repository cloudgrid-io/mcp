---
name: share-url-is-the-deliverable
when: You have finished deploying something for the user and are writing your final reply.
summary: End every deploy by returning the live share URL on its own line, using the server-returned url verbatim.
---

# Rule: the share URL is the deliverable

The point of a deploy is the live link. The user cannot use anything they cannot
open, so the URL is the deliverable — not a description of it.

- **End with the URL.** Close your reply with the live share URL on its own
  line, so it is the last and clearest thing the user sees.
- **Use the server-returned `url` verbatim.** Copy the `url` field from the
  deploy response exactly. Do not reconstruct it, guess the slug, or edit the
  host — a hand-built URL can 404 even when the deploy succeeded.

Deploy, then hand over the link.
