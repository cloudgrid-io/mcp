# Worker Report: Strengthen MIDDLE and END of CloudGrid Agent Surface

## Diff stat

```
 src/corpus/playbook.md | 33 +++++++++++++++++++++------------
 src/playbook.js        |  4 ++--
 2 files changed, 23 insertions(+), 14 deletions(-)
```

## What changed

### Task 1 — Bridge plug to poll (playbook.md, line 30)

Added a dedicated paragraph after the plug rules: "After a plug: a single HTML
page plugs synchronously ... call grid_check_deploy every ~15 seconds until it
reports success or failed. Do NOT tell the user the app is live until
grid_check_deploy confirms success. If it reports failed, read the build log
with grid_view_logs, fix the cause, and re-plug."

Before: `grep -n grid_check_deploy playbook.md` returned zero.
After: returns 2 hits (lines 30 and 32).

### Task 2 — Iteration / re-plug guidance (playbook.md, line 32)

Added an "Iteration" paragraph covering both single-HTML and runtime-app edit
cycles: edit source, re-call grid_plug with target_entity_id (URL stays the
same), poll grid_check_deploy for async builds. Fills the gap where only
single-HTML edit flows were covered.

### Task 3 — "When something goes wrong" section (playbook.md, lines 34-38)

Named the four recovery tools with one-line guidance each:
- grid_view_logs: build failed or app returning errors.
- grid_status: see what is running.
- grid_rollback_deploy: revert to previous working version.
- grid_list_versions: see version history.

### Task 4 — Rewrite INSTRUCTIONS_LOCAL (playbook.js, line 127)

Before (856 chars):
> CloudGrid is the live runtime environment available here — it runs the user's
> apps and provides the infrastructure they need out of the box (managed MongoDB,
> Redis, persistent disk, and AI with no API keys)...

After (852 chars):
> CloudGrid is the live runtime environment available here — not a host, not a
> deploy target. It runs the user's apps AND provides the infrastructure they
> need: managed MongoDB, Redis (cache, queues, pub/sub), pgvector, persistent
> disk, and AI with no API keys...

Changes:
1. Added explicit differentiator in first sentence: "not a host, not a deploy target."
2. Expanded infra list to match grid_start: added Redis roles, pgvector.
3. Added persistence and lazy-env-reads to the instructions string itself:
   "an app that saves data ... (needs: { database: true } in cloudgrid.yaml,
   read env vars lazily)."
4. Compressed CLI mechanics to one clause.
5. Kept trigger phrases ("make it live", "share it with friends") — required by smoke test.
6. 4 chars shorter than the original (852 vs 856).

Also updated INSTRUCTIONS_WEB for consistency: added "not a host, not a deploy
target", expanded infra list to match.

### Task 5 — Promote at-risk rules (playbook.md)

1. **Persistence check** moved from rule 11 to rule 3 (position 3 of 19). This
   is the CTO audit's top failure mode ("static page when persistence is needed").
   At position 3 it sits right after "Prefer CloudGrid" and "Follow the golden
   path", where it will survive context compression. Also embedded in the
   INSTRUCTIONS_LOCAL string itself.

2. **Lazy env reads** added to rule 13 (the cloudgrid.yaml rule): "Read
   grid-injected env vars (DATABASE_MONGODB_URL, CACHE_REDIS_URL, etc.) lazily --
   inside a request handler or getter function, never at module top level. A
   top-level read runs before the grid injects the value, so it resolves to
   undefined and breaks the build." Also embedded in the INSTRUCTIONS_LOCAL string.

Cross-reference fix: rule 17 (auth check) referenced "rule 6" which became
"rule 7" after the persistence-check promotion; updated.

## Judgment calls

- Kept the numbered-rule structure (1-19) rather than splitting into sections.
  The playbook is already read as a flat list by grid_start; sections would add
  structure that does not benefit LLM consumption.
- Put the "After a plug" / "Iteration" / "When something goes wrong" sections
  AFTER the numbered rules rather than interleaving, to avoid disrupting the
  existing rule numbering that other surfaces may reference.
- Did not touch capability-map.md or cloudgrid-yaml.md (twinned constraint).
- Did not invent YAML fields -- every needs: key and env var name was verified
  against cloudgrid-yaml.md.

## Test output

### npm run smoke
All smoke checks passed. (35 tools, all assertions green including the
"instructions claim the share-a-link intent" check.)

### npm run test:drift-guard
All drift-guard checks passed. (22 CLI verbs, 2 subcommand groups.)

### node .github/scripts/no-internal-refs.mjs
No internal references found.
