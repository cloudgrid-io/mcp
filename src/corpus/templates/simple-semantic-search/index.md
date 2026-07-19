# Template: simple-semantic-search (single-service pgvector search)

Semantic search over a document in ONE node service — the smallest real vector
app on the grid. The platform provisions pgvector from `needs: { vector:
pgvector }` and injects `VECTOR_PGVECTOR_URL`; embeddings come from the AI
Gateway via `@cloudgrid-io/runtime` (`needs: { ai: true }`, no API key). Proven
by a real end-to-end deploy (live in under 3 minutes, 2026-07-16).

For a multi-service search portfolio (upload UI, separate refresh cron), use the
heavier `semantic-search` blueprint instead. This template is the default for
"search my document by meaning".

**Key rules (all proven by the live deploy):**

1. **Size the vector column from a probe, never hardcode the dimension.** Embed
   one chunk first (`runtime.ai.embeddings`), read `probe.dim`, and create the
   table with `vector(${dim})`. Hardcoding 1536 breaks when the platform model
   differs.
2. **Seed in the background; report readiness via `/health`.** Bind the HTTP
   port immediately (the platform startup probe wants it open), run the
   embed+insert seed async, and return 503 from `/health` until it finishes —
   the readiness probe then holds the pod out of traffic until search works.
   The seed is idempotent (`CREATE ... IF NOT EXISTS`, count check, upsert).
3. **Read `VECTOR_PGVECTOR_URL` lazily inside the connect function** (with the
   legacy `PGVECTOR_URL` fallback). Never at module top level, never hardcoded.
4. **Query with the pgvector cosine operator.** `ORDER BY embedding <=> $1::vector`
   with score `1 - (embedding <=> $1::vector)`. Pass vectors as literals:
   `'[0.1,0.2,...]'` + `::vector` cast.
5. **Service code lives under `services/web/`**, not the project root.

## File tree

```
cloudgrid.yaml                      # name + needs: { vector: pgvector, ai: true } + services.web (node, health: /health)
services/web/package.json           # @cloudgrid-io/runtime, express, pg — nothing else
services/web/src/index.js           # seed + /search + minimal UI (single file)
services/web/src/document.txt       # the content to index — replace with the user's document
```

## What the CLI writes for you: `.cloudgrid/link.json`

On the first `grid plug` (which auto-creates the entity from `cloudgrid.yaml`,
honoring its `name:`), the CLI binds
the folder to its grid entity by writing `.cloudgrid/link.json`. It looks like:

```json
{
  "entity_id": "923b2d46-ce6e-42e5-9976-311f8dab5755",
  "org_id": "602fbff7-920b-4221-afb4-7440915b6bab",
  "org_slug": "atomic",
  "kind": "app",
  "entity_slug": "simple-semantic-search-86f2",
  "created_at": "2026-07-16T13:28:32.744Z",
  "cli_version": "0.15.4"
}
```

**Never hand-author or copy this file** — the CLI writes it, and every value is
minted when the entity is first registered (the slug gets a 4-hex suffix). Two
practical consequences:

- A folder **with** `.cloudgrid/link.json` is bound: `grid plug` UPDATES that
  entity. To fork someone else's project into your own app, `rm -rf .cloudgrid`
  (and remove any `name:` you don't own from `cloudgrid.yaml`) — the next
  `grid plug` mints a fresh identity.
- `link.json` is why identity does NOT belong in `cloudgrid.yaml` — the
  manifest describes the app; the link binds the folder.

## Deploy

```bash
grid plug                       # first plug registers the entity from cloudgrid.yaml
                                # + writes .cloudgrid/link.json, then builds + deploys
                                # (async — live URL in ~2-3 min)
grid visibility set <slug> link # default is grid-only (403 outside the org)
```

Then open the URL: a search box over the document, ranked by embedding
similarity. Replace `services/web/src/document.txt` with the user's content and
re-run `grid plug` to re-seed (delete rows or bump the table if the document
shrinks — the seed only tops up).

## cloudgrid.yaml (active fields)

```yaml
name: simple-semantic-search
description: Semantic search over a bundled document, backed by pgvector.
icon: "🔎"

needs:
  vector: pgvector    # injects VECTOR_PGVECTOR_URL (+legacy PGVECTOR_URL)
  ai: true            # embeddings via @cloudgrid-io/runtime, no API key

services:
  web:
    type: node
    path: /
    health: /health   # 503 until the seed finishes
```

## services/web/package.json

```json
{
  "name": "simple-semantic-search-web",
  "version": "1.0.0",
  "private": true,
  "description": "Semantic search over a bundled document on the CloudGrid vector substrate (pgvector).",
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js"
  },
  "dependencies": {
    "@cloudgrid-io/runtime": "^1.0.3",
    "express": "^4.21.2",
    "pg": "^8.13.0"
  }
}
```

## services/web/src/index.js

```js
'use strict';

// Simple semantic search — single-service reference for the CloudGrid managed vector
// substrate (pgvector) + the platform embeddings endpoint.
//
// On startup it embeds the bundled document (one vector per passage)
// via runtime.ai.embeddings and stores the vectors in the entity's own pgvector
// schema. POST /search embeds the query and returns the nearest passages by
// cosine distance. No keyword matching — relevance comes entirely from the
// embeddings.

const fs = require('fs');
const path = require('path');
const express = require('express');
const { Client } = require('pg');
const { runtime } = require('@cloudgrid-io/runtime');

const PORT = process.env.PORT || 8080;
const PGVECTOR_URL = process.env.VECTOR_PGVECTOR_URL || process.env.PGVECTOR_URL;

// One passage per non-empty paragraph in the article.
function loadChunks() {
  const raw = fs.readFileSync(path.join(__dirname, 'document.txt'), 'utf8');
  return raw
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .filter((p) => p.length > 0);
}

// Format a JS number[] as a pgvector literal: '[0.1,0.2,...]'.
function toVectorLiteral(values) {
  return '[' + values.join(',') + ']';
}

let seeded = false;
let seedError = null;
let chunkCount = 0;
let embeddingDim = 0;

async function connect() {
  if (!PGVECTOR_URL) {
    throw new Error('VECTOR_PGVECTOR_URL is not set — the vector need did not provision');
  }
  const client = new Client({ connectionString: PGVECTOR_URL });
  await client.connect();
  return client;
}

// Idempotent seed: ensure the extension + table exist, sized to the embedding
// model's actual output length, and populate the table once.
async function seed() {
  const chunks = loadChunks();
  const client = await connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector');

    // Size the column to the model's real output length — embed a probe first.
    const probe = await runtime.ai.embeddings({ text: chunks[0] });
    embeddingDim = probe.dim;
    console.log(`[seed] embedding model=${probe.model} dim=${embeddingDim}`);

    await client.query(
      `CREATE TABLE IF NOT EXISTS chunks (
         id integer PRIMARY KEY,
         chunk text NOT NULL,
         embedding vector(${embeddingDim}) NOT NULL
       )`,
    );

    const { rows } = await client.query('SELECT count(*)::int AS n FROM chunks');
    const existing = rows[0].n;
    if (existing >= chunks.length) {
      chunkCount = existing;
      console.log(`[seed] already populated with ${existing} chunks — skipping embed`);
      seeded = true;
      return;
    }

    console.log(`[seed] embedding ${chunks.length} chunks`);
    // Batch-embed every passage in input order.
    const vectors = await runtime.ai.embeddings({ text: chunks });
    for (let i = 0; i < chunks.length; i++) {
      const literal = toVectorLiteral(vectors[i].values);
      await client.query(
        `INSERT INTO chunks (id, chunk, embedding)
         VALUES ($1, $2, $3::vector)
         ON CONFLICT (id) DO UPDATE SET chunk = EXCLUDED.chunk, embedding = EXCLUDED.embedding`,
        [i, chunks[i], literal],
      );
      console.log(`[seed] inserted chunk ${i + 1}/${chunks.length}`);
    }
    chunkCount = chunks.length;
    seeded = true;
    console.log(`[seed] done — ${chunkCount} chunks stored`);
  } finally {
    await client.end().catch(() => {});
  }
}

async function search(query, limit = 5) {
  const q = await runtime.ai.embeddings({ text: query });
  const literal = toVectorLiteral(q.values);
  const client = await connect();
  try {
    const { rows } = await client.query(
      `SELECT chunk, 1 - (embedding <=> $1::vector) AS score
         FROM chunks
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
      [literal, limit],
    );
    return rows.map((r) => ({ chunk: r.chunk, score: Number(r.score) }));
  } finally {
    await client.end().catch(() => {});
  }
}

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  // Return not-ready until the seed completes so the platform's readiness probe
  // holds the pod out of traffic until search actually works.
  if (seedError) return res.status(500).json({ status: 'seed_failed', error: seedError });
  if (!seeded) return res.status(503).json({ status: 'seeding' });
  res.json({ status: 'ok', chunks: chunkCount, dim: embeddingDim });
});

app.post('/search', async (req, res) => {
  const query = req.body && typeof req.body.query === 'string' ? req.body.query.trim() : '';
  if (!query) return res.status(400).json({ error: 'Provide a query string.' });
  if (!seeded) return res.status(503).json({ error: 'The index is still loading. Try again shortly.' });
  try {
    const results = await search(query);
    res.json({ query, results });
  } catch (err) {
    console.error('[search] failed', err);
    res.status(500).json({ error: 'Search failed.' });
  }
});

app.get('/', (_req, res) => {
  res.type('html').send(PAGE);
});

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Semantic search</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; background: #fafafa; }
  main { max-width: 680px; margin: 0 auto; padding: 48px 20px 80px; }
  h1 { font-size: 24px; margin: 0 0 4px; }
  p.lede { color: #555; margin: 0 0 28px; }
  form { display: flex; gap: 8px; margin-bottom: 24px; }
  input { flex: 1; padding: 12px 14px; font-size: 16px; border: 1px solid #ccc; border-radius: 8px; background: #fff; }
  input:focus { outline: none; border-color: #888; }
  button { padding: 12px 20px; font-size: 16px; border: none; border-radius: 8px; background: #1a1a1a; color: #fff; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  .result { padding: 16px 0; border-top: 1px solid #eee; }
  .result .score { font-size: 13px; color: #888; margin-bottom: 4px; font-variant-numeric: tabular-nums; }
  .result .text { margin: 0; }
  .status { color: #888; font-size: 14px; }
</style>
</head>
<body>
<main>
  <h1>Semantic search</h1>
  <p class="lede">Search the document by meaning. Results are ranked by embedding similarity, not keyword match.</p>
  <form id="f">
    <input id="q" type="text" placeholder="Ask a question about the document" autocomplete="off" />
    <button id="b" type="submit">Search</button>
  </form>
  <div id="out"></div>
</main>
<script>
  var f = document.getElementById('f');
  var q = document.getElementById('q');
  var b = document.getElementById('b');
  var out = document.getElementById('out');
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    var query = q.value.trim();
    if (!query) return;
    b.disabled = true;
    out.innerHTML = '<p class="status">Searching.</p>';
    fetch('/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query }),
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        b.disabled = false;
        if (!data.results || !data.results.length) {
          out.innerHTML = '<p class="status">No results.</p>';
          return;
        }
        out.innerHTML = data.results.map(function (r) {
          return '<div class="result"><div class="score">score ' + r.score.toFixed(3) +
            '</div><p class="text">' + r.chunk.replace(/</g, '&lt;') + '</p></div>';
        }).join('');
      })
      .catch(function () {
        b.disabled = false;
        out.innerHTML = '<p class="status">Search failed. Try again.</p>';
      });
  });
</script>
</body>
</html>`;

app.listen(PORT, () => {
  console.log(`simple-semantic-search listening on ${PORT}`);
  // Seed in the background so the HTTP server binds immediately (the platform's
  // startup probe wants the port open). /health reports seeding progress.
  seed().catch((err) => {
    seedError = String((err && err.message) || err);
    console.error('[seed] FAILED', err);
  });
});
```

## services/web/src/document.txt

Any plain-text document, one passage per blank-line-separated paragraph. The
template ships a short factual solar-system article so the demo answers
questions like "which planet is the hottest?" — replace it with the user's
content.
