# Template: ai-knowledge-base (blueprint — RAG "ask my docs" on Next.js + Mongo + AI Gateway)

A **blueprint** for a retrieval-augmented knowledge base / "ask my docs" chatbot:
ingest documents, chunk + embed them, and answer questions grounded in the
retrieved chunks with citations. It is the persistent Next.js + Mongo runtime
shape (same base as `app-with-data` / `crm`) with a RAG loop layered on. This
template ships **structure, not app code** — read the structure guide, then build
the app following it.

**This is a blueprint (tier D):** the deliverable is `cloudgrid.yaml` +
`AGENTS.md`. Fetch the bundle, read `AGENTS.md`, then generate the files under
`services/web/` and deploy.

- **Structure guide:** `gridctl_fetch("template", "ai-knowledge-base")` → read
  **`AGENTS.md`** (file tree, Mongo collections, CloudGrid injection table, the
  RAG loop, the pgvector #1545 note, optional auth/payments, deploy steps).

**Key rules (same runtime discipline as `app-with-data`):**

1. **App code MUST live under `services/web/`, not the repo root.** `path: /` in
   `cloudgrid.yaml` is the URL mount, NOT the filesystem path.
2. **Read injected values LAZILY (inside a getter), never at module top level** —
   a top-level read fails `next build`. The grid injects `DATABASE_MONGODB_URL`
   (+ legacy `MONGODB_URL`) for Mongo and `AI_GATEWAY_URL` for the AI Gateway.
3. **Declare `needs: { ai: true, database: true }`** (canonical shape). Never
   author `requires:`, and never set `needs:` and `requires:` together (the
   validator rejects the combination).
4. **Ground answers in retrieved chunks + cite them** — never answer from the
   model's parametric memory alone. Keep chunking/retrieval as pure functions.

**Vector store:** `needs: vector` (pgvector, injecting `VECTOR_PGVECTOR_URL`) is
the intended embedding store but is **PENDING platform issue #1545**. The `ai`
part works today — until #1545 ships, store embeddings in a Mongo `chunks`
collection and rank by cosine similarity in the app; swap to a pgvector
ORDER-BY-distance query when it lands (see `AGENTS.md` §7).

Runtime app → **local edition** only (async build, poll to a live URL).

## cloudgrid.yaml

```yaml
# On disk this file is the full-annotated reference (templates/_cloudgrid.yaml.reference) with EVERY
# field present as a comment; only the fields below are uncommented, so it
# deploys to exactly these active fields. `vector: pgvector` is present but kept
# COMMENTED (PENDING #1545).
name: my-knowledge-base
services:
  web:
    type: nextjs
    path: /
needs:
  ai: true
  database: true
```

> **Capability:** `needs: { database: true }` → the deployer provisions Mongo and
> injects `DATABASE_MONGODB_URL` (plus legacy `MONGODB_URL`). `needs: { ai: true }`
> → injects `AI_GATEWAY_URL`; `@cloudgrid-io/ai` routes embeddings + chat through
> it with no API key to manage. `needs: { vector: pgvector }` (would inject
> `VECTOR_PGVECTOR_URL`) is PENDING #1545. See the capability-map for the full
> injection table.

## Structure guide

The real content of this blueprint is **`AGENTS.md`** — fetch the template bundle
and read it. It covers the `services/web/` file tree, the `documents` / `chunks`
collections, the CloudGrid injection table (needs + AI Gateway + the #1545 note),
the ingest → retrieve → answer RAG loop with lazy `lib/db.js` / `lib/ai.js` /
`lib/retrieve.js`, optional auth/payments via `vault:`, and the
`grid init → fill → grid plug → poll` deploy flow.

## Adapt it

- Pick your chunking window/overlap and embedding model in `lib/chunk.js` /
  `lib/ai.js`; tune retrieval `k`.
- Add auth (uncomment `vault: { AUTH_PROVIDER_KEY }`) to gate the KB, or payments
  (`vault: { STRIPE_KEY }`) to charge for access.
- When pgvector #1545 lands, uncomment `needs: { vector: pgvector }` and swap
  `lib/retrieve.js` to an ORDER-BY-distance query (`AGENTS.md` §7).
- Build under `services/web/`, then `grid dev` (local) / `grid plug` (async — poll
  to a live URL).
