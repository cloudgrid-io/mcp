# ai-knowledge-base template — RAG "ask my docs" blueprint

A blueprint for a retrieval-augmented knowledge-base chatbot on CloudGrid: a
persistent Next.js + Mongo app that ingests documents, chunks and embeds them,
and answers questions grounded in the retrieved chunks (with citations) — the
`app-with-data` runtime shape with a RAG loop layered on. Embeddings and answers
run through CloudGrid's AI Gateway (`@cloudgrid-io/ai`, injected via
`needs: { ai: true }` — works today); the ideal vector store `needs: vector`
(pgvector) is **now available** — #1545 shipped (verified live 2026-07-16) — but
this blueprint stores embeddings in Mongo and computes similarity in-app. Because RAG involves choices
(chunking, embedding model, retrieval), this template ships the **structure and
`cloudgrid.yaml`, not finished app code** — adapt it and build.

> **This is a blueprint: structure + cloudgrid.yaml, adapt and build.** Read
> `AGENTS.md` for the file tree, Mongo collections, CloudGrid injection table
> (needs + AI Gateway + the pgvector note), the RAG loop, optional
> auth/payments wiring, and the deploy flow — then generate the app under
> `services/web/` and `grid plug` it (runtime, local edition, async — poll to a
> live URL).

## Files

- `cloudgrid.yaml` — active fields: `name`, `services.web` (nextjs, `/`), and
  `needs: { ai: true, database: true }`. `vector: pgvector` is present but
  commented (available now, #1545 shipped — this blueprint uses Mongo
  embeddings); the optional `vault:` block (auth/payments) is
  commented too.
- `AGENTS.md` — the structure guide (read this first).
- `index.md` — the fetch-bundle summary + cloudgrid.yaml.
