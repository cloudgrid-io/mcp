---
name: simple-semantic-search
when: semantic search over a document / article / text, "search my doc by meaning", question-answering search box over content, embeddings search, vector search, similarity search, "find the passage that answers X" — a SINGLE document or small text set, one service. For a multi-service document portfolio with upload UI + refresh cron, use semantic-search instead.
needs: vector, ai
deploy: runtime
editions: all
capabilities_note: "vector search — needs: { vector: pgvector } (injects VECTOR_PGVECTOR_URL; #1545 shipped, verified live 2026-07-16) + ai: true (embeddings via @cloudgrid-io/runtime, no API key). Runtime app, async build, any edition (hosted: artifact_files inline; local: a folder)."
summary: "One node service that embeds a document into the entity's own pgvector schema at startup and serves POST /search + a minimal UI — probe-sized vector column, idempotent background seed, /health 503-until-ready, cosine <=> ranking. grid plug (auto-creates the entity from cloudgrid.yaml), live in ~3 minutes."
---

# Workflow: simple-semantic-search

The user wants to search content by MEANING — "find where it talks about X",
a question box over an article, notes, or docs. Keyword match is not enough;
this is embeddings + a vector store. On CloudGrid that is one declared need,
not infrastructure to run.

## 1. Edition check FIRST (pick the plug path)

A persistent app is a built + deployed container: an async build, not an
instant static drop. It works on every edition; what differs is how the files
reach the grid.

- **Hosted edition (Claude Web / hosted MCP):** write the files in the
  conversation and pass them inline to `grid_plug` as `artifact_files` (one
  entry per file, with the manifest as `cloudgrid_yaml`), then poll
  `grid_check_deploy`. A few text files plug fine; a framework build with a
  lockfile or binary assets is more reliable from the CLI
  (`npx -y @cloudgrid-io/cli@latest plug`), so say so rather than dropping
  files silently. Where this recipe says "scaffold with `grid new`" or "deploy
  the folder", do the same work inline: write the same files and plug them.
- **Local edition:** continue — scaffold, write the folder, and plug it with
  `path`.
## 2. Fetch the template

`grid_get_template({kind: "template", name: "simple-semantic-search"})` — it
contains the full working source (proven by a live deploy), the cloudgrid.yaml,
and the `.cloudgrid/link.json` explainer.

## 3. Adapt

- Drop the user's content into `services/web/src/document.txt` (plain text,
  blank-line-separated passages). Everything else usually stays as-is.
- Keep the three proven mechanics exactly: probe-sized `vector(dim)` column,
  idempotent background seed with `/health` 503-until-ready, lazy
  `VECTOR_PGVECTOR_URL` read (legacy `PGVECTOR_URL` fallback).
- The manifest is two needs and one service:

```yaml
needs:
  vector: pgvector
  ai: true
services:
  web: { type: node, path: /, health: /health }
```

## 4. Deploy

```bash
grid plug                      # first plug registers the entity from cloudgrid.yaml
                               # (honors its name:), then async build — live URL in ~2-3 minutes
grid visibility set <slug> link
```

`.cloudgrid/link.json` (entity_id / grid / slug binding) is WRITTEN BY THE CLI on
the first `grid plug` — never hand-author it. If the folder was copied from someone else's project,
`rm -rf .cloudgrid` first so `grid plug` doesn't update THEIR app.

## 5. Verify like it's real

Open the live URL, ask a question whose answer is in the document, and check
the top passage actually answers it (rules out keyword-only luck). `grid logs`
shows the `[seed]` lines; `/health` returns `{status:"ok", chunks: N, dim: D}`
when ready.
