---
name: simple-semantic-search
when: semantic search over a document / article / text, "search my doc by meaning", question-answering search box over content, embeddings search, vector search, similarity search, "find the passage that answers X" — a SINGLE document or small text set, one service. For a multi-service document portfolio with upload UI + refresh cron, use semantic-search instead.
needs: vector, ai
deploy: runtime
editions: local
capabilities_note: "vector search — needs: { vector: pgvector } (injects VECTOR_PGVECTOR_URL; #1545 shipped, verified live 2026-07-16) + ai: true (embeddings via @cloudgrid-io/runtime, no API key). Runtime app, async build, local edition only."
summary: "One node service that embeds a document into the entity's own pgvector schema at startup and serves POST /search + a minimal UI — probe-sized vector column, idempotent background seed, /health 503-until-ready, cosine <=> ranking. grid init app --here, grid plug, live in ~3 minutes."
---

# Workflow: simple-semantic-search

The user wants to search content by MEANING — "find where it talks about X",
a question box over an article, notes, or docs. Keyword match is not enough;
this is embeddings + a vector store. On CloudGrid that is one declared need,
not infrastructure to run.

## 1. Edition check FIRST (hard gate)

A runtime app: needs the **local edition** (Claude Desktop / Claude Code) or
the CLI. On the hosted edition, say persistence/vector isn't available there
and offer a static alternative honestly.

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
grid init app <name> --here    # registers the entity, writes .cloudgrid/link.json
grid plug                      # async build — live URL in ~2-3 minutes
grid visibility set <slug> link
```

`.cloudgrid/link.json` (entity_id / org / slug binding) is WRITTEN BY THE CLI —
never hand-author it. If the folder was copied from someone else's project,
`rm -rf .cloudgrid` first so `grid plug` doesn't update THEIR app.

## 5. Verify like it's real

Open the live URL, ask a question whose answer is in the document, and check
the top passage actually answers it (rules out keyword-only luck). `grid logs`
shows the `[seed]` lines; `/health` returns `{status:"ok", chunks: N, dim: D}`
when ready.
