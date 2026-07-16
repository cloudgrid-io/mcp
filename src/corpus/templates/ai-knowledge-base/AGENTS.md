# AGENTS.md — ai-knowledge-base blueprint (structure guide)

This is a **blueprint**, not a runnable app. It ships a `cloudgrid.yaml` and this
guide so an agent can *build* a retrieval-augmented "ask my docs" knowledge base
correctly on CloudGrid. There is no app code to copy — read this, generate the
files, then deploy.

An AI knowledge base is a persistent Next.js + Mongo runtime app (same base shape
as `app-with-data` / `crm`) with a **RAG** loop layered on: ingest documents →
chunk them → embed each chunk → store the vectors → at query time embed the
question, retrieve the nearest chunks, and ask the model to answer grounded in
them (with citations). Both the embedding and the answer step run through
CloudGrid's **AI Gateway** (`@cloudgrid-io/ai`, injected via `needs: { ai: true }`).

> **Vector-store status (read this first):** the ideal store for embeddings is
> `needs: vector` (pgvector on Postgres, injecting `VECTOR_PGVECTOR_URL`), and it
> is **now available** — #1545 shipped (verified live 2026-07-16). This blueprint
> still stores embeddings in **Mongo** (a `chunks` collection with an
> `embedding: number[]` field) and computes cosine similarity in the app; its
> `cloudgrid.yaml` declares `needs: { ai: true, database: true }` and keeps
> `vector: pgvector` commented. Uncomment it only if you also build the retrieval
> on pgvector — Section 7 describes the drop-in swap.

---

## 1. File tree

App code MUST live under `services/web/` — `path: /` in `cloudgrid.yaml` is the
URL mount, NOT the filesystem path. Files at the repo root fail with
`Error: Service directory not found: …/services/web`.

```
cloudgrid.yaml                              # name + services.web(nextjs,/) + needs:{ai:true, database:true}
services/web/
  package.json                              # next, react, react-dom, mongodb, @cloudgrid-io/ai
  lib/
    db.js                                   # lazy Mongo client from DATABASE_MONGODB_URL (legacy MONGODB_URL fallback)
    ai.js                                   # lazy @cloudgrid-io/ai client from AI_GATEWAY_URL — embed() + chat()
    chunk.js                                # pure fn: splitIntoChunks(text) -> string[] (e.g. ~800-token windows, overlap)
    retrieve.js                             # embed query -> cosine-rank chunks in Mongo -> top-k with scores
  app/
    layout.js                               # root layout + inline CSS
    page.js                                 # server component: doc list + upload form + ask box
    documents/[id]/page.js                  # a document's chunks / indexing status
    ask-box.js                              # client component: POST a question, stream/show the grounded answer + citations
    api/
      documents/route.js                    # GET list docs / POST ingest (chunk -> embed -> store) / DELETE (doc + its chunks)
      ask/route.js                          # POST { question } -> retrieve top-k chunks -> chat() grounded answer + sources
```

Keep it minimal and real; grow routes/collections as needed. Reuse the
`app-with-data` App-Router GET/POST/DELETE route shape for the CRUD parts.

---

## 2. Mongo collections + fields

The grid provisions one MongoDB database (`needs: { database: true }`). Suggested
collections (`_id` is the Mongo ObjectId on every doc):

**`documents`** — a source document the user added
- `title` (string)
- `source` (string — filename, URL, or "pasted")
- `status` (string: `indexing` | `ready` | `failed`)
- `chunkCount` (number — how many chunks it produced)
- `createdAt` (Date)

**`chunks`** — one embeddable slice of a document (the retrieval unit)
- `documentId` (ObjectId ref → documents)
- `text` (string — the chunk content, returned as a citation)
- `ordinal` (number — chunk order within the doc)
- `embedding` (number[] — the embedding vector; e.g. length 1536)
- `createdAt` (Date)

As shipped, `chunks.embedding` lives in Mongo and you rank in the app
(Section 3). If you swap to pgvector (available — #1545 shipped), the vectors
move to Postgres and `chunks` keeps only the text + a foreign key (Section 7).

---

## 3. How CloudGrid injects things

You never provision infra or set connection strings by hand. Declared inputs are
injected as env vars at `grid dev` (local) and at runtime (after `grid plug`):

| What | Declared in cloudgrid.yaml | Injected env var(s) | Read in code |
|------|----------------------------|---------------------|--------------|
| MongoDB | `needs: { database: true }` | `DATABASE_MONGODB_URL` (+ legacy `MONGODB_URL`) | `lib/db.js` |
| AI Gateway | `needs: { ai: true }` | `AI_GATEWAY_URL` | `lib/ai.js` (via `@cloudgrid-io/ai`) |
| Vector store (available — #1545 shipped) | `needs: { vector: pgvector }` | `VECTOR_PGVECTOR_URL` (+ legacy `PGVECTOR_URL`) | `lib/retrieve.js` — not used by this blueprint (Section 7 for the swap) |
| Auth key (optional) | `vault: { AUTH_PROVIDER_KEY: auth-provider-key }` | `AUTH_PROVIDER_KEY` | `lib/auth.js` |
| Stripe key (optional) | `vault: { STRIPE_KEY: stripe-live-key }` | `STRIPE_KEY` | `lib/stripe.js` |

The **AI Gateway needs no API key** — `needs: { ai: true }` injects
`AI_GATEWAY_URL` and `@cloudgrid-io/ai` routes through it. The `vault:` block only
**maps** an org vault item key → an env var name; store the real value once with
`grid secrets set <vault-item-key> <value>`. Never commit a secret; never hardcode
a connection string.

**Read injected values LAZILY inside a getter, never at module top level** — a
top-level `const uri = process.env.DATABASE_MONGODB_URL` fails `next build` (the
module is imported for route analysis before the grid injects the var). Same rule
for the AI client.

```js
// lib/db.js — same proven shape as app-with-data
import { MongoClient } from "mongodb";
export async function getDb() {
  const uri = process.env.DATABASE_MONGODB_URL || process.env.MONGODB_URL;
  if (!uri) throw new Error("DATABASE_MONGODB_URL not set — run via `grid dev` / `grid plug`.");
  globalThis.__mongo ??= new MongoClient(uri).connect();
  return (await globalThis.__mongo).db();
}
```

```js
// lib/ai.js — lazy AI Gateway client (no API key; the gateway URL is injected)
import { createClient } from "@cloudgrid-io/ai";
function ai() {
  const url = process.env.AI_GATEWAY_URL;
  if (!url) throw new Error("AI_GATEWAY_URL not set — declare needs:{ai:true} and run via `grid dev`/`grid plug`.");
  globalThis.__ai ??= createClient({ baseURL: url });
  return globalThis.__ai;
}
// embed one or many strings -> vectors (used for both indexing and queries)
export async function embed(texts) {
  const res = await ai().embeddings.create({ input: Array.isArray(texts) ? texts : [texts] });
  return res.data.map((d) => d.embedding);
}
// grounded chat answer
export async function chat(messages) {
  const res = await ai().chat.completions.create({ messages });
  return res.choices[0].message.content;
}
```

---

## 4. The RAG loop (build this)

### Ingest (`POST /api/documents`)
1. Accept a title + raw text (or a fetched URL's text).
2. `splitIntoChunks(text)` in `lib/chunk.js` — a pure function producing ~800-token
   windows with a small overlap so context isn't cut mid-idea.
3. Insert a `documents` doc with `status: "indexing"`.
4. `embed(chunkTexts)` (batch) via `lib/ai.js`, then insert one `chunks` doc per
   chunk with its `embedding`, `text`, `ordinal`, and `documentId`.
5. Update the document to `status: "ready"`, `chunkCount: n`.

### Retrieve (`lib/retrieve.js`)
1. `embed(question)` -> query vector.
2. As shipped (Mongo embeddings): load candidate `chunks`, compute cosine
   similarity in the app, keep the top-k (e.g. k=5). Keep it a pure, testable
   ranking function so it swaps cleanly to a pgvector query later.

```js
// lib/retrieve.js — cosine top-k over Mongo-stored embeddings (as shipped)
import { getDb } from "./db.js";
import { embed } from "./ai.js";
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const norm = (a) => Math.sqrt(dot(a, a));
const cosine = (a, b) => dot(a, b) / (norm(a) * norm(b) || 1);
export async function retrieve(question, k = 5) {
  const [q] = await embed(question);
  const db = await getDb();
  const chunks = await db.collection("chunks").find({}).toArray();
  return chunks
    .map((c) => ({ text: c.text, documentId: c.documentId, score: cosine(q, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
```

### Answer (`POST /api/ask`)
1. `retrieve(question)` -> top-k chunks.
2. Build a system prompt: *"Answer ONLY from the provided context; if it isn't
   there, say you don't know. Cite the chunks you used."* Put the retrieved chunk
   texts (with ids) in the context.
3. `chat([...])` via `lib/ai.js`; return the answer plus the source chunks so the
   UI can render **citations**. Grounding + citations are the point — never let the
   model answer from parametric memory alone.

---

## 5. Wiring optional auth / payments

Not needed for a personal KB, but common when the KB is internal or paid:

- **Auth (gate the chat UI):** add an auth SDK (`@clerk/nextjs` or
  `@auth0/nextjs-auth0`) to `package.json`, uncomment the `vault:` block mapping
  `AUTH_PROVIDER_KEY`, init it in `lib/auth.js` from `process.env.AUTH_PROVIDER_KEY`,
  and protect `/` + `/api/*` in `middleware.js`. Store the value with
  `grid secrets set auth-provider-key …`; set any non-secret public key via
  `grid env`.
- **Payments (charge for access):** add `stripe` to `package.json`, uncomment the
  `vault:` block mapping `STRIPE_KEY`, add a lazy `lib/stripe.js` reading
  `process.env.STRIPE_KEY`, a Checkout route, and a signature-verified
  `api/webhooks/stripe/route.js`. Store `grid secrets set stripe-live-key sk_live_…`.

Both keys ride the CloudGrid **vault** — the yaml maps the vault item to an env
var, and `grid secrets set` stores the real value. Never inline a key.

---

## 6. Deploy steps

Runtime app → **local edition** only (Claude Desktop / Claude Code / CLI); the
hosted edition cannot build a runtime container. Order matters — `plug` needs a
linked directory, so `init` first.

1. `grid init` (or `grid_create_project`) an app `<name>` — creates the entity +
   `.cloudgrid/link.json` and a starter `cloudgrid.yaml` with empty `services:{}`.
2. Fill: put the app under `services/web/` and set `cloudgrid.yaml` to this
   blueprint's active fields (`services.web` nextjs `/`, `needs:{ai:true,
   database:true}`).
3. (If you added auth/payments) store the vault secrets with `grid secrets set`;
   non-secret public config → `grid env`. The AI Gateway and Mongo need no secrets
   — they are injected by `needs`.
4. (Optional) `grid dev` to run locally against the injected dev Mongo + AI Gateway.
5. `grid plug` to deploy. A runtime deploy is **ASYNC** — the first response is
   `status: building`, not a live URL. Poll `grid status` (surface a liveness
   signal, never a bare wait) until Ready.
6. Once live, return the app URL. Re-plug the same entity to update the same URL.

---

## 7. The swap to pgvector (now available — #1545 shipped)

`needs: vector` is available; to migrate off the in-app cosine ranking:

1. Uncomment `vector: pgvector` in `cloudgrid.yaml`'s `needs:` block (dim 1536 to
   match your embedding model). The grid then injects `VECTOR_PGVECTOR_URL` (+
   legacy `PGVECTOR_URL`).
2. Store each chunk's embedding in a pgvector `vector` column instead of the Mongo
   `chunks.embedding` array; keep the chunk `text` either in Postgres or as a
   Mongo row keyed by the same id.
3. Rewrite `lib/retrieve.js` to run an ORDER-BY-distance query
   (`ORDER BY embedding <=> $queryVec LIMIT k`) against `VECTOR_PGVECTOR_URL`
   instead of loading all chunks and ranking in JS. Because `retrieve()` is already
   a single function returning `{ text, documentId, score }[]`, `POST /api/ask`
   and the UI don't change.

Read the pgvector URL with the same lazy-getter discipline (never at module top
level).

---

## 8. Edition note

Because this is a built + deployed container (Next.js + Mongo + AI Gateway), it
requires the **local edition** (Claude Desktop / Claude Code) or the CLI. The
hosted edition (Claude Web / hosted MCP) is inline-only and can only publish
static pages — offer a static explainer page there, but the real knowledge base
must be built and plugged from the local edition.
