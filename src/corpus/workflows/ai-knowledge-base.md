---
name: ai-knowledge-base
when: "RAG, ask my docs, knowledge base chatbot, retrieval-augmented search over documents"
needs: ai+database
deploy: runtime
editions: local
kind: blueprint
capabilities_note: "persistent RAG — needs ai + database. Runtime app, async build, local edition only. Declare needs:{ai:true, database:true}; the deployer injects AI_GATEWAY_URL (AI Gateway via @cloudgrid-io/ai — works today) and DATABASE_MONGODB_URL (+legacy MONGODB_URL). The ideal embedding store needs:{vector:pgvector} (VECTOR_PGVECTOR_URL) is PENDING platform issue #1545 — until it lands, store embeddings in a Mongo `chunks` collection and cosine-rank in-app."
summary: "A BLUEPRINT for a retrieval-augmented 'ask my docs' knowledge base — ingest documents, chunk + embed them, retrieve the nearest chunks per question, and answer grounded with citations, on persistent Next.js + Mongo + the CloudGrid AI Gateway. This is not fill-in-the-blanks app code; it ships structure + cloudgrid.yaml. Fetch the template, read AGENTS.md for the file tree / collections / RAG loop / CloudGrid wiring (needs ai+database, the pgvector #1545 note), then BUILD the app under services/web/ following it, and deploy async to a live URL (local edition only)."
---

# Workflow: ai-knowledge-base

The user wants a retrieval-augmented knowledge base — an "ask my docs" chatbot
that answers questions **grounded in their own documents**, with citations, rather
than from the model's memory. That is a **persistent runtime app** (Next.js + the
grid's shared Mongo) with a **RAG loop**: ingest documents → chunk → embed → store
→ at query time embed the question, retrieve the nearest chunks, and ask the model
to answer using only those. It is the `app-with-data` shape plus embeddings +
retrieval + a grounded answer step. Both the embedding and answer calls run through
CloudGrid's **AI Gateway** (`@cloudgrid-io/ai`).

**This is a BLUEPRINT.** Unlike a fill-in-the-blanks template, it ships
*structure* — a `cloudgrid.yaml` and an `AGENTS.md` structure guide — not finished
app code. The recipe is: fetch it, **read `AGENTS.md`**, then **build** the app
following it. Be honest that a runtime deploy is async and needs the local edition.

> **Vector-store status:** the ideal embedding store is `needs: { vector: pgvector }`
> (injects `VECTOR_PGVECTOR_URL`), but it is **PENDING platform issue #1545**. The
> **`ai` part works today.** Until #1545 ships, store embeddings in a Mongo
> `chunks` collection and cosine-rank in the app — the blueprint declares
> `needs: { ai: true, database: true }` and keeps `vector: pgvector` commented.

## 1. Edition check FIRST (hard gate)

A RAG knowledge base is a built + deployed container (Next.js + Mongo + AI
Gateway). It requires the **local edition** (Claude Desktop / Claude Code) or the
CLI.

- **Hosted edition (Claude Web / hosted MCP):** you CANNOT build a runtime app —
  hosted is inline-only and can only publish static pages. Tell the user plainly,
  offer a **static explainer page** instead, and STOP the runtime path here.
- **Local edition:** continue.

## 2. Auth + grid

1. Ensure signed in: `grid_login_status`; if not, `grid_login`.
2. A grid is required. Respect the grid picker: if the user has more than one
   grid, ask which to use; do not assume a target.

## 3. Fetch the blueprint and READ AGENTS.md

`grid_get_template("template", "ai-knowledge-base")`. The deliverable is the
**`AGENTS.md` structure guide** — read it before writing anything. It defines:
- the `services/web/` file tree (pages, `api/documents` + `api/ask` routes, `lib/`),
- the Mongo collections (`documents`, `chunks`) + fields,
- the CloudGrid injection table (needs ai+database + the pgvector #1545 note),
- the ingest → retrieve → answer RAG loop, with lazy `lib/db.js` / `lib/ai.js` /
  `lib/retrieve.js` (cosine top-k over Mongo embeddings until #1545),
- optional auth/payments wiring via `vault:`,
- the deploy flow and the pgvector swap-in once #1545 lands.

There is no app code to copy — you generate it from the guide.

## 4. Scaffold + fill cloudgrid.yaml

`grid_create_project` an app `<name>` FIRST (creates the entity + `.cloudgrid/link.json`
and a starter `cloudgrid.yaml` with empty `services:{}`; `plug` needs a linked
directory). Then put the app under **`services/web/`** and set `cloudgrid.yaml` to
the blueprint's active fields:

```yaml
name: my-knowledge-base
services:
  web:
    type: nextjs
    path: /
needs:
  ai: true
  database: true
```

**App code MUST live under `services/<name>/`** — `path:` is the URL mount, NOT
the filesystem path. **Declare `needs: { ai: true, database: true }`** (canonical)
— the deployer injects `AI_GATEWAY_URL` (routed through `@cloudgrid-io/ai`, no API
key) and provisions Mongo, injecting `DATABASE_MONGODB_URL` (+ legacy
`MONGODB_URL`). `requires:` is the deprecated v1 alias; never author it and never
set `needs:` and `requires:` together (the validator rejects the combination).
Leave `vector: pgvector` **commented** — it is PENDING #1545.

## 5. Build the app following AGENTS.md

Generate the files under `services/web/` per the guide:
- **Lazy getters** for injected values — read `process.env.DATABASE_MONGODB_URL`
  (legacy `MONGODB_URL` fallback) in `lib/db.js` and `process.env.AI_GATEWAY_URL`
  in `lib/ai.js`, **inside** a getter, never at module top level (a top-level read
  fails `next build`).
- **Ingest** (`POST /api/documents`): chunk the text (`lib/chunk.js`), `embed()`
  the chunks via the AI Gateway, store one `chunks` doc per chunk with its
  `embedding` array, mark the `documents` doc `ready`.
- **Retrieve** (`lib/retrieve.js`): embed the question, cosine-rank the Mongo
  `chunks`, return top-k `{ text, documentId, score }` — a pure function that swaps
  cleanly to a pgvector query once #1545 lands.
- **Answer** (`POST /api/ask`): retrieve top-k, prompt the model to answer ONLY
  from the provided context and to cite the chunks, `chat()` via the AI Gateway,
  return the answer plus source chunks so the UI shows **citations**.

## 6. Config / secrets

- The AI Gateway and Mongo need **no secrets** — they are injected by `needs:`. Do
  **NOT** set `AI_GATEWAY_URL`, `DATABASE_MONGODB_URL`, or legacy `MONGODB_URL`
  yourself; the grid injects them.
- Only if you add auth/payments: map the secret in the `vault:` block
  (`AUTH_PROVIDER_KEY` and/or `STRIPE_KEY`) and store the value with
  `grid secrets set <vault-item-key> …`. Non-secret public config → `grid_set_env`.

## 7. (Optional) Run locally

Mention the user can `grid dev` to run locally against the injected dev Mongo + AI
Gateway before deploying. Don't require it.

## 8. Deploy (async)

Deploy the folder with `grid_deploy`. A **runtime deploy is ASYNC**: the first
response is `status: "building"`, NOT a live URL yet.
- Poll `grid_status` (or the returned poll_url) until the entity is live.
- Surface a liveness signal while it builds — never a bare silent wait.
- Only once it is live, return the deployed app URL (NOT the build/log link).

## 9. Return the live URL + iterate

Give the user the live app URL — the deliverable. To iterate, re-plug the SAME
entity so it updates the same URL. Keep it honest: this is a blueprint you built
from, the build is async, it is local-edition only, credentials are injected by the
grid (AI Gateway + Mongo via `needs`), and the pgvector store is PENDING #1545 (so
embeddings currently live in Mongo). Swap to pgvector when #1545 ships per
`AGENTS.md` §7.
