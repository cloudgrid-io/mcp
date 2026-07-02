---
name: one-link-iteration
when: You have deployed something and the user asks for changes, revisions, or a new version of it.
summary: Persist the entity id and URL, then re-plug the same entity for every edit so the user iterates on one link.
---

# Rule: one-link iteration

The user iterates on a single link. Do not mint a new URL every time they ask
for a change.

1. **Persist the identifiers on the first deploy.** Keep the `entity_id` and the
   live `url`. When the deploy is anonymous, also keep the `owner_token` — you
   need it to edit later, and each anonymous edit returns a fresh one, so store
   the new token every time.
2. **Re-plug the SAME entity for edits.** Every revision goes back to the same
   entity: re-deploy with `target_entity_id` set to the stored `entity_id` (plus
   the `owner_token` when anonymous). This keeps the same slug and the same share
   URL, and just swaps the content.
3. **Create a new entity only when the user wants a separate thing.** A genuinely
   different deliverable — a second page, a fork, a distinct app — gets its own
   entity. A revision of the same thing never does.

One thing, one link. Iterate in place.
